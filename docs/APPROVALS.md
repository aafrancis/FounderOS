# Approval queue and grants

Anything that sends, spends or publishes goes through one queue: it is proposed with its full content,
cost and target, approved once, run once and logged. Added for thread SH-0271 (founder decision 2026-11-08).

## Off by default
- The kill switch starts **engaged**. Releasing it needs the arming secret.
- A grant starts **disarmed**; editing a grant disarms it again. Arming needs the arming secret.
- The arming secret is `GLADOS_ARMING_HASH` in `.env.local` (same scrypt format as `GLADOS_PASSWORD_HASH`,
  a different secret from the login password). Not set = nothing can be armed or released.
- No executor ships. A channel can only run once code calls `registerExecutor(channel, fn)` (lib/approvals.ts),
  and running also needs `GLADOS_WRITES=1` (lib/gates.ts).

## API (all behind the normal login gate)
| Route | What |
| --- | --- |
| `GET /api/approvals` | switch, grants, pending, recent, audit |
| `POST /api/approvals` | propose `{ channel, summary, target, payload, costCents, proposedBy }`; 409 unless the channel has an armed grant, the switch is released and today's caps allow it |
| `POST /api/approvals/:id` | `{ action: approve \| reject \| execute, confirm: true }` |
| `GET /api/grants` | switch and grants |
| `POST /api/grants` | `set` (channel, kind send/spend/publish, mode ask/auto, dailyCapCount, dailyCapCents; spend needs a money cap), `arm` (armingSecret), `disarm`, `kill` (no secret, always works), `release` (armingSecret); all but `kill` need `confirm: true` |

## Rules the code enforces (tests/approvals.test.ts)
- Caps are per channel per UTC day. Pending, approved and executed proposals count; a rejected one frees its slot.
- `ask` mode waits for approval; `auto` approves on proposal, but caps and the kill switch still apply.
- Approving and running re-check the switch, arming and caps. Pending proposals expire after 24 hours.
- Running claims `approved -> executed` in one atomic update, so a proposal can never run twice. A failed run stays `failed`; nothing retries it.
- The audit log (`approval_audit`) is append-only: every grant change, proposal, decision, refusal and run is a row.
