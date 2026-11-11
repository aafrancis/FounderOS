import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { hashPassword, resetThrottle } from '@/lib/auth';
import { createPasskeys, type RpConfig } from '@/lib/passkeys';
import { assert, attest, newKey } from './helpers/soft-authenticator';

/**
 * scripts/request-approval end to end (SH-0277): the real CLI process talks
 * HTTP to the real /api/approvals/hard-line route handlers over a real socket,
 * and the founder's decision is made through the real passkey module. Exit 0
 * only on a passkey approval.
 */

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'request-approval');
const RP: RpConfig = { rpID: 'founderos.test', origins: ['https://founderos.test'], rpName: 'FounderOS' };
const ARM = 'open the gate for me';
const TOKEN = 'test-hardline-token-123';
let server: Server;
let base = '';

beforeAll(async () => {
  process.env.GLADOS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'glados-hlcli-')), 'test.db');
  const route = await import('@/app/api/approvals/hard-line/route');
  const decide = await import('@/app/api/approvals/[id]/route');
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://${req.headers.host}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === 'GET' ? undefined : Buffer.concat(chunks),
    });
    const m = new URL(url).pathname.match(/^\/api\/approvals\/([^/]+)$/);
    let out: Response;
    if (new URL(url).pathname === '/api/approvals/hard-line') out = req.method === 'POST' ? await route.POST(request) : await route.GET(request);
    else if (m && req.method === 'POST') out = await decide.POST(request, { params: { id: m[1] } });
    else out = new Response('{}', { status: 404 });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  resetThrottle();
  vi.stubEnv('HARDLINE_REQUEST_TOKEN', TOKEN);
});

type Run = { code: Promise<number>; id: Promise<string>; out: () => string };

function run(args: string[], env: Record<string, string> = {}): Run {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? '', FOUNDEROS_URL: base, HARDLINE_REQUEST_TOKEN: TOKEN, ...env } as unknown as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let resolveId: (s: string) => void = () => {};
  const id = new Promise<string>((r) => (resolveId = r));
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString();
    const m = out.match(/^requested (\S+)$/m);
    if (m) resolveId(m[1]);
  });
  child.stderr.on('data', () => {});
  const code = new Promise<number>((r) => child.on('exit', (c: number | null) => r(c ?? -1)));
  return { code, id, out: () => out };
}

const ask = ['--summary', 'Force-push meta main', '--action', 'git push --force origin main', '--undo', 'git push origin old:main', '--interval', '0.1', '--by', 'agent:test'];

async function passkeys() {
  const { getDb } = await import('@/lib/data');
  const db = getDb();
  return createPasskeys({ repo: db.passkeys, approvals: db.approvals, rp: () => RP, armHash: () => hashPassword(ARM), loginHash: () => undefined });
}

describe('scripts/request-approval', () => {
  test('exits 0 only after the founder approves with their passkey', async () => {
    const p = await passkeys();
    const key = newKey();
    const reg = await p.registrationOptions(ARM, 'founder', 'cli-reg');
    if (!reg.ok) throw new Error(reg.error);
    expect((await p.verifyRegistration(attest(key, { challenge: reg.options.challenge, rpID: RP.rpID, origin: RP.origins[0] }), 'iPhone', 'founder')).ok).toBe(true);

    const r = run([...ask, '--timeout', '30']);
    const id = await r.id;
    const opts = await p.approvalOptions(id);
    if (!opts.ok) throw new Error(opts.error);
    expect((await p.approve(id, assert(key, { challenge: opts.options.challenge, rpID: RP.rpID, origin: RP.origins[0] }), 'founder')).ok).toBe(true);
    expect(await r.code).toBe(0);
    expect(r.out()).toMatch(/^approved /m);
  }, 30_000);

  test('the ordinary approve button cannot release it: the CLI keeps waiting, then times out with 2', async () => {
    const r = run([...ask, '--timeout', '1.5']);
    const id = await r.id;
    const { POST } = await import('@/app/api/approvals/[id]/route');
    const res = await POST(new Request(`http://localhost/api/approvals/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) }), { params: { id } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('passkey_required');
    expect(await r.code).toBe(2);
    expect(r.out()).toMatch(/^timeout /m);
  }, 30_000);

  test('exits 1 when the founder denies', async () => {
    const r = run([...ask, '--timeout', '30']);
    const id = await r.id;
    const { POST } = await import('@/app/api/approvals/[id]/route');
    const res = await POST(new Request(`http://localhost/api/approvals/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'reject' }) }), { params: { id } });
    expect(res.status).toBe(200);
    expect(await r.code).toBe(1);
  }, 30_000);

  test('exits 2 when the request expires', async () => {
    const r = run([...ask, '--timeout', '30']);
    const id = await r.id;
    const { getApprovals } = await import('@/lib/approvals-server');
    getApprovals().kill('test'); // the kill switch expires every open action
    expect(await r.code).toBe(2);
    expect(r.out()).toMatch(new RegExp(`^expired ${id}$`, 'm'));
    const { getDb } = await import('@/lib/data');
    getDb().approvals.setSwitch(false, new Date().toISOString(), 'test');
  }, 30_000);

  test('exits 3 with a wrong token, and files nothing', async () => {
    const r = run(ask, { HARDLINE_REQUEST_TOKEN: 'wrong' });
    expect(await r.code).toBe(3);
    expect(r.out()).not.toMatch(/requested/);
  }, 30_000);

  test('exits 3 on missing arguments', async () => {
    expect(await run(['--summary', 'x']).code).toBe(3);
  });
});
