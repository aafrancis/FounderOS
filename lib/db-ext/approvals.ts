/**
 * Approval queue storage (SH-0271, founder decision 2026-11-08): one queue for
 * every send, spend or publish. An action is proposed with its full content,
 * cost and target, the operator approves it, it runs once, and every step is
 * written to an append-only log. Grants are per channel with caps and are OFF
 * until armed. One kill switch stops all of it.
 *
 * This file is storage only. The rules live in lib/approvals.ts.
 */
import type Database from 'better-sqlite3';

export type GrantMode = 'ask' | 'auto';
export type ActionStatus = 'proposed' | 'approved' | 'rejected' | 'executing' | 'executed' | 'failed' | 'expired';

export type Grant = {
  channel: string;
  mode: GrantMode;
  dailyCapCount: number;
  dailyCapCents: number;
  armed: boolean;
  armedAt: string | null;
  updatedAt: string;
};

export type ApprovalAction = {
  id: string;
  channel: string;
  kind: string;
  title: string;
  content: string;
  target: string;
  costCents: number;
  status: ActionStatus;
  proposedBy: string;
  proposedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  executedAt: string | null;
  result: string | null;
};

export type TokenRow = { name: string; channels: string[]; createdAt: string; revokedAt: string | null };
export type SwitchState = { killed: boolean; changedAt: string | null; changedBy: string | null };
export type LogRow = { id: number; at: string; event: string; channel: string | null; actionId: string | null; actor: string; detail: string };

type RawGrant = {
  channel: string; mode: string; daily_cap_count: number; daily_cap_cents: number;
  armed: number; armed_at: string | null; updated_at: string;
};
type RawAction = {
  id: string; channel: string; kind: string; title: string; content: string; target: string; cost_cents: number;
  status: string; proposed_by: string; proposed_at: string; decided_at: string | null; decided_by: string | null;
  executed_at: string | null; result: string | null;
};

type RawToken = { name: string; token_hash: string; channels: string; created_at: string; revoked_at: string | null };
function parseChannels(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}
const toToken = (r: RawToken): TokenRow => ({ name: r.name, channels: parseChannels(r.channels), createdAt: r.created_at, revokedAt: r.revoked_at });
const toGrant = (r: RawGrant): Grant => ({
  channel: r.channel, mode: r.mode as GrantMode, dailyCapCount: r.daily_cap_count, dailyCapCents: r.daily_cap_cents,
  armed: r.armed === 1, armedAt: r.armed_at, updatedAt: r.updated_at,
});
const toAction = (r: RawAction): ApprovalAction => ({
  id: r.id, channel: r.channel, kind: r.kind, title: r.title, content: r.content, target: r.target, costCents: r.cost_cents,
  status: r.status as ActionStatus, proposedBy: r.proposed_by, proposedAt: r.proposed_at, decidedAt: r.decided_at,
  decidedBy: r.decided_by, executedAt: r.executed_at, result: r.result,
});

export const APPROVALS_DDL = `
CREATE TABLE IF NOT EXISTS approval_grants (
  channel TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('ask','auto')),
  daily_cap_count INTEGER NOT NULL,
  daily_cap_cents INTEGER NOT NULL DEFAULT 0,
  armed INTEGER NOT NULL DEFAULT 0,
  armed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_actions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  target TEXT NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  executed_at TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS approval_actions_by_status ON approval_actions (status, proposed_at);
CREATE INDEX IF NOT EXISTS approval_actions_by_channel ON approval_actions (channel, decided_at);
CREATE TABLE IF NOT EXISTS approval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  channel TEXT,
  action_id TEXT,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS approval_tokens (
  name TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  channels TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS approval_switch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  killed INTEGER NOT NULL DEFAULT 0,
  changed_at TEXT,
  changed_by TEXT
);
`;

export function approvalsRepo(db: InstanceType<typeof Database>) {
  return {
    grant(channel: string): Grant | null {
      const r = db.prepare('SELECT * FROM approval_grants WHERE channel = ?').get(channel) as RawGrant | undefined;
      return r ? toGrant(r) : null;
    },
    grants(): Grant[] {
      return (db.prepare('SELECT * FROM approval_grants ORDER BY channel').all() as RawGrant[]).map(toGrant);
    },
    upsertGrant(g: { channel: string; mode: GrantMode; dailyCapCount: number; dailyCapCents: number; armed: boolean; now: string }): Grant {
      db.prepare(
        `INSERT INTO approval_grants (channel, mode, daily_cap_count, daily_cap_cents, armed, armed_at, updated_at)
         VALUES (@channel, @mode, @count, @cents, @armed, @armedAt, @now)
         ON CONFLICT(channel) DO UPDATE SET mode = @mode, daily_cap_count = @count, daily_cap_cents = @cents,
           armed = @armed, armed_at = @armedAt, updated_at = @now`,
      ).run({ channel: g.channel, mode: g.mode, count: g.dailyCapCount, cents: g.dailyCapCents, armed: g.armed ? 1 : 0, armedAt: g.armed ? g.now : null, now: g.now });
      return this.grant(g.channel)!;
    },
    disarm(channel: string, now: string): boolean {
      return db.prepare('UPDATE approval_grants SET armed = 0, armed_at = NULL, updated_at = ? WHERE channel = ? AND armed = 1').run(now, channel).changes > 0;
    },
    disarmAll(now: string): number {
      return db.prepare('UPDATE approval_grants SET armed = 0, armed_at = NULL, updated_at = ? WHERE armed = 1').run(now).changes;
    },

    insertToken(t: { name: string; hash: string; channels: string[]; at: string }): void {
      db.prepare('INSERT INTO approval_tokens (name, token_hash, channels, created_at) VALUES (?, ?, ?, ?)').run(t.name, t.hash, JSON.stringify(t.channels), t.at);
    },
    tokenByName(name: string): TokenRow | null {
      const r = db.prepare('SELECT * FROM approval_tokens WHERE name = ?').get(name) as RawToken | undefined;
      return r ? toToken(r) : null;
    },
    tokenByHash(hash: string): TokenRow | null {
      const r = db.prepare('SELECT * FROM approval_tokens WHERE token_hash = ?').get(hash) as RawToken | undefined;
      return r ? toToken(r) : null;
    },
    tokens(): TokenRow[] {
      return (db.prepare('SELECT * FROM approval_tokens ORDER BY created_at, name').all() as RawToken[]).map(toToken);
    },
    revokeToken(name: string, now: string): boolean {
      return db.prepare('UPDATE approval_tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL').run(now, name).changes > 0;
    },

    insertAction(a: Omit<ApprovalAction, 'decidedAt' | 'decidedBy' | 'executedAt' | 'result'>): ApprovalAction {
      db.prepare(
        `INSERT INTO approval_actions (id, channel, kind, title, content, target, cost_cents, status, proposed_by, proposed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.id, a.channel, a.kind, a.title, a.content, a.target, a.costCents, a.status, a.proposedBy, a.proposedAt);
      return this.action(a.id)!;
    },
    action(id: string): ApprovalAction | null {
      const r = db.prepare('SELECT * FROM approval_actions WHERE id = ?').get(id) as RawAction | undefined;
      return r ? toAction(r) : null;
    },
    actions(status?: ActionStatus, limit = 200): ApprovalAction[] {
      const rows = status
        ? db.prepare('SELECT * FROM approval_actions WHERE status = ? ORDER BY proposed_at DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM approval_actions ORDER BY proposed_at DESC LIMIT ?').all(limit);
      return (rows as RawAction[]).map(toAction);
    },
    /**
     * Compare-and-set a status. Returns true only if the row was in `from`, so
     * two racing approvals (or two executors) cannot both win: this is what
     * makes "it runs once" hold.
     */
    transition(id: string, from: ActionStatus, to: ActionStatus, f: { at: string; by?: string; result?: string } ): boolean {
      const decided = to === 'approved' || to === 'rejected';
      const executed = to === 'executed' || to === 'failed';
      return (
        db
          .prepare(
            `UPDATE approval_actions SET status = @to,
               decided_at = CASE WHEN @decided = 1 THEN @at ELSE decided_at END,
               decided_by = CASE WHEN @decided = 1 THEN @by ELSE decided_by END,
               executed_at = CASE WHEN @executed = 1 THEN @at ELSE executed_at END,
               result = COALESCE(@result, result)
             WHERE id = @id AND status = @from`,
          )
          .run({ id, from, to, at: f.at, by: f.by ?? null, result: f.result ?? null, decided: decided ? 1 : 0, executed: executed ? 1 : 0 }).changes === 1
      );
    },
    /** Every not-yet-run action becomes expired (the kill switch). */
    expireOpen(now: string, by: string): number {
      return db
        .prepare(
          `UPDATE approval_actions SET status = 'expired', decided_at = ?, decided_by = ?, result = 'stopped by the kill switch'
           WHERE status IN ('proposed','approved')`,
        )
        .run(now, by).changes;
    },
    /**
     * What a channel has used since `sinceIso`: actions the operator (or an auto
     * grant) approved, whether or not they finished. A failed run still counts,
     * so a retry loop cannot dodge the cap.
     */
    usedSince(channel: string, sinceIso: string): { count: number; cents: number } {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(cost_cents), 0) AS c FROM approval_actions
           WHERE channel = ? AND status IN ('approved','executing','executed','failed') AND decided_at >= ?`,
        )
        .get(channel, sinceIso) as { n: number; c: number };
      return { count: r.n, cents: r.c };
    },

    switchState(): SwitchState {
      const r = db.prepare('SELECT killed, changed_at, changed_by FROM approval_switch WHERE id = 1').get() as
        | { killed: number; changed_at: string | null; changed_by: string | null }
        | undefined;
      return { killed: r?.killed === 1, changedAt: r?.changed_at ?? null, changedBy: r?.changed_by ?? null };
    },
    setSwitch(killed: boolean, now: string, by: string): void {
      db.prepare(
        `INSERT INTO approval_switch (id, killed, changed_at, changed_by) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET killed = excluded.killed, changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
      ).run(killed ? 1 : 0, now, by);
    },

    log(e: { at: string; event: string; actor: string; channel?: string | null; actionId?: string | null; detail?: string }): void {
      db.prepare('INSERT INTO approval_log (at, event, channel, action_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
        e.at, e.event, e.channel ?? null, e.actionId ?? null, e.actor, e.detail ?? '',
      );
    },
    logRows(limit = 200): LogRow[] {
      return (db.prepare('SELECT * FROM approval_log ORDER BY id DESC LIMIT ?').all(limit) as {
        id: number; at: string; event: string; channel: string | null; action_id: string | null; actor: string; detail: string;
      }[]).map((r) => ({ id: r.id, at: r.at, event: r.event, channel: r.channel, actionId: r.action_id, actor: r.actor, detail: r.detail }));
    },
    count(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM approval_actions').get() as { n: number }).n;
    },
  };
}
