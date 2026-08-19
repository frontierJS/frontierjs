---
id: bulk-data
status: idea
dated: 2026-08-12
---

# Idea — Bulk data: the import screen every application builds by hand

**Status: IDEA. Nothing here is built for the user-facing case.** Dated 2026-08-12,
from the same sweep as `IDEAS/time-and-recurrence.md` — *what hard part of ordinary web
development does a developer still wire up by hand here.* Probed against the tree, and
the probe changed the record: **more of this exists than expected, aimed at the wrong
person.**

---

## What already exists, and who it is for

`packages/litestone/src/seeder.js` ships `parseCsv()` — a real RFC-4180 parser handling
quoted fields, embedded commas and newlines, `""` escapes, and a coercion rule with a
stated reason (*quoted values stay strings, which is how a fixture says "this really is
the text 0123"*). Above it, `loadFixture()` reads a `.csv` or `.json` and writes the
rows, optionally upserting on a named natural key:

```js
await loadFixture(db, 'Plan', './db/fixtures/plans.csv', { upsert: 'code' })
```

Its own header states the property that matters: *rows go through the ORM, so defaults,
validators, `@encrypted` and hooks all apply — a fixture is an ordinary write, unlike
`restore()`.* That is the correct design and it is most of the hard part.

**It is built for a developer at seed time, and three properties make it unusable for a
user at runtime**, each of them deliberate rather than an oversight:

- **It fails on the first bad row.** `table.create()` throws, the loop stops, and the
  rows before it are already written. A user uploading 4,000 rows needs *3,988 imported,
  12 rejected, here is why* — a report, not an exception.
- **There is no dry run.** Nothing can answer *what would this file do* before it does
  it, which is the single thing that makes an import screen feel safe.
- **It reads from the filesystem.** `fs/promises`, so there is no browser path and no
  Service path; nothing above the Data boundary can call it.

So the gap is narrower and sharper than "FJS has no CSV support". **The parsing and the
upsert are solved. What has no owner is the part where an untrusted file meets a
schema and a person has to be told what happened.**

---

## Why this is worth a record

Import and export is the most reliably requested feature in business software and the
most reliably hand-written. It is also the one where hand-written is genuinely
expensive: the parser is the easy 10%, and the other 90% is per-row validation with a
readable report, type coercion from strings, upsert on a natural key, partial failure,
progress on a file too big to hold in memory, and an export that does not leak.

**Every one of those is a fact the seed already states.** Column names, types,
`@unique`, required-ness, enum members, per-field validator messages, and — the part no
other framework has — *who is allowed to read this column*.

---

## The template is the piece worth building first

Raised as the framing for this record and it is the right instinct: the interesting
artefact is not the parser, it is **the empty file the user downloads before they have
any data.**

An import that begins with *upload a CSV* fails, because the user does not know what
columns you want, what an enum's legal values are, what format a date takes, or which
fields are required. So they upload something wrong, and the error report becomes the
documentation. An import that begins with *download the template* skips all of it.

The schema states enough to generate that file completely:

- **Headers** are the model's writable columns — which is already a computed set,
  since `autoValidate` deletes every key the model does not declare and `@computed`
  and `readOnly` fields are already excluded from the create schema.
- **Legal values for an enum column** are in the `$defs` table that
  `generateJsonSchema` already emits, and a `$ref` already resolves on both sides.
- **A required column is marked**, using `@label` for the human name — the same
  `title` the form layer reads, so the spreadsheet and the form call a field the same
  thing.
- **One example row** costs nothing, because model factories
  (`IDEAS/overview.md` 1.3) already generate a plausible row from field types and rules.

**And the same derivation validates the upload.** One function produces the template
and checks the file against it, so the two cannot drift — which is the failure mode of
every hand-written importer, where the sample spreadsheet in the help centre is a year
older than the validator.

This makes the template the *first* deliverable rather than a nicety: it is small, it
is entirely derived, and it is useful with no import path built at all. A team that
only ever gets `fli export:template Order` still got something.

---

## The frontend half is a screen, not a component

The import UI is a small state machine and it is the same one in every application:

**choose a file → map columns → preview and dry run → commit → report.**

Column mapping earns its place because real files come from somewhere else and the
headers never match — a template makes it a no-op in the good case, and the mapping
step is what saves the other case. The preview is the dry run rendered: *these 12 rows
will be rejected, these 40 will update existing records, these 3,948 will be created.*

The kit has more of this than expected. `FileUpload.mesa`, `Table.mesa` and
`Pagination.mesa` all ship; `<Form>` already owns the *"a thrown value becomes per-field
messages"* protocol via `toFieldErrors()` and `$context.form`, and a per-row error
report is that same shape with a row index in front of it. So the screen is a
composition rather than new primitives — **but it should not be a component in
`@frontierjs/ui`**, because it needs a resource, a schema and a service call, and the
kit's rule is that a component takes props. It belongs where the other derived UI
belongs, which is the `foundry` question (`IDEAS/overview.md` 1.1): the same generator
that can render a form from a model can render an import screen from one.

The export side needs no screen at all — a button and a route.

---

## Export is the half with the `only` claim in it

Import is a parity feature done well. **Export is where FJS can do something no
handler-based framework can**, and it is worth stating plainly because it is easy to
build the leaky version by accident.

An export is a read that leaves the building. It must therefore respect exactly what a
read respects: `@guarded` and `@encrypted` columns absent rather than redacted-looking,
`@@allow` row policies applied, `@@softDelete` honoured, the caller's gate level
deciding which columns appear at all. **A framework whose authorization lives in
handlers cannot derive this**, so its export is written against the table and quietly
returns the columns the UI hides — which is one of the most common real-world data
leaks and is nearly invisible in review.

Here it is the default if the export goes through the Service rather than the Data
boundary, and a disaster if somebody reaches for `asSystem()` to make the export
"simpler". That is the ruling this record most wants: **an export is a `find`, and a
column absent from the caller's read is absent from their file.** The escape hatch is
the one that already exists — a separate, gated service, the shape `/hub/` uses in
basecamp.

It also joins `IDEAS/compliance-from-the-seed.md` from the other end: a subject access
request *is* an export, scoped to one principal and traversing the relation graph. If
both are built the traversal should be written once.

---

## What has to be decided

- **Does an import go through the Service or the Data boundary?** Through the Service
  it fires hooks, announces on channels, writes audit entries and is gated — all
  correct, and 4,000 announcements is a problem. Through the Data boundary it is fast
  and invisible, which is the `db.asSystem()` trap `CLAUDE.md` already names for
  background jobs. The likely answer is the Service with a declared bulk announcement,
  which is a protocol question Junction's existing `{data, errors}` list shape is
  already half of.
- **What is the unit of failure?** All-or-nothing needs a transaction across 4,000
  writes; per-row needs a report and leaves the database partly changed. Both are
  legitimate and the user must choose, which means it is a stated option and not a
  default to guess at.
- **Where does a large file live while it is being processed?** This is an attached
  file, so it is Litestone's `FileStorage` — and it makes the import a long-running
  process, which is a Caravan job, which is the *resumable process* noun
  `IDEAS/declared-semantics.md` §4 already says the framework does not have.
- **Is an import idempotent?** Upsert on a natural key mostly makes it so, and the
  re-uploaded file is the common case. This wants the same *this work already
  happened* definition as `IDEAS/ecosystem-gaps.md` §14 and the deploy journal.
- **Formats.** CSV is the requirement; the requests will be for Excel, which is a real
  dependency and a real decision, and the honest first answer is *CSV and JSON, and
  Excel exports CSV*.

## See also

- `packages/litestone/src/seeder.js` — `parseCsv()` and `loadFixture()`, the developer
  half that already works
- `IDEAS/compliance-from-the-seed.md` — DSAR export, the same traversal with a
  different scope
- `IDEAS/forms-from-the-seed.md` — the derived-UI generator this screen belongs to
- `IDEAS/declared-semantics.md` §4 — the resumable-process noun a large import needs
- `IDEAS/ecosystem-gaps.md` §14 — inbound integrations; a file upload and a webhook are
  the same question about untrusted external data
- `CLAUDE.md` § Bridge index — `toFieldErrors()`, `$context.form`, `coerceToSchema()`,
  the pieces a per-row report is built from
