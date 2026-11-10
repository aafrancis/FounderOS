/**
 * Approval queue + per-channel grants (thread SH-0271, founder decision 2026-11-08).
 *
 * Anything that sends, spends or publishes is PROPOSED here with its full content,
 * cost and target, approved once by the operator, run once, and logged. Nothing is
 * armed by default:
 *   - the kill switch starts ENGAGED (releasing it is a deliberate, logged act);
 *   - a grant starts disarmed, and editing a grant disarms it again;
 *   - arming needs a second secret (GLADOS_ARMING_HASH), separate from the login password.
 * The audit log is append-only: nothing here updates or deletes an audit row.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type GrantKind = 'send' | 'spend' | 'publish';
export type GrantMode = 'ask' | 'auto';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired';

export type Grant = {
  channel: string;
  kind: GrantKind;
  mode: GrantMode;
  /** Max proposals per UTC day; null = no count cap (a cap of 0 blocks the channel). */
  dailyCapCount: number | null;
  /** Max total cost per UTC day in minor units (pence/cents); null = no money cap. */
  dailyCapCents: number | null;
  armedAt: string | null;
  updatedAt: string;
};

export type Approval = {
  id: string;
  channel: string;
  kind: GrantKind;
  summary: string;
  payload: unknown;
  target: string;
  costCents: number;
  status: ApprovalStatus;
  proposedBy: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  executedAt: string | null;
  result: string | null;
};

export type ProposeInput = {
  channel: string;
  summary: string;
  payload: unknown;
  target: string;
  costCents?: number;
  proposedBy: string;
};

export type Refusal = { ok: false; reason: string };
export type Ok<T> = { ok: true; value: T };

export const APPROVALS_DDL = `
CREATE TABLE IF NOT EXISTS grants (
  channel TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ask',
  daily_cap_count INTEGER,
  daily_cap_cents INTEGER,
  armed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  target TEXT NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  executed_at TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS approvals_by_status ON approvals (status, created_at);
CREATE INDEX IF NOT EXISTS approvals_by_channel_day ON approvals (channel, created_at);
CREATE TABLE IF NOT EXISTS approval_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  approval_id TEXT,
  channel TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS grant_switch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  killed INTEGER NOT NULL DEFAULT 1,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL
);
INSERT OR IGNORE INTO grant_switch (id, killed, changed_at, changed_by) VALUES (1, 1, '1970-01-01T00:00:00.000Z', 'default');
`;

type GrantRow = {
  channel: string; kind: string; mode: string; daily_cap_count: number | null; daily_cap_cents: number | null;
  armed_at: string | null; updated_at: string;
};
type ApprovalRow = {
  id: string; channel: string; kind: string; summary: string; payload: string; target: string; cost_cents: number;
  status: string; proposed_by: string; created_at: string; decided_at: string | null; decided_by: string | null;
  executed_at: string | null; result: string | null;
};

const toGrant = (r: GrantRow): Grant => ({
  channel: r.channel, kind: r.kind as GrantKind, mode: r.mode as GrantMode, dailyCapCount: r.daily_cap_count,
  dailyCapCents: r.daily_cap_cents, armedAt: r.armed_at, updatedAt: r.updated_at,
});
const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id, channel: r.channel, kind: r.kind as GrantKind, summary: r.summary, payload: JSON.parse(r.payload) as unknown,
  target: r.target, costCents: r.cost_cents, status: r.status as ApprovalStatus, proposedBy: r.proposed_by,
  createdAt: r.created_at, decidedAt: r.decided_at, decidedBy: r.decided_by, executedAt: r.executed_at, result: r.result,
});

const CHANNEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const dayOf = (iso: string): string => iso.slice(0, 10);
/** Pending proposals older than this are expired rather than approved blind. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const refuse = (reason: string): Refusal => ({ ok: false, reason });

export function approvalsRepo(db: InstanceType<typeof Database>, now: () => Date = () => new Date()) {
  const stamp = () => now().toISOString();
  const audit = (actor: string, event: string, detail = '', approvalId: string | null = null, channel: string | null = null) =>
    db
      .prepare('INSERT INTO approval_audit (at, actor, event, approval_id, channel, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(stamp(), actor, event, approvalId, channel, detail);

  const getGrant = (channel: string): Grant | null => {
    const r = db.prepare('SELECT * FROM grants WHERE channel = ?').get(channel) as GrantRow | undefined;
    return r ? toGrant(r) : null;
  };
  const getApproval = (id: string): Approval | null => {
    const r = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
    return r ? toApproval(r) : null;
  };
  const killed = (): boolean => (db.prepare('SELECT killed FROM grant_switch WHERE id = 1').get() as { killed: number }).killed === 1;

  /** Count and money already committed on this channel today (pending, approved and executed all count). */
  const usedToday = (channel: string, day: string, excludeId?: string) =>
    db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(cost_cents), 0) AS cents FROM approvals
         WHERE channel = ? AND substr(created_at, 1, 10) = ? AND status IN ('pending','approved','executed') AND id != ?`,
      )
      .get(channel, day, excludeId ?? '') as { n: number; cents: number };

  /** Shared checks for propose and approve: kill switch, grant exists, armed, within today's caps. */
  const guard = (channel: string, costCents: number, day: string, excludeId?: string): Refusal | null => {
    if (killed()) return refuse('The kill switch is engaged: nothing may be proposed, approved or run.');
    const g = getGrant(channel);
    if (!g) return refuse(`No grant for channel "${channel}".`);
    if (!g.armedAt) return refuse(`The grant for "${channel}" is not armed.`);
    const used = usedToday(channel, day, excludeId);
    if (g.dailyCapCount !== null && used.n + 1 > g.dailyCapCount) return refuse(`Daily count cap reached for "${channel}" (${g.dailyCapCount}).`);
    if (g.dailyCapCents !== null && used.cents + costCents > g.dailyCapCents) {
      return refuse(`Daily spend cap would be exceeded for "${channel}" (${g.dailyCapCents}).`);
    }
    return null;
  };

  return {
    killed,
    grant: getGrant,
    approval: getApproval,
    grants(): Grant[] {
      return (db.prepare('SELECT * FROM grants ORDER BY channel').all() as GrantRow[]).map(toGrant);
    },
    switchState() {
      const r = db.prepare('SELECT killed, changed_at, changed_by FROM grant_switch WHERE id = 1').get() as {
        killed: number; changed_at: string; changed_by: string;
      };
      return { killed: r.killed === 1, changedAt: r.changed_at, changedBy: r.changed_by };
    },
    list(status?: ApprovalStatus, limit = 100): Approval[] {
      const rows = status
        ? db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(limit);
      return (rows as ApprovalRow[]).map(toApproval);
    },
    auditLog(limit = 200) {
      return db.prepare('SELECT * FROM approval_audit ORDER BY seq DESC LIMIT ?').all(limit) as {
        seq: number; at: string; actor: string; event: string; approval_id: string | null; channel: string | null; detail: string;
      }[];
    },

    /** Create or edit a grant. Always disarms: a changed cap must be re-armed on purpose. */
    setGrant(input: { channel: string; kind: GrantKind; mode: GrantMode; dailyCapCount?: number | null; dailyCapCents?: number | null }, actor: string): Ok<Grant> | Refusal {
      if (!CHANNEL.test(input.channel)) return refuse('Channel must be lowercase letters, digits, dot, dash or underscore.');
      if (!['send', 'spend', 'publish'].includes(input.kind)) return refuse('Kind must be send, spend or publish.');
      if (!['ask', 'auto'].includes(input.mode)) return refuse('Mode must be ask or auto.');
      const cnt = input.dailyCapCount ?? null;
      const cents = input.dailyCapCents ?? null;
      if ((cnt !== null && (!Number.isInteger(cnt) || cnt < 0)) || (cents !== null && (!Number.isInteger(cents) || cents < 0))) {
        return refuse('Caps must be whole numbers of zero or more.');
      }
      if (input.kind === 'spend' && cents === null) return refuse('A spend grant needs a daily money cap.');
      db.prepare(
        `INSERT INTO grants (channel, kind, mode, daily_cap_count, daily_cap_cents, armed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(channel) DO UPDATE SET kind = excluded.kind, mode = excluded.mode,
           daily_cap_count = excluded.daily_cap_count, daily_cap_cents = excluded.daily_cap_cents,
           armed_at = NULL, updated_at = excluded.updated_at`,
      ).run(input.channel, input.kind, input.mode, cnt, cents, stamp());
      audit(actor, 'grant.set', `kind=${input.kind} mode=${input.mode} count=${cnt} cents=${cents} (disarmed)`, null, input.channel);
      return { ok: true, value: getGrant(input.channel)! };
    },
    /** Caller has already verified the arming secret; this only records the act. */
    armGrant(channel: string, actor: string): Ok<Grant> | Refusal {
      if (!getGrant(channel)) return refuse(`No grant for channel "${channel}".`);
      db.prepare('UPDATE grants SET armed_at = ? WHERE channel = ?').run(stamp(), channel);
      audit(actor, 'grant.arm', '', null, channel);
      return { ok: true, value: getGrant(channel)! };
    },
    disarmGrant(channel: string, actor: string): Ok<Grant> | Refusal {
      if (!getGrant(channel)) return refuse(`No grant for channel "${channel}".`);
      db.prepare('UPDATE grants SET armed_at = NULL WHERE channel = ?').run(channel);
      audit(actor, 'grant.disarm', '', null, channel);
      return { ok: true, value: getGrant(channel)! };
    },
    /** Engaging needs no secret (it must always be one click). Releasing is gated by the caller. */
    setKilled(killedNow: boolean, actor: string): void {
      db.prepare('UPDATE grant_switch SET killed = ?, changed_at = ?, changed_by = ? WHERE id = 1').run(killedNow ? 1 : 0, stamp(), actor);
      audit(actor, killedNow ? 'switch.kill' : 'switch.release');
    },

    propose(input: ProposeInput): Ok<Approval> | Refusal {
      const cost = input.costCents ?? 0;
      if (!Number.isInteger(cost) || cost < 0) return refuse('Cost must be a whole number of zero or more.');
      if (!input.summary.trim() || !input.target.trim()) return refuse('A proposal needs a summary and a target.');
      const at = stamp();
      const blocked = guard(input.channel, cost, dayOf(at));
      if (blocked) {
        audit(input.proposedBy, 'propose.refused', blocked.reason, null, input.channel);
        return blocked;
      }
      const g = getGrant(input.channel)!;
      const id = randomUUID();
      const auto = g.mode === 'auto';
      db.prepare(
        `INSERT INTO approvals (id, channel, kind, summary, payload, target, cost_cents, status, proposed_by, created_at, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.channel, g.kind, input.summary, JSON.stringify(input.payload ?? null), input.target, cost,
        auto ? 'approved' : 'pending', input.proposedBy, at, auto ? at : null, auto ? 'auto-grant' : null,
      );
      audit(input.proposedBy, 'propose', `${g.kind} -> ${input.target} cost=${cost}${auto ? ' (auto-approved by grant)' : ''}`, id, input.channel);
      return { ok: true, value: getApproval(id)! };
    },
    approve(id: string, actor: string): Ok<Approval> | Refusal {
      const a = getApproval(id);
      if (!a) return refuse('No such proposal.');
      if (a.status !== 'pending') return refuse(`Proposal is ${a.status}, not pending.`);
      if (now().getTime() - Date.parse(a.createdAt) > PENDING_TTL_MS) {
        db.prepare(`UPDATE approvals SET status = 'expired', decided_at = ?, decided_by = 'ttl' WHERE id = ? AND status = 'pending'`).run(stamp(), id);
        audit('ttl', 'expire', '', id, a.channel);
        return refuse('Proposal expired; ask for a fresh one.');
      }
      // Re-check the switch, arming and caps at decision time (excluding this proposal's own count).
      const blocked = guard(a.channel, a.costCents, dayOf(a.createdAt), id);
      if (blocked) {
        audit(actor, 'approve.refused', blocked.reason, id, a.channel);
        return blocked;
      }
      const r = db
        .prepare(`UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`)
        .run(stamp(), actor, id);
      if (r.changes !== 1) return refuse('Proposal changed under you; reload.');
      audit(actor, 'approve', '', id, a.channel);
      return { ok: true, value: getApproval(id)! };
    },
    reject(id: string, actor: string): Ok<Approval> | Refusal {
      const r = db
        .prepare(`UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`)
        .run(stamp(), actor, id);
      if (r.changes !== 1) return refuse('Only a pending proposal can be rejected.');
      const a = getApproval(id)!;
      audit(actor, 'reject', '', id, a.channel);
      return { ok: true, value: a };
    },
    /**
     * Claim an approved proposal for running: approved -> executed in ONE atomic update, so it can never
     * run twice. The caller runs the action after a successful claim and reports with finish().
     */
    claim(id: string, actor: string): Ok<Approval> | Refusal {
      const a = getApproval(id);
      if (!a) return refuse('No such proposal.');
      if (killed()) return refuse('The kill switch is engaged: nothing may run.');
      const g = getGrant(a.channel);
      if (!g || !g.armedAt) return refuse(`The grant for "${a.channel}" is not armed.`);
      const r = db
        .prepare(`UPDATE approvals SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'approved'`)
        .run(stamp(), id);
      if (r.changes !== 1) return refuse(`Proposal is ${a.status}, not approved (it runs once).`);
      audit(actor, 'execute.claim', '', id, a.channel);
      return { ok: true, value: getApproval(id)! };
    },
    /** Record the outcome. A failed run stays 'failed' and is never retried automatically. */
    finish(id: string, actor: string, outcome: { ok: boolean; result: string }): void {
      db.prepare(`UPDATE approvals SET status = ?, result = ? WHERE id = ? AND status = 'executed'`).run(
        outcome.ok ? 'executed' : 'failed', outcome.result.slice(0, 2000), id,
      );
      audit(actor, outcome.ok ? 'execute.ok' : 'execute.failed', outcome.result.slice(0, 500), id);
    },
  };
}
