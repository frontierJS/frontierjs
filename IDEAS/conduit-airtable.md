---
id: conduit-airtable
status: partial
dated: 2026-11-10
---

# Idea — `conduit-airtable`: Airtable over conduit

**Status: PARTIAL.** Dated 2026-11-10. Phases 0–3 are built, sink-only, in
`packages/conduits/conduit-airtable/` (uncommitted); Phases 4–6 are parked until a
caller exists (`FJS-D2056`). Do not cite the parked phases as behavior — see
`VERIFYING.md`. The API facts below were measured against a scratch base on the
date above, except where a bullet says unmeasured.

---

## Trigger

The owner asked for one on 2026-11-10. There is no Airtable connector in
`packages/conduits/`, and no row, ruling or idea names one. `stressors.md` refuses
an Airtable *clone* as a stressor, which is a different thing: this is a call to a
base somebody already keeps in Airtable, from an FJS app at runtime. **No caller is
named yet** (Q2), so the phases after the send half wait on one.

Like `conduit-37signals`, it fails `conduit-connectors.md` § The test, test one: a
spreadsheet-database is a vertical. It passes test two. `FJS-D1181` made a vertical
a reason weighed at promotion rather than a bar to scope, and `FJS-D1559` made
`packages/conduits/` every connector's home. Q1 asks whether both hold here.

---

## What exists, and must not be restated here

| Piece | Where | What it settles |
| --- | --- | --- |
| The contract | `packages/conduit/docs/CONTRACT.md` | C1–C13 and every amendment. This connector is graded against it |
| The shape to copy | `packages/conduits/conduit-37signals/` | `src/{index,errors,types}.ts`, `sink.ts`, `test/*.drive.ts`, one target per account, a feed walked by cursor, `findCreated` matching rather than keying (C6 — 37signals) |
| The drive harness | `packages/conduits/lib/drive.ts` | `results()` / `report()`, one row per claim (C11) |
| A refresh token that rotates | `conduit-oidc`'s `exchangeCode` / `refreshTokens`, which take a bare `{ token_endpoint }` | `grant_lost` on a burned refresh (C6 — oidc, `FJS-D795`) |
| A body key that collapses a write | C5 — mattermost | the caller's key in the body makes a write `replayable: true` |
| A 429 with no `Retry-After` | C5 — google-maps | the connector supplies the vendor's documented wait |
| A mirror claim | `mirror-apps.md` rule 1, `FJS-D1124`/`FJS-D1125` | earned by a surface that LISTS the noun, and by nothing else |

---

## Airtable, as documented on 2026-11-10

Read from the docs, then measured on 2026-11-10 against a scratch base (`test/fixture/`). Each bullet ends with what the measurement found. The webhook ping's bytes and the OAuth lines are not measured.

- **Auth.** A personal access token (PAT) or an OAuth access token, both
  `Authorization: Bearer`. The scopes used here are `data.records:read`,
  `data.records:write`, `schema.bases:read` and `webhook:manage`. OAuth uses
  `airtable.com/oauth2/v1/{authorize,token}`, PKCE `S256` is required, an access
  token lasts 60 minutes, and a refresh token lasts 60 days and is **single use**.
  A confidential client sends Basic on the token call. *(0.1, 5.1)* **Measured:** a PAT as `Authorization: Bearer` works on records, schema and webhooks, and a bogus token answers `401 { error: { type: "AUTHENTICATION_REQUIRED" } }` (so 401 does carry a type). The OAuth numbers are unmeasured, owed to 5.1.
- **Rate.** 5 requests a second per BASE, and 50 a second per user across that
  user's PATs. A 429 says wait **30 seconds**, and the docs do not say whether
  `Retry-After` is sent. *(0.2)* **Corrected:** a burst of 60 parallel reads on one base answered 40 `200` and 20 `429`, and 24 in parallel all passed. The 429 carries **no `Retry-After`** and its body is the PLURAL shape `{ "errors": [{ "error": "RATE_LIMIT_REACHED", "message": "Rate limit exceeded. Please try again later" }] }`.
- **Records.** `GET/POST /v0/{baseId}/{tableIdOrName}`. A list is paged by
  `offset` at up to 100 a page. An offset can die mid-walk (`422
  LIST_RECORDS_ITERATOR_NOT_AVAILABLE`), and the walk then starts over. A URL
  must be under 16,000 characters, and `POST …/listRecords` takes the same
  parameters in a body. **A record omits every empty field** (`""`, `[]`,
  `false`). *(0.2)* **Measured:** a record created with one field reads back with that one field, and a cleared field vanishes from the record. A first-page `offset` looks like `itr9O5nlW8wMQnSVT/recC2oSW4KkaziPa8` and the last page carries none. `pageSize=500` is `422 INVALID_PAGE_SIZE_ARGUMENT`, a bad offset `422 INVALID_OFFSET_VALUE`, a bad formula `422 INVALID_FILTER_BY_FORMULA`, an unknown view `422 VIEW_NAME_NOT_FOUND`. The `LIST_RECORDS_ITERATOR_NOT_AVAILABLE` death is unmeasured, and so is the 16,000-character URL cap.
- **Writes.** Create, update and delete take up to 10 records a request. **Corrected for create:** a create of 11 and of 12 answered `200` and wrote every record, and a create of 101 is `422 INVALID_RECORDS "A maximum of 25 records can be created per request but you have provided 101."`, so the create cap is **25**, with 26 not probed. The update and delete caps are unmeasured. `PATCH`
  updates the fields given, and **`PUT` clears every field not given**. **Measured:** a `PATCH` sending `null` clears the field, and so does `""` on a multilineText, so Invariant 9 holds on the wire and an explicit `null` is the one spelling to send. A `PUT` of one field out of five left only that one (read before and after). A single-record `PATCH`/`PUT` takes `returnFieldsByFieldId` in the BODY: in the query string it is ignored and the answer is keyed by name. An
  upsert (`performUpsert.fieldsToMergeOn`, 1–3 non-computed fields) creates on
  zero matches, updates on one and **fails on more than one**, and its answer
  lists `createdRecords` and `updatedRecords`. **Measured:** the upsert is a `PATCH` on `/v0/{base}/{table}` with `performUpsert` and `records`. No match answered `createdRecords: [id], updatedRecords: []`, one match the reverse, and two matches `422 INVALID_VALUE_FOR_COLUMN "Cannot update more than one record for fields to merge on"` with nothing written. No write takes an idempotency
  key. A 2xx may carry `details.message: "partialSuccess"` or
  `"cellsRedactedDueToLimitedPermissions"`. *(0.2)* **Unmeasured:** no documented way to provoke either on an owner's own token was found, and none was tried past the brief. The `typecast: true` flag is measured: an unknown singleSelect value is `422 INVALID_MULTIPLE_CHOICE_OPTIONS "Insufficient permissions to create new select option"` without it, and with it the choice is created and the write succeeds.
- **Field keys.** Fields come keyed by NAME unless `returnFieldsByFieldId: true`,
  and a base's owner renames a field whenever they like. *(0.2, 0.4)* **Measured:** a read keyed by name unless `returnFieldsByFieldId=true` (query on a list or get, body on a create or a `POST …/listRecords`). A create answers by name unless its BODY says `returnFieldsByFieldId: true`. A write accepts a field id as a key, and an unknown key of either spelling is `422 UNKNOWN_FIELD_NAME "Unknown field name: …"`. Field keys in a record come out in alphabetical order, not schema order. A webhook payload is keyed by field id.
- **Errors.** The body is `{ error: { type, message } }` or `{ error: "<TYPE>" }`.
  `403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` uses one type for both "no
  access" and "no such table". `404 NOT_FOUND`, `422 INVALID_REQUEST_UNKNOWN`,
  `429 RATE_LIMIT_REACHED` and `503 RETRIABLE_ERROR` each have a type, and
  `401`, `413`, `500` and `502` have none. *(0.2)* **Corrected:** a missing record is **`403`**, not 404: a well-formed `rec00000000000000` and the bogus `recXXXXXXXXXXXXXX` both answer `403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` on a get and on a `PATCH`, as do a missing table and a missing base, so one type covers all three. `404` is unmeasured (a deleted record was not probed). `401` has a type (`AUTHENTICATION_REQUIRED`), and the 429 uses the plural `errors` array while every other error uses `error: { type, message }`. A link to a record that does not exist is `422 ROW_DOES_NOT_EXIST`, a link by name `422 INVALID_RECORD_ID`, a write to a count field `422 INVALID_VALUE_FOR_COLUMN "…cannot accept a value because the field is computed"`.
- **Schema.** `GET /v0/meta/bases` lists the bases a token reaches, and
  `GET /v0/meta/bases/{baseId}/tables` gives each table's fields with their ids,
  types and options. *(0.4)* **Measured:** the schema was read from `GET /v0/meta/bases/{baseId}/tables` for the field-type table below, and a currency field's `symbol` and `precision` sit in its `options`. `GET /v0/meta/bases` was not captured. The `tables.json` answer is captured in `packages/conduits/conduit-airtable/test/fixture/`, and the sink serves it.
- **Webhooks.** `POST /v0/bases/{baseId}/webhooks` answers a `macSecretBase64`.
  A notification is a **ping** carrying only `{ base, webhook, timestamp }`,
  signed `X-Airtable-Content-MAC: hmac-sha256=<hex>` over the body with the
  decoded secret. It is delivered at least once and may be coalesced or
  spurious. **Unmeasured:** the ping's raw bytes and MAC header, which need a tunnel (owner's). The changes themselves are pulled from `GET …/webhooks/{id}/payloads?cursor=N`
  (50 a page, `mightHaveMore`, keyed by `baseTransactionNumber`). Payloads are
  deleted after **one week**. A webhook made with a PAT or an OAuth token
  **expires after 7 days** unless refreshed, and pulling payloads refreshes it.
  Thirteen failed pings in about a day disable notifications, while payloads
  keep accruing. *(0.3)* **Measured:** `POST …/webhooks` with `notificationUrl` omitted is accepted and answers `{ id, macSecretBase64, expirationTime }` with the expiry exactly 7 days out (`2026-11-17T19:22:04.591Z`). A pull answered `{ payloads, cursor, mightHaveMore, payloadFormat: "v0" }` with `cursor: 3` after two transactions (`baseTransactionNumber` 37 and 38), so `cursor` is the next payload's number and not a transaction number. A created record is `createdRecordsById.{rec}.cellValuesByFieldId` and an update is `changedRecordsById.{rec}.current.cellValuesByFieldId` holding **only the changed fields**, both keyed by field id, with `actionMetadata.source: "publicApi"` and the acting user's id, email and name. A pull at the returned cursor answered `payloads: []` with the same cursor. `POST …/refresh` answered `{ expirationTime }` 7 days from the call. The list shows `notificationUrl: null`, `lastNotificationResult: null`, `areNotificationsEnabled: true`, `isHookEnabled: true` and `cursorForNextPayload: 3`. `DELETE` answered `{}`. The 7-day expiry, the payload retention and the 13-ping disable rule are unmeasured.

---

## Open questions

- ~~**Q1 — Scope and name.**~~ **Answered 2026-11-10 (`FJS-D2057`): A — `@frontierjs/conduit-airtable` in `packages/conduits/`, like its 28 siblings.**
  - **A** — `@frontierjs/conduit-airtable` in `packages/conduits/`, like its 28 siblings.
  - **B** — an app's own `providers/airtable.ts`, never a package.
  - **Recommend A** — `FJS-D1181` already admitted a vertical on the same terms, deferring *batteries vs. smallness* to promotion, and the hard parts (the rate per base, a ping that carries no data, a webhook that expires, `PUT`'s clear) are the ring of rules § The test's test two is about.
- ~~**Q2 — Who calls it first?**~~ **Answered 2026-11-10 (`FJS-D2056`): B — none yet: build Phases 0–3 against the sink and park the rest.**
  - **A** — a named app, Kobami or client, whose base it reads or writes. The owner names it.
  - **B** — none yet: build Phases 0–3 against the sink and park the rest.
  - **Recommend A if one exists** — 37signals' Phase 5 named Intake, and that caller cut the mirror claim from four nouns to three. With no caller, B, and Phases 4–6 stay open boxes.
- ~~**Q3 — Whose credential does the app spend?**~~ **Answered 2026-11-10 (`FJS-D2054`): A, with B as Phase 5.**
  - **A** — a PAT, the process's (`provider:airtable`), one bearer target.
  - **B** — OAuth, a person's (`per_caller`), refreshed hourly through `conduit-oidc`.
  - **C** — both, as a bundle (`airtableTargets() → { api, token }`, C1 — the bundle).
  - **Recommend A, with B as Phase 5** — a PAT fits C1 exactly and reaches every base its owner shares. `FJS-D1182` took both for Basecamp because a person's verb must appear as its author, but an Airtable edit shows the token's user either way. OAuth is owed only when an app's user connects THEIR OWN base from inside the app.
- ~~**Q4 — How does Airtable reach the app?**~~ **Answered 2026-11-10 (`FJS-D2055`): C, and only when Q2's caller needs inbound.**
  - **A** — no inbound: the app polls `LAST_MODIFIED_TIME()` through a formula.
  - **B** — webhooks: the ping wakes a pull, and the payload cursor is the source of truth.
  - **C** — B, plus a scheduled full read of each table as the floor.
  - **Recommend C, and only when Q2's caller needs inbound** — A misses deletions entirely, and B alone has holes: a week's retention and disabled notifications both lose payloads with no error. 37signals' scope walk (`FJS-D1180`) is the same floor.
- ~~**Q5 — How are fields keyed on the wire?**~~ **Answered 2026-11-10 (`FJS-D2053`): A — always by field id (`returnFieldsByFieldId: true`, ids in every write), with a name ↔ id map read from the schema.**
  - **A** — always by field id (`returnFieldsByFieldId: true`, ids in every write), with a name ↔ id map read from the schema.
  - **B** — by name, as Airtable defaults.
  - **Recommend A** — a renamed field under B silently stops matching, so a write lands nowhere and a read returns `undefined` with no error. That is the same failure as Invariant 2's three resolvers falling out of agreement. Under A, a rename changes nothing.

---

## Phases

### Phase 0 — Groundwork

Goal: real shapes measured against a real base, not read from docs.
Done when: scrubbed fixtures are on disk, every *(0.x)* fact above is marked measured or corrected, and the field-type table is filled.

- [x] 0.1 **Owner's step:** a scratch base on a free plan, holding no client data, and a PAT scoped `data.records:read`, `data.records:write`, `schema.bases:read` and `webhook:manage` on that base alone. Record the token's prefix and where it is kept, never the token. Recorded: PAT prefix patG2d, kept in packages/conduits/conduit-airtable/.env, gitignored
- [x] 0.2 Capture records with `curl`: a list (two pages and a filtered page), a get, a create of 1 and of 10, a create of 11, a `PATCH` sending `null` (does it clear? Invariant 9), a `PUT`, an upsert creating and one updating, an upsert matching two, a `404` record, a `403` on a missing table, a `422` on an unknown field, and a `429` (does `Retry-After` come?). Provoke `partialSuccess` if a documented way exists. Fixtures go to `test/fixture/`, and raw dumps stay in the scratchpad
  - Not measured: a `404` (a missing record is a `403`), the update and delete caps, `partialSuccess` and `cellsRedactedDueToLimitedPermissions`. The scratch base's records were left in place when the session's classifier refused the delete (see the report), so a cleanup of Scratch / Upsert / Dup rows in Clients, Projects and Tasks is owed
- [ ] 0.3 Capture a webhook end to end: create (record the expiry it answers), a ping's RAW bytes and headers through a tunnel, a pull of payloads, a pull at a cursor past the end, and a refresh
  - [x] create, pull of payloads, pull at the cursor past the end, refresh, list and delete, measured
  - [ ] ping bytes and MAC header: owner's, needs a tunnel
- [x] 0.4 The field-type table below: for each type, the JSON a read answers, what a write takes, and what an empty value looks like (omitted). Currency (a float, with its symbol and precision in the field's options), date and dateTime (time zone), linked records (ids), lookup and rollup (computed, so a write refuses them), attachments (URLs that expire), checkbox (`false` is omitted), select (a name, not an id)

#### Airtable field types

Filled by 0.4. The columns are *read*, *write*, *empty*, and *C-clause*, the
last naming where the connector converts something (C7 for currency, C9 for a
computed field a write must refuse locally). Measured on 2026-11-10 against the
scratch base; "unmeasured" rows are types the base lacks, and `Retry-After` and
the rest of the transport sit in the section above.

| Type | Read | Write | Empty | C-clause |
| --- | --- | --- | --- | --- |
| singleLineText, multilineText, email, phoneNumber, url | a string (`"line one\nline two"`) | a string; the field is not validated beyond its type on these | omitted; `null` or `""` clears | none |
| multipleRecordLinks | `["recsCLwK3j6Bk5BYM"]`, ids only | `["recId"]`. A primary-field value is `422 INVALID_RECORD_ID`, a missing id `422 ROW_DOES_NOT_EXIST` | omitted. Clearing with `[]` is unmeasured | none; the reverse link field is filled by Airtable |
| singleSelect | the choice NAME (`"Discovery"`), never the id | a choice name or a choice id, both accepted and answered as the name. An unknown one is `422 INVALID_MULTIPLE_CHOICE_OPTIONS`, and `typecast: true` creates it | omitted | name is the key: a renamed choice changes what a read answers, so map ids from the schema's `options.choices` |
| date | `"2026-11-10"`, a string, `YYYY-MM-DD` for an `iso` field | `"YYYY-MM-DD"`. `"11/10/2026"` was accepted without `typecast` and read back `2026-11-10`, and with `typecast: true` it was `422 INVALID_VALUE_FOR_COLUMN` | omitted | send ISO only |
| currency | a number (`1234.5`) even though the field's `precision` is 0; symbol and precision are in `options` | a JSON number | omitted | C7: minor units of the stored value; precision is display only |
| count | an integer, and **`0` when nothing is linked** (not omitted) | refused: `422 INVALID_VALUE_FOR_COLUMN "Field \"Total Tasks\" cannot accept a value because the field is computed"` | `0` | C9: refuse a computed field locally |
| singleCollaborator | `{ "id": "usr…", "email": "…", "name": "…" }` | `{ "id": "usr…" }` | omitted | none |
| number | a JSON number (`2.5`) | a JSON number | omitted by the omission rule, but an empty number was not read | none |
| checkbox, dateTime, attachment, lookup, rollup, formula, multipleSelects | unmeasured | unmeasured | unmeasured | unmeasured; the base lacks them |

### Phase 1 — Rulings

Goal: Q1–Q5 answered.
Done when: each Q names an `FJS-D`.

- [x] 1.1 Q1–Q5 through the question tool, then written into `DECISIONS.md` — `FJS-D2053`–`FJS-D2057`, 2026-11-10

### Phase 2 — Records

Goal: the connector's read and write half, against a sink.
Done when: `bun run test` in the package is green, and the drive's negative control fails with the feature removed.

- [x] 2.1 Scaffold `packages/conduits/conduit-airtable/` on conduit-37signals' layout: `README.md`, `CLAUDE.md`, `PROJECT_STATE.md` (Invariant 17), TypeScript (`FJS-D890`), `airtableTarget({ ref })` with a bearer token at `https://api.airtable.com`, and the group's row in `DRIVES.md` and the README table
  - Built 2026-11-10. `DRIVES.md` and `docs/` name no per-connector row (the group has one), so the README table in `packages/conduits/` is the one place. `peerDependencies` adds `@frontierjs/toolbelt` for the currency codec (3.2)
- [x] 2.2 `translate()` (C3), reading the status before the type: `401` → `auth_failed`; `403 INVALID_PERMISSIONS*` → `forbidden`, because the type cannot tell no access from no table and a good token must not be forgotten over it; `404` → `gone`; `422` → `invalid_request` with Airtable's type in `code`, except `LIST_RECORDS_ITERATOR_NOT_AVAILABLE` → `refused`, `code: 'iterator_expired'` (37signals' cursor re-entry shape). No kind is coined; the kinds are conduit's `CONDUIT_ERROR_KINDS` plus the domain words siblings already use; `429` → `rate_limited` with 30 s supplied when no `Retry-After` comes (C5 — google-maps); `502`/`503` → retryable
  - Per decision 1: the status is read before the type and BOTH error shapes parse; `403` is `forbidden` for a missing record, table and base alike, `422` is `invalid_request` with Airtable's type in `code`, a `5xx` is conduit's own `server_error` rather than a kind coined here
- [x] 2.3 Reads: `listRecords` (sent as `POST …/listRecords`, so a long formula never meets the URL limit) walked by `offset`, restarting the walk once on `code: 'iterator_expired'`; `getRecord`. Field keys follow Q5. A read fills every field the schema names, and a key Airtable omitted becomes the type's empty value, so the caller never confuses empty with unknown
  - Per decisions 3 and 4: `returnFieldsByFieldId` is in the body of every `POST …/listRecords`, and `getRecord` is the one GET (a query). `listRecords` and `getRecord` take the table from `baseSchema` as `schema` (or a `fields` list); without one they return what Airtable sent
- [x] 2.4 `formula`: the one builder of `filterByFormula`. A caller's value is always quoted and escaped, and a field is named by `{id}`, never by caller text. This is Invariant 8's rule applied to Airtable's formula language, and the drive's negative control is a value holding `"` and `)` that matches every row once the escape is removed
  - `Formula` has no constructor and a string is refused by `listRecords`. Negative control is `x' != 'y")`: 0 rows through the builder, every row once the escape is removed. Airtable's escapes (`\'`, `\\`, `\n`) are the docs' and unmeasured
- [x] 2.5 Writes. `createRecords` refuses more than 10 locally (C9) and is unkeyed and unreplayable (C5). `updateRecords` is `PATCH` only, and `replayable: true`, because it writes values rather than deltas. `PUT` is never sent, since one omitted field clears a cell. `upsertRecords` with the caller's own key field as `fieldsToMergeOn` is `replayable: true` (C5 — mattermost, a key in the body), and two matches come back as `conflict` with `code: 'ambiguous_match'` (Stripe, n8n and Cloudflare already say `conflict`). `deleteRecords` is replayable, and a `404` on its replay is `gone`. Each write sends `typecast: false`, so a value is never coerced silently
  - Per decisions 2, 5 and 6: one cap of 10 on create, update, upsert and delete (a create took 25, measured); `deleteRecords` is `replayable: true` and a replayed delete answers (in the sink) a 403, which `translate` calls `forbidden` and never `gone`, the real answer unmeasured; `PUT` has no code path at all
- [x] 2.6 C4 and C6. `validate` refuses `partialSuccess` per 0.2's measurement. A lost `createRecords` returns an `attempt`, and `findCreated(send, attempt)` reads the table filtered by `CREATED_TIME()` since the attempt and matches the written fields (C6 — 37signals). The README says an upsert needs no such read
  - Per decision 8: `noPartial` refuses `partialSuccess` and `cellsRedactedDueToLimitedPermissions`, both unmeasured and fabricated by the sink. `findCreated` returns `found` aligned with the records sent (a row or `null`), each row used once
- [x] 2.7 `sink.ts` (C10) answering the five chaos cases, decoding the JSON body by hand, enforcing 10 records a request, omitting empty fields on read, and dying an `offset` on arm. The drive (C11) covers each row from 2.2–2.6
  - `sink.ts` answers from the fixtures; the chaos cases are `rateLimit`, `failNext`, `lost`, `offsetDies: n` and `partial`, plus `/_sink/seed` and `/_sink/rename`. It caps at 10 on every verb, not the measured 25. 59 drive rows green

### Phase 3 — Schema and field types

Goal: a field's value means what its type says.
Done when: the drive proves a currency field reads as minor units, a computed field is refused before a send, and a renamed field still reads under Q5.

- [x] 3.1 `listBases`, `baseSchema(baseId)` → tables with fields keyed by id, typed per 0.4's table
  - `baseSchema` answers tables with `fields` keyed by id. The sink's schema answer is `tables.json`, the real `GET …/tables` (four tables, the reverse links, every choice id, the count definitions)
- [x] 3.2 Field codecs from 0.4: currency → `{ amount, currency }` through `@frontierjs/toolbelt/units` (C7), dates kept with their zone, attachments returned with the expiry their URLs carry, and a lookup, rollup or formula refused in a write by name (C9)
  - Per decisions 9 and 10: currency is `{ amount, currency }` in minor units ONLY for a field the caller gave a code (`currencies: { [fieldId]: 'USD' }`), minor units of the stored value (1234.5 with `USD` reads 123450; `precision` is display only), through `toMinor`/`fromMinor` from `@frontierjs/toolbelt/units`, which fits as is. Dates are ISO only (refused locally), a computed type is refused by id, attachments and every unmeasured type pass through. "Dates kept with their zone" is dropped: `dateTime` is unmeasured
- [x] 3.3 The README's limits paragraph covers the 5-a-second budget per base (conduit holds no limiter per target, so pacing is the caller's), `PUT`, the week's payload retention, and an attachment URL's lifetime
  - In `README.md` § Limits. The attachment URL lifetime and the delete replay are marked unmeasured

### Phase 4 — Inbound (if Q4 is B or C)

Goal: a change in a base reaches the app once.
Done when: the drive proves a forged ping is refused, a replayed ping only causes a pull, a payload is applied once by `baseTransactionNumber`, and a webhook near expiry is refreshed.

- [ ] 4.1 `verifyAirtablePing({ rawBody, headers, secret })` (C8, HMAC family): hex digest after `hmac-sha256=`, compared in constant time over the RAW bytes. The ping carries no data, so a replay costs one pull and changes nothing. The verifier therefore takes no freshness window, and that is a C8 amendment
- [ ] 4.2 The pull: a Dialect for `app.conduit.receive()` whose apply walks payloads from the stored cursor while `mightHaveMore`. The cursor persists only after apply, and the dedupe key is `webhook:<id>:<baseTransactionNumber>`
- [ ] 4.3 Lifetime: a job refreshes each webhook before day 7 and turns notifications back on after they are disabled. A gap in the cursor (payloads aged out) triggers 4.4
- [ ] 4.4 The floor (Q4 = C): a scheduled full read of each watched table, which is the only way a row deleted inside a gap ever leaves

### Phase 5 — A person's credential (if Q3 is B or C)

Goal: an app's user connects their own base.
Done when: the drive proves a code exchange, an hourly refresh, and a burned refresh answered `grant_lost`.

- [ ] 5.1 `airtableTargets() → { api, token }` (C1 — the bundle), with PKCE and refresh through `conduit-oidc`'s `exchangeCode` / `refreshTokens` given `{ token_endpoint }` by hand, since Airtable publishes no discovery document. The refresh token rotates, so a replay is `grant_lost` (C6 — oidc). The token is stored `@encrypted` in the app (`FJS-D1126`)

### Phase 6 — The first caller

Goal: the app Q2 names reads or writes its real base through the connector.
Done when: that app's own drive passes against the sink, and one owner-run call reaches the real base.

- [ ] 6.1 Wire Q2's app: install the target, spend the PAT from its env check, and replace any hand-rolled `fetch`
- [ ] 6.2 If that app LISTS an Airtable table on a screen, open the mirror-claim question (`mirror-apps.md` rule 1). Until then there is no claim

---

## Not planned

A mirror claim, until 6.2 earns one · adopting a base as `db/schema.lite`, where a
table becomes a model and its fields become columns, which is the `discovery`
skill's existing-database case and `tenant-declared-fields.md`'s territory rather
than a connector's · attachment upload (`content.airtable.com`, base64, 5 MB) ·
comments, interfaces and automations · the Enterprise and SCIM APIs · the
deprecated user API key.

## See also

- `conduit-37signals.md` — the plan this one is shaped on: a feed walked by cursor, `findCreated`, and a scope walk as the floor
- `conduit-connectors.md` § The test — why a vertical is admitted on `FJS-D1181`'s terms
- [Airtable Web API](https://airtable.com/developers/web/api/introduction) · [rate limits](https://airtable.com/developers/web/api/rate-limits) · [errors](https://airtable.com/developers/web/api/errors) · [list records](https://airtable.com/developers/web/api/list-records) · [update records](https://airtable.com/developers/web/api/update-multiple-records) · [webhooks](https://airtable.com/developers/web/api/webhooks-overview) · [webhook payloads](https://airtable.com/developers/web/api/list-webhook-payloads) · [OAuth](https://airtable.com/developers/web/api/oauth-reference)
