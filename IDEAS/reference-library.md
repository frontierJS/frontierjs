---
id: reference-library
status: proposed
dated: 2026-08-30
---

# Idea — a reference library: whole schemas, chosen because somebody solved that domain

**Status: PROPOSAL. Nothing built.** Dated 2026-08-30. **The availability half is
measured and the judgement half is not.** Every path in § *Readable today* was
probed over HTTP on 2026-08-30 and the byte counts are real; every claim that an
application models its domain WELL is an assessment made from outside its tree,
so treat it as a lead to verify rather than a fact (`VERIFYING.md`). Four
candidates that a reading-from-memory would have listed do not ship a schema file
at all, and the probe is the only reason that is known.

---

## Trigger

*"A library of reference litestone schemas to compare and contrast how to model
data the best ways for the right use cases."*

The tree already has two things that are nearly this and neither is it.

**`packages/litestone/test/fixtures/corpus/` selects for the wrong property.**
Its own README says so: *nothing here is a claim about how any of it should be
modeled*. Seven applications were chosen because they are large, foreign and
awkward — the point is to find what `.lite` cannot say, and it worked (251
partial indexes, 235 wide integers, `FJS-563` and `FJS-583` among the rest). A
corpus fixture is a **measurement**. Grading one of its files on whether it is
good modeling would break the thing that makes it useful.

**`packages/litestone/references/` selects for the right property at the wrong
granularity.** Three hand-written files, one model each, self-contained by
construction — `AuditEvent`, `Notification`, `Tag`. That answers *what columns
does a Notification need*. It cannot answer *what does a double-entry ledger look
like*, because the answer to that is six models and the relations between them,
and the constraint that makes the folder work (no `@relation` to a model the file
does not declare) is exactly what forbids it.

So the missing tier is a third: **whole schemas, one application each, carried
because that application is the best available answer to one modeling problem.**
A **judgement**, where the corpus is a measurement, and the two must not be
confused for each other in either direction.

---

## The unlock, which is bigger than any individual entry

**The `sql` reader already exists, so any application that boots into Postgres is
readable with no new reader code at all**: start its own `docker-compose`, run
`pg_dump --schema-only`, feed the result to `litestone import --from sql`.

That is a better source than the repository's own files, not merely a cheaper
one. A dump is post-migration truth — every partial index, every CHECK, every
foreign key as the database actually holds it — where a source file is whatever
the authors last wrote down, and misses whatever a later migration added.
Discourse and Lago are already in the corpus by this shape and cost nothing but a
URL.

It opens, with zero reader work: Saleor · Zulip · Sentry · PostHog · Plane ·
Keycloak · Flagsmith · Firefly III · Moodle · Odoo · Mattermost · Gitea. Every
one of those otherwise needs a front-end of its own.

The cost is that it needs Docker and several minutes per application, where
`fetch.mjs` needs a URL — so a fetched entry and a booted entry are not the same
kind of fixture and the directory should say which each one is.

---

## Readable today — probed 2026-08-30

Eight, against readers that already exist or a reader small enough to be
uncontroversial. Byte counts are the fetched file.

| Application | Path | Reader | What it is evidence of |
| --- | --- | --- | --- |
| **GitLab** | `db/structure.sql` · 2.9 MB | `sql` | the new scale ceiling, roughly twice ERPNext. Also the most reviewed schema in open source — they run a documented database-review process — and the namespace/group hierarchy is the multi-tenant reference |
| **OpenStreetMap** | `db/structure.sql` · 99 KB | `sql` | small and canonical: a versioned graph, free-form tags, and separate full-history tables. The sharpest contrast available to `@version` and `@@softDelete`, because it keeps history in a second table rather than on the row |
| **MediaWiki** | `sql/tables.json` · 118 KB | new, small — declarative JSON, the shape the `frappe` reader already reads | page / revision / slot / content, content-addressed. The reference content-versioning model, and it is four models where most projects write one |
| **Open Food Network** | `db/schema.rb` · 64 KB | `rails` | commerce with a supply chain and many enterprises over one catalogue. The only Rails commerce schema that is actually fetchable — Spree, Solidus and Redmine ship **no** `db/schema.rb`, which the probe is how we know |
| **Chatwoot** | `db/schema.rb` · 75 KB | `rails` | a multi-channel inbox: conversation, contact and inbox identity across channels that disagree about what a person is |
| **listmonk** | `schema.sql` · 22 KB | `sql` | the small end. One file, one job, no framework — a teaching example of a schema that is complete and stays legible |
| **Synapse** | `storage/schema/main/full_schemas/72/full.sql.postgres` · 53 KB | `sql` | an event DAG with state groups. Append-only and immutability taken further than anything else here |
| **Ghost** | `core/server/data/schema/schema.js` · 95 KB | new, small — a plain declarative JS object | a small, argued Node schema; the counterexample to *every JS app models by accident* |

---

## The list by problem, which is the axis that is useful

Organizing by application category produces a directory nobody opens. Organizing
by *which one do I read when I have this question* is the thing being asked for.

### Double-entry money — the corpus has nothing

Lago is billing, which is not a ledger; it prices and invoices and does not post
balanced entries. Directly relevant to `@money`, `FJS-D154` and
`@frontierjs/toolbelt/units`'s `allocate`.

- **Apache Fineract** (Liquibase XML) — core banking: loan schedules, accrual,
  charges, a general ledger. The reference for modeling financial *products*
  rather than transactions.
- **Firefly III** (Laravel migrations) — personal finance, and the
  transaction-journal-with-splits shape stated at a readable size.
- **TigerBeetle** — not importable and worth reading anyway: two structs,
  `Account` and `Transfer`, which is the shortest correct statement of
  double-entry in existence.

### Permissions — three rival models, and each is an argument

`FJS-D146` rules that the capability grid and the `@@gate` ladder compose, ANDed,
with the gate as the floor. That ruling was made against this repository's own
two apps. These are the three shapes the field actually ships.

- **Keycloak** — realm / client / role / group, with composite roles. The
  enterprise answer.
- **Moodle** — role × capability × **context tree**. The best hierarchical-scope
  permission model in open source, and the nearest neighbor to the inferred
  `@@tenant(via:)` scoping.
- **Ory Keto** — Zanzibar relation tuples. A tiny schema carrying an entirely
  different idea: a permission is an edge in a graph, not a column on a row.
  Read against `permission-sets.md`.

### Commerce depth

`example/` is a working shop and these are the depth references above it.

- **Saleor** (Django, or the pg_dump route) — channels, price lists, stock
  allocations, fulfillment. The deepest commerce model that is open.
- **Medusa** (TypeScript) — order edits, and tax and promotion as separable
  concerns.

### Inventory as a ledger

- **InvenTree** (Django) — stock item trees, allocations, build orders. Direct
  contrast to `verify:stock`'s *on hand minus unexpired holds*, which is this
  repository's own answer to the same question.

### Messaging

- **Zulip** — stream / topic / message, plus a `UserMessage` row per recipient.
  A famous and explicitly argued tradeoff, which is rarer than a good schema.

### Workflow and state

- **Redmine** — status transitions scoped **per role**, which is what
  `@@transitions` with a `@gate` compresses into one line. Worth reading for what
  the long form buys.
- **Zammad** — ticket state at production volume.

### Metadata-driven and user-defined fields

ERPNext is already in the corpus and is the strong case. The contrast set:

- **Directus** · **Strapi** — the modern collections/fields tables.
- **WordPress** `postmeta` — the anti-pattern, and worth one file precisely
  because it shows what the cost looks like at scale rather than asserting it.

### Grouping and observability

- **Sentry** — event against issue against group. A modeling decision almost
  everybody gets wrong on the first attempt.

---

## Readers, ranked by yield

| Reader | Cost | Opens |
| --- | --- | --- |
| **the pg_dump route** | no reader; a `docker-compose` and one command per application | Saleor · Zulip · Sentry · PostHog · Plane · Keycloak · Flagsmith · Firefly III · Moodle · Odoo · Mattermost · Gitea |
| **Django** — `models.py` and migrations | medium; migrations are declarative `CreateModel(fields=[…])` | the same list without booting anything, plus InvenTree, wger, DefectDojo |
| **declarative object** — Ghost's `schema.js`, MediaWiki's `tables.json` | small; both are the shape `frappe` already reads | two entries above, and most of the modern Node ecosystem |
| **Liquibase XML** | small | Keycloak · Fineract |
| **Laravel migrations** | medium | Firefly III · Kimai · Akaunting |

The Django reader is the one worth arguing about: it is the largest single unlock
and it is also the one the pg_dump route makes optional. The case for building it
anyway is that a dump loses the author's intent — a Django `models.py` says
`on_delete=PROTECT` and a `TextChoices`, where the dump says a foreign key and a
`varchar`.

---

## The shape of the directory, and the one rule it needs

`packages/litestone/references/apps/`, beside the per-model files rather than
replacing them, with `references/README.md` growing a section that says which of
the two a reader wants.

**Each file leads with what it is the best answer to.** That header is the whole
product — a directory of eleven large schemas with no statement of why each one is
there is a directory nobody reads twice. It should also say what the application
got WRONG where that is known, because a reference that only praises is one
nobody can calibrate against.

**The one rule: a judgement must never leak into the corpus, and a measurement
must never leak out of it.** The corpus README's *nothing here is a claim about
how any of it should be modeled* is load-bearing — it is what makes `gaps.json`
a report about `.lite` rather than about the applications. This new directory is
the opposite claim by construction, so the two need different words at the top of
each and probably a line in each pointing at the other.

Two files would then be in both, and that is correct rather than a duplication:
Cal.com is in the corpus because Prisma writes shapes `.lite` does not, and would
be in the library because recurrence, availability and time zones are hard and
they did it well. Same bytes, two jobs. The library entry should reference the
corpus file rather than copying it.

---

## What to actually do with it

**Start with the eight in § Readable today and nothing else.** Six need no reader
work at all, and the two small readers each pay for a second thing. That is a
directory that exists and is useful inside a day, against a plan that needs four
front-ends before the first file lands.

Then the question the corpus cannot answer is worth asking of it: *what does
`.lite` make AWKWARD that these all express easily?* The corpus reports what
cannot be said. A reference library, read with a question in hand, reports what
can be said badly — which is the more expensive class and has no detector.

**License.** The corpus already vendors GPL-2, GPL-3 and AGPL derivatives, so the
precedent is set and its README carries the split. GitLab and Moodle are worth
checking before either is committed rather than fetched.

---

## Relationship to the other files

- `IDEAS/prior-art.md` — the same instinct one altitude up: read whole projects
  rather than mechanisms. This is its Data-realm half
- `IDEAS/permission-sets.md` — the gap Keycloak, Moodle and Keto each answer
  differently
- `IDEAS/polymorphic-relations.md` — the corpus already priced this; the library
  is where the good answers would sit
- `IDEAS/partial-indexes.md` — the largest thing the corpus found unrepresented
- `packages/litestone/test/fixtures/corpus/README.md` — the measurement, and the
  file this one must not become
- `packages/litestone/references/README.md` — the judgement at model granularity,
  and the folder this one extends
