# conduit-airtable — state

**Scaffolded 2026-11-10; sink-only, drive green (59 rows).** Phases 2 and 3 of `frontierjs/IDEAS/conduit-airtable.md`. Phases 4–6 (webhooks, a person's OAuth, the first caller) are parked: no caller is named (`FJS-D2056`).

- Drive green against: the sink, and Phase 0's scrubbed fixtures in `test/fixture/`. Measured against the owner's scratch base on 2026-11-10 (records, the 403 for a missing record, the plural 429 with no `Retry-After`, the create cap of 25, `PUT`'s clear, upsert). **Unmeasured:** a 404, the update and delete caps, `partialSuccess` and `cellsRedactedDueToLimitedPermissions`, a dead offset, a replayed delete, and the field types the base lacks. No live call is made by this package's drive.
- Conforms to the connector contract (`FJS-D890`): C1 (one bearer target, the builder reads no env), C3, C4, C5, C6 (`findCreated` matches on the written fields), C7 (currency only with the caller's code), C9 (batch cap, computed field, non-ISO date, id-keyed writes, formula), C10, C11. C8 and the OAuth bundle wait for Phases 4–5.
- Owed: the scratch base's Scratch / Upsert / Dup rows (plan 0.2); the probe for a replayed delete.
- 2026-11-10: Phases 2.1–2.7 and 3.1–3.3 built, sink-only.
- 2026-11-10 round 2: the sink answers the real `tables.json` (four tables); currency is minor units of the stored value, not rounded to `precision`; a replayed delete stays `replayable` with the delete-twice probe named unmeasured.
- FJS filed: none.
