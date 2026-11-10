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
`app/api/approvals/` (canned from that code, not a live server), the request paths and bodies,
refusals with their server code, and Swift 6 strict concurrency.
What they do not prove: behaviour against a running server with the queue merged, anything on iOS or
macOS, Face ID or Secure Enclave signing, and any UI.
