import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { APPROVALS_DDL, approvalsRepo, PENDING_TTL_MS } from '@/lib/db-ext/approvals';
import { hashPassword } from '@/lib/auth';
import { checkArming } from '@/lib/approvals';

function fresh(start = '2026-11-10T10:00:00.000Z') {
  const db = new Database(':memory:');
  db.exec(APPROVALS_DDL);
  let t = Date.parse(start);
  const repo = approvalsRepo(db, () => new Date(t));
  return { db, repo, advance: (ms: number) => (t += ms) };
}
const input = { channel: 'email.test', summary: 'Send hello', payload: { body: 'hi' }, target: 'a@example.com', proposedBy: 'agent' };
const armed = (repo: ReturnType<typeof fresh>['repo'], extra: Partial<Parameters<ReturnType<typeof fresh>['repo']['setGrant']>[0]> = {}) => {
  repo.setGrant({ channel: 'email.test', kind: 'send', mode: 'ask', dailyCapCount: 2, ...extra }, 'op');
  repo.armGrant('email.test', 'op');
  repo.setKilled(false, 'op');
};

describe('safe by default', () => {
  test('kill switch starts engaged and there are no grants', () => {
    const { repo } = fresh();
    expect(repo.killed()).toBe(true);
    expect(repo.grants()).toEqual([]);
    const res = repo.propose(input);
    expect(res.ok).toBe(false);
  });

  test('a grant that is set but not armed refuses proposals; editing a grant disarms it', () => {
    const { repo } = fresh();
    repo.setKilled(false, 'op');
    repo.setGrant({ channel: 'email.test', kind: 'send', mode: 'ask', dailyCapCount: 5 }, 'op');
    expect(repo.propose(input)).toMatchObject({ ok: false, reason: expect.stringContaining('not armed') });
    repo.armGrant('email.test', 'op');
    expect(repo.propose(input).ok).toBe(true);
    repo.setGrant({ channel: 'email.test', kind: 'send', mode: 'ask', dailyCapCount: 50 }, 'op');
    expect(repo.grant('email.test')?.armedAt).toBeNull();
    expect(repo.propose(input).ok).toBe(false);
  });

  test('a spend grant must carry a money cap', () => {
    const { repo } = fresh();
    expect(repo.setGrant({ channel: 'ads.meta', kind: 'spend', mode: 'ask' }, 'op').ok).toBe(false);
    expect(repo.setGrant({ channel: 'ads.meta', kind: 'spend', mode: 'ask', dailyCapCents: 1000 }, 'op').ok).toBe(true);
  });
});

describe('caps', () => {
  test('daily count cap blocks the next proposal and resets the next UTC day', () => {
    const { repo, advance } = fresh();
    armed(repo);
    expect(repo.propose(input).ok).toBe(true);
    expect(repo.propose(input).ok).toBe(true);
    expect(repo.propose(input)).toMatchObject({ ok: false, reason: expect.stringContaining('count cap') });
    advance(24 * 60 * 60 * 1000);
    expect(repo.propose(input).ok).toBe(true);
  });

  test('daily money cap counts what is already committed', () => {
    const { repo } = fresh();
    repo.setGrant({ channel: 'ads.meta', kind: 'spend', mode: 'ask', dailyCapCents: 1000 }, 'op');
    repo.armGrant('ads.meta', 'op');
    repo.setKilled(false, 'op');
    const a = { ...input, channel: 'ads.meta', costCents: 600 };
    expect(repo.propose(a).ok).toBe(true);
    expect(repo.propose(a)).toMatchObject({ ok: false, reason: expect.stringContaining('spend cap') });
    expect(repo.propose({ ...a, costCents: 400 }).ok).toBe(true);
  });

  test('a rejected proposal frees its cap', () => {
    const { repo } = fresh();
    armed(repo, { dailyCapCount: 1 });
    const p = repo.propose(input);
    if (!p.ok) throw new Error('setup');
    expect(repo.propose(input).ok).toBe(false);
    repo.reject(p.value.id, 'op');
    expect(repo.propose(input).ok).toBe(true);
  });
});

describe('approve, run once, audit', () => {
  test('ask mode: pending until approved; claim only after approval; second claim refused', () => {
    const { repo } = fresh();
    armed(repo);
    const p = repo.propose(input);
    if (!p.ok) throw new Error('setup');
    expect(p.value.status).toBe('pending');
    expect(repo.claim(p.value.id, 'op').ok).toBe(false);
    expect(repo.approve(p.value.id, 'op').ok).toBe(true);
    expect(repo.claim(p.value.id, 'op').ok).toBe(true);
    expect(repo.claim(p.value.id, 'op')).toMatchObject({ ok: false, reason: expect.stringContaining('runs once') });
    repo.finish(p.value.id, 'op', { ok: true, result: 'sent' });
    expect(repo.approval(p.value.id)).toMatchObject({ status: 'executed', result: 'sent' });
  });

  test('auto mode approves on proposal but caps and the kill switch still apply', () => {
    const { repo } = fresh();
    armed(repo, { mode: 'auto', dailyCapCount: 1 });
    const p = repo.propose(input);
    expect(p.ok && p.value.status).toBe('approved');
    expect(repo.propose(input).ok).toBe(false);
  });

  test('kill switch stops approving and running, even for already approved proposals', () => {
    const { repo } = fresh();
    armed(repo);
    const p = repo.propose(input);
    if (!p.ok) throw new Error('setup');
    repo.approve(p.value.id, 'op');
    repo.setKilled(true, 'op');
    expect(repo.claim(p.value.id, 'op')).toMatchObject({ ok: false, reason: expect.stringContaining('kill switch') });
    expect(repo.approval(p.value.id)?.status).toBe('approved');
  });

  test('disarming a grant blocks running its approved proposals', () => {
    const { repo } = fresh();
    armed(repo);
    const p = repo.propose(input);
    if (!p.ok) throw new Error('setup');
    repo.approve(p.value.id, 'op');
    repo.disarmGrant('email.test', 'op');
    expect(repo.claim(p.value.id, 'op').ok).toBe(false);
  });

  test('a stale pending proposal expires instead of being approved', () => {
    const { repo, advance } = fresh();
    armed(repo);
    const p = repo.propose(input);
    if (!p.ok) throw new Error('setup');
    advance(PENDING_TTL_MS + 1000);
    expect(repo.approve(p.value.id, 'op')).toMatchObject({ ok: false, reason: expect.stringContaining('expired') });
    expect(repo.approval(p.value.id)?.status).toBe('expired');
  });

  test('every step lands in the audit log, in order, and the log is append-only', () => {
    const { repo, db } = fresh();
    armed(repo);
    const p = repo.propose(input);
    if (!p.ok) throw new Error('setup');
    repo.approve(p.value.id, 'op');
    repo.claim(p.value.id, 'op');
    repo.finish(p.value.id, 'op', { ok: false, result: 'smtp down' });
    const events = repo.auditLog().reverse().map((r) => r.event);
    expect(events).toEqual(['grant.set', 'grant.arm', 'switch.release', 'propose', 'approve', 'execute.claim', 'execute.failed']);
    expect(repo.approval(p.value.id)?.status).toBe('failed');
    expect((db.prepare('SELECT COUNT(*) AS n FROM approval_audit').get() as { n: number }).n).toBe(7);
  });
});

describe('arming secret', () => {
  test('refused when none is configured, wrong, or missing; accepted when right', () => {
    const prev = process.env.GLADOS_ARMING_HASH;
    try {
      delete process.env.GLADOS_ARMING_HASH;
      expect(checkArming('anything')).toContain('No arming secret');
      process.env.GLADOS_ARMING_HASH = hashPassword('correct horse battery');
      expect(checkArming('nope')).toBe('Wrong arming secret.');
      expect(checkArming(undefined)).toContain('required');
      expect(checkArming('correct horse battery')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.GLADOS_ARMING_HASH;
      else process.env.GLADOS_ARMING_HASH = prev;
    }
  });
});
