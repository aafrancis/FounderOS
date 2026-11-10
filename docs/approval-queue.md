# Approval queue (SH-0271)

One queue for every send, spend or publish. Founder decision 2026-11-08: rights are granted
per channel with a daily cap, nothing runs without an approval step, and one switch stops it all.

**State when this landed: inert.** No channel is armed, no executor is registered, and no
arming secret is set. Merging it changes no behaviour.

## How it works

1. **Arm a channel** (`POST /api/approvals/grants`, `action: "arm"`). Needs the arming secret
   (`GLADOS_ARM_HASH`), a different secret from the login password. A stolen session cookie
   cannot grant rights. Choose `ask` (every action waits for the operator) or `auto`.
   Recommended for the first two weeks: `ask`.
2. **Propose** (`POST /api/approvals`). An agent or a Wild Horse loop files the action with its
   full content, cost in cents and target. Refused with 403 unless the channel is armed, 429
   past the daily cap, 423 when the kill switch is on.
3. **Decide** (`POST /api/approvals/:id`, `decision: "approve" | "reject"`). Approve re-checks
   the kill switch, the grant and the cap, then runs the action once through the executor
   registered for its `kind` (`registerExecutor` in `lib/approvals.ts`). The status change is a
   compare-and-set, so an action can never run twice.
4. **Kill switch** (`POST /api/approvals/kill`, `action: "kill"`). Disarms every grant and
   expires every open action. Needs no secret. Lifting it (`action: "reset"`) needs the arming
   secret and re-arms nothing.

Every step is written to `approval_log`, which is append-only.

## Also required to run anything

- `GLADOS_WRITES=1` on the instance (the existing gate). Off: an approved action stays approved.
- An executor registered for the action's `kind`. None exists yet: the first one is the first
  channel the operator names.

## Setting the arming secret

```
node scripts/hash-arm-secret.mjs
```

Type the secret when asked (not echoed, not stored). Put the printed `GLADOS_ARM_HASH=...` line
in the instance's local env file. The server refuses an arming secret equal to the login password.

## Caps

Per channel, per UTC day: `dailyCapCount` actions and `dailyCapCents` cents (0 = free actions
only). An approved action counts even if it then fails, so a retry loop cannot dodge the cap.

## Not built yet

- A screen for it (queue, approve buttons, kill button). The API is complete; the UI follows.
- The phone path. Approving from the iPhone app needs the Ops app to call these routes.
- Wild Horse loops posting into this queue and obeying the kill switch (a pause flag counts only
  once something on the host obeys it).
- Per-agent tokens for proposing. Today a proposal needs the operator session cookie.
