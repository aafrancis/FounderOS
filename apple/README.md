# FounderOS native apps (Mac and iPhone)

Status: started 2026-11-10 (thread SH-0271). Only `FounderKit` exists so far; there is no app shell yet.

The native app is a client of this repo's web backend, not a rewrite of it. It covers what nothing else
in the estate does: approvals (the send, spend and publish gate), the reply desk, pipeline and clients,
later money and calls. Plan: `ecosystem-roles-founderos-2026-11-10.md` and
`founderos-swift-app-plan-2026-11-10.md` in threads-shared `deliverables/SH-0271-ops-app/`.

## FounderKit
Swift package, Foundation only: models of the approval queue API and a client with a replaceable
transport. It holds no credentials and never holds send, spend or publish keys.

Run the tests anywhere with Docker (no Swift needed on the host):

```
cd apple/FounderKit
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/pkg -w /pkg swift:6.1 swift test --scratch-path /tmp/fk-build
```

On a Mac with Xcode: `cd apple/FounderKit && swift test`.

What the tests prove: decoding of the JSON shapes in `lib/db-ext/approvals.ts` and the routes under
`app/api/approvals/` (9 canned from that code), the request paths and bodies, refusals with their
server code, and Swift 6 strict concurrency.

Live tests (`LiveServerTests`, 4 of them) run the same client against a REAL server and are skipped
unless `FOUNDEROS_URL` is set. Use a throwaway instance with its own database, because one test turns
the kill switch on:

```
PORT=4199 GLADOS_DB=/tmp/fk-live.db node scripts/serve.mjs dev     # loopback, no password needed
cd apple/FounderKit
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -e FOUNDEROS_URL=http://127.0.0.1:4199 \
  -v "$PWD":/pkg -w /pkg swift:6.1 swift test --scratch-path /tmp/fk-build
```

Checked 2026-11-10 against the merged queue (main at f39e250): the real state decodes, a proposal on a
channel with no grant is refused with 403 and code `no_grant`, deciding an unknown id is refused, and the
kill switch works with no secret and shows in the state. Behind a password, also set `FOUNDEROS_PASSWORD`.

What they do not prove: anything on iOS or macOS, Face ID or Secure Enclave signing, any UI, or an
armed channel (nothing is armed, so propose, approve and run on a real channel are untested).
