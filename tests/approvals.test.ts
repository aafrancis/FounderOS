import { beforeEach, describe, expect, test, vi } from 'vitest';
import { openDb } from '@/lib/db';
import { hashPassword, resetThrottle } from '@/lib/auth';
import { createApprovals, dayStart, type Executor } from '@/lib/approvals';

/**
 * The approval queue (SH-0271). Every rule that keeps send, spend and publish
 * rights safe has a test that fails if the rule is removed: no grant, caps,
 * once-only execution, the kill switch, and the arming secret.
 */

const SECRET = 'arming-secret-123';
const LOGIN = 'login-password-456';
let clock = new Date('2026-11-10T10:00:00Z');

function setup(over: { writesOn?: boolean; armHash?: string | undefined; executors?: Map<string, Executor> } = {}) {
  const db = openDb(':memory:');
  const repo = db.approvals;
  const executors = over.executors ?? new Map<string, Executor>();
  const approvals = createApprovals({
    repo,
    now: () => clock,
    writesOn: () => over.writesOn ?? true,
    armHash: () => ('armHash' in over ? over.armHash : hashPassword(SECRET)),
    loginHash: () => hashPassword(LOGIN),
    executors,
  });
  return { db, repo, approvals, executors };
}

const arm = (a: ReturnType<typeof setup>['approvals'], over: Record<string, unknown> = {}) =>
  a.arm({ channel: 'email', mode: 'ask', dailyCapCount: 2, dailyCapCents: 500, ...over }, SECRET, 'operator', 'k1');
const propose = (a: ReturnType<typeof setup>['approvals'], over: Record<string, unknown> = {}) =>
  a.propose({ channel: 'email', kind: 'send-email', title: 'Hello', content: 'Hi there', target: 'a@example.com', costCents: 0, proposedBy: 'agent', ...over });

beforeEach(() => {
  clock = new Date('2026-11-10T10:00:00Z');
  resetThrottle();
});

describe('nothing is possible until a channel is armed', () => {
  test('propose on an unarmed channel is refused and files nothing', () => {
    const { approvals, repo } = setup();
    const r = propose(approvals);
    expect(r).toMatchObject({ ok: false, status: 403, code: 'no_grant' });
    expect(repo.count()).toBe(0);
  });

  test('a fresh database has no grants and the kill switch off', () => {
    const { approvals } = setup();
    const s = approvals.state();
    expect(s.grants).toEqual([]);
    expect(s.killed).toBe(false);
  });

  test('disarming a channel stops new proposals again', () => {
    const { approvals } = setup();
    arm(approvals);
    expect(propose(approvals).ok).toBe(true);
    expect(approvals.disarm('email', 'operator')).toMatchObject({ ok: true, disarmed: true });
    expect(propose(approvals)).toMatchObject({ ok: false, code: 'no_grant' });
  });

  test('a bad proposal is a 400 with the field named', () => {
    const { approvals } = setup();
    arm(approvals);
    const r = propose(approvals, { content: '' });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'invalid' });
    expect((r as { error: string }).error).toContain('content');
  });
});

describe('arming needs the arming secret, not the login password', () => {
  test('no arming secret configured: refused with the setup step', () => {
    const { approvals } = setup({ armHash: undefined });
    expect(arm(approvals)).toMatchObject({ ok: false, status: 503, code: 'arming_not_configured' });
  });

  test('wrong secret: 401, nothing armed, the refusal is logged', () => {
    const { approvals, repo } = setup();
    const r = approvals.arm({ channel: 'email', mode: 'ask', dailyCapCount: 1, dailyCapCents: 0 }, 'wrong', 'operator', 'k2');
    expect(r).toMatchObject({ ok: false, status: 401, code: 'bad_arm_secret' });
    expect(repo.grants()).toEqual([]);
    expect(repo.logRows().some((l) => l.event === 'arm_refused')).toBe(true);
  });

  test('the login password cannot double as the arming secret', () => {
    const { approvals, repo } = setup({ armHash: hashPassword(LOGIN) });
    const r = approvals.arm({ channel: 'email', mode: 'ask', dailyCapCount: 1, dailyCapCents: 0 }, LOGIN, 'operator', 'k3');
    expect(r).toMatchObject({ ok: false, status: 403, code: 'arm_secret_is_login_password' });
    expect(repo.grants()).toEqual([]);
  });

  test('repeated wrong secrets lock the arming door, even for the right secret', () => {
    const { approvals } = setup();
    for (let i = 0; i < 12; i++) approvals.arm({ channel: 'email', mode: 'ask', dailyCapCount: 1, dailyCapCents: 0 }, 'nope', 'operator', 'k4');
    const r = approvals.arm({ channel: 'email', mode: 'ask', dailyCapCount: 1, dailyCapCents: 0 }, SECRET, 'operator', 'k4');
    expect(r).toMatchObject({ ok: false, status: 429, code: 'throttled' });
  });

  test('the right secret arms, and the grant carries its caps', () => {
    const { approvals } = setup();
    const r = arm(approvals, { dailyCapCount: 3, dailyCapCents: 1000 });
    expect(r.ok && r.grant).toMatchObject({ channel: 'email', armed: true, mode: 'ask', dailyCapCount: 3, dailyCapCents: 1000 });
  });

  test('a cap of zero actions is not accepted', () => {
    const { approvals } = setup();
    expect(arm(approvals, { dailyCapCount: 0 })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('the queue: propose, approve, run once', () => {
  test('ask mode: the action waits, then approve runs it exactly once', async () => {
    const run = vi.fn(async () => ({ sent: true }));
    const { approvals, executors, repo } = setup();
    executors.set('send-email', run);
    arm(approvals);
    const filed = propose(approvals);
    expect(filed.ok && filed.autoApproved).toBe(false);
    const id = filed.ok ? filed.action.id : '';
    expect(run).not.toHaveBeenCalled();
    expect(approvals.decide(id, 'approve', 'operator').ok).toBe(true);
    const done = await approvals.execute(id, 'operator');
    expect(done.ok && done.action.status).toBe('executed');
    expect(run).toHaveBeenCalledTimes(1);
    // A second run is refused and the executor is not called again.
    expect(await approvals.execute(id, 'operator')).toMatchObject({ ok: false, status: 409, code: 'not_approved' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(repo.logRows().map((l) => l.event)).toEqual(expect.arrayContaining(['armed', 'proposed', 'approved', 'executing', 'executed']));
  });

  test('two runners racing for one approved action: exactly one runs it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const run = vi.fn(async () => {
      await gate;
      return 'ok';
    });
    const { approvals, executors } = setup();
    executors.set('send-email', run);
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.decide(id, 'approve', 'operator');
    const a = approvals.execute(id, 'one');
    const b = approvals.execute(id, 'two');
    release();
    const results = await Promise.all([a, b]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  test('deciding twice is refused; a rejected action can never be approved or run', async () => {
    const { approvals, executors } = setup();
    executors.set('send-email', async () => 'x');
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    expect(approvals.decide(id, 'reject', 'operator').ok).toBe(true);
    expect(approvals.decide(id, 'approve', 'operator')).toMatchObject({ ok: false, status: 409 });
    expect(await approvals.execute(id, 'operator')).toMatchObject({ ok: false, code: 'not_approved' });
  });

  test('an unapproved action cannot be executed', async () => {
    const { approvals, executors } = setup();
    executors.set('send-email', async () => 'x');
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    expect(await approvals.execute(id, 'operator')).toMatchObject({ ok: false, code: 'not_approved' });
  });

  test('no executor registered: nothing runs and the action stays approved', async () => {
    const { approvals, repo } = setup();
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.decide(id, 'approve', 'operator');
    expect(await approvals.execute(id, 'operator')).toMatchObject({ ok: false, status: 501, code: 'no_executor' });
    expect(repo.action(id)?.status).toBe('approved');
  });

  test('writes off (GLADOS_WRITES): nothing runs even when approved', async () => {
    const run = vi.fn(async () => 'x');
    const { approvals, executors, repo } = setup({ writesOn: false });
    executors.set('send-email', run);
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.decide(id, 'approve', 'operator');
    expect(await approvals.execute(id, 'operator')).toMatchObject({ ok: false, code: 'writes_off' });
    expect(run).not.toHaveBeenCalled();
    expect(repo.action(id)?.status).toBe('approved');
  });

  test('an executor that throws marks the action failed with its message, and still counts toward the cap', async () => {
    const { approvals, executors, repo } = setup();
    executors.set('send-email', async () => {
      throw new Error('smtp down');
    });
    arm(approvals, { dailyCapCount: 1 });
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.decide(id, 'approve', 'operator');
    const r = await approvals.execute(id, 'operator');
    expect(r.ok && r.action).toMatchObject({ status: 'failed', result: 'smtp down' });
    expect(repo.usedSince('email', dayStart(clock)).count).toBe(1);
    expect(propose(approvals)).toMatchObject({ ok: false, code: 'cap_count' });
  });

  test('auto mode approves at once and reports it', () => {
    const { approvals } = setup();
    arm(approvals, { mode: 'auto' });
    const r = propose(approvals);
    expect(r.ok && r.autoApproved).toBe(true);
    expect(r.ok && r.action).toMatchObject({ status: 'approved', decidedBy: 'auto' });
  });
});

describe('daily caps', () => {
  test('the count cap refuses the next proposal, and resets the next UTC day', () => {
    const { approvals } = setup();
    arm(approvals, { mode: 'auto', dailyCapCount: 2 });
    expect(propose(approvals).ok).toBe(true);
    expect(propose(approvals).ok).toBe(true);
    expect(propose(approvals)).toMatchObject({ ok: false, status: 429, code: 'cap_count' });
    clock = new Date('2026-11-11T00:00:01Z');
    expect(propose(approvals).ok).toBe(true);
  });

  test('the spend cap is a hard ceiling, zero means free actions only', () => {
    const { approvals } = setup();
    arm(approvals, { mode: 'auto', dailyCapCount: 10, dailyCapCents: 500 });
    expect(propose(approvals, { costCents: 300 }).ok).toBe(true);
    expect(propose(approvals, { costCents: 300 })).toMatchObject({ ok: false, code: 'cap_cents' });
    expect(propose(approvals, { costCents: 200 }).ok).toBe(true);
    const free = setup();
    arm(free.approvals, { dailyCapCents: 0 });
    expect(propose(free.approvals, { costCents: 1 })).toMatchObject({ ok: false, code: 'cap_cents' });
    expect(propose(free.approvals, { costCents: 0 }).ok).toBe(true);
  });

  test('approval re-checks the cap: queued actions cannot exceed it together', () => {
    const { approvals } = setup();
    arm(approvals, { dailyCapCount: 1 });
    const a = (propose(approvals) as { action: { id: string } }).action.id;
    const b = (propose(approvals) as { action: { id: string } }).action.id;
    expect(approvals.decide(a, 'approve', 'operator').ok).toBe(true);
    expect(approvals.decide(b, 'approve', 'operator')).toMatchObject({ ok: false, status: 429, code: 'cap_count' });
  });

  test('caps are per channel', () => {
    const { approvals } = setup();
    arm(approvals, { mode: 'auto', dailyCapCount: 1 });
    approvals.arm({ channel: 'sms', mode: 'auto', dailyCapCount: 1, dailyCapCents: 500 }, SECRET, 'operator', 'k1');
    expect(propose(approvals).ok).toBe(true);
    expect(propose(approvals, { channel: 'sms', kind: 'send-sms' }).ok).toBe(true);
  });
});

describe('the kill switch', () => {
  test('disarms every grant, expires every open action, and blocks everything', async () => {
    const run = vi.fn(async () => 'x');
    const { approvals, executors, repo } = setup();
    executors.set('send-email', run);
    arm(approvals);
    approvals.arm({ channel: 'sms', mode: 'ask', dailyCapCount: 1, dailyCapCents: 0 }, SECRET, 'operator', 'k1');
    const queued = (propose(approvals) as { action: { id: string } }).action.id;
    const approved = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.decide(approved, 'approve', 'operator');
    expect(approvals.kill('operator')).toMatchObject({ ok: true, disarmed: 2, expired: 2 });
    expect(repo.action(queued)?.status).toBe('expired');
    expect(repo.action(approved)?.status).toBe('expired');
    expect(propose(approvals)).toMatchObject({ ok: false, status: 423, code: 'killed' });
    expect(await approvals.execute(approved, 'operator')).toMatchObject({ ok: false, code: 'not_approved' });
    expect(arm(approvals)).toMatchObject({ ok: false, status: 423, code: 'killed' });
    expect(run).not.toHaveBeenCalled();
  });

  test('an action approved a moment before the kill cannot be run after it', async () => {
    const run = vi.fn(async () => 'x');
    const { approvals, executors, repo } = setup();
    executors.set('send-email', run);
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.decide(id, 'approve', 'operator');
    repo.setSwitch(true, clock.toISOString(), 'test'); // switch flipped, action row untouched
    expect(await approvals.execute(id, 'operator')).toMatchObject({ ok: false, status: 423, code: 'killed' });
    expect(run).not.toHaveBeenCalled();
  });

  test('lifting it needs the arming secret and re-arms nothing', () => {
    const { approvals } = setup();
    arm(approvals);
    approvals.kill('operator');
    expect(approvals.reset('wrong', 'operator', 'k5')).toMatchObject({ ok: false, code: 'bad_arm_secret' });
    expect(approvals.state().killed).toBe(true);
    expect(approvals.reset(SECRET, 'operator', 'k5').ok).toBe(true);
    expect(approvals.state().killed).toBe(false);
    expect(approvals.state().grants.every((g) => !g.armed)).toBe(true);
    expect(propose(approvals)).toMatchObject({ ok: false, code: 'no_grant' });
  });

  test('kill is idempotent and needs no secret', () => {
    const { approvals } = setup({ armHash: undefined });
    expect(approvals.kill('operator').ok).toBe(true);
    expect(approvals.kill('operator').ok).toBe(true);
    expect(approvals.state().killed).toBe(true);
  });
});

describe('the log', () => {
  test('every step is recorded, newest first, with who did it', () => {
    const { approvals, repo } = setup();
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.decide(id, 'reject', 'josh');
    const rows = repo.logRows();
    expect(rows.map((r) => r.event)).toEqual(['rejected', 'proposed', 'armed']);
    expect(rows[0]).toMatchObject({ actor: 'josh', actionId: id, channel: 'email' });
  });
});

describe('rights are re-checked at every step, not only at proposal', () => {
  test('disarming after a proposal stops it being approved', () => {
    const { approvals, repo } = setup();
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.disarm('email', 'operator');
    expect(approvals.decide(id, 'approve', 'operator')).toMatchObject({ ok: false, status: 403, code: 'no_grant' });
    expect(repo.action(id)?.status).toBe('proposed');
  });

  test('disarming after approval stops it running', async () => {
    const run = vi.fn(async () => 'x');
    const { approvals, executors, repo } = setup();
    executors.set('send-email', run);
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.decide(id, 'approve', 'operator');
    approvals.disarm('email', 'operator');
    expect(await approvals.execute(id, 'operator')).toMatchObject({ ok: false, status: 403, code: 'no_grant' });
    expect(run).not.toHaveBeenCalled();
    expect(repo.action(id)?.status).toBe('approved');
  });

  test('the kill flag alone blocks approval, even before anything is expired', () => {
    const { approvals, repo } = setup();
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    repo.setSwitch(true, clock.toISOString(), 'test');
    expect(approvals.decide(id, 'approve', 'operator')).toMatchObject({ ok: false, status: 423, code: 'killed' });
    expect(repo.action(id)?.status).toBe('proposed');
  });

  test('an approved action cannot be rejected afterwards', () => {
    const { approvals, repo } = setup();
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    approvals.decide(id, 'approve', 'operator');
    expect(approvals.decide(id, 'reject', 'operator')).toMatchObject({ ok: false, status: 409, code: 'not_proposed' });
    expect(repo.action(id)?.status).toBe('approved');
  });
});

describe('storage: status changes are compare-and-set', () => {
  test('a transition from the wrong state changes nothing and says so', () => {
    const { approvals, repo } = setup();
    arm(approvals);
    const id = (propose(approvals) as { action: { id: string } }).action.id;
    const at = clock.toISOString();
    expect(repo.transition(id, 'approved', 'executed', { at })).toBe(false);
    expect(repo.action(id)?.status).toBe('proposed');
    expect(repo.transition(id, 'proposed', 'approved', { at, by: 'operator' })).toBe(true);
    expect(repo.transition(id, 'proposed', 'rejected', { at, by: 'operator' })).toBe(false);
    expect(repo.action(id)).toMatchObject({ status: 'approved', decidedBy: 'operator' });
  });
});
