---
id: scoped-sql
status: partial
dated: 2026-08-06
---

# Idea — Scoped SQL: raw queries against a derived view, not the base tables

**Status: THE HOLE IS CLOSED. THE DESIGN IS STILL UNBUILT.** Updated 2026-08-06.

`FJS-005` is closed, but **not by building what this file designs**. Raw SQL is
now available through `asSystem()` only, on any schema that declares access
rules — a refusal, not a scoped view set. `DECISIONS.md` § Access control has
the ruling; `packages/litestone/src/core/client.js` has the code.

Two things this file argues turned out to be wrong, both worth knowing before
the design is picked up again:

1. **"`db.sql` (no identity) → base tables. Unchanged"** (§Scope follows the
   proxy) does not hold. The unscoped client is the *widest* gap, not an
   acceptable one: an unauthenticated `db.invoice.findMany()` returns **0** rows,
   because the policy evaluates with `auth() == null` and matches nothing, while
   `db.sql` returned all 3. The ORM is at its most restrictive exactly where this
   file assumed there was nothing to enforce.

2. **The statement allowlist (§the load-bearing part) has no good mechanism.**
   SQLite's `sqlite3_set_authorizer` would be the right one — enforced inside
   SQLite at prepare time, immune to every naming trick — and **`bun:sqlite` does
   not expose it** (verified: `Database` has no `setAuthorizer`). That leaves a
   hand-written SQL validator as the only path, which is the piece whose failure
   mode is a FALSE guarantee. That risk, not the view derivation, is what makes
   the design expensive.

**Revisit with `herald`** (`IDEAS/agent-surface.md`) — the consumer that makes
scoped raw SQL a capability worth its cost rather than a speculative one. The
sections below are the design as argued; do not cite them as behavior, and read
the two corrections above first. See `VERIFYING.md`.

---

## Trigger

Agent-Native (`agent-native.com/docs`) scopes raw SQL by never letting it reach a
base table:

```
session.orgId → AGENT_ORG_ID → temporary VIEW → agent SQL
```

```sql
CREATE TEMPORARY VIEW "notes" AS
  SELECT * FROM main."notes" WHERE "owner_email" = 'x@y.com';
```

A bare table name can only return owned rows, and schema-qualified references are
rejected so the view cannot be stepped around. Their scoping key is a required
`owner_email` column on every table — a convention the developer maintains.

**Litestone can do this better, because it does not need the convention.** The
scoping facts are already declared.

## The hole today

`db.sql` is the raw escape hatch and goes straight to the read connection:

```js
async function sql(strings, ...values) {          // src/core/client.js:6306
  // ...builds `query` with ? placeholders...
  return readDb.query(query.trim()).all(...values)
}
```

No gate, no `@scoped`, no `@@allow`, no `@guarded`, no `@@softDelete`. For a
deliberate developer escape hatch that is defensible.

**The part that is not defensible: `db.$setAuth(user).sql` is the same function.**
`authSql` (`src/core/client.js:6627`) is byte-identical to `sql` — it closes over
`user` and never reads it. Directly beneath it, `authQuery` goes to real trouble to
keep auth context alive through `$transaction`, with a comment explaining that
without it "`$transaction` would pass `clientProxy` (unscoped) and silently strip the
auth context from every batched query."

So on the same proxy, built in the same closure: `query` preserves the scope, `sql`
silently drops it. A caller who has done everything right — `$setAuth(user)`, then a
raw query for something the ORM cannot express — gets every row in the table. Nothing
warns. This is a live gap in the auth proxy, independent of whether anything below
gets built.

## The idea

**Litestone materialises a scoped view set for the current identity, and raw SQL runs
against that view set only.**

```js
const scoped = db.$setAuth(user)
await scoped.sql`SELECT status, count(*) FROM invoices GROUP BY status`
//                                            ↑ the view, not the table
```

`invoices` in that statement resolves to a temporary view built from what the schema
already declares — not to `main.invoices`.

### What the view is derived from

This is where it beats the `owner_email` convention: every input already exists and is
already enforced elsewhere in litestone.

| Declaration | Contribution to the view |
| --- | --- |
| `@scoped` | the row predicate — the viewer's dimension, bound the same way `_makeScopedProxy` binds it |
| `@@allow` policies | additional row predicates, compiled to SQL as they already are for the ORM path |
| `@@gate` read level | whether the model gets a view **at all**. Below the read level, the name simply does not resolve |
| `@guarded` | **omitted from the view's column list.** Not nulled — absent |
| `@@softDelete` | `WHERE deletedAt IS NULL` |
| `@encrypted` | omitted, or the view is the wrong surface for it — see open questions |

`@guarded` is the one Agent-Native cannot do, because its view is `SELECT *`. Naming
the columns explicitly means `SELECT *` against the view **physically cannot** return
a withheld column — the strongest possible form of the invariant-7 promise, enforced
by SQLite rather than by a serializer.

### Scope follows the proxy

The rule should be the one already in force for every other accessor:

| Surface | Reads through |
| --- | --- |
| `db.$setAuth(user).sql` | the scoped view set for that user |
| `db.asSystem().sql` | base tables — `asSystem()` is the documented bypass |
| `db.sql` (no identity) | base tables — no identity, nothing to scope by. **Unchanged** |

That fixes the hole by making `sql` behave the way its proxy already implies, rather
than by adding a second method beside it (`CLAUDE.md` evolution policy; invariant 4).

## The load-bearing part: a view is a projection, not a boundary

A temporary view shadows a base table **only for a bare, unqualified name**. Anything
that can name the table another way walks straight past it. So the view is half the
mechanism and restricting the SQL is the other half — shipping the view alone would
be a security feature that does not hold.

The escape routes, all real in SQLite:

- **`main.invoices`** — schema-qualified, reaches the base table directly. Agent-Native
  rejects `public.<table>` for exactly this reason; the SQLite equivalent is `main.`
  and `temp.`.
- **`ATTACH`** — and litestone *exposes `$attach`/`$detach` on the proxy*, so an
  attached alias is a second namespace onto the same file.
- **`PRAGMA`** — schema introspection, and worse.
- **Creating another view or temp table** inside the scoped statement.
- **Writes.** A SQLite view is read-only without `INSTEAD OF` triggers, which is
  convenient: v1 should be read-only and say so, rather than silently accepting an
  `INSERT` that does nothing useful.

So scoped SQL needs a **statement allowlist**, not just a re-pointed name: single
statement, `SELECT` only, no `ATTACH`/`PRAGMA`/`CREATE`/`WITH RECURSIVE` past a
depth, no qualified schema references. Rejecting is correct; the caller has
`asSystem()` if they genuinely need the base table.

## What it unlocks

- **`herald` can offer SQL at all** (`IDEAS/agent-surface.md`). Today an agent surface
  would have to refuse raw queries outright, because the only raw path bypasses every
  declaration in the schema. With this it becomes the *safest* thing the agent can be
  given: an arbitrary read that cannot return a row or a column the user could not
  have fetched.
- **Reporting and saved queries** without writing a service per question — which is
  the thing every app eventually wants and currently cannot have safely.
- **Aggregates over a scoped set.** `aggregate()`/`groupBy()` already exist and are
  already scoped, so this is for what they cannot express, not a replacement.
- **A "query your data" product surface** that inherits authorization instead of
  reimplementing it.

## What would have to be built

1. **View derivation** — model → `CREATE TEMPORARY VIEW` text, from the predicates and
   column lists litestone already computes for the ORM path. The predicates exist;
   this is a second emitter over them, not new semantics.
2. **Lifetime and connection affinity.** Temporary views are per-connection, and `sql`
   reads from `readDb` while writes go elsewhere. The view set must be created on the
   connection the scoped `sql` actually uses, and torn down or replaced when the scope
   changes. **This is the piece most likely to be subtly wrong**, and the one to probe
   first rather than design on paper.
3. **The statement allowlist** (above). Without it, step 1 is decorative.
4. **Making `authSql` use them**, which is the fix to the live hole.

Steps 1, 2 and 4 without 3 must not ship — a scoped-looking API that can be stepped
around is worse than the current honest raw one.

## Open questions

- **Cost.** Creating N views per request is not free. Cache per (identity, schema
  version)? Create lazily, only for tables the statement names — which requires
  parsing the statement, which the allowlist needs anyway?
- **`@encrypted` columns.** Decryption happens above SQLite, so a view exposes
  ciphertext. Omit them (safe, surprising) or expose them raw (honest, useless)? Omit,
  probably, with the omission reported.
- **Does the view set follow `$scopedBy(...)` too?** It should — same declarations,
  same binding — but that multiplies the cache key.
- **Reads across a relation.** A join between two scoped views is correct by
  construction, which is a nice property worth stating explicitly rather than
  discovering.
- **Do writes ever arrive?** `INSTEAD OF` triggers could auto-inject the scope
  dimension the way Agent-Native auto-injects `owner_email` on INSERT. Attractive, and
  a much larger surface. Read-only first.
- **Is this how `db.sql` should behave for an unauthenticated client?** Argued above
  as "unchanged" — there is no identity to scope by — but that means the least
  restricted path is the one with no auth on it, which reads oddly out of context and
  should be a `DECISIONS.md` line rather than an implicit fallthrough.

## See also

- `IDEAS/agent-surface.md` — the consumer that makes this urgent rather than nice
- `IDEAS/diagnostics.md` — "a raw `sql` call on an auth-scoped proxy" is a check
- `IDEAS/compliance-from-the-seed.md` — the same declarations, read for audit
- `CLAUDE.md` invariant 6 (access declared in the schema, enforced at the Data
  boundary) and invariant 7 (protected fields never surface) — this is both of them
  applied to the one path that currently honors neither
- `packages/litestone/src/core/client.js` — `sql` (6306), `authSql` (6627),
  `_makeScopedProxy`, `$attach`/`$detach`
