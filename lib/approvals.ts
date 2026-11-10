/**
 * The approval queue's rules (SH-0271, founder decision 2026-11-08).
 *
 * Send, spend and publish rights are granted per channel, with a daily cap, and
 * are OFF until armed. Nothing in here sends, spends or publishes by itself: an
 * action only runs through an executor that some other module registered for its
 * kind, and this PR registers none. So merging this changes no behaviour.
 *
 *   propose  an agent or Wild Horse loop files an action with its full content,
 *            cost and target. Refused outright unless the channel is armed.
 *   decide   the operator approves or rejects. Approval re-checks the kill
 *            switch, the grant and the cap, then flips proposed -> approved once.
 *   execute  approved -> executing -> executed|failed, compare-and-set, so an
 *            action runs at most once. Needs GLADOS_WRITES=1 as well.
 *   arm      turns a channel on. Needs the arming secret (GLADOS_ARM_HASH), which
 *            is a different secret from the login password: a stolen session
 *            cookie cannot grant rights. Disarming needs nothing (safe direction).
 *   kill     one switch: disarms every grant and expires every open action.
 *            Lifting it needs the arming secret and does NOT re-arm anything.
 *
 * Every step lands in the append-only approval_log. Refusals are returned with a
 * code and a plain-English reason, never swallowed.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { clearFailures, readAuthState, recordFailure, throttled, verifyPassword } from '@/lib/auth';
import { resolveCred } from '@/lib/creds';
import { generateToken, hashToken, TOKEN_PREFIX } from '@/lib/approval-tokens';
import { writesEnabled } from '@/lib/gates';
import type { ActionStatus, ApprovalAction, Grant, GrantMode, LogRow, SwitchState, TokenRow, approvalsRepo } from '@/lib/db-ext/approvals';

export const ARM_HASH_KEY = 'GLADOS_ARM_HASH';

export type Refusal = { ok: false; status: number; code: string; error: string };
export type Ok<T> = { ok: true } & T;
export type Result<T> = Ok<T> | Refusal;

export type Executor = (action: ApprovalAction) => Promise<unknown>;

const executors = new Map<string, Executor>();
/** Register what actually performs an approved action of this kind. One per kind. */
export function registerExecutor(kind: string, fn: Executor): void {
  if (executors.has(kind)) throw new Error(`an executor for "${kind}" is already registered`);
  executors.set(kind, fn);
}
/** Tests only. */
export function clearExecutors(): void {
  executors.clear();
}

export type Deps = {
  repo: ReturnType<typeof approvalsRepo>;
  now?: () => Date;
  writesOn?: () => boolean;
  armHash?: () => string | undefined;
  loginHash?: () => string | undefined;
  newId?: () => string;
  newToken?: () => string;
  executors?: Map<string, Executor>;
};

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'lowercase letters, digits, dot, dash, underscore');
export const ProposalSchema = z.object({
  channel: slug,
  kind: slug,
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(20_000),
  target: z.string().trim().min(1).max(500),
  costCents: z.number().int().min(0).max(100_000_00).default(0),
  proposedBy: z.string().trim().min(1).max(100),
});
export type Proposal = z.input<typeof ProposalSchema>;

export const ArmSchema = z.object({
  channel: slug,
  mode: z.enum(['ask', 'auto']),
  dailyCapCount: z.number().int().min(1).max(1000),
  dailyCapCents: z.number().int().min(0).max(1_000_000_00),
});
export type ArmInput = z.input<typeof ArmSchema>;

export const TokenIssueSchema = z.object({
  name: slug,
  channels: z.array(slug).min(1).max(20),
});

const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

/** Start of the current UTC day: caps reset there. */
export function dayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function createApprovals(deps: Deps) {
  const { repo } = deps;
  const now = () => (deps.now ? deps.now() : new Date());
  const iso = () => now().toISOString();
  const writesOn = deps.writesOn ?? writesEnabled;
  const armHash = deps.armHash ?? (() => resolveCred(ARM_HASH_KEY, [])?.trim() || undefined);
  const loginHash = deps.loginHash ?? (() => readAuthState().passwordHash);
  const newId = deps.newId ?? (() => randomUUID());
  const registry = deps.executors ?? executors;

  const killed = () => repo.switchState().killed;

  /** Caps for one more action on this channel today, or a refusal. */
  function capRefusal(grant: Grant, costCents: number): Refusal | null {
    const used = repo.usedSince(grant.channel, dayStart(now()));
    if (used.count + 1 > grant.dailyCapCount) {
      return refuse(429, 'cap_count', `The daily cap for ${grant.channel} is ${grant.dailyCapCount} action(s) and ${used.count} already used today.`);
    }
    if (used.cents + costCents > grant.dailyCapCents) {
      return refuse(429, 'cap_cents', `The daily spend cap for ${grant.channel} is ${grant.dailyCapCents} cents; ${used.cents} used, this action costs ${costCents}.`);
    }
    return null;
  }

  /** Verify the arming secret with a lockout, logging every refusal. */
  function checkArmSecret(secret: unknown, actor: string, throttleKey: string, channel: string | null): Refusal | null {
    const hash = armHash();
    if (!hash) {
      return refuse(503, 'arming_not_configured', 'No arming secret is set (GLADOS_ARM_HASH), so nothing can be armed. Run scripts/hash-arm-secret.mjs and put the result in .env.local.');
    }
    if (throttled(throttleKey)) {
      return refuse(429, 'throttled', 'Too many wrong arming secrets. Wait about a minute.');
    }
    if (typeof secret !== 'string' || !verifyPassword(secret, hash)) {
      recordFailure(throttleKey);
      repo.log({ at: iso(), event: 'arm_refused', actor, channel, detail: 'wrong arming secret' });
      return refuse(401, 'bad_arm_secret', 'The arming secret is wrong.');
    }
    const login = loginHash();
    if (login && verifyPassword(secret, login)) {
      repo.log({ at: iso(), event: 'arm_refused', actor, channel, detail: 'arming secret equals the login password' });
      return refuse(403, 'arm_secret_is_login_password', 'The arming secret must differ from the login password.');
    }
    clearFailures(throttleKey);
    return null;
  }

  return {
    state(): {
      killed: boolean;
      switch: SwitchState;
      writesEnabled: boolean;
      armConfigured: boolean;
      grants: Grant[];
      open: ApprovalAction[];
      recent: ApprovalAction[];
      log: LogRow[];
    } {
      return {
        killed: killed(),
        switch: repo.switchState(),
        writesEnabled: writesOn(),
        armConfigured: Boolean(armHash()),
        grants: repo.grants(),
        open: [...repo.actions('proposed'), ...repo.actions('approved')],
        recent: repo.actions(undefined, 50),
        log: repo.logRows(50),
      };
    },

    propose(input: unknown): Result<{ action: ApprovalAction; autoApproved: boolean }> {
      const parsed = ProposalSchema.safeParse(input);
      if (!parsed.success) return refuse(400, 'invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const p = parsed.data;
      if (killed()) return refuse(423, 'killed', 'The kill switch is on. Nothing can be proposed.');
      const grant = repo.grant(p.channel);
      if (!grant || !grant.armed) {
        repo.log({ at: iso(), event: 'propose_refused', actor: p.proposedBy, channel: p.channel, detail: 'channel not armed' });
        return refuse(403, 'no_grant', `Channel "${p.channel}" has no armed grant, so nothing can be proposed on it.`);
      }
      const cap = capRefusal(grant, p.costCents);
      if (cap) {
        repo.log({ at: iso(), event: 'propose_refused', actor: p.proposedBy, channel: p.channel, detail: cap.code });
        return cap;
      }
      const id = newId();
      repo.insertAction({
        id, channel: p.channel, kind: p.kind, title: p.title, content: p.content, target: p.target, costCents: p.costCents,
        status: 'proposed', proposedBy: p.proposedBy, proposedAt: iso(),
      });
      repo.log({ at: iso(), event: 'proposed', actor: p.proposedBy, channel: p.channel, actionId: id, detail: `${p.kind} -> ${p.target} (${p.costCents} cents)` });
      let autoApproved = false;
      if (grant.mode === 'auto') {
        autoApproved = repo.transition(id, 'proposed', 'approved', { at: iso(), by: 'auto' });
        if (autoApproved) repo.log({ at: iso(), event: 'approved', actor: 'auto', channel: p.channel, actionId: id, detail: 'auto-approve grant' });
      }
      return { ok: true, action: repo.action(id)!, autoApproved };
    },

    decide(id: string, decision: 'approve' | 'reject', actor: string): Result<{ action: ApprovalAction }> {
      const action = repo.action(id);
      if (!action) return refuse(404, 'unknown', 'No such action.');
      if (action.status !== 'proposed') return refuse(409, 'not_proposed', `This action is already ${action.status}.`);
      if (decision === 'reject') {
        if (!repo.transition(id, 'proposed', 'rejected', { at: iso(), by: actor })) return refuse(409, 'not_proposed', 'This action was decided a moment ago.');
        repo.log({ at: iso(), event: 'rejected', actor, channel: action.channel, actionId: id });
        return { ok: true, action: repo.action(id)! };
      }
      if (killed()) return refuse(423, 'killed', 'The kill switch is on. Nothing can be approved.');
      const grant = repo.grant(action.channel);
      if (!grant || !grant.armed) return refuse(403, 'no_grant', `Channel "${action.channel}" is not armed any more.`);
      const cap = capRefusal(grant, action.costCents);
      if (cap) return cap;
      if (!repo.transition(id, 'proposed', 'approved', { at: iso(), by: actor })) return refuse(409, 'not_proposed', 'This action was decided a moment ago.');
      repo.log({ at: iso(), event: 'approved', actor, channel: action.channel, actionId: id });
      return { ok: true, action: repo.action(id)! };
    },

    /** Run one approved action, at most once. */
    async execute(id: string, actor: string): Promise<Result<{ action: ApprovalAction }>> {
      const action = repo.action(id);
      if (!action) return refuse(404, 'unknown', 'No such action.');
      if (action.status !== 'approved') return refuse(409, 'not_approved', `This action is ${action.status}, not approved.`);
      if (killed()) return refuse(423, 'killed', 'The kill switch is on. Nothing runs.');
      const grant = repo.grant(action.channel);
      if (!grant || !grant.armed) return refuse(403, 'no_grant', `Channel "${action.channel}" is not armed any more.`);
      if (!writesOn()) return refuse(403, 'writes_off', 'Outbound writes are off on this instance (GLADOS_WRITES). The action stays approved.');
      const run = registry.get(action.kind);
      if (!run) return refuse(501, 'no_executor', `Nothing is registered to run "${action.kind}" actions. The action stays approved.`);
      if (!repo.transition(id, 'approved', 'executing', { at: iso() })) return refuse(409, 'not_approved', 'Another runner took this action.');
      repo.log({ at: iso(), event: 'executing', actor, channel: action.channel, actionId: id });
      try {
        const out = await run(repo.action(id)!);
        const text = (typeof out === 'string' ? out : JSON.stringify(out ?? null)).slice(0, 2000);
        repo.transition(id, 'executing', 'executed', { at: iso(), result: text });
        repo.log({ at: iso(), event: 'executed', actor, channel: action.channel, actionId: id, detail: text.slice(0, 300) });
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
        repo.transition(id, 'executing', 'failed', { at: iso(), result: msg });
        repo.log({ at: iso(), event: 'failed', actor, channel: action.channel, actionId: id, detail: msg.slice(0, 300) });
      }
      return { ok: true, action: repo.action(id)! };
    },

    arm(input: unknown, armSecret: unknown, actor: string, throttleKey: string): Result<{ grant: Grant }> {
      const parsed = ArmSchema.safeParse(input);
      if (!parsed.success) return refuse(400, 'invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const a = parsed.data;
      if (killed()) return refuse(423, 'killed', 'The kill switch is on. Lift it first; that does not re-arm anything.');
      const bad = checkArmSecret(armSecret, actor, throttleKey, a.channel);
      if (bad) return bad;
      const grant = repo.upsertGrant({ ...a, mode: a.mode as GrantMode, armed: true, now: iso() });
      repo.log({ at: iso(), event: 'armed', actor, channel: a.channel, detail: `${a.mode}, ${a.dailyCapCount}/day, ${a.dailyCapCents} cents/day` });
      return { ok: true, grant };
    },

    /** Turning a grant off is the safe direction, so it needs no secret. */
    disarm(channel: string, actor: string): Result<{ disarmed: boolean }> {
      const parsed = slug.safeParse(channel);
      if (!parsed.success) return refuse(400, 'invalid', 'channel: bad name');
      const disarmed = repo.disarm(parsed.data, iso());
      repo.log({ at: iso(), event: 'disarmed', actor, channel: parsed.data, detail: disarmed ? '' : 'was not armed' });
      return { ok: true, disarmed };
    },

    /**
     * Issue a proposing token for one agent. Needs the arming secret, because a
     * token is a right. The plain token comes back once; only its hash is kept.
     * A name is never reused, even after a revoke, so the log stays unambiguous.
     */
    issueToken(input: unknown, armSecret: unknown, actor: string, throttleKey: string): Result<{ name: string; channels: string[]; token: string }> {
      const parsed = TokenIssueSchema.safeParse(input);
      if (!parsed.success) return refuse(400, 'invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      if (killed()) return refuse(423, 'killed', 'The kill switch is on. Lift it first.');
      const bad = checkArmSecret(armSecret, actor, throttleKey, null);
      if (bad) return bad;
      const { name, channels } = parsed.data;
      if (repo.tokenByName(name)) return refuse(409, 'token_exists', `A token named "${name}" already exists (a revoked name stays taken). Pick another name.`);
      const token = deps.newToken ? deps.newToken() : generateToken();
      repo.insertToken({ name, channels, hash: hashToken(token), at: iso() });
      repo.log({ at: iso(), event: 'token_issued', actor, detail: `${name} may propose on ${channels.join(', ')}` });
      return { ok: true, name, channels, token };
    },

    /** Revoking is the safe direction, so it needs no secret. */
    revokeToken(name: string, actor: string): Result<{ revoked: boolean }> {
      const parsed = slug.safeParse(name);
      if (!parsed.success) return refuse(400, 'invalid', 'name: bad name');
      const revoked = repo.revokeToken(parsed.data, iso());
      repo.log({ at: iso(), event: 'token_revoked', actor, detail: `${parsed.data}${revoked ? '' : ' (was not active)'}` });
      return { ok: true, revoked };
    },

    /** Names, channels and dates. Never a token or a hash. */
    tokens(): TokenRow[] {
      return repo.tokens();
    },

    /** Who holds this bearer token? null for anything unknown, revoked or oddly shaped. Writes nothing. */
    authenticateToken(presented: string | null): { name: string; channels: string[] } | null {
      if (!presented || !presented.startsWith(TOKEN_PREFIX)) return null;
      const t = repo.tokenByHash(hashToken(presented));
      return t && !t.revokedAt ? { name: t.name, channels: t.channels } : null;
    },

    /** A proposal from an agent. Its name and channels come from the token, never from the body. */
    proposeAs(agent: { name: string; channels: string[] }, input: unknown): Result<{ action: ApprovalAction; autoApproved: boolean }> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse(400, 'invalid', 'A JSON object body is required.');
      const body = input as Record<string, unknown>;
      if (typeof body.channel !== 'string' || !agent.channels.includes(body.channel)) {
        repo.log({ at: iso(), event: 'propose_refused', actor: `agent:${agent.name}`, channel: null, detail: 'channel not allowed for this token' });
        return refuse(403, 'token_channel', 'This token may not propose on that channel.');
      }
      return this.propose({ ...body, proposedBy: `agent:${agent.name}` });
    },

    /** The kill switch: disarm everything, expire everything open. No secret needed. */
    kill(actor: string): Result<{ disarmed: number; expired: number }> {
      const at = iso();
      repo.setSwitch(true, at, actor);
      const disarmed = repo.disarmAll(at);
      const expired = repo.expireOpen(at, actor);
      repo.log({ at, event: 'killed', actor, detail: `${disarmed} grant(s) disarmed, ${expired} action(s) expired` });
      return { ok: true, disarmed, expired };
    },

    /** Lift the kill switch. Needs the arming secret and re-arms nothing. */
    reset(armSecret: unknown, actor: string, throttleKey: string): Result<{ killed: false }> {
      const bad = checkArmSecret(armSecret, actor, throttleKey, null);
      if (bad) return bad;
      repo.setSwitch(false, iso(), actor);
      repo.log({ at: iso(), event: 'kill_lifted', actor, detail: 'grants stay disarmed until re-armed' });
      return { ok: true, killed: false };
    },
  };
}

export type Approvals = ReturnType<typeof createApprovals>;
export type { ActionStatus };
