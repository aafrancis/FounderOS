import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { invalidateModeCache } from '@/lib/paths';
import { hashPassword, resetThrottle } from '@/lib/auth';
import { clearExecutors, registerExecutor } from '@/lib/approvals';
import { decideGate } from '@/lib/auth-gate';
import { TOKEN_PREFIX, bearerOf, hashToken } from '@/lib/approval-tokens';

/**
 * Agent proposing tokens over HTTP (SH-0271). One temp database for the file;
 * each test sets its own env-local. Names and channels are unique per test.
 */

const ARM_PHRASE = 'open the gate for me';
let dir = '';
beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'glados-tokens-'));
  process.env.GLADOS_DB = path.join(root, 'test.db');
});
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'glados-tokens-env-'));
  vi.stubEnv('GLADOS_ENV_LOCAL', path.join(dir, '.env.local'));
  vi.stubEnv('GLADOS_MODE_FILE', path.join(dir, '.glados-mode'));
  vi.stubEnv('DEMO_MODE', '0');
  invalidateModeCache();
  resetThrottle();
  clearExecutors();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateModeCache();
});

const envLocal = (lines: string) => writeFileSync(path.join(dir, '.env.local'), lines);
const withArm = (extra = '') => envLocal(`GLADOS_ARM_HASH=${hashPassword(ARM_PHRASE)}\n${extra}`);
const json = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

async function armChannel(channel: string, mode = 'ask') {
  const { POST } = await import('@/app/api/approvals/grants/route');
  return POST(json('/api/approvals/grants', 'POST', { action: 'arm', channel, mode, dailyCapCount: 5, dailyCapCents: 1000, armSecret: ARM_PHRASE }));
}
async function issue(name: string, channels: string[], secret: unknown = ARM_PHRASE) {
  const { POST } = await import('@/app/api/approvals/tokens/route');
  return POST(json('/api/approvals/tokens', 'POST', { action: 'issue', name, channels, armSecret: secret }));
}
async function issued(name: string, channels: string[]): Promise<string> {
  const res = await issue(name, channels);
  expect(res.status).toBe(200);
  return (await res.json()).token as string;
}
async function propose(token: string | null, body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/approvals/propose/route');
  return POST(json('/api/approvals/propose', 'POST', body, token ? { authorization: `Bearer ${token}` } : {}));
}
const item = (channel: string, over: Record<string, unknown> = {}) => ({ channel, kind: 'send-email', title: 'Hi', content: 'Body', target: 'a@example.com', costCents: 0, ...over });
async function queue() {
  const { GET } = await import('@/app/api/approvals/route');
  return (await GET()).json();
}

describe('issuing and listing tokens', () => {
  test('needs the arming secret: not configured 503, wrong 401, missing 401, right 200', async () => {
    envLocal('');
    expect((await issue('t-none', ['c-none'])).status).toBe(503);
    withArm();
    expect((await issue('t-wrong', ['c-a'], 'wrong')).status).toBe(401);
    expect((await issue('t-missing', ['c-a'], null)).status).toBe(401);
    const ok = await issue('t-ok', ['c-a']);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ ok: true, name: 't-ok', channels: ['c-a'] });
    expect(body.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  test('the list shows names and channels, never a token or a hash', async () => {
    withArm();
    const token = await issued('t-list', ['c-list']);
    const { GET } = await import('@/app/api/approvals/tokens/route');
    const text = JSON.stringify(await (await GET()).json());
    expect(text).toContain('t-list');
    expect(text).not.toContain(token);
    expect(text).not.toContain(hashToken(token));
    const { tokens } = JSON.parse(text) as { tokens: Array<Record<string, unknown>> };
    expect(Object.keys(tokens.find((t) => t.name === 't-list')!).sort()).toEqual(['channels', 'createdAt', 'name', 'revokedAt']);
  });

  test('a repeated name is 409 (a revoked name stays taken); bad names and channels are 400', async () => {
    withArm();
    await issued('t-dup', ['c-dup']);
    expect((await issue('t-dup', ['c-dup'])).status).toBe(409);
    const { POST } = await import('@/app/api/approvals/tokens/route');
    await POST(json('/api/approvals/tokens', 'POST', { action: 'revoke', name: 't-dup' }));
    expect((await issue('t-dup', ['c-dup'])).status).toBe(409);
    expect((await issue('Bad Name', ['c-x'])).status).toBe(400);
    expect((await issue('t-empty', [])).status).toBe(400);
    expect((await issue('t-badchan', ['NOT OK'])).status).toBe(400);
  });

  test('issuing is refused while the kill switch is on', async () => {
    withArm();
    const kill = await import('@/app/api/approvals/kill/route');
    await kill.POST(json('/api/approvals/kill', 'POST', { action: 'kill' }));
    expect((await issue('t-killed', ['c-k'])).status).toBe(423);
    await kill.POST(json('/api/approvals/kill', 'POST', { action: 'reset', armSecret: ARM_PHRASE }));
  });
});

describe('proposing with a token', () => {
  test('files a proposal on an allowed, armed channel, and the proposer is the token name whatever the body says', async () => {
    withArm();
    await armChannel('c-ok');
    const token = await issued('t-agent', ['c-ok']);
    const res = await propose(token, item('c-ok', { proposedBy: 'operator' }));
    expect(res.status).toBe(201);
    const { action, autoApproved } = await res.json();
    expect(autoApproved).toBe(false);
    expect(action.proposedBy).toBe('agent:t-agent');
    expect(action.status).toBe('proposed');
  });

  test('a channel the token was not issued for is 403 and nothing is queued', async () => {
    withArm();
    await armChannel('c-allowed');
    await armChannel('c-other');
    const token = await issued('t-narrow', ['c-allowed']);
    const before = (await queue()).open.length;
    const res = await propose(token, item('c-other'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('token_channel');
    expect((await propose(token, { ...item('c-allowed'), channel: undefined })).status).toBe(403);
    expect((await queue()).open.length).toBe(before);
  });

  test('no token, a made-up token, a wrong-shape token and a revoked token are all 401', async () => {
    withArm();
    await armChannel('c-auth');
    const token = await issued('t-revoke', ['c-auth']);
    expect((await propose(null, item('c-auth'))).status).toBe(401);
    expect((await propose(`${TOKEN_PREFIX}notarealtoken`, item('c-auth'))).status).toBe(401);
    expect((await propose('plain-secret', item('c-auth'))).status).toBe(401);
    expect((await propose(token, item('c-auth'))).status).toBe(201);
    const { POST } = await import('@/app/api/approvals/tokens/route');
    const rev = await POST(json('/api/approvals/tokens', 'POST', { action: 'revoke', name: 't-revoke' }));
    expect((await rev.json()).revoked).toBe(true);
    expect((await propose(token, item('c-auth'))).status).toBe(401);
  });

  test('refused callers write nothing: no queue row and no log row', async () => {
    withArm();
    await armChannel('c-quiet');
    const before = await queue();
    await propose(null, item('c-quiet'));
    await propose(`${TOKEN_PREFIX}nope`, item('c-quiet'));
    const after = await queue();
    expect(after.open.length).toBe(before.open.length);
    // the log is capped at the newest 50 rows, so compare the newest id, not the length
    expect(after.log[0]?.id).toBe(before.log[0]?.id);
  });

  test('the kill switch stops token proposals (423) and an unarmed channel is 403', async () => {
    withArm();
    await armChannel('c-kill');
    const token = await issued('t-kill', ['c-kill', 'c-unarmed']);
    expect((await propose(token, item('c-unarmed'))).status).toBe(403);
    const kill = await import('@/app/api/approvals/kill/route');
    await kill.POST(json('/api/approvals/kill', 'POST', { action: 'kill' }));
    expect((await propose(token, item('c-kill'))).status).toBe(423);
    await kill.POST(json('/api/approvals/kill', 'POST', { action: 'reset', armSecret: ARM_PHRASE }));
  });

  test('on an auto grant a token proposal is approved and run inside the cap, once', async () => {
    withArm('GLADOS_WRITES=1\n');
    const run = vi.fn(async () => ({ sent: true }));
    registerExecutor('send-email', run);
    await armChannel('c-auto', 'auto');
    const token = await issued('t-auto', ['c-auto']);
    const res = await propose(token, item('c-auto'));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.autoApproved).toBe(true);
    expect(body.action.status).toBe('executed');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('the gate', () => {
  const gate = (pathname: string) => decideGate({ pathname, method: 'POST', hostname: 'example.com', origin: null, requestOrigin: 'https://example.com', configured: true, authed: false });

  test('only the propose path is open to a caller with no session; every other approvals path needs one', () => {
    expect(gate('/api/approvals/propose').kind).toBe('pass');
    for (const p of ['/api/approvals', '/api/approvals/tokens', '/api/approvals/grants', '/api/approvals/kill', '/api/approvals/abc', '/api/approvals/propose/x']) {
      expect(gate(p).kind, p).toBe('unauthorized-api');
    }
  });

  test('bearerOf drops anything not shaped like our token before a lookup', () => {
    const r = (h: string) => new Request('http://localhost/x', { headers: { authorization: h } });
    expect(bearerOf(r(`Bearer ${TOKEN_PREFIX}abc`))).toBe(`${TOKEN_PREFIX}abc`);
    expect(bearerOf(r('Bearer abc'))).toBeNull();
    expect(bearerOf(r(`Basic ${TOKEN_PREFIX}abc`))).toBeNull();
    expect(bearerOf(r(`Bearer ${TOKEN_PREFIX}${'a'.repeat(300)}`))).toBeNull();
    expect(bearerOf(new Request('http://localhost/x'))).toBeNull();
  });
});
