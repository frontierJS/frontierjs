# conduit-microsoft — state

**Built 2026-10-22 (`FJS-D1463`), unreleased, drive green, never run against Microsoft from this package.**

- **Drive**: `bun run drive` — 33 rows against the sink, all green. Fixture: none; no conforming Graph exists to record one.
- **Real vendor**: not called from here. The source it was lifted from, ELA's `api/src/providers/microsoft/`, ran live on one Microsoft 365 mailbox from 2026-07-22; the sink is ELA's stand-in, which encodes what that run taught (rotating refresh token, REST vs immutable id, 4230-minute cap, validationToken handshake, 410 reset). Anything the stand-in got wrong this package has too.
- **Source**: ELA `providers/microsoft/{targets,oauth,graph,subscriptions,receive,errors}.ts` and `test/standin/graph.ts`. The sync engine (`sync.ts`, `map.ts`, the Message-Id re-match of ELA ruling 108, writeback rules, raw routes and jobs) stays in ELA per C12. ELA's adoption of this package is owed; until then the two copies drift.
- **Gaps**
  - The validationToken handshake cannot ride `app.conduit.receive()` — the receiver answers its own body. `handshake(url)` is a pure function the app mounts as a raw route AHEAD of the receiver. `FJS-1804`'s case.
  - `invalidateFor` remembers a dead access token in-process only; it is not written to the grant row, so a second process keeps using a token the first saw refused until its own 401.
  - No `$batch`; one Graph call per message.
  - Lifecycle notifications are parsed, not acted on: `reauthorizationRequired`/`subscriptionRemoved` are the app's to answer with `ensureSubscription`.
- **Amendments to CONTRACT**: none. C10's `/_sink/arm` carries vendor knobs (`expireAccessTokens`, `expireDeltaTokens`, `revoke`, `lapse`) beyond `failNext`/`dropNext`; the shape is the same.
- The ELA code this was lifted from ran live on one Microsoft 365 mailbox from 2026-07-22; that is the only real Microsoft the facts here come from.
- **FJS filed**: none.
