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
seed, not `fli db:repl`, not a job on `db.`.

```lite
enum Status { draft  issued  voided }

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

**`Text`, `Integer`, `Real` and `Blob` are not types of this language.** A field
typed with one is read as a reference to an enum or a model and refused as
*unknown type*. If you are reaching for one you are writing SQL or Prisma from
memory; the eight above are the whole list.

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
CI, so it cannot drift from the parser. Litestone Studio's Explore panel is the third
door and will place a word into your schema and show you the diff first.

**An attribute this package does not have is not a silent no-op — it is a parse
error.** That is the good case. The bad cases are below.

---

## Choosing a column's access word

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
- **`@guarded`** — locked both directions. The read half is `asSystem()` only;
  the write half opens for a call that names the column, `system: ['tokenHash']`,
  which keeps the gate, the policies and the audit actor and is how a grant's
  digest is written by the caller's own create (`FJS-D819`). Not a level:
  `@guarded(5)` does not parse. A **required** `@guarded` column makes the
  model uncreatable below level 8 unless the application fills it that way.
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

## The gate ladder

`@@gate("R.C.U.D")` is the minimum level for read, create, update and delete. **A
position not written takes the one before it**: `"4"` is `"4.4.4.4"`, `"2.4"` is
`"2.4.4.4"`. A named form (`read: USER`) does not parse.

| Level | Name | Who the default resolver grades there |
|---|---|---|
| 0 | `STRANGER` | no session |
| 1 | `VISITOR` | signed in, `verifiedAt` is `null` |
| 2 | `READER` | verified, `activatedAt` is `null` |
| 3 | `CREATOR` | signed in with **no `role`** |
| 4 | `USER` | signed in with any `role` |
| 5 | `ADMINISTRATOR` | `isAdmin` |
| 6 | `OWNER` | `isOwner` |
| 7 | `SYSADMIN` | `isSystemAdmin` |
| 8 | `SYSTEM` | `asSystem()` only — no session ever grades here |
| 9 | `LOCKED` | nothing, `asSystem()` included |

**A role-less session is 3, so `@@gate("4")` refuses every signed-in caller of an
app that never sets `role`.** An ABSENT `verifiedAt` or `activatedAt` is no
objection; only `null` grades down. The standing flags win over the lifecycle, and
a `GatePlugin({ getLevel })` replaces the whole column. A row policy reads the
same answer as `auth().level`.

Pinned by `@frontierjs/toolbelt`'s `test/specs/gate.spec.js`.

---

## State machines — `@@transitions`

A closed column — an enum or a Boolean — that moves only along declared edges.
`litestone explain @@transitions` is the syntax, and a refused move throws a
class naming the move; what neither tells you is which to reach for:

- **`@system` on a move is usually what "the engine does this" means**: the app
  makes it on the CALLER's client (`transition(id, name, { system: true })`), so
  the model gate, the policies and the audit actor still apply. `@gate(8)` is the
  other spelling — only `asSystem()` passes, and all three drop.
- **A row is created at the column's `@default`, by everyone**, `asSystem()`
  included. A row that belongs further along is created at the entry and walked
  there by its moves; `updateMany` refuses the column outright.
- **`resource.transitions(row, level)` in the browser grades the gate half only.**
  A move a policy refuses reads `allowed: true` there and 403s when pressed;
  `db.order.transitions(row)` on the server says `refusedBy: 'policy'`.

Pinned by `test/system-transitions.test.ts` and `test/transition-entry.test.ts`.

---

## Claims — what `auth().x` may name

**Every `auth().x` in a policy must be a claim the principal is known to carry**,
or it is refused at startup naming the set. That set is the framework's nine
(`id`, `capabilities`, `level` and the six standing fields above), the `@@auth`
model's columns, the `tenancy` claim, and what the schema declares:

```lite
model User { id Int @id  @@auth }

model Employee {
  id     Int  @id
  userId Int  @unique                    // one row per caller, or the lookup is ambiguous
  user   User @relation(fields: [userId], references: [id])
}

claim cartToken                          // resolved per request by the app
claim employeeId from Employee(userId)   // read per request off the caller's row

model Cart {
  id         Int    @id
  token      String
  employeeId Int?

  @@allow('read', token == auth().cartToken || employeeId == auth().employeeId)
}
```

A bare `claim` only NAMES it; the app's principal resolver supplies the value
(junction's AGENTS.md, *Who the caller is*). A `from` claim's subject must be a
`@unique` column that a `@relation` ties to the `@@auth` model, and its name
may not be one of the framework's — `claim role from …` is refused because a
row may not decide how the caller is graded; call it `membershipRole`. Litestone
alone resolves neither kind: `$setAuth({ id, employeeId })` is what a test
passes. **A claim the caller does not carry
is UNKNOWN, not false** — an `@@allow` holds only on TRUE and an `@@deny` fires on
UNKNOWN too, so a deny on a missing claim refuses. `auth().x == null` is how to
write *carries no such claim*.

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
  never compare equal. On a *composite* `@@unique` this is a parse error unless
  `@@unique([a, b], nullsDistinct: true)` says it is meant; on one optional
  column it is allowed without a word, because *unique when present* has a
  single reading there.

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

- **A `where` typo throws `ValidationError`**, naming the key with a *Did you
  mean* — an unknown field, an unknown operator, an `in` given a string, and a
  real key SQLite cannot filter (`@computed`, `@encrypted`). Over HTTP it is a 400.
  A `jsonl` or `trail` model answers the scalar operators only (`not`, `gt`, `gte`,
  `lt`, `lte`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`) and refuses the
  rest by name, `$raw` included: it is SQL, and a record there is a JSON line.

- **The audit trail defers one event-loop tick.** A read in the same tick sees
  0 rows. Yield once; do not wait.

---

## Reading and writing

```js fragment
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
db.user.delete({ where })       ·  db.user.deleteMany({ where })       // hard, @@softDelete or not
db.user.remove({ where })       ·  db.user.restore({ where })          // the soft pair
db.user.transition(id, 'issue')
```

Filters:

```js fragment
{ id: 1 }                                  // equality
{ deletedAt: null }                        // IS NULL
{ score: { gte: 0, lte: 100 } }            // gt gte lt lte not
{ status: { in: ['active', 'pending'] } }  // in · notIn
{ name: { contains: 'smith' } }            // contains startsWith endsWith — ASCII case-insensitive, nothing folds past it
{ AND: [ … ] } · { OR: [ … ] } · { NOT: { … } }
```

**A `Json` column written whole loses a key another writer set.** Change one key
with `data: { settings: { $merge: { theme: 'dark' } } }` (`json_patch`, RFC 7396):
the other keys stay, `null` deletes a key, an array replaces whole. It is the one
operator a `Json` column takes, and `docs/querying.md` § `$merge` has the rest.

**A client throws on an unknown property**, so a typo'd accessor is loud and
feature-detection is itself a throwing expression — use `'$maybe' in db`, never
`typeof db.$maybe === 'function'`.

**`asSystem()` drops the gate, the row policies, `@guarded`, `@system` and every
field `@allow`. It does not drop a `@check`, a `@@check`, an `@@arc` or
`@immutable`** — those are in the table or in the constraint tier, so a system
write is refused exactly as anybody's is. That asymmetry is the reason to reach
for a constraint: it is the only rule that holds against a migration, a seed,
an atomic operator and `fli db:repl` at once.

Raw SQL requires `asSystem()` once a schema declares any access rule, and
enforces none of them. `where: { $raw: sql\`…\` }` keeps every policy and is the
hatch to reach for first.

---

## Testing — `@frontierjs/litestone/testing`

Full surface: `docs/testing.md`. An app with a Junction API imports the same
names from `@frontierjs/testing` (its `AGENTS.md`), which adds the API half.

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { GatePlugin } from '@frontierjs/litestone'

const getLevel = (user) => user?.level ?? 0       // the app's own resolver
const env = await createTestEnv({
  schema: `model Lead {
    id   Int    @id @default(autoincrement())
    name String
    @@gate("1.3.3.5")
  }`,                                              // text or a path; a throwaway tmpdir, never the app's file
  // migrations: 'db/migrations',                  // replay committed SQL instead of generating DDL
  autoFactories: true,                             // env.factories.<accessor>; empty without it
  plugins:       [new GatePlugin({ getLevel })],
})
const mismatches = await env.verifyGateLadder()    // every gated model × level × op
if (mismatches.length) throw new Error(JSON.stringify(mismatches))   // [] is a pass
await env.factories.lead.asSystem().createOne()
env.close()
```

- **Seeding past a gate is a system concern.** An unauthenticated factory grades
  `STRANGER` and throws `AccessDeniedError`. Seed with `env.factories.lead.asSystem()
  .withParents().createOne()`, or in `env.setup(({ factories }) => …)` /
  `env.phases().arrange(…)`, whose factories are system-bound. A generated row
  leaves out an optional `@guarded` column; a required one is system-only to seed.
- **`env.actingAs(user)` is the app's `getLevel`; `env.atLevel(n)` is a synthetic
  one.** Use `actingAs` for any claim about behavior and `atLevel` only to walk the grid.
- **The verifiers answer a list of mismatches; `[]` passes.** `verifyGateLadder`,
  `verifyReadLadder`, `verifyFieldProtection`, `verifyRowPolicies`,
  `verifyConstraints`, `verifyTenantIsolation`. A `got: 'error'` or `'skipped'` is
  not a verdict — read it.
- **Arrange / Act / Assert is three clients:** `env.phases({ as: user })` →
  `arrange` (system), `act` (the principal, once), `assert` (the principal, read-only).
- **`env.clock` moves `now()`**, in a row policy and `@@softDelete`'s stamp. It does
  not move `@default(now())` or `@updatedAt`; state those on the write.
- **The audit trail is a model in the env.** `await env.system.auditTrail.findMany({
  where: { model: 'lead' } })` after one tick (`await new Promise(r => setTimeout(r, 0))`).
  Its `model` is the accessor spelling, and `records`/`before`/`after` come back as JSON
  strings. `db.$audit({ operation, model, records })` writes an entry by hand (`meta`
  is never redacted). **Declare `database main { … }` beside a `trail` database**, or
  `createTestEnv` throws a bare `TypeError` (`FJS-2532`).
- **Local file storage is the double.** `plugins: [FileStorage({ provider: 'local',
  localPath: tempDir('myapp-') })]` from `@frontierjs/litestone/storage`; a `File`
  column takes `new File([bytes], 'x.png', { type })` or `fromPath(p)`, never a
  hand-built `{ key, name }` ref (`ValidationError`), and the bytes land at
  `<localPath>/<Model>/<field>/<uuid>.<ext>` for the test to read.
- **Hand-written factories** are `defineFactory({ model: 'User', definition: seq => ({…}) })`
  passed as `factories: { user: … }`; `seed:` makes the RNG deterministic.
- **Nothing here mocks a module.** Pass a real client,
  a real plugin, a real double.

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
8. Ran `litestone advise` — the shapes the parser accepts and something
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

The catalog's completeness is asserted against the parser's own switch arms in
both directions by `test/catalog.test.ts` — a word with no entry fails the suite
and an entry with no word fails it too. So the table cannot drift from the
language, which is the only reason this file is allowed not to repeat it.

**`fli check` is the executable half of this document.** Its app-scoped rules
read an app's own source for exactly the shapes above — a discarded `$setAuth`,
`asSystem()` off the app client, a service resolving to no model, a `@@gate`
level nothing in the app can reach. Run it after writing, not instead.
