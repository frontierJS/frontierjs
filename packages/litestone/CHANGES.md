# Changes — @frontierjs/litestone

## 2026-08-05 — a transaction can read its own writes

1362 tests (was 1355).

`$transaction` opened a write transaction on the write connection and then handed
the callback the ordinary client, whose reads go to the separate readonly WAL
connection. WAL isolation means that reader cannot see uncommitted work, so:

    await db.$transaction(async (tx) => {
      await tx.t.create({ data: { name: 'a' } })   // succeeds, returns the row
      await tx.t.findMany()                        // → []
      await tx.t.count()                           // → 0
    })

Every read-after-write inside a transaction saw stale data — check-then-act,
read-modify-write, and any `include` resolved against a parent created moments
earlier. Nothing threw; the reads simply described the world as it was before the
transaction started.

Each read connection is now wrapped in a router sharing the transaction manager's
depth. While a transaction is open, reads go to the **write** connection, which
observes its own uncommitted work; outside one, nothing changes and reads still run
concurrently on the readonly connection. The two prepared-statement fast paths
(`findMany()` with no args, `findUnique` by pk) stand down inside a transaction —
they were prepared against the read connection at table-build time and cannot be
re-pointed.

Read-only clients are untouched: their write connection is a throwing stub, and
they can never open a transaction to route into.

Found while trying to build per-test isolation on `$transaction` for the seeding
work below. Pinned by seven tests: findMany, findUnique, read-modify-write,
`include`, rollback, routing restored after commit *and* after rollback, and
nested savepoints.

## 2026-08-05 — seeding ergonomics

1355 tests (was 1334).

Six additions and one retry, all on top of the relation work below.

- **`snapshot(db)` / `restore(db, snap)`** — seed once, reset between tests. A
  truncate + bulk re-insert of the exact rows, which beats re-seeding. Deliberately
  raw: rows move through the write connection, so `@encrypted`/`@secret` columns
  keep the ciphertext they already have (a round trip through the ORM would
  re-encrypt them) and no gate, policy, hook or audit entry fires. FTS5 shadow
  tables are skipped — writing those directly corrupts the index.
- **`defineFactory({ model, definition, traits, afterCreate })`** — the Factory
  without the class. Returns a class, so it registers exactly as before. A subclass
  declares `traits` as an instance field, which initialises only after `super()`
  returns; that is the only reason `Factory`'s constructor returns a Proxy, and
  this path never needs it.
- **A value catalogue** (`src/fake.js`). Well-known field names — `firstName`,
  `city`, `company`, `title`, `description`, … matched case- and
  separator-insensitively — draw real words instead of `Name a4f2`. **Only when a
  seed was set.** Unseeded output is byte-identical to before, because
  schema-derived test *cases* have to stay stable and diff-able.
- **`static dependsOn = [OtherSeeder]`** — a seeder names what it needs instead of
  every caller knowing the order. Each class runs at most once per `call()`; a
  cycle throws naming the classes in it.
- **`loadFixture(db, model, jsonOrCsvOrArray, { upsert })`** — authored reference
  data (countries, plans, currencies) is written down, not generated. Rows go
  through the ORM, unlike `restore`. Ships a small RFC-4180 `parseCsv`.
- **`fli make:factory <Model>`** — scaffolds a `defineFactory` stub into
  `db/factories/`, refusing a model the schema does not declare.
- **UNIQUE collisions retry.** Generated values carry a seq token so a `@unique`
  column is unique by construction, but the token pool is finite and the catalogue
  is small. `createOne` now rebuilds and retries (5 attempts) — a rebuild advances
  `seq`, which changes every generated value — rather than failing a long seed.

`withParents()` also stops **silently skipping** a required relation whose target is
already in the parent chain. A cycle cannot be satisfied by creating more rows, so
it now says that, names the chain, and suggests `.for(…)` — previously it surfaced
as an opaque `FOREIGN KEY constraint failed` far from the cause.

### Why snapshot/restore rather than a transaction

The intended implementation was a per-test transaction rolled back at the end.
`$transaction` could not serve it: reads inside one did not observe its own writes.
That turned out to be a general correctness bug rather than a test-helper problem,
and is fixed in its own entry above. `snapshot`/`restore` remains the isolation
primitive here — it survives a client restart and does not hold a write lock for the
length of a test.

## 2026-08-04 — factories can seed a relation graph

1334 tests (was 1321).

Factories could only reach one relation shape: `withRelation`/`for`, a single named
belongsTo, wired by hand. Everything else was on the caller. Measured by pointing
`autoFactories` at the two real schemas in this repo and creating one row per model:

    example  (Int keys)   3 of 3  models seeded
    basecamp (uuid keys)  5 of 24 models seeded

The 19 failures were all `FOREIGN KEY constraint failed`. An `Int` FK falls back to
`1`, which accidentally works when the parent happens to be row 1; a `String`/uuid FK
has no fallback at all, so the generator emitted `"AccountId 1"` and every write with
a parent failed. Four additions:

- **`withParents()`** — reads the schema and auto-creates a parent for every
  *required* belongsTo, recursively. `{ optional: true }` covers nullable ones,
  `{ fresh: true }` gives each row its own. Relation cycles are skipped rather than
  followed; `depth` is only a backstop.
- **`has(name, count, opts)`** — hasMany children, created after the parent with the
  FK pointed back at it. The FK comes from the child's own `@relation`; a child with
  two relations to the same parent is an error naming both, not a guess.
- **`attach(name, countOrRows)`** — implicit many-to-many, via the `{ connect: […] }`
  form the client already takes. Accepts a count or existing rows.
- **`usingDb()` / `asSystem()` / `actingAs()`** — a schema declaring any `@@gate`
  auto-installs GatePlugin, so an anonymous factory grades STRANGER and cannot create
  anything. The client now propagates through the whole wired graph; rebinding only
  the top factory left every parent on the gated client.

`has`/`attach`/`withParents` need the parsed schema and a factory registry, which
`makeTestClient({ autoFactories: true })` and `factoryFrom()` now supply — to
hand-written factory classes as well as generated ones. Without them the methods
throw a message naming what to pass.

Same measurement after:

    example   3 of 3  models seeded via factories.X.asSystem().withParents()
    basecamp  24 of 24

## 2026-08-04 — the factory generator stops emitting data the schema rejects

1321 tests (was 1306).

`generateFactory` derives a row from a model's field types. It was not reading most
of the rules on those fields, so `autoFactories` produced rows that could not be
written. Probed with one hostile model — every line below is a separate failure:

    { code:"xxxx", phone:"Phone c9zs", age:11001, meta:null, tags:[], plan:"free" }

    createOne     → phone: must be a valid phone number, age: must be at most 99,
                    meta is required, ref: must match ^[A-Z]{3}-[0-9]{4}$
    createMany(2) → UNIQUE constraint failed: code.v

- **`@unique` + `@length` generated a constant.** The whole branch was
  `'x'.repeat(min)` — no seq — so the second insert always collided. Every string
  now carries the seq token and is padded/truncated into the declared range.
- **`Int` ignored `@gte`/`@lte`**, and both types ignored exclusive `@gt`/`@lt`.
  One bounds resolver now serves `Int` and `Float`, and the value walks the range
  with `seq` so a bounded `@unique` column also survives `createMany`.
- **Required `Json`/`Bytes` generated `null`** → "is required" on every write. Now
  `{}` / bytes when required, `null` only when optional.
- **`@phone` was unhandled** → plain text, always invalid.
- **`@regex` emitted `field-abcd`**, which matches almost no pattern. There is now a
  generator for the common subset (anchors, escapes, classes, groups, alternation,
  quantifiers) that **checks its own output against the pattern** and warns instead
  of emitting an invalid value.
- **`@minItems` was ignored** — arrays were always `[]`.
- **`@startsWith` / `@endsWith` were ignored.**
- **`DateTime` used `new Date()`**, so a seeded factory was not reproducible — the
  one promise the seeded-RNG design makes. Derived from `seq` now.
- **Enums always returned the first value** — five seeded builds gave five `free`.
  `rng.pick` when seeded; still the first value unseeded, so generated test cases
  stay stable.
- **`@sequence` columns are no longer emitted.** An explicit value is honoured and
  moves the per-scope counter (verified), so writing one both defeats the feature
  and collides with any `@@unique([scope, seqField])` beside it.

### makeTestClient could open the project's real database

Found while running the above against `packages/basecamp/db/schema.lite`: rows
appeared in tables that should have been empty. `makeTestClient` builds a throwaway
db in a tmpdir and passes it as `db:` — but **a `database` block in the schema wins
over `db:`**, which is documented litestone behaviour. So pointing this helper at a
real app schema opened `./db/basecamp.db` — the actual project database — and wrote
test rows into it. The docs said "always uses `:memory:` — no files created".

It now overrides every declared database path into the tmpdir, one file per declared
database, with per-database DDL. Pinned by two tests, including one asserting the
declared path is never created on disk.

## 2026-08-04 — `Factory.create(overrides)` no longer returns nothing

1306 tests (was 1302).

`build(n, o)` and `create(n, o)` branched on `n != null`, so the first argument was
a count whenever it was present at all. Laravel's `factory()->create($attrs)` is the
muscle memory everyone brings, and `factory.create({ role: 'admin' })` took the
overrides object as the count:

    Array.from({ length: {} })   // → []

No row written, nothing thrown, an empty array returned where a row was expected.
Both now branch on `typeof n === 'number'` — a number is a count, anything else
(object or function) is overrides. All four forms are pinned by tests:

    create()                    → 1 row
    create({ role: 'admin' })   → 1 row with overrides
    create(5)                   → 5 rows
    create(5, { role: 'x' })    → 5 rows with overrides

**Types corrected alongside.** `index.d.ts` described a `Factory` that does not
exist — `for(relatedId)` and `withRelation(model, id)` have taken
`(name, row|factory, fk?, pk?)` for as long as they have existed, `afterCreate` is a
subclass field and not a fluent method, and `seed`, `traits`, `build` and `create`
were undeclared. `testing.d.ts` typed `factories` and `factoryFrom` as `unknown`,
claimed `generateFactory` "returns code as string" (it returns the
`definition(seq, rng)` function), and gave `generateGateMatrix` /
`generateValidationCases` return shapes neither one has ever produced —
`{op, level, label, expect}` and `{valid, invalid, boundary}`, not what was written.

`docs/testing.md` told you to write `model = 'users'` and
`factoryFrom(schema, 'users', db)`. Lowercase plural throws
`model "users" not found in schema` — model names are PascalCase singular
(Invariant 2). README had it right; the doc had drifted.

## 2026-08-04 — transition errors carry an HTTP status

1302 tests (was 1298).

`TransitionGateError` always set `this.status = 403`, with a comment saying that
is the contract: Junction reads `err.status` directly, so an error class you own
needs no mapper and no registration. The other three were missed, so a caller
asking for an illegal move got `500 GeneralError` — the wrong class of error
entirely, telling a client to retry something that will never work.

    TransitionViolationError  → 409   conflicts with the row's current state
    TransitionConflictError   → 409   optimistic-lock loss; also retryable: true
    TransitionNotFoundError   → 400   named a move the model does not declare

Found by driving `@@transitions` from a UI for the first time in `example/`.

## 2026-08-04 — @label and @required, and messages that leave the Data boundary

1298 tests (was 1289).

Every validator already took its own wording — `@length(3, 20, "…")`,
`@email("…")`, `@gte(0, "…")`, the ZenStack convention — and this package's own
validator honoured them. `generateJsonSchema` emitted **none** of them, so a
sentence authored once in `db/schema.lite` died here: invisible to Junction's
autoValidate and to Sierra's client-side rules, both of which derive from that
document. A form said `customerId is required` and no amount of schema
authoring could change it.

**Messages are now emitted as `x-messages`**, keyed BOTH by rule name and by
the JSON Schema keyword the rule compiles to — `@length` publishes under
`length`, `minLength` and `maxLength`. Keying by keyword is the point: a
consumer that just failed `minLength` looks up `minLength`. The alternative,
publishing only the rule name, puts a keyword→rule table in Junction *and*
Sierra, and this file is the one that already owns that mapping (it is
documented at the top of it). `MESSAGE_KEYWORDS` is pinned by a test asserting
the aliases match what the field actually emits — `@gt` is `exclusiveMinimum`,
not `minimum`.

**`@label("Customer")` → JSON Schema `title`.** Every generated message on
every side builds its sentence from it, so an error stops reading `customerId`
under a form label that says "customer". Consumers must read it off the
FIELD's own schema and never a `$ref` target: every enum `$def` is titled with
the type name, so a deref'd title would make `status OrderStatus` introduce
itself as "OrderStatus".

**`@required("…")`** fills the one gap the trailing-message convention could
not: required-ness is the absence of `?`, not an attribute, so there was
nowhere to hang a message. ZenStack reaches for model-level
`@@validate(expr, msg)` here; this follows Remult's field-level
`Validators.required(msg)` so the wording sits beside the rule like every other
message in the file. It carries the wording only — it does **not** make the
field required, and on an optional field it is a parse error rather than a
message that could never fire.

Nine tests in `test/messages.test.ts`.

Newest first. Entries older than 2026-08-02 live in `PROJECT_STATE.md` §What's
been done (phases 1–10) — this file starts where that log left off.

## 2026-08-03 — `@@transitions`: state machines move to the model, and gain gates

A `status` column's rules used to live in whatever service handler was written
first. They are now declared once on the model, enforced at the Data boundary,
and readable by the browser.

```prisma
enum OrderStatus { pending  paid  shipped  refunded  cancelled }

model Order {
  status OrderStatus @default(pending)

  @@transitions(status,
    pay:    pending         -> paid,
    ship:   paid            -> shipped,
    refund: paid            -> refunded @gate(5),
    cancel: [pending, paid] -> cancelled)
}
```

**What's new**

- **`@@transitions(field, …)`** on the model, beside `@@gate` and `@@allow`
  where every other access declaration already lives. The transition name is
  optional (`pending -> paid` names itself after the target); `from` takes a
  list; a trailing `@gate(N)` takes a number or a level name.
- **`@gate(N)` per transition** — a floor on top of `@@gate`'s update level,
  which had to pass to reach the write at all. Shipping an order and refunding
  one are not the same authority. Under-level moves throw the new
  **`TransitionGateError`**, which carries its own `status: 403` so Junction
  maps it with no registration.
- **`db.order.transitions(row)`** — the legal next states for *this* record at
  *this* user's level. A gated move the caller can't make comes back with
  `allowed: false` rather than being dropped; a disabled button is usually
  better UI than a missing one. Takes a row (no round trip) or an id.
- **`x-transitions` on the model in `generateJsonSchema`**, so the machine
  reaches the browser. Sierra's `resource.transitions(row, level)` returns the
  identical shape — a UI affordance only, the server enforces regardless.
- A gated transition **auto-installs a level resolver** when the app configures
  no `GatePlugin`, the same way `@@gate` does. A declared gate that silently did
  nothing would be a fail-open default.

**Why the model and not the enum**

The existing `enum X { transitions { … } }` block attached rules to the *enum*,
so every model with a field of that type shared one machine — and therefore
would have had to share one authority level. Two models using one `Status` can
now differ. The enum block is kept as shorthand for the common case and
**desugars into `@@transitions`** at parse time, so there is one enforcement
path, one representation in the JSON Schema, and the existing behaviour is
unchanged (all 20 of its tests pass untouched). A model that declares its own
`@@transitions` for that field overrides the enum's outright.

**Breaking**

- `x-litestone-transitions` is **no longer emitted on the enum `$def`**. The
  resolved machine is on the model as `x-transitions`. Emitting both would give
  a client two sources that drift the moment one model narrows.

**Documentation corrections** — three places described syntax that never
existed: `docs/schema.md` documented a `@from(pending)` enum-value attribute,
and `docs/roadmap.md` and `docs/soft-delete.md` both showed an array form
`@@transitions([{ name, from, to }])`. `docs/soft-delete.md` additionally
claimed `remove()` enforces transitions — **it does not**, and never did;
enforcement runs on `update()` and `upsert()` only. Use a `@@deny('delete', …)`
policy to require a state before deletion.

1286 tests green (was 1253).

## 2026-08-03 — `@encrypted` on a `Json` field silently destroys the value

**Open. Not fixed — route around it.**

A `Json @encrypted` column round-trips as the string `"[object Object]"`. The
value is stringified with `String(obj)` instead of `JSON.stringify` before it
reaches the cipher, so the object is gone before encryption ever happens.

Everything *around* it works, which is what makes it dangerous: the column is
genuinely encrypted at rest, `@guarded(all)` read-withholding is enforced, the
write returns normally, nothing throws and nothing warns. Only the payload is
missing, and only on read-back.

```prisma
model Secret {
  data  Json @encrypted     // ← writes {"key":"…"}, reads back "[object Object]"
}
```

**Workaround:** declare the column `String @encrypted` and do the
`JSON.parse` / `JSON.stringify` at the service layer. That is what
`packages/basecamp/db/schema.lite` does — see `packages/basecamp/db/README.md`
§"A Litestone bug to route around".

Also recorded in `docs/gotchas.md`.

---

## 2026-08-03 — the audit logger was never dropping rows; reads lag writes

Reported repeatedly as "**`@@log(audit)` writes 0 rows**", including in the root
`CLAUDE.md`, where it sat unexplained for weeks. It is not a bug and nothing is
lost.

The logger driver buffers and flushes on a **~1s timer and on process exit**, so
a read in the same session immediately after a write sees nothing — and the
`.jsonl` file may not exist yet. Litestone's own examples read straight after
writing, which is exactly the shape that reports zero.

Measured on a fresh database:

| after | `auditLogs.findMany()` | file |
| --- | --- | --- |
| 1 write, immediately | 0 rows | does not exist |
| +2s | 1 row | 297 B |
| +50 more writes, same process | 1 row | 297 B |
| next process | **51 rows** | 15,137 B |

Entries carry `operation` / `model` / `records` / `before` / `after` /
`actorId` / `createdAt`, and are queryable through the **`auditLogs`** accessor
that declaring a logger database synthesizes.

Two related facts worth keeping together with this one:

- **`@secret` expands to `@encrypted + @guarded(all) + @log(<first logger db>)`.**
  Merely *declaring* a logger database therefore starts logging every `@secret`
  field in the schema. That is by design.
- **The logger `path` resolves against the process CWD, not the schema file.**
  Where the trail lands depends on where you launch from.

### Protected fields are redacted (same date, and this is what makes the above safe)

`src/core/client.js`. Any `@encrypted` / `@guarded` / `@secret` value is written
as `'[redacted]'` in **both** the field-level entry and the model-level
`before`/`after` snapshot. The trail records *that* a field was written, by
whom, to which rows, when — never what it holds.

- `null` is preserved rather than redacted: nothing to leak, and it keeps a
  `null → value` transition visible (`before: null, after: '[redacted]'`).
- Unprotected fields on the same model are still logged in full.
- The row returned to the caller is untouched — redaction happens on a copy, on
  the way to the log.

**Before this fix the plaintext landed in the JSONL while the database row was
correctly ciphertext**, so any audit file written before 2026-08-03 may hold
secrets in the clear. Consumers that log identity or credential models —
`packages/basecamp` does, on all 16 of its non-event models — require a
Litestone from this date or later.

Pinned by 8 tests (`test/litestone.test.ts` → "audit log redaction"), 5 of which
fail if the redaction is removed. Reference docs: `docs/audit-logging.md`
§"Protected fields are redacted".

---

## 2026-08-02 — v1.1.0 published; the dialect trap is closed

**The trap:** in-repo packages resolved a *registry* Litestone rather than the
workspace one, so schemas written against the current dialect
(`Int` / `String` / `Float` / `Bytes`) were parsed by a build that still spoke
`Integer` / `Text` / `Real` / `Blob`. The failure surfaced far from its cause —
Junction carried **7 test failures filed for months as "test drift"** that were
this mismatch and nothing else. Fixing the resolution cleared all 7.

Two halves, both closed:

- **In-repo:** junction and auth now take `workspace:*` as a dev-dependency with
  a `^1.1.0` peer, so workspace code gets the workspace parser.
- **Registry:** 1.1.0 is published and npm `latest` points at it. Verified by
  `npm view` dist-tags *and* by unpacking the tarball — `SCALARS` carries
  `Int/String/Float/Bytes` and `RENAMED_TYPES` rejects `Integer/Text/Real/Blob`.

**Type renames are a hard cut, not aliases.** `Text`, `Integer`, `Real` and
`Blob` are rejected outright with a rename message (`PROJECT_STATE.md` §"Type
rename — hard cut").

**Still true, and the reason this went unnoticed for so long:** don't pin
Litestone with a bare `"latest"` or `"*"`. A floating range is what let a
consumer silently sit on the old dialect. Use `^1.1.0`. Anything installed from
the registry before 2026-08-02 needs a reinstall.
