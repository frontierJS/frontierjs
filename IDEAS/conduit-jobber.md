---
id: conduit-jobber
status: proposed
dated: 2026-11-13
---

# Idea — `conduit-jobber`: Jobber over conduit, before the maid.tech port

**Status: PROPOSED.** Dated 2026-11-13. Nothing here is built. Do not cite this
file as behavior; see `VERIFYING.md`. The API facts below are from Jobber's
docs, which Jobber served only as search snippets on the date above (the site
answers `403` to a fetch). Phase 0 measures them.

---

## Trigger

maid.tech's port (`fjs-prototypes/maidtech`, stressor #27) is next, and Jobber
is the one CRM in it that has a credential. The port already talks to Jobber
from app code: `api/src/core/integrations.ts` declares three targets and the
resolver that refreshes a rotating token, `api/src/domain/push-lead.ts` sends
`clientCreate`, and `api/test/standins/crm.ts` stands in for Jobber's GraphQL
and its token endpoint. None of it is reusable, the connect flow has no screen
(`R-Q11b`), and only the lead push is ported. This plan lifts what works into a
package, finishes the parts the live app uses, and leaves the port spending it.

---

## What the live app does with Jobber

Read 2026-11-13 from `my.maid.tech/db/development.db` (production data, read
only; it ends 2026-06-04) and `api/src/services/actions/jobber.actions.js` (923
lines).

| Use | Runs | Accounts | Last | Jobber call |
| --- | --- | --- | --- | --- |
| Lead push: a form or a card creates the client | ~790 | 7 | 2026-06-03, daily | `clientCreate` (with a property when there is an address) |
| …and a work request on top | inside the above | 2 (`createWorkRequest`) | 2026-06 | `requestCreate` |
| Quote push from an estimate | 4 | 1 (acct 73) | 2025-05 | `quoteCreate`, after reading `taxRates` |
| Payroll: timesheets per visit | 2 | 1 (acct 3) | 2024-12 | `timeSheetEntries`, paged |
| Import clients, import users | 1 each | 1 | 2025-05 | `clients`, `users`, paged |
| Connect (OAuth code exchange) | 8 logins ever | 8 | 2026-03 | `authorization_code` at `/api/oauth/token` |

**Every refresh token is tied to the app's client id.** The reference refreshes
with `settings.account.client_id`, decoded from the token. So unless the port
spends the same Jobber developer app as the live maid.tech, all 8 accounts have
to reconnect at cutover (Q5).

Defects the reference carries and this package must not: GraphQL built by
string interpolation with HTML-entity escaping (`D24`); a refused refresh that
wiped both keys and recursed without limit (`D23`). Both are in the port's
`PLAN.md` § Defects.

## Jobber's API, as documented

- **OAuth 2.0 authorization code.** Authorize at
  `api.getjobber.com/api/oauth/authorize`, token at `/api/oauth/token` (form
  POST). The access token is a JWT that lasts 60 minutes and carries `exp`. When
  *Refresh Token Rotation* is on in the app's settings, every refresh returns a
  new refresh token and the old one dies. Re-authorizing kills every earlier
  refresh token for that user.
- **GraphQL at `/api/graphql`, versioned by a header**,
  `X-JOBBER-GRAPHQL-VERSION`. The port pins `2024-12-05`. Whether that version
  still answers is unmeasured (0.2).
- **Two rate limits, both per app and account pair.** Requests: 2,500 per 5
  minutes, then `429`. Query cost: a leaky bucket of 10,000 points that refills
  at 500/s. **A throttled query returns HTTP 200** with `code: "THROTTLED"` in
  `errors`, and `extensions.cost` on every answer carries the bucket's state. So
  conduit's 429 handling never sees it, and `translate()` has to.
- **A `401` is an expired or invalid token.** A business failure arrives as
  `userErrors` on the mutation with HTTP 200.
- **Webhooks carry ids only** (`topic`, `accountId`, `itemId`, `occuredAt`),
  are signed `X-Jobber-Hmac-SHA256` (base64 HMAC of the raw body keyed by the
  app's client secret), and include `APP_DISCONNECT`. maid.tech has never used
  one.

Sources: [App Authorization](https://developer.getjobber.com/docs/building_your_app/app_authorization),
[API Rate Limits](https://developer.getjobber.com/docs/using_jobbers_api/api_rate_limits),
[Setting up Webhooks](https://developer.getjobber.com/docs/using_jobbers_api/setting_up_webhooks/),
[Jobber on refresh token rotation](https://dev.to/jobber/refresh-token-rotation-what-why-and-how-2eh),
[rate limits measured in production](https://www.adeocode.com/blog/jobber-api-rate-limits-what-you-can-actually-build/).

---

## What exists, and must not be restated here

| Piece | Where | What it settles |
| --- | --- | --- |
| Per-account credential | `FJS-D848`, conduit `per_caller`, `getFor`/`invalidateFor` | a send spends the login of the account it runs in; a `401` invalidates that account's login alone and replays once |
| A credential's expiry | `FJS-D1075` | the resolver answers `{ value, expires_at }`, so a refresh can happen before the `401` |
| A mint through its own target | `FJS-D933`, conduit-oidc, conduit-37signals' `token` target | a refresh is a send through an `auth: none` target; a refused mint is a `MintError` |
| The connect flow | `FJS-2246`, `FJS-D1313` (owed, `IDEAS/owed-rulings.md`) | auth has no flow that writes a TENANT's tokens to the app's own row; this plan's Phase 3 is blocked on it |
| Package home and naming | `FJS-D1559`, `FJS-D1181` | `packages/conduits/conduit-<x>/`, `@frontierjs/` even for a vertical (37signals' precedent) |
| The shape to copy | `packages/conduits/conduit-37signals/` | `src/{index,errors,types}.ts`, `sink.ts`, `test/*.drive.ts`, two targets (`api`, `token`) |
| The port's working code | `maidtech/api/src/core/integrations.ts`, `push-lead.ts`, `test/standins/crm.ts`, `test/actions.test.ts` | the CAS on `updatedAt` that settles two processes refreshing at once; `disconnectedAt` on a refused refresh; the push failing by name |

---

## Open questions

- ~~**Q1 — Scope and name.**~~ **Answered 2026-11-13 (`FJS-D2116`): A — `@frontierjs/conduit-jobber` at `packages/conduits/conduit-jobber/`, held out of publishing like its siblings.**
  - **A** — `@frontierjs/conduit-jobber` at `packages/conduits/conduit-jobber/`, held out of publishing like its siblings.
  - **B** — `@kobami/conduit-jobber`, outside the tree, as `conduit-connectors.md`'s Service Autopilot row says.
  - **Recommend A** — `FJS-D2057` put conduit-airtable in `packages/conduits/` "like its 28 siblings", and `FJS-D1181` made 37signals, another vertical, `@frontierjs/` and struck the `@kobami/` row. The owner has asked for its own package. Phase 1 strikes the Jobber clause of that row the same way.
- ~~**Q2 — `FJS-D1313`: how does auth finish a connect flow that writes a tenant's tokens to the app's own row?**~~ **Answered 2026-11-13 (`FJS-D1313`): A — a `grant` flow kind on the existing `oauthBegin`/`oauthCallback`, with an `onGrant` the app declares and `purpose: 'grant'` keeping the provider out of sign-in.** The options and prior art are in `IDEAS/owed-rulings.md`.
- ~~**Q3 — What does the first version cover?**~~ **Answered 2026-11-13 (`FJS-D2117`): B — A plus one paged reader, `walk()`, and `timesheets()` on it for payroll (`7e` in the port's `ROUTES.md`).**
  - **A** — the writes only: client, request, quote, plus refresh and connect.
  - **B** — A plus one paged reader, `walk()`, and `timesheets()` on it for payroll (`7e` in the port's `ROUTES.md`).
  - **Recommend B** (confidence 2) — conduit-37signals, conduit-microsoft (`walkDelta`) and conduit-gmail (`walkHistory`) each keep a `walk` over their own paging, so this is the sibling pattern. Throttling matters most on a paged read (one dashboard load measured 13–20k points, a secondary source that 0.2 checks), so it is built and tested once inside the connector. If B costs more than expected, A with `walk()` deferred until payroll needs it is the fallback.
- ~~**Q4 — Jobber's webhooks?**~~ **Answered 2026-11-13 (`FJS-D2118`): C — B plus the object topics (`CLIENT_*`, `REQUEST_*`, `QUOTE_*`).**
  - **A** — none. A dead login is found by the next push, which already fails by name with "reconnect Jobber".
  - **B** — only `APP_DISCONNECT`, verified by HMAC, which sets `disconnectedAt` the moment an account disconnects the app.
  - **C** — B plus the object topics (`CLIENT_*`, `REQUEST_*`, `QUOTE_*`).
  - **Recommend A** — maid.tech has never received a Jobber webhook. B needs the cutover host's URL registered on the Jobber app and buys only an earlier warning. B is a later step if the owner wants the warning.
- ~~**Q5 — Whose Jobber developer app does the port spend?**~~ **Answered 2026-11-13 (`FJS-D2119`): A — the live maid.tech's app, same client id and secret, with the new host's callback added to its redirect URIs.**
  - **A** — the live maid.tech's app, same client id and secret, with the new host's callback added to its redirect URIs.
  - **B** — a new app registered for the port.
  - **Recommend A** — the 8 accounts' refresh tokens refresh only under the client id that minted them, so B makes every account reconnect at cutover. A keeps the same app and adds one redirect URI. The cost is that the live app's secret becomes the port's deploy secret: it lives in the deploy env only, never in a file. Building and driving use a separate dev app on a Jobber developer test account (0.1) in either case.
- **Q6 — What does maid.tech do with each Jobber event?** `FJS-D2118` receives the object topics. The connector verifies an event, routes it to an account and re-reads the item, but what the app does next is the app's call. Asked once 0.2 has measured the payloads.
  - **A** — record only: each event is an `Action` row on the account (topic, item, Jobber's link), visible in the action list, and nothing else changes.
  - **B** — A, plus `CLIENT_UPDATE` and `CLIENT_DESTROY` update or archive the maid.tech contact whose `externalId` matches; request and quote events stay as records.
  - **Recommend A** (confidence 1) — the live app has no inbound path to copy, and B makes Jobber a second writer of a contact a person edits in maid.tech, which raises the conflict question `conduit-connectors.md` § *What is deliberately not on it* keeps out. A shows what arrives, and B can follow once that has been seen.

**What must stay true:** a refused refresh marks the row `disconnectedAt` and the send fails by name. It never clears the tokens and never recurses (`D23`). Phase 2's rotation and refused-refresh drive cases are what fail if it stops.

---

## Phases

### Phase 0 — Groundwork

Goal: Jobber's real answers on disk, and the reference read into a nouns table.
Done when: scrubbed fixtures cover every row of the nouns table, the token endpoint's three answers, a `401`, and one `THROTTLED`; 0.2 records whether `2024-12-05` still answers.

- [ ] 0.1 **Owner's step:** a Jobber developer account, a dev app with Refresh Token Rotation ON (as the live app has, by the reference's behavior), and a developer test account. The client id and secret go into the keyring, never a file in this repo.
- [ ] 0.2 Measure against the test account with `curl`: the authorize redirect and the code exchange; a refresh (does the old refresh token die at once or after a grace period?); a refused refresh (`invalid_grant`?), and its status and body; a `401`'s body; the version header (current string; does `2024-12-05` still answer, and what does an expired one return?); `extensions.cost` on an ordinary query; and a provoked `THROTTLED` (one over-cost query). Webhooks, through a tunnel to a scratch receiver: one payload per topic family and its signature header; whether a non-`2xx` answer is retried, how often and for how long; and whether one change ever arrives twice. Raw dumps stay in the scratchpad.
- [ ] 0.3 Capture bodies for each noun: `clientCreate` with a property, `requestCreate`, `quoteCreate` (with `taxRates` read first), one page each of `clients`, `users` and `timeSheetEntries`, and a `userErrors` answer (a client with no name). Scrub before `test/fixture/`.
- [ ] 0.4 The nouns table: for each row of § What the live app does, the verb's name, its mutation or query, its input mapping from the reference, and its idempotency. A create has no key, so a lost answer is resolved by reading back, not by replaying.

### Phase 1 — Rulings

Goal: Q1–Q6 answered.
Done when: each Q names an `FJS-D`, and `conduit-connectors.md` row 189 says what Q1 ruled.

- [x] 1.1 Q1, Q3, Q4 and Q5 through the question tool — `FJS-D2116`–`FJS-D2119`. Q4 went against the recommendation: the owner wants the object topics in v1
- [x] 1.2 `FJS-D1313` (Q2) ruled **A** through the question tool, which unblocks `FJS-2246`
- [x] 1.3 `conduit-connectors.md` row 189's Jobber clause names this plan and `FJS-D2116`
- [ ] 1.4 Q6 through the question tool, after 0.2

### Phase 2 — Send

Goal: the connector, against a sink. The port is untouched.
Done when: `bun run test` in the package is green over the sink, with a mutation check on the rotation write and on the throttle path, and `fli done` is clean.

- [ ] 2.1 Scaffold `packages/conduits/conduit-jobber/` from conduit-37signals' layout: `test` is `bun run drive`, a typecheck script, the root `CLAUDE.md` Packages row, then `fli ws:atlas`, `ws:exports`, `ws:deps` and `ws:surface` to refresh the snapshots
- [ ] 2.2 `jobberTargets({ version })` returns `{ api, token }`. `api` is `per_caller` bearer with the version header on the descriptor; `token` is `auth: none` and form-encoded. The version is a required argument, so a pin is the app's, visible, and moves when Jobber retires one
- [ ] 2.3 `translate()`: `401` → `auth_failed`; HTTP 200 with `THROTTLED` → `rate_limited` with a wait computed from `extensions.cost.throttleStatus` (the deficit divided by the restore rate); `429` keeps conduit's handling; `userErrors` → a typed refusal carrying Jobber's messages
- [ ] 2.4 `refreshJobber(send, { clientId, clientSecret, refreshToken })` returns `{ accessToken, refreshToken, expiresAt }`, with `expiresAt` read from the JWT's `exp` so the app's resolver answers `FJS-D1075`'s shape and refreshes before the `401`. A refused refresh is `MintError`. The connector mints, and the app's row stays the app's, CAS included. Also `exchangeJobberCode(send, { code, redirectUri, … })`, the same shape, for Phase 3
- [ ] 2.5 Verbs with GraphQL variables, never interpolation (`D24`): `createClient(send, input)` (with property), `createRequest`, `createQuote` (taking a tax rate id; `taxRates(send)` lists them). Each answers the created id or the refusal
- [ ] 2.6 `walk(send, query, vars)` follows `pageInfo.endCursor` and waits on `THROTTLED` rather than failing the page. `timesheets(send, { from, to })` is a thin caller of it
- [ ] 2.7 `sink.ts` and `test/jobber.drive.ts`: a GraphQL sink with rotation (the old refresh token dies on use), a refused refresh, a `401`, `userErrors`, a `THROTTLED` with a cost body, and pages. Folded in from the port's stand-in, so 4.1 can delete that

### Phase 3 — Connect

Goal: an account admin connects or reconnects Jobber, and the tokens land on the account's own `Integration` row.
Done when: the `FJS-D1313` red test passes (begin, callback; no `User`, `Credential` or session created; tokens on the app's row), and `FJS-2246` closes.

- [ ] 3.1 Build `FJS-D1313`'s ruling in auth, with its red test first
- [ ] 3.2 conduit-jobber exports Jobber's provider declaration for that flow: authorize URL, token exchange through 2.4's `exchangeJobberCode`, and `purpose: 'grant'` (`FJS-D1313` A)
- [ ] 3.3 `verifyJobberSignature(rawBody, header, clientSecret)`, a base64 HMAC-SHA256 compared in constant time, on conduit-stripe's `verify.ts` shape. Then `receiveJobber()`: parse `{ topic, accountId, itemId, occuredAt }` (Jobber's spelling), dedupe on topic + item + time, since the payload has no event id, and re-read the item through `send`, because the payload carries only ids (`FJS-D2118`)
- [ ] 3.4 The account a webhook names is Jobber's encoded account id, which the port keeps today only inside `settings` (the token's `account` claim). The Integration row gains it as an indexed column, written by `onGrant`, so routing an event is one lookup and never a scan of `settings`
- [ ] 3.5 `APP_DISCONNECT` sets `disconnectedAt` on that row, with the same name as a refused refresh

### Phase 4 — The port spends it

Goal: maid.tech's port has no Jobber code of its own beyond its row and its resolver.
Done when: the port's `actions.test.ts` is green on the package's sink, and a Chrome drive connects Jobber, pushes a lead and a quote, and reconnects after a refused refresh, all against the sink.

- [ ] 4.1 `core/integrations.ts` builds its targets from `jobberTargets`, and its resolver refreshes through `refreshJobber`, keeping its CAS and `disconnectedAt`. `push-lead.ts` calls `createClient` and `createRequest`, and Jobber leaves `test/standins/crm.ts` (MaidCentral stays)
- [ ] 4.2 The quote push, ported onto `createQuote`, for the one account that uses it
- [ ] 4.3 The integration screen's Connect and Reconnect buttons over Phase 3 (`R-Q11b`), driven in a browser
- [ ] 4.4 payroll's timesheet read (`7e`) onto `timesheets()`
- [ ] 4.5 The port's webhook route: raw body, `verifyJobberSignature`, answer `200` fast, then a job runs `receiveJobber` and does what Q6 rules. The URL is registered per topic on the dev app (owner's step)

### Phase 5 — The real Jobber

Goal: everything above proven against Jobber itself, not the sink.
Done when: on the developer test account, through the port's own screen: connect, push a lead with a request, push a quote, read a timesheet page, force a refresh and see the rotation written, edit a client in Jobber and see Q6's answer to it, then disconnect the app in Jobber, see `disconnectedAt` set by `APP_DISCONNECT`, and reconnect.

- [ ] 5.1 Run the Done-when sequence on the dev app (0.1), and record anything the sink got wrong as a sink fix
- [ ] 5.2 Cutover notes for the port's `R-Q11a`: the client id and secret of the app Q5 names, its redirect URI updated to the cutover host, and the 8 rows' tokens carried over encrypted. The owner's steps are listed, not taken

---

## Not planned

- Jobs, visits, invoices and the rest of Jobber's schema. Nothing in maid.tech calls them.
- The client and user imports. They ran once each, in 2025-05, and the port has no screen for them. `walk()` makes either one a few lines if one is wanted.
- A mirror claim (`@@mirror`) on any Jobber noun. No surface lists them (`mirror-apps.md` rule 1).
- A cross-process refresh lock in conduit. The port's CAS on `updatedAt` settles the race, measured in `actions.test.ts`. `third-party-credentials.md` keeps the general question.

## See also

`IDEAS/conduit-connectors.md` · `IDEAS/conduit-37signals.md` · `IDEAS/third-party-credentials.md` · `IDEAS/conversion-maid-tech.md` · `fjs-prototypes/maidtech/PLAN.md` § Q11
