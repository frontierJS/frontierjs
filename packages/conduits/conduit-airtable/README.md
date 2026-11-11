# @frontierjs/conduit-airtable

Airtable over [`@frontierjs/conduit`](../../conduit/): a bearer target, records read and written by **field id**, the one `filterByFormula` builder, and the schema's field types. Sink-only so far; nothing here has been spent on a caller's base.

```ts
import { createConduit } from '@frontierjs/conduit'
import { airtableTarget, bindSend, baseSchema, listRecords, createRecords, updateRecords, eq } from '@frontierjs/conduit-airtable'

const conduit = createConduit({ credentials })               // the app's resolver holds the PAT
await conduit.register(airtableTarget({ ref: 'provider:airtable' }))
const send = bindSend(conduit)

const { tables } = await baseSchema(send, 'appXXXXXXXXXXXXXX')
const clients = tables!.find(t => t.name === 'Clients')!
const { records } = await listRecords(send, { baseId, table: clients.id, schema: clients, formula: eq(nameId, userInput) })
```

## What it covers

| Call | Airtable |
| --- | --- |
| `airtableTarget({ ref })` | one bearer target, `https://api.airtable.com`; the app installs it (C1) |
| `listBases`, `baseSchema(baseId)` | `GET /v0/meta/bases`, `…/tables`: tables with their fields keyed by id |
| `listRecords` | `POST …/listRecords` walked by `offset`; a dead offset restarts the walk once |
| `getRecord` | `GET …/{record}`, the one GET |
| `createRecords`, `updateRecords`, `upsertRecords`, `deleteRecords` | up to 10 records each; `PATCH` for the middle two, never `PUT` |
| `findCreated(send, attempt)` | did a lost create land? (C6) |
| `eq`, `and`, `or`, `not`, `createdSince` | the only way to a `filterByFormula` |
| `readValue`, `fillRecord`, `writeFields` | the field codecs, applied for you when a call is given its `schema` |

A call returns `{ <rows>, error? }` and never throws on Airtable's answer; it throws a `TypeError` for a request it can refuse itself (C9): a batch of 11, a field named rather than keyed by id, a computed field in a write, a non-ISO date, a formula that is a string.

## Fields are keyed by id

Every read and write uses `fldXXXXXXXXXXXXXX`, with `returnFieldsByFieldId: true` in the **body** of every `POST` and `PATCH` (the query form is ignored on a single-record write, measured). A base's owner renames a field whenever they like, and a name-keyed write then lands nowhere with no error (`FJS-D2053`). Read the schema once and keep the table: `fieldId(table, 'Budget')` turns a name you hold into the id.

Reads **fill every field the schema names**: Airtable omits an empty cell, so a key it did not send becomes the type's empty value (`''` for text, `[]` for links, `null` for a select, date, number, currency or collaborator, `0` for a count). Without a `schema` a record is what Airtable sent.

## Writes

- `createRecords` is **unkeyed and unreplayable**: Airtable takes no idempotency key. It returns an `attempt` on every outcome, and a lost answer (`indeterminate`) is resolved by `findCreated(send, attempt)`, which reads the table for rows created since the attempt (`CREATED_TIME()`) and matches each written record by the fields it wrote. `found` is aligned with the records you sent, `null` where one did not land. It is a match, not a key: two identical rows in the window are indistinguishable.
- `updateRecords` is `PATCH`: the fields given are set, `null` clears one, every other field is untouched. It writes values and not deltas, so it is `replayable: true`. **`PUT` is never sent**, not even as an option: it clears every field you did not give.
- `upsertRecords` takes `mergeOn`, one to three field ids that every record carries. No match creates, one updates, and two is `conflict` with `code: 'ambiguous_match'`, nothing written. The key is in the body, so it is `replayable: true`, and a lost answer needs no `findCreated`: send it again.
- `deleteRecords` is `replayable: true`. What a replay of an already-deleted record answers is **unmeasured**; the sink answers 403 because a missing record is a 403, and `translate` does not call it `gone`. The probe that settles it: delete one record, GET it, delete it again.
- Every write sends `typecast: false`, so a value is never coerced silently.
- `validate` refuses a 2xx carrying `details.message` of `partialSuccess` or `cellsRedactedDueToLimitedPermissions` as `invalid_response` with that word in `code` (C4). **Both words are the docs', unmeasured**; the sink fabricates them.

## Errors

`translate(error, status)` reads the status before the type.

| Status | Kind | Why |
| --- | --- | --- |
| 401 | `auth_failed` | the key |
| 403 | `forbidden` | `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` is a missing record, table and base alike (measured), so it cannot say the token is bad |
| 404 | `gone` | the docs' word; no 404 was measured |
| 422 | `invalid_request`, Airtable's type in `code` | `LIST_RECORDS_ITERATOR_NOT_AVAILABLE` is `refused` / `iterator_expired` (unmeasured), and an upsert matching two rows is `conflict` / `ambiguous_match` |
| 429 | `rate_limited`, `retryAfterMs: 30000` | no `Retry-After` comes (measured), so the docs' 30 s is supplied; the body is the plural `{ errors: [{ error, message }] }` |
| 5xx | conduit's own (`server_error`) | |

## Limits, and what is the caller's

- **Rate: 5 requests a second per base**, and 50 a second per user across that user's tokens. Conduit holds no limiter per target, so **pacing is the caller's**: sixty parallel reads on one base answered 40 and 429 for 20 (measured).
- **Batch: 10 records on every write.** Airtable took 25 on a create (11 and 12 answered 200, 101 was refused naming 25, 26 not probed); the connector still caps at 10 so there is one number and the documented update and delete cap is never exceeded.
- **A page is at most 100 records**; a URL under 16,000 characters is why a read is a `POST`. Neither the URL cap nor an offset dying is measured.
- **A webhook's payloads are kept a week**, and a webhook made with a token expires after 7 days. Webhooks are Phase 4 and not built; the numbers are in the plan.
- **An attachment's URL expires.** The expiry is unmeasured, and the type is passed through untouched: copy the file if you need it, never the URL.
- **A `forbidden` after a lost delete may mean the delete landed**: a replay of a deleted record is not called `gone`, and the delete-twice probe (delete one record, GET it, delete it again) is unmeasured.
- **`PUT`** clears every field not given (measured: one of five left, the other four cleared).

## Field types (Phase 3)

Only a type 0.4 measured has a codec; every other type passes through untouched.

| Type | Read | Write |
| --- | --- | --- |
| text, email, url, phone | a string; `''` when empty | a string; `null` clears |
| `singleSelect` | the choice **name**, never the id | a name or a choice id; an unknown one is `invalid_request`, since `typecast` is never sent |
| `date` | `YYYY-MM-DD` | ISO only; anything else is refused locally, because Airtable silently reads `11/10/2026` as a date |
| `currency` | Airtable's number, or `{ amount, currency }` in minor units when you pass `currencies: { [fieldId]: 'USD' }` | a number, or `{ amount, currency }` (integer minor units) when a code is given; a major-unit number is then refused (C7) |
| `count`, `formula`, `rollup`, `lookup`, `createdTime`, `lastModifiedTime`, `autoNumber` | as sent; a count is `0` when empty | refused by field id before the send (C9) |
| `multipleRecordLinks` | record ids; `[]` when empty | `['recId']`; a primary-field value is `422` |

**Why a currency needs a code from you:** a field's options carry a `symbol` and a `precision` and never an ISO code, and `$` is USD, CAD or AUD. Guessing one is the money bug C7 exists for, so with no code the number is left as Airtable's. With one, the cell becomes the minor units of the stored value (1234.5 with `USD` reads 123450): `precision` is how Airtable displays the cell and rounds nothing, so it is ignored. Conversion is `@frontierjs/toolbelt/units`.

## Not measured

A 404 (a missing record is a 403), the update and delete caps, `partialSuccess` and `cellsRedactedDueToLimitedPermissions`, a dead offset, a replayed delete, `checkbox`, `dateTime`, attachments, `multipleSelects`, lookups, rollups and formulas, and every webhook and OAuth line. `test/fixture/README.md` lists what was captured.

## Proving it

`bun run drive` — against `sink.ts` and the scrubbed fixtures; no network, no credential. Typecheck: `bun run typecheck`.
