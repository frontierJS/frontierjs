# Access Control

Litestone has two orthogonal access control systems: **row-level policies** (`@@allow`/`@@deny`) and **level-based GatePlugin**. They can be used together or independently.

## Row-level policies

`@@allow` and `@@deny` compile to SQL `WHERE` injections — filtering happens inside SQLite, not in JS. No rows are ever fetched and filtered in memory.

**Why SQL and not JavaScript?**

Most ORMs that have access control implement it as a JS filter: fetch the rows, check each one in the app layer. This has a critical failure mode — if you forget to apply the filter, you expose data. The filter is opt-in and can be skipped by accident.

Litestone's policies are structural. Once a policy is declared on a model, it is injected into every query automatically. There is no path to unfiltered data except `asSystem()`, which is always explicit. The only way to bypass it is intentional.

As a concrete example: `@@allow('read', accountId == auth().accountId)` compiles to:

```sql
WHERE "accountId" = ? -- bound to ctx.auth.accountId
```

That clause is part of every `SELECT`, `UPDATE`, and `DELETE` that touches this model from a scoped client. It cannot be forgotten.

```prisma
model Post {
  id        Int  @id
  accountId Int
  ownerId   Int  @default(auth().id)
  status    String     @default("draft")
  title     String

  @@allow('read',   status == 'published' || accountId == auth().accountId)
  @@allow('create', auth() != null)
  @@allow('update', ownerId == auth().id)
  @@deny('delete',  status == 'published')   // published posts can never be deleted
}
```

Rules:
- No `@@allow` for an operation → unrestricted
- First `@@allow` makes the operation deny-by-default
- `@@deny` always wins over `@@allow`
- Multiple `@@allow` on same op → OR'd together
- Custom error messages: `@@allow('update', expr, "You can only edit your own posts")`

### Policy expressions

```
auth()                — current auth object (null if unauthenticated)
auth().field          — field on auth object (e.g. auth().id, auth().role)
auth() != null        — authenticated check
now()                 — current UTC timestamp, ONE instant per evaluation
check(field)          — delegates to related model's read policy
field == value        field != value  field > value  field >= value  field < value  field <= value
value in list         membership — the list is always the RIGHT operand
cond ? a : b          a value chosen by a condition — see below
expr1 && expr2        expr1 || expr2  !expr
```

### `cond ? a : b`

Binds looser than `||` and is **right-associative**, so `a ? x : b ? y : z`
nests into the else — which is how a four-value ladder is written without a
CASE keyword:

```
@@scope(urgent, priority > 8 ? true : priority > 5 ? status == 'open' : false)
@@allow('create', priority > 8 ? auth().isAdmin == true : auth() != null)
```

A parenthesised group is an operand on **either** side of a comparison, so a
ternary can choose the value being compared against:

```
@@allow('read', ownerId == (status == 'open' ? auth().id : auth().adminId))
```

This is where the language stops being predicate-only and starts producing
**values**, so it carries two obligations, both met:

- It lands in **both** compilers — `CASE WHEN … THEN … ELSE … END` in the SQL
  half, `?:` in the JS half. A form in one and not the other is the shape that
  let `field == null` allow a row on create that then read as hidden.
- `verifyRowPolicies` grades one against the other over it, with rows on both
  sides of the condition.

### `in` — a list on one side

The grammar compared scalars, so *this row is visible to these principals* — an
audience held on the row — could not be said at the Data boundary at all and had
to become a service where-clause, which is what `@@allow` exists to prevent: a
forgotten filter is an exposure.

**The list is always on the right**, which is what makes one operator enough for
all three shapes:

```
model Doc {
  memberIds Int[]
  ownerId   Int
  status    String

  @@allow('read',   auth().id in memberIds)          // the row holds the list
  @@allow('delete', ownerId in auth().ownedIds)      // the principal holds it
  @@allow('update', status in ['draft', 'review'])   // written literally
}
```

An array column compiles to `EXISTS (SELECT 1 FROM json_each("memberIds") WHERE
value = ?)` — the same SQL `where: { memberIds: { has: … } }` produces, so
membership has one definition. The other two compile to `IN (?, …)`. **An empty
list admits nothing** and is answered before any SQL is built, because `IN ()`
is a syntax error.

A literal list also replaces the shape that had to be written as
`status == 'draft' || status == 'review'`.

**What the schema can decide is decided at startup**, naming the model and
quoting the expression back, because a wrong policy is an empty screen with a
200 rather than an error:

- the right operand is not an array field, or is not a field at all
- the left operand is an array — overlap between two lists is not expressible
- both operands name a column on the same row
- the list column is `@encrypted`/`@hashed`/`@secret`, so it holds an encoding
  rather than its members

It lands in **both** compilers — `compileSql` for the WHERE and `evalJs` for
`create` — because a form in only one is `FJS-195` repeating: a row that create
allows and read then hides. `verifyRowPolicies` grades one against the other.

### Comparing an encrypted column

A predicate over an encoded column encodes its operand the same way the column
was encoded, which is the rewrite a `where` gets — so a `@hashed` or
`@encrypted(deterministic: true)` column is comparable in a policy:

```
model Doc {
  owner String @hashed
  @@allow('read', owner == auth().email)
}
```

Plain `@encrypted` is not: a random IV means the same value stores different
bytes on every write, so no operand can be encoded to match it. That, a
comparison other than `==` / `!=`, and a column compared against another column
are all refused when the client is built rather than compiling to a predicate no
row satisfies — see [filtering.md](filtering.md) § An encoded column inside a
policy for the table and the `create` / `post-update` exceptions.

### `now()` and the clock

`now()` resolves **once per policy evaluation**, not once per occurrence — so
`@@allow('read', startAt < now() && now() < endAt)` compares both sides against
the same instant. Without that a query has no single "as of" moment and can
return a row satisfying a contradiction, which matters far more for a report
than for an access check.

The clock is injectable:

```js
const db = await createClient({ path: './schema.lite', now: () => new Date('2026-01-01T00:00:00Z') })
```

`now` takes a function returning a `Date` or an ISO string; absent, it is the
wall clock. It reaches both halves of the policy compiler — the WHERE and the
JS evaluator a `create` policy uses — and `@@softDelete`'s stamp, so a frozen
clock freezes every timestamp litestone writes rather than only the ones a
policy compares against.

**SQLite's own clock is refused in a `$raw` predicate.** `datetime('now')`
answers `2026-08-13 07:38:31` — a space, no milliseconds, no `Z` — while
litestone stores `2026-08-13T07:38:31.984Z`. The comparison is string-wise and
`'T'` sorts after a space, so `dueAt < datetime('now')` was right for rows from
earlier days and silently wrong for rows from today (`FJS-226`). Write
`sql\`dueAt < ${now()}\`` instead, or the structured form
`{ dueAt: { lt: new Date().toISOString() } }`.

`now()` and this `now` are **different clocks**, deliberately. The one here is
the request's instant, resolved once and injectable for a test. `now()` in a
`$raw` is SQLite's, fixed for the duration of one statement — which is what lets
two occurrences in one predicate agree, and what puts it out of reach of
`createClient({ now })`. A test that needs a frozen instant in a raw predicate
binds its own ISO string.

### Applying policies

```js
// Scope client to a user — policies apply to all queries
const userDb = db.$setAuth(req.user)

const posts = await userDb.posts.findMany()   // only returns allowed posts
await userDb.posts.create({ data: {...} })    // checked against @@allow('create', ...)

// Bypass all policies
const all = await db.asSystem().posts.findMany()

// Debug which policy blocked a query
const result = await userDb.posts.findMany({ policyDebug: true })
```

### Reaching a model through `include`

A relation is a read of the model it points at, and every rule that model
declares applies there too — the row policy filters the children, `_count`
counts only what the caller may read, `@guarded` and field `@allow` withhold
columns, and a `@@gate` the caller does not clear **refuses the query** rather
than answering an empty list (a gate is per model: *no rows* and *not for you*
are different answers).

```js
// Vault is @@gate("7"); the caller is level 4
await userDb.team.findMany({ include: { secrets: true } })
// AccessDeniedError: "Vault.read" requires level 7, user has level 4

// Post is @@allow('read', accountId == auth().accountId)
await userDb.account.findMany({ include: { posts: true } })
// each account carries only the posts this caller may read
```

The gate is checked before the query runs, so it names the model it refused.
`asSystem()` bypasses all of it, here as everywhere.

### Field-level policies

```prisma
model User {
  salary Float?   @allow('read',  auth().role == 'admin')   // hidden unless admin
  apiKey String?   @allow('write', auth().role == 'admin')   // read-only unless admin
}
```

`@allow('read', expr)` — field silently stripped when expr is false
`@allow('write', expr)` — field silently dropped from write data when expr is false
`@allow('all', expr)` — both

`asSystem()` always sees and writes all fields.

**Conflicts with `@guarded` and `@secret`, and the conflict is the point.**
`@guarded` answers both halves at once — a system-context column, stripped from
every read and refused on every write — so a field cannot carry both a lock that
says *nobody but the system* and a predicate that says *some callers*. Pick the
one that describes the column: `@allow('write', …)` for a column an admin may
set, `@guarded` for one only `asSystem()` touches. The two also fail
differently, which is deliberate: a field `@allow` DROPS the key, because the
same form body is legitimate for the caller one level up, while `@guarded`
REFUSES the write by name, because no caller was ever meant to send it.

## Gates — level-based access control

Assigns numeric levels to users (0–7) and declares the minimum level required per operation.

**Gates are enforced by default.** If any model declares `@@gate`, Litestone
installs the standard resolver (`FrontierGateGetLevel` — reads `verifiedAt`,
`activatedAt`, `role`, `isAdmin`, `isOwner`, `isSystemAdmin` off the auth
object) automatically. A declared gate is never silently inert. Models without
`@@gate` are completely ungated.

```js
// Nothing to install — @@gate in the schema is enough:
const db = await createClient({ path: './schema.lite', db: './app.db' })
```

To map identity to levels yourself, install your own `GatePlugin` — it replaces
the default resolver entirely:

```js
import { GatePlugin, LEVELS } from '@frontierjs/litestone'

const gate = new GatePlugin({
  async getLevel(user, model) {
    if (!user)                return LEVELS.STRANGER       // 0 — unauthenticated
    if (user.isSysAdmin)      return LEVELS.SYSADMIN       // 7
    if (user.role === 'admin') return LEVELS.ADMINISTRATOR  // 5
    if (user.isOwner)         return LEVELS.OWNER          // 6
    return LEVELS.USER                                     // 4
  }
})

const db = await createClient({ plugins: [gate], ... })
```

### Levels

| Level | Name | Typical use |
|---|---|---|
| 0 | `STRANGER` | Unauthenticated |
| 1 | `VISITOR` | Authenticated but unverified |
| 2 | `READER` | Verified, read-only |
| 3 | `CREATOR` | Can submit/create, can't manage (public forms, free tier) |
| 4 | `USER` | Full member, standard CRUD |
| 5 | `ADMINISTRATOR` | App admin |
| 6 | `OWNER` | Account/tenant owner |
| 7 | `SYSADMIN` | Global system admin (revocable) |
| 8 | `SYSTEM` | `asSystem()` only — never returned by `getLevel` |
| 9 | `LOCKED` | Impassable — not even `asSystem()` passes |

### The default resolver, and `undefined` vs `null`

A schema declaring any `@@gate` auto-installs `GatePlugin({ getLevel: FrontierGateGetLevel })`
when the app supplies no GatePlugin — a declared gate that silently does nothing
is a fail-open default. Supplying your own replaces it; supplying none does not
disable it.

That resolver reads `verifiedAt` / `activatedAt` / `role` / `isAdmin` /
`isOwner` / `isSystemAdmin`, and the distinction between an absent field and a
`null` one is the whole design:

| value | meaning | effect |
|---|---|---|
| `undefined` (absent) | the app does not model this stage | **not an objection** |
| `null` | modelled, and this user has not reached it | grades down |

An app with no verification flow leaves `verifiedAt` unset and its sessions
grade `USER`; an app that has one sets it to `null` until the user verifies, and
those sessions grade `VISITOR`. Absence never means "not yet" — otherwise every
app would have to restate a lifecycle it does not have just to make `@@gate`
usable.

Explicit standing outranks the lifecycle: `isSystemAdmin` / `isOwner` /
`isAdmin` are checked first, so an owner who never completed activation is still
the owner.

> **Fixed 2026-08-04.** This used to test `!user.verifiedAt`, which collapses
> absent into null — so every session from an app without a verification flow
> graded `VISITOR(1)`, below the `USER(4)` an ordinary model needs to read, and
> gates 403'd the whole API. The `role` check also ran ahead of the standing
> checks, so a system admin with no role string graded `CREATOR(3)`.

Junction's `sessionGateLevel()` is the same function for the same purpose on the
other side of the dependency boundary (Litestone cannot import Junction). They
are a hand copy — change one, change both.

### @@gate syntax

The canonical form is **named**: level names per operation, self-documenting,
no decoder ring.

```prisma
model Post {
  @@gate(read: VISITOR, write: USER, delete: OWNER)
}

model AdminSetting {
  @@gate(read: ADMINISTRATOR, write: ADMINISTRATOR, delete: LOCKED)
}
```

Keys: `read`, `create`, `update`, `delete`, and the shorthand `write`, which
expands to create + update + delete unless one of those is given explicitly:

```prisma
@@gate(read: STRANGER, write: USER)                  // 0.4.4.4
@@gate(read: READER, write: USER, delete: OWNER)     // 2.4.4.6 — delete overrides write
@@gate(write: USER)                                  // 0.4.4.4 — read defaults to STRANGER
```

Missing keys cascade: `read` defaults to `STRANGER` (0), `create` from `read`,
`update` from `create`, `delete` from `update`.

**Compact form** — the same four positions as a digit string
(`Read.Create.Update.Delete`), useful once you know the level scale by heart:

```prisma
@@gate("R.C.U.D")      // four positions — required level for each op
@@gate("4")            // shorthand: all ops require USER (level 4+)
@@gate("2.4.4.6")      // READER to read, USER to write, OWNER to delete
@@gate("1.8.8.9")      // anyone can read, SYSTEM to write, LOCKED to delete
```

Both forms compile to the same gate; use whichever reads better — new schemas
and all documentation examples use the named form.

## The identity models — the one recipe worth copying

`8` is not a strong `5`. It means *nothing outside `asSystem()` has anything to
say to this model*, which is true of a table holding credential material and
false of the table your own screens list. `@frontierjs/auth` ships the
distinction:

```prisma
model User {
  emailVerified  Boolean  @default(false) @allow('write', auth().isAdmin)
  role           String   @default("user") @allow('write', auth().isAdmin)

  @@gate("4.4.4.5")
  @@allow('update', id == auth().id || auth().isAdmin)
}

model Credential { …  @@gate("8") }   // the password hash, the API key HMAC
model Session    { …  @@gate("8") }   // the bearer token
model Verification { … @@gate("8") }  // the reset token
```

Three declarations answering three different questions, and **you need all
three**:

| Declaration | Question | What it does when it refuses |
|---|---|---|
| `@@gate` | what KIND of caller | throws, naming the model and the level |
| `@@allow` | WHOSE row | filters — the write matches nothing and answers |
| field `@allow('write', …)` | WHICH columns | drops the field, keeps the rest of the write |

A gate is per model, never per row, so `@@gate("4.4.4.5")` on its own says *any
signed-in caller may write any user row*. That is not an argument for raising
the level — at `8` an app cannot list its own people, and every screen that
needs to ends up in `asSystem()`, where nothing is enforced at all. It is an
argument for declaring the other two.

**The field policies are the part people leave out, and they are the security
half.** Whatever your `getLevel` reads — `role`, `isAdmin`, a `status` column, a
tenant's membership — is a column that must not be writable by the caller being
graded, or the ladder grades a caller on a value the caller chose. Write the
policy against the same standing the level is graded from (`auth().isAdmin`
here) so the two cannot disagree about who an administrator is.

Because a policy filters rather than throws, **the refused write returns
normally**. Test it by reading the row back through `asSystem()`; the return
value cannot tell you.

## Combining both systems

GatePlugin checks run before row-level policies. If a user's level is below the `@@gate` threshold, the request is rejected before any SQL runs. If level passes, row-level policies are then applied as WHERE injections.

```prisma
model Post {
  ownerId Int @default(auth().id)

  @@gate("1.2.4.6")                           // level check first
  @@allow('update', ownerId == auth().id)     // row check second
}
```

## @default(auth().id)

Stamp a field from `ctx.auth` at create time — no SQL DEFAULT emitted:

```prisma
model Post {
  ownerId   Int  @default(auth().id)
  ownerType String     @default(auth().type)
}
```

Requires a scoped client (`db.$setAuth(user)`).
