---
id: schema-explorer
status: shipped
dated: 2026-08-22
---

# Idea — the schema surface is discoverable, and discovery ends in code

**Status: BUILT 2026-08-22, all five steps, all four readers.** What shipped:
`src/core/catalog.js` (86 words that morning, 89 by the end of the day — the
number moved twice under it while it was being written, which is the argument for
committing it rather than counting it; held against the parser's own `case` arms
in both directions by `test/catalog.test.ts`), `src/core/advise.js` (the
visibility table and five rules, 22 tests), three endpoints — `GET /api/catalog`,
`GET /api/advise`, `POST /api/preview` — and Studio's Explore panel. Proven by
`bun run verify:studio:explore`, 46 assertions in a real Chrome against a real
server. Four readers past that: `litestone explain`, the editor extension,
`catalog.snapshot.md`, and `docs/reference.snapshot.md`.

Six things it found, none of which this file predicted:

- **The catalog's own `@@gate` row was wrong.** The arity said
  `<create>.<read>.<update>.<delete>`; the order is read.create.update.delete and
  the levels must be non-decreasing, so the shipped example was one the access
  layer refuses. It passed the parse test because **`parse()` is more permissive
  than the layers above it** — the test now runs `deriveAccess` over every
  example too.
- **`CLAUDE.md` was wrong that `@guarded` and `@encrypted` cannot sit on one
  field.** Nothing refuses the pair, and `@secret` expands into exactly it. The
  line is corrected and the claim is now an `info` rule rather than an invariant.
- **Per-model DDL had no owner.** The preview assembled `generateTableDDL` +
  `generateIndexDDL` by hand and could see neither the FTS virtual table nor the
  `updatedAt` trigger, so adding `@@fts` previewed as no change at all.
  `generateModelDDL` is the one owner now and `generateDDL` calls it.
- **A blind append is barely better than no insert.** Appending `@@fts` writes a
  second model called `Example`; the card asks which model, and the surgery needs
  a string-aware brace scanner because `@generated(\`{a} {b}\`)` and
  `@check("… '%{%'")` both put braces inside quotes.
- **The `parser → catalog` gate caught a live change mid-session** — another
  session added `@@label` to the parser and the suite went red naming it, which
  is the mechanism working on a real change rather than a constructed one.
- **A rule set has to be calibrated against real schemas or it is noise.** The
  first cut of `gate-over-own-standing` fired five times on basecamp: two real,
  one plainly wrong (`Server.role` is a fleet role), two arguable — all as
  `error`. It now raises to `error` only where litestone can SEE the model is the
  standing (`@@auth`, or the model carrying the tenancy claim that declares
  `@@tenant(none)`) and asks a question everywhere else. The one it kept is
  [FJS-410](../ISSUES.md#fjs-410).

One more found by review rather than by the suite, and it is the sharper kind:
**`level` (which switch parses a word) is not the same question as where the word
is LEGAL.** An enum member may carry `@label("…")`, and the parser gets there by
calling `parseFieldAttribute` and refusing everything else — so the arm the
coverage test scrapes is the FIELD arm, and no source scan can see the third
position. A `positions` axis now states it, checked by DRIVING the parser rather
than reading it. The lesson generalises past this row: a completeness test built
on reading source is blind wherever the parser reuses a routine and filters
afterwards.

**The second reader is built**: `litestone explain [@word]`, with `--visibility`
and `--json`, 11 tests. It needs no server, no schema and no database, which is
what makes it evidence rather than a restatement — the module boundary is load
bearing, not decorative. **The third is built too**: `frontierjs-vscode` derives completion and hover from
the catalog, bundled beside the parser through the resolver it already had — so
no `exports` entry was needed and the published surface is untouched, which
corrects an assumption made earlier in this record. It found the sharpest
evidence for the whole idea: the editor's own hand-written list was missing 29
words, including four entire declarations, and nothing could tell. **The fourth
is built**: `litestone catalog --reference` writes `docs/reference.snapshot.md`,
the A–Z page — and it carries the same evidence one level out, because **forty of
the words had no entry anywhere else in `docs/`**, appearing inside samples or
not at all. Its examples are the catalog's own `probeFor`, so every sample on the
page is one the suite parses. `catalog.snapshot.md` commits the surface for a
reviewer, so a word whose arity or legality moves is a reviewable diff; the
reference page is the same rows for a person, and the two are deliberately
different renderings — prose churns and a snapshot that reshuffles on an edited
sentence is one nobody reads.

All four readers are built. The catalog's contract has now been tested from
outside once: `valueset` and `@values` arrived from another branch and the
completeness test went red naming both, which is the mechanism working on
somebody else's change.

**The original observation is now answered.** This file opens on it: *every
artefact this repo commits answers what did you declare; none of them can say
what you could have declared and did not, because a generated artefact is
derived from the seed.* `src/core/opportunities.js` is that second question —
nine checks for *legal and missing*, the sibling of advise's *legal and wrong*,
and the distinction carries all the way down: a rule has a **severity** because
it is a defect, a suggestion has a **confidence** because the schema is not
wrong. Every finding names the WORD it is about, as typed, which is what makes
it a route rather than a lint: in Studio the word is a button onto its card, in
`litestone advise` the row ends in the `explain` command and the docs page.

Four false positives, each found by pointing it at `example` and `basecamp`,
each teaching the check something true — `@guarded` is an access lock and not
at-rest protection; a `@transient` value has no column to be at rest in; nothing
in a schema distinguishes a catalogue from a possession; a `@@trait` use is
ERASED at parse, so the repeated-columns check has to compare against the
declarations that survive. Two `likely` findings stand on basecamp,
[FJS-410](../ISSUES.md#fjs-410) and [FJS-432](../ISSUES.md#fjs-432).

**Two more doors, both about reach rather than content.** `fli db:explain`
(aliased `fli explain`) is the terminal reader from where an app developer
actually stands — `fli` is what a scaffolded app installs and `litestone` is a
dependency of it, so a reader nobody can reach is not a reader — and it is the
one `db:` command that requires no schema, because the moment you most want to
look a word up is before the thing exists. `fli db:advise` is the same for the
two lists. And **every word now says where to read more**: `DOCS` in the catalog
is one block of 85 pointers, checked against the filesystem, with the three words
that have no page named and explained rather than left silently absent. Before
it, `seeAlso` only ever led to another word and all four readers dead-ended at
the blurb.

**The rule set is eleven, and the sixth new one was wrong on its first real
schema.** `index-another-index-already-covers` fired twelve times on basecamp and
nine were on `@@softDelete` models, where `ddl.js` emits every `@@index`
`WHERE deletedAt IS NULL` and every UNIQUE in full — so the shorter one is a
smaller partial index rather than a duplicate, and the rule was telling basecamp
to delete the better ones. That is the second time calibration against a real
schema changed a rule rather than confirming it (`gate-over-own-standing` was the
first), which is enough to call it the method rather than a precaution. The other
five new rules found ten unindexed foreign keys in basecamp, filed as
[FJS-413](../ISSUES.md#fjs-413).

---

## The observation

**Litestone's declarable surface is eighty-six words and there is no place that lists
them.** Counted off the parser's own dispatch on 2026-08-22: nine top-level
declarations (`import · database · tenancy · model · view · enum · function · trait ·
type`), fifty-five field attributes, twenty-two model attributes. `parseSchema` names all
nine in the error it throws for an unknown one; `parseFieldAttribute` and
`parseModelAttribute` are switch statements whose `case` arms are the only complete
inventory that exists.

Every artefact this repo commits answers *what did you declare*. `db/access.snapshot.md`
is the access surface you have, `db/jsonschema.snapshot.md` is the JSON Schema your
models emit, `db/ddl.snapshot.sql` is the DDL you generate, `surface.snapshot.md` is
the API you answer. None of them can say **what you could have declared and did not**,
because a generated artefact is derived from the seed and a word absent from the seed
is absent from everything downstream of it.

So the failure is quiet in the way this repo's worst failures usually are. Nobody gets
an error for never having heard of `@@fts`, `@derived`, `trait`, `function`, `@edge` or
`@sequence`. They write the application without them, at a cost nothing measures.

## What Studio already has

Studio holds the whole answer and does not show it. `GET /api/info` returns
`db.$schema` entire — `imports · tenancy · databases · models · views · enums ·
functions · traits · types` — so **the read half of an explorer needs no new
endpoint**. The write half needs none either: `POST /api/schema-validate`,
`/api/schema-diff`, `POST /api/schema-source` and `/api/migrations/create` are the
door the `schema.lite` editor already goes through.

What Studio has instead is two views on the same file that both assume you know the
language. `#schema` is an ER canvas, which draws model-to-model foreign keys and
nothing else — no enum, no type, no trait, no function, no database. `#lite` is a
textarea. Between *a picture of the relations you already wrote* and *the raw bytes*
there is no view that answers **what is this language, and what of it am I using**.

## The shape

A tenth Studio panel, or a second view inside `#schema` behind the pill tablist
`#access` already uses. Nine boxes, one per top-level word, each carrying its count.
A box with nothing declared is **greyed, never hidden, and still a full card** — blurb,
worked example, the traps, and a button that inserts a template into the `#lite`
editor. Dim means *you are not using this*; it must never mean *this is not available*,
because the boxes that are dim are exactly the ones the feature exists for.

Drilling into a box gives cards. A model card carries its gate, field count, relations,
row policies and protected fields; an enum card carries its values **and the number of
fields that reference it**, because an enum nothing references is a dead declaration
and no other view can see that. Traits and types and functions get the same count, and
it is cheap — one walk of the parse.

Below the declared attributes on a model card sits the sharper half: a strip of the
capabilities it has **not** declared — `@@softDelete`, `@@fts`, `@version`,
`@@log(audit)`, `@@transitions`, `@@gate`. That strip is already the vocabulary of a
live error. `CapabilityNotDeclaredError` is a 400 that names the model and the
attribute that would make the request legal, so Studio saying the same sentence before
the call is made is one vocabulary at two moments rather than a second explanation.

## Discovery has to end in code

An index that only tells you a word exists has moved the problem. The loop is five
hops and four of them ship:

```
grey box → card (what it buys, example, traps)
         → [+ Add] template into the #lite editor
         → /api/schema-validate   live, under the textarea
         → /api/schema-diff       what DDL this changes
         → /api/migrations/create name it, ship it
```

The fifth hop is the one that pays. **Studio's own surface is already gated on the
schema** — the Tenants nav is hidden until `tenancy` is declared — so adopting a
feature makes the tool grow: `@@fts` brings Optimize FTS into Maintenance,
`@@softDelete` brings the show-deleted toggle and the restore button into Browse,
`@@gate` populates the Access panel and gives the *Acting as* picker something to
change. Nothing has to be built for that; it is behaviour that exists and nothing
announces.

## The rail: one catalog, or the index lies

**The inventory must not be hand-written in `studio.html`.** An attribute added to the
parser and not to the panel makes the index quietly wrong, which is worse than no index
— the whole value on offer is that the list is complete.

So the inventory is `packages/litestone/src/core/catalog.js`: one row per word a person
can type, carrying its level, its argument form, the group it belongs to, a blurb, a
worked example, and its edges — what it excludes, what it is confused with. It is keyed
by **the written word**, not the parsed node kind, because `@@unique` parses to
`uniqueIndex` and `@secret` expands into three other attributes, and what an explorer
indexes is what you type.

The catalog is held true two ways, both executable:

- **catalog → parser.** Every row's example is parsed. A row describing a form the
  parser does not accept fails.
- **parser → catalog.** The `case` arms of the two attribute switches, and the nine
  words `parseSchema` names in its own error, are extracted and compared. A word in the
  parser with no row fails.

That second assertion is the feature. **A new attribute ships documented or it does not
ship**, on the same argument that keeps `checks.js` a single engine behind both
`fli check` and CI's `structure` phase: two inventories of one language is how the
language ends up with a word nobody can find.

## Why the catalog is worth more than the panel

Once it exists it has four readers, and the browser is only the loudest:

| Reader | What it gets |
| --- | --- |
| Studio Explorer | the boxes, the cards, the grey ones |
| `litestone explain @guarded` | the same rows in a terminal |
| `frontierjs-vscode` | hover and completion detail, which the extension hand-carries today |
| generated reference docs | one source for a page nobody maintains |

## The interview, later

The eventual form is the one that answers a question rather than an index: *can the
caller see this value? can the caller write it? does the application write it?* — and
lands on `@encrypted`, `@system`, `@transient`, `@guarded` or a field
`@allow('read', …)`. Those five are one confusion and the parser already carries the
table that separates them, four rows wide, in the comment above `@transient`.

The interview is worth building only after the catalog, because it is the catalog's
`excludes`/`seeAlso` edges walked as questions rather than new knowledge. What it adds
is **refusal**, which is the half a suggestion box cannot give: `@guarded` and
`@encrypted` cannot sit on one field; a required `@guarded` column makes the model
uncreatable below level 8; a `@system` column listed in create-mode `required` refuses
every create in the browser (`FJS-095`); and a `@@gate` is per model, so a gate on the
table `getLevel` reads from is a gate that lets any signed-in caller rewrite anyone
else's standing. Each of those is knowable at the checkbox and currently learned at
runtime.

## The rails that keep it honest

- **No regenerate button.** The committed snapshots stay the reviewed artefact and CI
  stays the gate — the same rule that kept the access panel safe (4.22). Explorer reads.
- **The wizard writes text, never DDL.** It goes through the editor, validate, diff and
  a migration file like any other schema change.
- **Two words need the file, not the parse.** `trait` is erased at splice time and
  `import` is inlined, so both count zero against `db.$schema` even when the file uses
  them. The explorer reads `/api/schema-source` for those two, or the index lies about
  the two features that are specifically about not repeating yourself.
- **Studio parses at boot** and holds it, so anything written has to reload — drift
  case C, already named in `studio-access-and-drift.md`.

## Order

1. `catalog.js` plus the two assertions. Valuable standing alone, and everything below
   is a reader of it.
2. Nine boxes and card drill-down off `/api/info`. No backend.
3. `+ Add` into the existing editor → validate → diff → migration door.
4. The capability strip, and the consequence preview: pick an attribute, see the DDL
   line, the access verdict, the JSON Schema keywords and the form control it produces
   — the four realms the seed fans out into, in one place, before writing anything.
5. The interview.
