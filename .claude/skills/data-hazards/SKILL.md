---
name: data-hazards
description: Litestone — a `.lite` schema, a gate or row policy, a migration, tenancy, encryption, a `@`-attribute, the audit trail. Correct-but-surprising behavior at the Data boundary; use when touching any of them.
---

# Data-realm live hazards

**Correct behavior you have to know about.** Things that are *wrong* live in `ISSUES.md`, one id each; things that are *fixed* live in `CHANGES.md`. If a rule here is pinned by a test that cannot be deleted quietly, it does not need to be here.

**The index below is each hazard's rule; its section's reference file holds the rest** — the mechanism, the measurement, and what it refuses. Read that file before changing code the rule is about.

## Schema and parse
Detail: `references/schema-and-parse.md`

- **Two owners decide whether a schema is legal, and the line between them is what CAN be expressed.**
- **A composite `@@unique` naming a NULLABLE column is a parse error, and single-column `@unique` over one is not** (`FJS-D130`)
- **`litestone introspect` output must PARSE, and the property that holds it is a FIXED POINT** (`FJS-594`)
- **A Litestone client THROWS on an unknown property, and `createClient` refuses an unknown OPTION by name**
- **A relative `database { path }` resolves against the process CWD, and a schema can be told otherwise.**
- **`@map` renames the COLUMN and nothing a caller touches**
- **`createClient({ db })` names MAIN's path and nothing else.**
- **A scaled column is bounded at 2^53 and a plain `Int` is not.**

## Soft delete and `@unique`
Detail: `references/soft-delete-and-unique.md`

- **A drive that cleans up through the API cannot free a `@unique` on a soft-deleting model, so a fixed fixture key makes it single-use** (`FJS-530`, `FJS-546`, `FJS-547`)
- **A soft-deleted row keeps its `@unique` values, and `restore()` is why.**
- **A soft-deleted parent's children have THREE fates and each has a spelling.**
- **A per-call flag the model cannot SATISFY is refused by name, and so is a method.**

## Gates, policies and claims
Detail: `references/gates-policies-and-claims.md`

- **`auth().x` is graded against a DECLARED set, and only where there is one** (`FJS-666`, `FJS-667`, `FJS-668`)
- **A `@@gate` refuses, a `@@allow` filters — so a wrong policy is an empty screen, not an error.**
- **A freeze that depends on STATE is not expressible, and `@@gate` is where you notice.**
- **`asSystem()` grades at 8, and `9` is LOCKED — not reachable through the ORM by any client.**
- **A cache keyed on the ctx OBJECT is shared across principals** (`FJS-722`)
- **You cannot run without gates.**
- **`$setAuth(user)` RETURNS a scoped client, it does not mutate.**
- **A CAPABILITY is a grid beside the ladder, and a finer grant REPLACES the coarse one rather than adding to it** (`FJS-D146`)
- **A `CHECK` fails only on FALSE, so a NULL passes it**
- **`asSystem()` does not bypass a `@check`, a `@@check` or an `@@arc`, and it bypasses everything else.**
- **Raw SQL requires `asSystem()` once a schema declares access rules.**
- **A field `@allow` is a PREDICATE and it is compiled into SQL, both ways** (`FJS-D129`)
- **`@guarded` is not a level**
- **A column your `getLevel` reads must not be writable by the caller being graded.**
- **A `9`-gated table cannot be tidied up, by anything**

## `@@transitions`
Detail: `references/transitions.md`

- **A BULK write may not name a transitions field** (`FJS-D182`)
- **A move asked for BY NAME is not the same question as an update carrying the column** (`FJS-611`)
- **A row that stops counting at a date and is also MOVED at that date has two answers until the move fires, and the date is the one to read** (`FJS-D353`)

## `@immutable` and encryption
Detail: `references/immutable-and-encryption.md`

- **`@immutable` is a column written once, and `asSystem()` cannot drop it either.**
- **A stored value names the KEY that wrote it** (`FJS-D183`)

## Tenancy
Detail: `references/tenancy.md`

- **Under `strategy database` four seams belong to the tenant path rather than the single-client path.**
- **Tenancy is declared in the seed and there are two strategies.**

## Migrations and release
Detail: `references/migrations-and-release.md`

- **A schema change is a deploy question before it is a migration**
- **The migration differ compares an ENUMERATED list of dimensions, so *in sync* means *in sync on every dimension it reads*.**
- **A new column with an EXPRESSION default costs a table rebuild, and one with no default at all is refused.**

## Columns and clocks
Detail: `references/columns-and-clocks.md`

- **Litestone emits columns verbatim camelCase and `DateTime` as ISO-8601 TEXT.**
- **Every timestamp litestone writes comes from the CLIENT's clock, and a raw `UPDATE` therefore stamps nothing.**

## The audit trail and the log
Detail: `references/the-audit-trail-and-the-log.md`

- **An audit row says WHERE the write came from, and junction is what tells it.**
- **A `driver logger` trail is written by every process, and the index database's write transaction is what serializes them** (`FJS-D180`)
- **An audit row names the TABLE, not the model**
- **An effective-dated write BACKWARDS overwrites the prior belief, and only the log holds it.**
- **`@@log(audit)` records a WRITE; `db.$audit()` records an EVENT — and the second one throws.**

## Reads and windows
Detail: `references/reads-and-windows.md`

- **A `where` refusal is a `ValidationError` — including an operator that does not exist** (`FJS-892`)
- **A modelless service's filters cannot be graded and do not need to be.**
- **An `include` is a SEPARATE statement, and `$tapQuery` reports it as one** (`FJS-891`)
- **A cursor and an offset never combine, and `$after` wins.**
  - **A cursor is caller-supplied text and is GRADED against the ordering using it** (`FJS-779`)
  - **A sort key carries WHERE ITS NULLS SIT, and a cursor compares against that** (`FJS-780`)
  - **`buildCursorWhere` never answers `''` when it was given a cursor.**
