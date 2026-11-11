# conduit-airtable — package map

`src/index.ts` `airtableTarget({ ref })`, `bindSend`, the reads (`listBases`, `baseSchema`, `listRecords`, `getRecord`), the writes (`createRecords`, `updateRecords`, `upsertRecords`, `deleteRecords`), `findCreated`, `noPartial` · `src/errors.ts` `translate` · `src/formula.ts` the one `filterByFormula` builder · `src/codecs.ts` the field codecs · `src/types.ts` · `sink.ts` · `test/airtable.drive.ts` · `test/fixture/` scrubbed bodies from the scratch base (its README lists each request). The plan is `frontierjs/IDEAS/conduit-airtable.md`; Phases 4–6 are parked (`FJS-D2055`, `FJS-D2056`).

## What bites

- **A missing record, table and base are all `403`**, never 404, so `translate` calls 403 `forbidden` and nothing may forget the token over it. `gone` (404) is unmeasured.
- **Fields are keyed by id, and `returnFieldsByFieldId` goes in the BODY.** On a single-record `PATCH` the query form is ignored and the answer comes back keyed by name. `getRecord` is the one GET and takes it as a query. A write keyed by a name is refused locally.
- **A cell Airtable holds empty is absent.** A read given the table's `schema` fills it; without one a key missing means empty, not unknown.
- **`PUT` is never sent.** One field omitted clears it. `updateRecords` is `PATCH`, and `null` is the one spelling that clears.
- **A batch is 10 on every verb**, though a create took 25 (measured). The connector refuses 11 before the send.
- **`formula` is the only builder of `filterByFormula`.** `Formula` has no constructor; a string is refused by `listRecords`. A value is quoted and escaped, a field is `{fld…}`, never a name. Removing the escape makes the drive's `x' != 'y")` match every row.
- **A create is never resent.** No key exists, so a lost one is `indeterminate` and `findCreated` is the way back, a match on the written fields since the attempt (120 s clock skew, as 37signals). An update, an upsert and a delete are replayable; a replayed delete's answer is unmeasured.
- **A 429 has no `Retry-After`** and the plural body `{ errors: [...] }`; 30 s is supplied. Pacing (5 a second per base) is the caller's; conduit has no limiter per target.
- **A currency has no ISO code in Airtable.** `currencies: { [fieldId]: 'USD' }` is the caller's; without it the number is untouched.
- **The sink's schema is `test/fixture/tables.json`**, the real `GET …/tables`; what `sink.ts` still invents is a dead offset's words, a delete's answer and `details.message` on a 2xx.
- **A fixture is scrubbed.** `fixtures.scrubbed` fails on a stray address or a token-shaped string; a new capture is scrubbed before it lands. The package `.env` holds a live token: never read, print or commit it, and no drive spends it.

## Proving a change

`bun run drive` — sink only. `bun run typecheck`.
