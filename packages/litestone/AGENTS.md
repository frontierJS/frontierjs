# @frontierjs/litestone — for agents

Compressed reference for writing a `.lite` schema and querying it. The README is
written for a person reading once; this file is written for a program that must
get one model right without reading the rest.

If you are changing this package rather than consuming it, read `CLAUDE.md`
instead — the rules are different and the suite enforces them.

**This file does not list the language.** The word list is generated from the
parser and shipped beside this file as `catalog.snapshot.md`; a copy here would
be a second answer that goes stale. What is here is the half a table cannot
carry: which word to reach for, and where a legal spelling means something you
did not intend.

---

## The one rule

**Declare it in the schema. Do not enforce it in code.**

The schema is the seed — the API, the forms, the validators, the migrations and
the access rules are derived from it. A rule written in a service hook holds for
callers that go through that hook and for nobody else: not a migration, not a
seed, not `fli tinker`, not a job on `db.`.

```lite
model Invoice {
  id        Int      @id @default(autoincrement())
  number    String   @unique @immutable
  total     Int      @money(USD) @gte(0)
  status    Status   @default(draft)

  @@gate("2.4.4.5")
  @@transitions(status, issue: draft -> issued, void: issued -> voided @gate(5))
}
```

Every line above reaches four places at once. Writing the equivalent as
`if (user.role !== 'admin') throw` reaches one.

---

## Types — eight, and four that are refused

`String` · `Int` · `Float` · `Bytes` · `Boolean` · `DateTime` · `Json` · `File`

**`Text`, `Integer`, `Real` and `Blob` do not parse.** They are the old names,
cut rather than aliased, and the tokenizer answers with the replacement. If you
are reaching for one you are writing SQL or Prisma from memory.

**There is no `Decimal` and no `Numeric`.** An exact number is `Int @scale(n)`
— an integer column with the point declared — and money is `@money`, which is
`@scale(2)` with a currency. `Float` is a double and is the wrong type for money
in this language as in every other.

**Arrays are `String[]`, `Int[]`, `File[]`, an enum name, or a model name** —
the last being implicit many-to-many. Anything else is a parse error. An array
column is JSON TEXT under a `json_type = 'array'` CHECK, not a join table.

`DateTime` is stored as ISO-8601 TEXT and columns are emitted **verbatim
camelCase**. Hand-written SQL assuming snake_case or epoch-ms matches nothing.

---

## Naming — three resolvers depend on it

**Model names are PascalCase singular.** `model Lead` gives the accessor
`db.lead` and the service `leads`. The plural is derived by
`@frontierjs/toolbelt/inflect`, and the same rules run backwards to resolve a
service name to a model, so `model Leads` or `model lead` silently disconnects
the API and the UI from the table. `@@external` is the one exemption.

Irregulars resolve unaided (`people` → `Person`). Genuine ambiguity — `lens`
against `len` — cannot be reached by any rule and is stated by hand at the
resource.

---

## Looking a word up

Do not guess an attribute. Three ways to ask, all live:

```
litestone explain @guarded          # one word, with a worked example
litestone catalog --snapshot        # the whole surface, as a file
litestone advise                    # what your schema declares and should not
```

`catalog.snapshot.md` beside this file is the same table, committed and gated by
CI, so it cannot drift from the parser. Studio's Explore panel is the third
door and will place a word into your schema and show you the diff first.

**An attribute this package does not have is not a silent no-op — it is a parse
error.** That is the good case. The bad cases are below.

---

## Choosing an access word

Four words, and they are not a ladder. This table is the whole decision.

| caller writes | caller reads | word |
|---|---|---|
| yes | yes | *an ordinary column* |
| yes | no | `@encrypted` |
| no | yes | `@system` |
| no | no | `@guarded` |
| — | depends who asks | `@allow('read', …)` **on the field** |

- **`@system`** — the application writes it, the caller does not. A tracking
  code, a computed total. Readable by anyone. Fill it by naming the column on
  the write: `db.order.update({ where, data, system: ['trackingCode'] })`.
- **`@guarded`** — locked both directions, `asSystem()` only. Not a level:
  `@guarded(5)` does not parse. A **required** `@guarded` column makes the
  model uncreatable below level 8.
- **`@secret`** — exactly `@encrypted @guarded`. Writing both by hand is
  this word spelled out.

Above the columns sit two model-level words that answer different questions:

| word | refuses how | what a wrong one looks like |
|---|---|---|
| `@@gate("r.c.u.d")` | **throws** | a 401/403 naming the model |
| `@@allow(op, expr)` | **filters** | an empty screen with a 200 |

A gate is *what kind of caller*; a policy is *which rows*. A refusal must never
confirm a row exists, which is why a policy compiles into the WHERE rather than
raising. **A wrong policy is silence** — declare one model at a time and run the
app's drive between them.

`8` is not a stronger `5`. It means nothing outside `asSystem()` has anything to
say to this model, which is true of credential material and false of a table
your own screens list — raising the gate there just moves the surface into the
bypass.

---

## Wrong guesses

Ranked by how often training data produces them.

| You will write | This language wants |
|---|---|
| `Text` `Integer` `Real` `Blob` | `String` `Int` `Float` `Bytes` |
| `Decimal(10,2)` | `Int @scale(2)`, or `@money` |
| `take:` / `skip:` in a query | `limit:` / `offset:` — both are refused by name |
| `datasource` / `generator` blocks | `database <name> { … }` |
| `@db.VarChar(80)` | `@length(0, 80)` |
| `@@index([deletedAt])` beside `@@softDelete` | nothing — the index is implied, and declaring it is **refused by name** as a duplicate |
| snake_case columns | verbatim camelCase, or `@map("column_name")` |
| a service hook checking a role | `@@gate` / `@@allow` |
| `String @default(uuid())` written as a SQL string | `@default(uuid())` is a call, not a literal |

---

## Silent failures

Everything above is loud. These are not.

- **`$setAuth(user)` returns a scoped client, it does not mutate.**
  `db.$setAuth(u)` then `db.thing.create(…)` grades as **anonymous**, with no
  warning. It is `const userDb = db.$setAuth(u)`.

- **A `@computed` field in a `where` matches everything or nothing.** It is not
  a column, so SQLite reads the unresolvable name as a *string literal*:
  `{ comp: 'A' }` matches no rows and `{ comp: 'comp' }` matches every row.
  `$checkWhere` refuses it before the query if you ask.

- **`@unique` on an optional column admits any number of NULLs.** Two NULLs
  never compare equal. On a *composite* `@@unique` this is a parse error; on one
  optional column it is allowed, because *unique when present* has a single
  reading there. Say you meant it with `nullsDistinct: true`.

- **A key that is a tuple is `@@id([a, b])`, and the ORDER in it is load-bearing.**
  It desugars to `@id` on each named field, so everything downstream works
  unchanged — but a primary key builds an implicit index and an implicit index is
  prefix-matched, so `@@id([orgId, userId])` answers `WHERE orgId = ?` and the
  swap does not. Refused beside a field-level `@id`, and over a nullable field, a
  relation, an array or a virtual column.

- **`notIn` includes rows where the column IS NULL.** SQL three-valued logic,
  not a bug.

- **A relative `database { path }` resolves against the process CWD.** The same
  schema then means a different file depending on which directory the command
  ran in, and nothing fails — SQLite creates the file and every tool reports on
  the new empty database. Use `resolveFrom: 'schema'` to anchor to the app root.

- **A soft-deleted row keeps its `@unique` values.** A create naming a value a
  deleted row holds is refused with `SoftDeletedUniqueError` (409), not by
  SQLite. The way out is `restore()`, or `update({ …, withDeleted: true })` to
  move the value aside. A fixed fixture key therefore makes a test single-use.

- **A `where` typo below the API boundary warns to stderr and returns no rows.**
  Over HTTP it is a 400 naming the key; a service building its own filter gets
  silence.

- **The audit logger defers one event-loop tick.** A read in the same tick sees
  0 rows. Yield once; do not wait.

---

## Reading and writing

```js
db.user.findMany({ where, orderBy, limit, offset, include, select })
db.user.findFirst({ where })            // → row | null
db.user.findUnique({ where })           // → row | null
db.user.findManyAndCount({ where, limit, offset })   // → { rows, total }
db.user.count({ where })
db.user.exists({ where })               // SELECT 1 LIMIT 1
db.user.aggregate({ … })  ·  db.user.groupBy({ … })  ·  db.user.search(q)

db.user.create({ data })       ·  db.user.createMany({ data })
db.user.update({ where, data }) ·  db.user.updateMany({ where, data })
db.user.upsert({ where, create, update })
db.user.delete({ where })       ·  db.user.deleteMany({ where })
db.user.restore({ where })      ·  db.user.transition(id, 'issue')
```

Filters:

```js
{ id: 1 }                                  // equality
{ deletedAt: null }                        // IS NULL
{ score: { gte: 0, lte: 100 } }            // gt gte lt lte not
{ status: { in: ['active', 'pending'] } }  // in · notIn
{ name: { contains: 'smith' } }            // contains startsWith endsWith
{ AND: [ … ] } · { OR: [ … ] } · { NOT: { … } }
```

**A client throws on an unknown property**, so a typo'd accessor is loud and
feature-detection is itself a throwing expression — use `'$maybe' in db`, never
`typeof db.$maybe === 'function'`.

**`asSystem()` drops the gate, the row policies, `@guarded`, `@system` and every
field `@allow`. It does not drop a `@check`, a `@@check`, an `@@arc` or
`@immutable`** — those are in the table or in the constraint tier, so a system
write is refused exactly as anybody's is. That asymmetry is the reason to reach
for a constraint: it is the only rule that holds against a migration, a seed,
an atomic operator and `fli tinker` at once.

Raw SQL requires `asSystem()` once a schema declares any access rule, and
enforces none of them. `where: { $raw: sql\`…\` }` keeps every policy and is the
hatch to reach for first.

---

## Checklist before emitting a schema

1. Every model name is **PascalCase singular**.
2. No `Text` / `Integer` / `Real` / `Blob` / `Decimal` anywhere.
3. Money is `@money`; any other exact number is `Int @scale(n)`.
4. Every model declares a `@@gate`, or the app declares none at all — a
   declared-but-unenforced gate is fail-open.
5. Every protected column used one of the four words from the visibility table,
   not a hook.
6. Every foreign key has an index (`foreign-key-without-index` warns).
7. Every attribute used appears in `catalog.snapshot.md`.
8. Ran `litestone advise` — the eleven shapes the parser accepts and something
   later refuses, each with the word that fixes it.

---

## Source of truth

| File | What | Generated |
|---|---|---|
| `catalog.snapshot.md` | every word, arity, where it is legal, the rules table | yes, gated by CI |
| `litestone explain <word>` | one word, live off the parser | — |
| `docs/reference.snapshot.md` | the same words with prose and a worked example each | yes, gated by CI |
| `db/access.snapshot.md` *(in your app)* | the whole declared access surface | `fli test:access` |
| `db/jsonschema.snapshot.md` *(in your app)* | what crosses to the browser | `litestone jsonschema --snapshot` |

The catalogue's completeness is asserted against the parser's own switch arms in
both directions by `test/catalog.test.ts` — a word with no entry fails the suite
and an entry with no word fails it too. So the table cannot drift from the
language, which is the only reason this file is allowed not to repeat it.

**`fli check` is the executable half of this document.** Thirteen of its rules
read an app's own source for exactly the shapes above — a discarded `$setAuth`,
`asSystem()` off the app client, a service resolving to no model, a `@@gate`
level nothing in the app can reach. Run it after writing, not instead.
