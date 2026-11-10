import { beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

beforeAll(() => {
  process.env.GLADOS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'glados-approvals-')), 'test.db');
  process.env.GLADOS_ARMING_HASH = ''; // none configured: arming must be refused
});

const post = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('approval routes: nothing is armed by default', () => {
  test('overview is empty, killed and reports no arming secret', async () => {
    const { GET } = await import('@/app/api/approvals/route');
    const body = await (await GET()).json();
    expect(body.switch.killed).toBe(true);
    expect(body.armingConfigured).toBe(false);
    expect(body.grants).toEqual([]);
    expect(body.pending).toEqual([]);
  });

  test('a proposal is refused with 409 while there is no armed grant', async () => {
    const { POST } = await import('@/app/api/approvals/route');
    const res = await POST(post('http://localhost/api/approvals', { channel: 'email.test', summary: 's', target: 't' }));
    expect(res.status).toBe(409);
  });

  test('grant admin needs confirm, arming needs the arming secret, kill always works', async () => {
    const { POST } = await import('@/app/api/grants/route');
    const u = 'http://localhost/api/grants';
    expect((await POST(post(u, { action: 'set', channel: 'email.test', kind: 'send', mode: 'ask' }))).status).toBe(409);
    expect((await POST(post(u, { action: 'set', confirm: true, channel: 'email.test', kind: 'send', mode: 'ask', dailyCapCount: 1 }))).status).toBe(200);
    expect((await POST(post(u, { action: 'arm', confirm: true, channel: 'email.test', armingSecret: 'x' }))).status).toBe(403);
    expect((await POST(post(u, { action: 'release', confirm: true, armingSecret: 'x' }))).status).toBe(403);
    expect((await POST(post(u, { action: 'kill' }))).status).toBe(200);
  });

  test('execute needs confirm and refuses when the proposal does not exist or writes are off', async () => {
    const { POST } = await import('@/app/api/approvals/[id]/route');
    const u = 'http://localhost/api/approvals/nope';
    expect((await POST(post(u, { action: 'execute' }), { params: { id: 'nope' } })).status).toBe(409);
    expect((await POST(post(u, { action: 'execute', confirm: true }), { params: { id: 'nope' } })).status).toBe(409);
  });
});
