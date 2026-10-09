---
id: conduit-batteries
status: proposed
dated: 2026-10-05
---

# Idea — what conduit does not do yet, parked until an app asks

**Status: PROPOSAL. Nothing here is built.** Dated 2026-10-05. These were
`conduit-13`'s neighbors under the `FJS-710` umbrella, from the API-realm audit
([§ 3.5](https://claude.ai/code/artifact/afba85f4-efe9-4959-92ca-a1b010dd2a16)).
None is a defect: each is a feature conduit lacks, and none has an app asking for
it. Build one when an app needs it, and file it as its own row then.

The parts of that umbrella that already have a home are not repeated here:
credential expiry, refresh, OAuth2 client credentials and a per-tenant key are leg
three of [`third-party-credentials.md`](third-party-credentials.md); an inbound
receiver is [`inbound-integrations.md`](inbound-integrations.md) under
[`FJS-D177`](../DECISIONS.md#fjs-d177); junction's webhooks plugin dialing out
without conduit is [`FJS-659`](../ISSUES_ARCHIVE.md#fjs-659).

| Item | What it would do | Note |
| --- | --- | --- |
| **http `stream()`** | Server-sent events over the http transport | Answers `not_implemented` today, on purpose, so *cannot stream* is told apart from *streamed nothing* ([`FJS-D585`](../DECISIONS.md#fjs-d585)). |
| **Per-target rate limiter** | Hold a send rather than spend a vendor's quota | Would be an eighth policy number, so it falls back the way the seven do (`FJS-728`). |
| **Retry budget** | Cap retries as a share of traffic, not per call | Stops a retry storm the per-call cap allows. |
| **Hedged requests** | Send a second copy when the first is slow, keep the first answer | Only safe for an idempotent call, so it reads the idempotency key. |
| **Record and replay** | Capture a target's real answers and serve them in a test | The test half of a connector; `example`'s `verify:stripe` hand-builds what this would record. |
| **Mock-server helper** | A declared fake target for a drive | Overlaps record and replay; build one of the two. |
| **Proxy and mTLS** | Dial through a proxy, or present a client certificate | Belongs on the descriptor, beside `policy`. |

A redacting request log is not listed: observers already receive the body,
headers and query through `redactSecrets`, so a log is an observer.
