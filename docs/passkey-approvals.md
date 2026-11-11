# Passkey (Face ID) hard-line approvals

Status: draft, unreviewed (SH-0277 lane SH0277-PASSKEY, 2026-11-11).

Founder decisions (SH-0277, 2026-11-10 and 2026-11-11): a hard-line approval is a
pop-up in the founder's app with an Approve button behind Face ID (a passkey).
Agents keep admin. This is the first working slice, in FounderOS.

## What it does

1. **An agent asks.** `scripts/request-approval --summary ... --action ... --undo ...`
   files a hard-line request at `POST /api/approvals/hard-line` and polls
   `GET /api/approvals/hard-line?id=<id>` until it is approved, denied or expired.
   Exit 0 only on approved. 1 denied, 2 expired or timed out, 3 error.
2. **The founder sees it** at the top of `/approvals`, with the summary, the exact
   action and the undo. Two buttons: **Approve with Face ID** and **Deny**.
3. **Approve** asks the server for a fresh challenge bound to that one request,
   runs the passkey prompt (Face ID on iPhone Safari), and sends the signed
   assertion back. The server verifies it and only then marks the request approved.
4. **Deny** needs no passkey (it only ever removes a yes).
5. A request nobody approves expires after 30 minutes.

## The rules (lib/passkeys.ts, lib/approvals.ts, lib/db-ext/approvals.ts)

| Rule | Where | Test |
|---|---|---|
| Challenge = base64url(`hard-line:<action id>:<nonce>`), stored with the action id | `approvalOptions` | `the challenge names the action id` |
| Binding: the signed challenge must be one we issued, for THIS action | `approve` | `challenge binding` (2 tests) |
| Single use: consumed compare-and-set before verifying | `approve`, `consumeChallenge` | `replay` |
| 5-minute expiry | `approve` | `expiry` |
| Credential must be registered and the signature must verify with user verification (Face ID) | `approve` + @simplewebauthn/server | `wrong credential` (4 tests) |
| `decide(approve)` on hard-line refuses with `passkey_required` | `lib/approvals.ts` | `no other door` |
| A hard-line kind through the ordinary `propose` refuses (an `auto` grant cannot approve it) | `lib/approvals.ts` | `no other door` |
| Storage refuses `transition(... -> approved)` on a hard-line row; only `approveHardLineWithPasskey` can set it | `lib/db-ext/approvals.ts` | `no other door` |
| Registering a passkey needs the arming secret (not the login password) | `registrationOptions` | `no other door` |
| Non-hard-line approvals behave exactly as before | `lib/approvals.ts` | `non-hard-line approvals are unaffected` |

Tests: `tests/passkey-approvals.test.ts` (a real P-256 software authenticator,
verified by the real library), `tests/hard-line-cli.test.ts` (the real CLI process
against the real route handlers over a socket), `tests/approvals-view.test.ts`.

## Setup (founder, once)

1. In `.env.local` (never committed):
   - `GLADOS_PASSKEY_RP_ID`: the host name the founder opens FounderOS on, e.g. `founderos.example.com`.
   - `GLADOS_PASSKEY_ORIGIN`: the full origin(s), comma-separated, e.g. `https://founderos.example.com`.
   - optional `GLADOS_PASSKEY_RP_NAME` (default `FounderOS`).
   - `HARDLINE_REQUEST_TOKEN`: a long random string agents send as `Authorization: Bearer ...`.
     It can only file and read hard-line requests. Unset means operator session or loopback only.
2. Passkeys need HTTPS on a real host name (WebAuthn refuses plain http except `localhost`).
3. Open `/approvals` on the iPhone, type the arming password under "Passkey for
   hard-line approvals", press **Register this device**, and confirm with Face ID.

## Trust note: what this does and does not prove

Agents have root on this host. A server here can be modified by an agent: an
agent with root can edit `lib/passkeys.ts`, swap the registered public key in
the database, or flip a row to `approved` with `sqlite3` directly.

So, plainly:

- **The passkey proves** the founder pressed Approve, with Face ID, for that exact
  request (its id is inside the signed challenge), within 5 minutes, once.
- **It does not stop** a rogue root agent from changing the server that checks it,
  or from skipping the check altogether. Any verifier running on a host the agents
  administer can be bypassed by those agents.

This is the same finding that parked meta#741 (SSH-signed approvals): the agents'
sudo makes local signers and local verifiers forgeable.

### The follow-up that closes it

Move the verifier to a host agents cannot administer, and make the hard-line
tools trust only that verifier's signature:

1. A small verifier service on a separate trust root (for example a Cloudflare
   Worker or a tiny VPS the agents hold no credentials for), holding the founder's
   passkey public key and its own signing key that never touches this host.
2. The founder's app asserts against that verifier, which returns a signed
   "approved <action id> <expiry>" receipt.
3. The hard-line gate (meta, later) verifies the receipt with the verifier's
   PUBLIC key pinned in a place agents cannot rewrite unnoticed (for example a
   founder-signed commit or a hardware-backed key), not by asking FounderOS.
4. Until then, keep the approval log (`approval_log`) and watch it from a host
   the agents cannot write to.

## What the Mac session must build

No Xcode on this host, so the Swift side is types only
(`apple/FounderKit/Sources/FounderKit/PasskeyModels.swift`). The Mac session must:

1. `swift build` and `swift test` in `apple/FounderKit` (the new file has not been compiled).
2. Add `FounderClient` methods: `passkeyStatus()`, `hardLineOptions(id)`,
   `approveHardLine(id, assertion)`, using the types in `PasskeyModels.swift`.
3. In the app: show hard-line items as a pop-up / alert with Approve and Deny.
   Approve runs `ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier:)`
   `.createCredentialAssertionRequest(challenge:)` (Face ID), then posts the
   assertion. Deny calls `decide(id, .reject)`.
4. Associated Domains: `webcredentials:<GLADOS_PASSKEY_RP_ID>` in the app
   entitlement, and an `apple-app-site-association` file served by FounderOS
   at `/.well-known/apple-app-site-association` so the app and Safari share the
   same passkey. (Not in this slice: it needs the Team ID and bundle id.)
5. Push notification for a new hard-line request (so it really pops up), later.

## Not in this slice

- meta's hard-line gate calling `scripts/request-approval` (another lane; meta untouched here).
- Consuming an approval (marking it used once the agent acts). Today an approved
  request stays approved; the agent acts once on exit 0.
- The off-host verifier above.
