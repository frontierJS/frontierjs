---
id: import-intent
status: proposed
dated: 2026-11-28
---

# Idea — `litestone import` generates litestone's own words

**Status: PROPOSED. Nothing here is built.** Dated 2026-11-28. The counts are a
name-match over the eighteen corpus fixtures on this date and are leads, not
measurements of precision. See `VERIFYING.md`.

## The gap

`litestone import` writes only what the source schema stated: `@map`, `@default`,
`@relation`, `@@index`, `@id`, `@@check`, `@@unique`, `@big`, `@@arc`, `@scale`.
Across the 18 corpus fixtures (1,500+ models), litestone's own vocabulary appears
once, in hand-written `chinook.lite`. `packages/litestone/docs/import.md` § After the import says so:
the source had nowhere to say an access rule or `@@softDelete`, so the output is a
plain ORM.

The output is therefore a faithful port and a poor example. A person porting a real
app gets no hint where litestone would say more, and the corpus never exercises those
features against shapes this project did not invent.

| Column shape in the corpus | Count | The word a person would write |
| --- | --- | --- |
| `deleted_at` / `discarded_at` | 90 | `@@softDelete` |
| `email` | 186 | `@email` |
| password / digest / hash | 64 | `@hashed` |
| `token` | 167 | `@secret` or `@encrypted` |
| tenant-style FK (`accountId`, `teamId`, `organizationId`, …) | 549 | `@@scope` / tenancy |
| `status String` | 31 | an enum, perhaps `@@transitions` |

## The proposal

**The importer generates the attribute**, not just a report of it. The owner leans
generate (2026-11-28); the report-only form, graded `noted` like
`polymorphic-candidate` in `src/import/polymorphic.js`, is the fallback for a
pattern whose evidence is too weak.

Every generated attribute is still recorded in `gaps.json`, so the person can audit
what was inferred and strip it. That keeps the refusal list the artifact
(`packages/litestone/test/fixtures/corpus/README.md`) while the `.lite` becomes a
real example.

**Why generation is not free.** Several of these words change behavior, so a wrong
guess changes what the app does, not only what the schema says:

- `@@softDelete` changes every read. Strong evidence exists: Mastodon's 43 partial
  uniques `where deleted_at IS NULL` are the source stating soft-delete in its own
  words, and they are the uniques the importer currently drops.
- `@hashed` changes every write. A Devise/`has_secure_password` column already holds
  bcrypt digests; whether `@hashed` verifies them or double-hashes is Q4.
- `@email` is a validation; an existing malformed row refuses on its next update.
- `@encrypted` needs a key and a data migration; `@secret` does not.
- Tenancy needs a claim design the source cannot supply.
- An enum needs its values; only a SQL `CHECK (status IN (…))` carries them.

## Open questions

- **Q1** — Generate by default, or behind a flag on `litestone import`? Owner leans
  generate; a lean, not a ruling. **Recommend:** generate by default for the
  annotate-only words (Phase 2), and keep `@@softDelete`, `@hashed` and tenancy
  report-only as `noted` until Phase 0 measures them. Precedent is
  `polymorphic-candidate`. A flag adds a convention and records nothing. Rule this
  after Phase 0.
- **Q2** — The grade of an inferred attribute in `gaps.json`: a new grade (`inferred`)
  or `changed`? **Recommend `inferred`** in `src/import/tiers.js`: a generated line
  graded `changed` or `noted` cannot be told from a stated one in the summary count.
  Rule before Phase 2.
- **Q3** — What counts as evidence per pattern: the name alone, or name plus shape
  (`deleted_at` plus a partial unique on it; `email` plus `@unique`)?
- **Q4** — Is `@hashed` safe over a column already holding bcrypt digests?
- **Q5** — Tenancy: generate `@@scope`, or report only?

## Plan

### Phase 0 — Measure precision

Goal: know, per pattern, how often the name means what it looks like.
Done when: a table of candidates and hand-checked false positives per pattern, over
all 18 fixtures, written into this file.

- [ ] 0.1 Count candidates per pattern per fixture from `src/import/` output
- [ ] 0.2 Hand-check a sample of each against the upstream source
- [ ] 0.3 Read `@hashed`'s write and compare paths for Q4

### Phase 1 — Rulings

Goal: Q1–Q5 ruled.
Done when: each Q cites its `FJS-D` in `DECISIONS.md`.

- [ ] 1.1 Rule Q1–Q5 with the owner

### Phase 2 — Generate the patterns that only annotate or validate

Goal: `@email`, `@secret`, and enums from `CHECK … IN` generated, each recorded in
`gaps.json`.
Done when: the corpus regenerates, every fixture passes parse, types, build and a
second start-up with nothing to migrate, and `test/corpus.test.ts` counts each
pattern per fixture and fails a generated attribute with no `gaps.json` row.

- [ ] 2.1 One shared inference pass beside `polymorphic.js`, run by all three readers.
  `polymorphic.js` only detects; name the seam that emits before building it
- [ ] 2.2 `@email` and `@secret`
- [ ] 2.3 Enums from `CHECK … IN`

### Phase 3 — Generate the patterns that change behavior

Goal: `@@softDelete`, `@hashed` and tenancy as Phase 1 ruled.
Done when: as Phase 2, plus the `@@softDelete` partial-unique interplay
(`@@unique(where:)` never gets the clause, `FJS-614`) holds on Mastodon's 43.

- [ ] 3.1 `@@softDelete`, with partial uniques on its column kept rather than dropped
- [ ] 3.2 `@hashed` per Q4
- [ ] 3.3 Tenancy per Q5

### Phase 4 — Docs

Goal: `packages/litestone/docs/import.md` § After the import describes what is now generated.
Done when: `test/doc-examples.test.ts` passes on the page.

- [ ] 4.1 Rewrite § After the import and the corpus README's audit section
