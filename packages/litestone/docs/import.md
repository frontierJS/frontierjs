# Importing a schema

`litestone import` reads a schema you already have into `.lite` — a Prisma
schema, a Rails `db/schema.rb`, a PostgreSQL dump, or a Frappe app.

```bash
litestone import packages/prisma/schema.prisma --out db/schema.lite
litestone import db/structure.sql --out db/schema.lite --report gaps.json
litestone import ./erpnext --from frappe --out db/schema.lite --strict
```

| Flag | |
| --- | --- |
| `--from=prisma\|rails\|sql\|frappe` | the source format. Detected from the path when omitted; a stated one always wins, because a dump named `.txt` is still a dump |
| `--out=<path>` | write the schema. Without it the schema goes to **stdout** and the report to stderr, so `litestone import x.prisma > db/schema.lite` is a schema and not a schema with a report on top of it |
| `--report=<path>` | every unexpressed construct as JSON, tier included |
| `--strict` | exit 1 if anything **changed** meaning |

## The output is not the whole answer

A converter that prints only its output has quietly decided what to lose. This
one records every construct it could not express — with the model, the field,
what the source said and what was emitted instead — and that list is the half
worth reading.

Seven real applications produced 2,178 such records. Undifferentiated that is
noise, so each one is graded:

| | |
| --- | --- |
| **changed** | the schema says something the source does not. Reading it will mislead you — an invented primary key, an exact number turned into a float, a `NOT VALID` foreign key emitted as an enforced one |
| **lost** | the source says something the schema does not. Thinner, never wrong — a partial index's predicate, an array default, a view, an index name |
| **noted** | nothing lost and nothing changed: a decision only you can make, or a translation that is exact |

`--strict` fails on **changed** alone. A gate that also failed on `lost` would
fail on every real import — one of the seven carries 251 partial indexes — and a
check that always fires is one nobody reads.

An unknown kind grades `changed`, which is fail-closed on purpose: a reader that
learns a new refusal must not have it filed under *ignore me*.
`test/import.test.ts` reads every `gap('…')` literal out of the four readers and
fails on one the table does not name, so that default is a backstop rather than
the mechanism.

## Where the warning lives

The terminal scrolls away and the schema file does not, so both carry it:

```
// Imported from packages/prisma/schema.prisma.
//
// Read mechanically by `litestone import --from prisma`. 51 models.
//
// **26 constructs did not survive the reading**, and the counts are
// the point rather than the total:
//
//      5 changed  the schema below says something the source does not
//     17 lost     the source says something the schema below does not
//      4 noted    a decision for you, not a defect
```

…and every `changed` construct is marked on **its own line**, which is the only
place anyone is looking when a value turns out wrong:

```
  positionX Int @scale(2) @default(0)  // ⚠ imported: Decimal with no @db.Decimal(p, s) → Int @scale(2) — a GUESS
```

A model-level one — an invented key — is marked on the `model` line.

## What each reader is for

| Format | Source | Here for |
| --- | --- | --- |
| `prisma` | `schema.prisma` | the common case |
| `rails` | `db/schema.rb` | single-table inheritance, partial indexes, and the `(type, id)` polymorphic pair — none of which Prisma can express |
| `sql` | `pg_dump --schema-only`, `db/structure.sql` | CHECK constraints, views and native enums. It is also the only reader that emits `@@arc`: an exclusive arc written as SQL (`(a IS NOT NULL) <> (b IS NOT NULL)`, `num_nonnulls(…) = 1`) is read back as the constraint it is |
| `frappe` | a Frappe/ERPNext app directory | the only source that **declares** whether a polymorphic target set is closed. A `Dynamic Link` names the field holding its target doctype, and that field says which |

None of them repairs, renames or improves its input. A reader that quietly fixes
things up is one that cannot report anything.

## What it will not guess

**Polymorphism.** A `(commentable_type, commentable_id)` pair has two answers in
`.lite` — `@@arc` when the target set is closed and small, the pair itself when
it is open — and which is right depends on a fact the schema does not carry. The
importer reports the pair, names the column, and **never emits an `@@arc`**:
guessing *closed* invents integrity the source does not have, and guessing *open*
hides an arc the author should have written. See
[`references/Tag.lite`](../references/Tag.lite) and
[schema.md § Exclusive foreign keys](schema.md).

**Single-table inheritance.** A string `type` column is the Rails shape, and it
is also just a category in plenty of schemas. Reported as a candidate on the same
terms.

Both are `noted`, because neither is a defect.

## After the import

The schema is a starting point, not a migration:

1. Read the `changed` markers. Each one is a column whose meaning moved.
2. `litestone migrate create` — the schema describes tables that already exist
   elsewhere, so nothing here is a plan for adopting a live database.
3. Declare access. An imported schema carries no `@@gate`, no `@@allow` and no
   `@@softDelete`, because the source had nowhere to say them.

## Related

- [modeling.md](modeling.md) — writing a schema from scratch
- [schema.md](schema.md) — the language the output is written in
- [cli.md](cli.md) — every command with its flags
