import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { invalidateModeCache } from '@/lib/paths';
import { hashPassword, resetThrottle } from '@/lib/auth';
import { clearExecutors, registerExecutor } from '@/lib/approvals';

/**
 * The approval queue's HTTP contract (SH-0271). One temp database for the file;
 * each test sets its own env-local so the arming hash and GLADOS_WRITES are
 * under its control. Channels are unique per test so tests do not share state.
 */

const SECRET = 'arming-secret-123';
let dir = '';
beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'glados-approvals-'));
  process.env.GLADOS_DB = path.join(root, 'test.db');
});
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'glados-approvals-env-'));
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
const withArm = (extra = '') => envLocal(`GLADOS_ARM_HASH=${hashPassword(SECRET)}\n${extra}`);
const json = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function armChannel(channel: string, over: Record<string, unknown> = {}, secret: unknown = SECRET) {
  const { POST } = await import('@/app/api/approvals/grants/route');
  return POST(json('/api/approvals/grants', 'POST', { action: 'arm', channel, mode: 'ask', dailyCapCount: 5, dailyCapCents: 1000, armSecret: secret, ...over }));
}
async function file(channel: string, over: Record<string, unknown> = {}) {
  const { POST } = await import('@/app/api/approvals/route');
  return POST(json('/api/approvals', 'POST', { channel, kind: 'send-email', title: 'Hi', content: 'Body', target: 'a@example.com', costCents: 0, proposedBy: 'agent', ...over }));
}

describe('GET /api/approvals', () => {
  test('answers 200 with the switch, the grants and the queue', async () => {
    const { GET } = await import('@/app/api/approvals/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ killed: false, armConfigured: false, writesEnabled: false });
    expect(Array.isArray(body.grants)).toBe(true);
    expect(Array.isArray(body.open)).toBe(true);
  });
});

describe('arming over HTTP', () => {
  test('no arming secret on the instance: 503 and nothing is armed', async () => {
    envLocal('');
    const res = await armChannel('r-none');
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('arming_not_configured');
  });

  test('wrong secret: 401; right secret: 200 with the grant', async () => {
    withArm();
    expect((await armChannel('r-arm', {}, 'wrong')).status).toBe(401);
    const ok = await armChannel('r-arm');
    expect(ok.status).toBe(200);
    expect((await ok.json()).grant).toMatchObject({ channel: 'r-arm', armed: true, mode: 'ask' });
  });

  test('a missing arming secret is 401, never a silent arm', async () => {
    withArm();
    const { POST } = await import('@/app/api/approvals/grants/route');
    const res = await POST(json('/api/approvals/grants', 'POST', { action: 'arm', channel: 'r-nosecret', mode: 'ask', dailyCapCount: 1, dailyCapCents: 0 }));
    expect(res.status).toBe(401);
  });

  test('an unknown action and a missing body are 400', async () => {
    const { POST } = await import('@/app/api/approvals/grants/route');
    expect((await POST(json('/api/approvals/grants', 'POST', { action: 'nope' }))).status).toBe(400);
    expect((await POST(new Request('http://localhost/api/approvals/grants', { method: 'POST' }))).status).toBe(400);
  });

  test('disarm needs no secret', async () => {
    withArm();
    await armChannel('r-disarm');
    const { POST } = await import('@/app/api/approvals/grants/route');
    const res = await POST(json('/api/approvals/grants', 'POST', { action: 'disarm', channel: 'r-disarm' }));
    expect(res.status).toBe(200);
    expect((await res.json()).disarmed).toBe(true);
    expect((await file('r-disarm')).status).toBe(403);
  });
});

describe('the queue over HTTP', () => {
  test('propose on an unarmed channel is 403 with the code', async () => {
    withArm();
    const res = await file('r-unarmed');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('no_grant');
  });

  test('propose, approve, and it runs once through the registered executor', async () => {
    withArm('GLADOS_WRITES=1\n');
    const run = vi.fn(async () => ({ sent: true }));
    registerExecutor('send-email', run);
    await armChannel('r-flow');
    const filed = await file('r-flow');
    expect(filed.status).toBe(201);
    const { action, autoApproved } = await filed.json();
    expect(autoApproved).toBe(false);
    expect(run).not.toHaveBeenCalled();

    const decide = await import('@/app/api/approvals/[id]/route');
    const res = await decide.POST(json(`/api/approvals/${action.id}`, 'POST', { decision: 'approve' }), { params: { id: action.id } });
    expect(res.status).toBe(200);
    const done = await res.json();
    expect(done.execution).toBe('ran');
    expect(done.action.status).toBe('executed');
    expect(run).toHaveBeenCalledTimes(1);

    const again = await decide.POST(json(`/api/approvals/${action.id}`, 'POST', { decision: 'approve' }), { params: { id: action.id } });
    expect(again.status).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('approved but writes are off: the action stays approved and the reason is returned', async () => {
    withArm(); // no GLADOS_WRITES
    registerExecutor('send-email', async () => 'x');
    await armChannel('r-writes-off');
    const { action } = await (await file('r-writes-off')).json();
    const decide = await import('@/app/api/approvals/[id]/route');
    const res = await decide.POST(json(`/api/approvals/${action.id}`, 'POST', { decision: 'approve' }), { params: { id: action.id } });
    const body = await res.json();
    expect(body.action.status).toBe('approved');
    expect(body.execution).toMatchObject({ code: 'writes_off' });
  });

  test('reject, an unknown id and a bad decision', async () => {
    withArm();
    await armChannel('r-reject');
    const { action } = await (await file('r-reject')).json();
    const decide = await import('@/app/api/approvals/[id]/route');
    const rej = await decide.POST(json(`/api/approvals/${action.id}`, 'POST', { decision: 'reject' }), { params: { id: action.id } });
    expect((await rej.json()).action.status).toBe('rejected');
    expect((await decide.POST(json('/api/approvals/nope', 'POST', { decision: 'approve' }), { params: { id: 'nope' } })).status).toBe(404);
    expect((await decide.POST(json('/api/approvals/x', 'POST', { decision: 'maybe' }), { params: { id: 'x' } })).status).toBe(400);
  });

  test('a bad proposal body is 400', async () => {
    withArm();
    await armChannel('r-bad');
    expect((await file('r-bad', { target: '' })).status).toBe(400);
  });
});

describe('the kill switch over HTTP', () => {
  test('kill stops everything; reset needs the secret and re-arms nothing', async () => {
    withArm();
    await armChannel('r-kill');
    const { POST } = await import('@/app/api/approvals/kill/route');
    const killed = await POST(json('/api/approvals/kill', 'POST', { action: 'kill' }));
    expect(killed.status).toBe(200);
    expect((await file('r-kill')).status).toBe(423);
    expect((await armChannel('r-kill')).status).toBe(423);

    expect((await POST(json('/api/approvals/kill', 'POST', { action: 'reset', armSecret: 'wrong' }))).status).toBe(401);
    expect((await POST(json('/api/approvals/kill', 'POST', { action: 'reset' }))).status).toBe(401);
    expect((await POST(json('/api/approvals/kill', 'POST', { action: 'reset', armSecret: SECRET }))).status).toBe(200);
    expect((await file('r-kill')).status).toBe(403); // grant is still off
  });

  test('an unknown action is 400', async () => {
    const { POST } = await import('@/app/api/approvals/kill/route');
    expect((await POST(json('/api/approvals/kill', 'POST', { action: 'nope' }))).status).toBe(400);
  });
});
