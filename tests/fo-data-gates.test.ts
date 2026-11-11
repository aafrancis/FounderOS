import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOKEN_PATHS, decideGate, isOpenPath } from '@/lib/auth-gate';
import { cronEnabled, gateDecision, isConfirmed, writesEnabled } from '@/lib/gates';
import { authorizePush } from '@/lib/push-auth';
import { invalidateModeCache } from '@/lib/paths';

/** SPEC O7 and AC-13: the write gate, the cron gate, the confirm rule and the push-token auth. */

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'glados-gates-'));
  vi.stubEnv('GLADOS_ENV_LOCAL', path.join(dir, '.env.local'));
  vi.stubEnv('GLADOS_MODE_FILE', path.join(dir, '.glados-mode'));
  vi.stubEnv('DEMO_MODE', '0');
  invalidateModeCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  invalidateModeCache();
});

const envLocal = (lines: string) => writeFileSync(path.join(dir, '.env.local'), lines);

describe('GLADOS_WRITES and GLADOS_CRON', () => {
  test('both are off by default', () => {
    vi.stubEnv('GLADOS_WRITES', undefined as unknown as string);
    vi.stubEnv('GLADOS_CRON', undefined as unknown as string);
    delete process.env.GLADOS_WRITES;
    delete process.env.GLADOS_CRON;
    expect(writesEnabled()).toBe(false);
    expect(cronEnabled()).toBe(false);
  });

  test('only exactly "1" turns a switch on; .env.local takes effect without a restart', () => {
    vi.stubEnv('GLADOS_WRITES', 'true');
    expect(writesEnabled()).toBe(false);
    envLocal('GLADOS_WRITES=1\nGLADOS_CRON=1\n');
    expect(writesEnabled()).toBe(true);
    expect(cronEnabled()).toBe(true);
  });

  test('Filming forces both off', () => {
    envLocal('GLADOS_WRITES=1\nGLADOS_CRON=1\n');
    vi.stubEnv('DEMO_MODE', '1');
    invalidateModeCache();
    expect(writesEnabled()).toBe(false);
    expect(cronEnabled()).toBe(false);
  });

  test('gateDecision: the switch first (403), then the confirm (409), then go', () => {
    const off = () => false;
    const on = () => true;
    expect(gateDecision('GLADOS_WRITES', { confirm: true }, off)).toMatchObject({ status: 403, gate: 'GLADOS_WRITES' });
    expect(gateDecision('GLADOS_CRON', { confirm: true }, off)).toMatchObject({ status: 403, gate: 'GLADOS_CRON' });
    expect(gateDecision('GLADOS_WRITES', {}, on)).toMatchObject({ status: 409, needsConfirm: true });
    expect(gateDecision('GLADOS_WRITES', { confirm: 'true' }, on)?.status).toBe(409);
    expect(gateDecision('GLADOS_WRITES', { confirm: 1 }, on)?.status).toBe(409);
    expect(gateDecision('GLADOS_WRITES', { confirm: true }, on)).toBeNull();
    expect(gateDecision(null, { confirm: true })).toBeNull();
    expect(isConfirmed(null)).toBe(false);
  });
});

describe('push endpoints: the middleware lets exactly these through, the route checks the token', () => {
  test('TOKEN_PATHS are open to the middleware; nothing else new is', () => {
    expect([...TOKEN_PATHS].sort()).toEqual(['/api/approvals/hard-line', '/api/plaud/ingest', '/api/trading/limits', '/api/trading/snapshot', '/api/usage/push']);
    for (const p of TOKEN_PATHS) expect(isOpenPath(p)).toBe(true);
    for (const p of ['/api/trading', '/api/usage', '/api/clients', '/api/cron/tick', '/api/trading/snapshot/x']) expect(isOpenPath(p)).toBe(false);
    const gate = decideGate({ pathname: '/api/clients/confirm', method: 'POST', hostname: 'example.com', origin: null, requestOrigin: 'https://example.com', configured: true, authed: false });
    expect(gate.kind).toBe('unauthorized-api');
  });

  const req = (headers: Record<string, string> = {}, url = 'http://localhost/api/trading/snapshot') => new Request(url, { method: 'POST', headers });

  test('a matching bearer token is accepted; a wrong one is 401', () => {
    envLocal('TRADING_PUSH_TOKEN=s3cret-token\n');
    expect(authorizePush(req({ authorization: 'Bearer s3cret-token' }), 'TRADING_PUSH_TOKEN')).toEqual({ ok: true, via: 'token' });
    expect(authorizePush(req({ 'x-glados-token': 's3cret-token' }), 'TRADING_PUSH_TOKEN')).toEqual({ ok: true, via: 'token' });
    expect(authorizePush(req({ authorization: 'Bearer nope' }), 'TRADING_PUSH_TOKEN')).toMatchObject({ ok: false, status: 401 });
  });

  test('an unset token never means open: a token sent to an unset key is 401', () => {
    expect(authorizePush(req({ authorization: 'Bearer anything' }), 'USAGE_PUSH_TOKEN')).toMatchObject({ ok: false, status: 401 });
  });

  test('no token, password set: the session cookie is required', () => {
    envLocal('GLADOS_PASSWORD_HASH=x\nGLADOS_SESSION_SECRET=sess-secret\n');
    expect(authorizePush(req(), 'PLAUD_INGEST_TOKEN')).toMatchObject({ ok: false, status: 401 });
    expect(authorizePush(req({ cookie: 'glados_session=wrong' }), 'PLAUD_INGEST_TOKEN')).toMatchObject({ ok: false, status: 401 });
    expect(authorizePush(req({ cookie: 'glados_session=sess-secret' }), 'PLAUD_INGEST_TOKEN')).toEqual({ ok: true, via: 'session' });
  });

  test('no token, no password: loopback only, and cross-origin writes are refused', () => {
    expect(authorizePush(req({ host: 'localhost:4100' }), 'PLAUD_INGEST_TOKEN')).toEqual({ ok: true, via: 'session' });
    expect(authorizePush(req({ host: '192.168.1.20:4100' }), 'PLAUD_INGEST_TOKEN')).toMatchObject({ ok: false, status: 401 });
    expect(authorizePush(req({ host: 'localhost:4100', origin: 'https://evil.example' }), 'PLAUD_INGEST_TOKEN')).toMatchObject({ ok: false, status: 403 });
  });
});
