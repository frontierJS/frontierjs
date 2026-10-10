# Guide: Row-Level Security

Combine row-level policies and GatePlugin to build a complete permission system — filtering in SQL, not JS.

---

## The two systems

**GatePlugin** answers: "can this user perform this operation at all?"
- Integer levels: STRANGER (0) through SYSADMIN (7); 8 is `asSystem()` and 9 is LOCKED
- Declared per-model with `@@gate("R.C.U.D")`
- Evaluated before any SQL runs

**Row-level policies** answer: "which specific rows can this user access?"
- Boolean expressions against the row and `auth()`
- Compiled to SQL `WHERE` clauses — filter happens in SQLite
- Evaluated inside every query

Use both together for defense in depth.

---

## A complete example: blog with roles

```lite
// schema.lite
enum Role { admin  editor  viewer }

model User {
  id     Int    @id
  email  String @unique
  role   Role   @default(viewer)
  salary Float? @allow('read',  auth().role == 'admin')   // absent unless admin
  notes  String? @allow('write', auth().role == 'admin')  // read-only unless admin

  @@auth
}

model Post {
  id        Int  @id
  authorId  Int  @default(auth().id)
  status    String     @default("draft")  // draft | published | archived
  title     String
  body      String
  createdAt DateTime @default(now())
  deletedAt DateTime?

  @@softDelete

  // Level-based gate: viewers can read, editors can write, admins can delete
  @@gate("1.3.4.5")

  // Row policies: published posts visible to all; drafts only to author or admin
  @@allow('read',   status == 'published' || authorId == auth().id || auth().role == 'admin')
  @@allow('create', auth() != null)
  @@allow('update', authorId == auth().id || auth().role == 'admin')
  @@deny('update',  status == 'archived')            // archived posts are immutable
  @@allow('delete', auth().role == 'admin')           // only admins can delete
}
```

`@@auth` on `User` is what makes `auth().role` legal: a policy may name only a
claim the principal is known to carry, and the `@@auth` model's columns are
that set. Without it the client refuses to build, naming the claim.

---

## Gate setup

A schema that declares a `@@gate` installs `GatePlugin` itself, grading a
session by its standing fields (`role`, `isAdmin`, `verifiedAt`, …). Passing
your own `GatePlugin` replaces that grader:

```js
import { createClient, GatePlugin, LEVELS } from '@frontierjs/litestone'

const gate = new GatePlugin({
  getLevel(user, model) {
    if (!user)                  return LEVELS.STRANGER       // 0
    if (user.role === 'admin')  return LEVELS.ADMINISTRATOR  // 5
    if (user.role === 'editor') return LEVELS.CREATOR        // 3
    return LEVELS.VISITOR                                    // 1
  }
})

const db = await createClient({ path: './schema.lite', db: './blog.db', plugins: [gate] })
```

---

## How they layer

For a viewer reading posts:

1. `getLevel(viewer, 'Post')` → `VISITOR` (1)
2. Gate check: `@@gate("1.3.4.5")` → read requires level 1 → ✓ passes
3. SQL injected: `WHERE "deletedAt" IS NULL AND (("status" = ? OR "authorId" = ?) OR ? = ?)` — bound to `'published'`, the viewer's id, the viewer's role and `'admin'`
4. Returns only published posts (viewer can't see drafts they don't own)

For an unauthenticated user:

1. `getLevel(null, 'Post')` → `STRANGER` (0)
2. Gate check: `@@gate("1...")` → read requires level 1 → ✗ blocked immediately
3. No SQL runs — `AccessDeniedError` thrown

For an editor trying to update an archived post:

1. `getLevel(editor, 'Post')` → `CREATOR` (3)
2. Gate check: `@@gate("1.3.4.5")` → update requires level 4 → ✗ blocked
3. `AccessDeniedError` thrown before policy check even runs

Measured, with the schema above:

```js
import { GatePlugin, LEVELS, AccessDeniedError } from '@frontierjs/litestone'

const gate = new GatePlugin({
  getLevel(user) {
    if (!user)                  return LEVELS.STRANGER
    if (user.role === 'admin')  return LEVELS.ADMINISTRATOR
    if (user.role === 'editor') return LEVELS.CREATOR
    return LEVELS.VISITOR
  }
})
const db = await createClient({ path: './schema.lite', db: ':memory:', plugins: [gate] })

const sys    = db.asSystem()
const admin  = await sys.user.create({ data: { email: 'admin@example.com', role: 'admin' } })
const viewer = await sys.user.create({ data: { email: 'viewer@example.com' } })
const editor = await sys.user.create({ data: { email: 'editor@example.com', role: 'editor' } })
await sys.post.create({ data: { authorId: admin.id, status: 'published', title: 'Hello', body: '…' } })
await sys.post.create({ data: { authorId: admin.id, status: 'draft',     title: 'Draft', body: '…' } })
await sys.post.create({ data: { authorId: admin.id, status: 'archived',  title: 'Old',   body: '…' } })

const titles = (await db.$setAuth(viewer).post.findMany()).map(p => p.title)
if (titles.join() !== 'Hello') throw new Error(`viewer saw ${titles}`)

try { await db.post.findMany(); throw new Error('a stranger read posts') }
catch (e) { if (!(e instanceof AccessDeniedError)) throw e }

try { await db.$setAuth(editor).post.update({ where: { id: 3 }, data: { title: 'x' } }); throw new Error('an editor updated') }
catch (e) { if (!(e instanceof AccessDeniedError)) throw e }
```

---

## Scoping per request

`$setAuth(user)` RETURNS a scoped client and mutates nothing — keep what it
returns:

```js fragment
// middleware
req.db = db.$setAuth(req.user)

// Handler — policies and gate level apply automatically
const posts = await req.db.post.findMany()
// Returns only posts this user is allowed to read, filtered in SQL
```

---

## Bypassing for admin operations

```js
// Cron job — runs without a user context, needs full access
const allPosts = await db.asSystem().post.findMany({ withDeleted: true })
// → all posts, including soft-deleted, no policy filtering
```

`asSystem()` bypasses the gate (it grades as level 8) and every
`@@allow`/`@@deny` policy. It does not lift the soft-delete filter — that is
what `withDeleted: true` is for — nor a `@check`, `@immutable` or the
`@@transitions` machine.

---

## Field-level policies

Restrict visibility of specific fields. `salary` and `notes` on `User` above carry one each:

```js
const sys    = db.asSystem()
const admin  = await sys.user.create({ data: { email: 'admin@example.com', role: 'admin', salary: 85000, notes: 'VIP' } })
const viewer = await sys.user.create({ data: { email: 'viewer@example.com' } })

await db.$setAuth(viewer).user.findUnique({ where: { id: admin.id } })
// → { id: 1, email: 'admin@example.com', role: 'admin', notes: 'VIP' }        — no salary key at all
await db.$setAuth(admin).user.findUnique({ where: { id: admin.id } })
// → { id: 1, email: 'admin@example.com', role: 'admin', salary: 85000, notes: 'VIP' }

const row = await db.$setAuth(viewer).user.update({ where: { id: viewer.id }, data: { notes: 'mine' } })
// → the write succeeds and `notes` is still null: the key was dropped, not refused
if (row.notes !== null) throw new Error('a viewer wrote notes')
```

A field `@allow('read', …)` the caller fails is **omitted** from the row — the
key is absent, not `null`, so a reader can tell *hidden* from *empty*. A field
`@allow('write', …)` the caller fails drops that key from the payload silently,
because the same form body is legitimate for someone else. Neither throws.

---

## Debugging policies

`policyDebug` is a `createClient` option, not a query option. It prints the
`WHERE` each policy compiled to, with its bindings, on every graded read and
write:

```js
const db = await createClient({ path: './schema.lite', db: ':memory:', policyDebug: true })
// [litestone:policy] read  "Post"  → WHERE ((("status" = ? OR "authorId" = ?) OR ? = ?))  ["published", 1, "viewer", "admin"]
```

`'verbose'` adds the full statement. Useful during development to verify the SQL being generated.

---

## Common patterns

### Public read, authenticated write

```lite
model Comment {
  id      Int    @id
  ownerId Int    @default(auth().id)
  body    String

  @@allow('read', true)              // anyone can read
  @@allow('create', auth() != null)  // must be logged in to write
  @@allow('update', ownerId == auth().id)
  @@allow('delete', ownerId == auth().id)
}
```

### Team-scoped data

`auth().teamId` is a claim, so the principal model declares it: a `teamId`
column on the `@@auth` model, or a top-level `claim teamId`.

```lite
model User {
  id     Int @id
  teamId Int

  @@auth
}

model Task {
  id     Int @id
  teamId Int

  @@allow('read',   teamId == auth().teamId)
  @@allow('create', teamId == auth().teamId)
  @@allow('update', teamId == auth().teamId)
  @@allow('delete', teamId == auth().teamId)
}
```

### Admin-only model

```lite
model SystemConfig {
  id    Int    @id
  value String

  @@gate("5.5.5.5")    // ADMINISTRATOR required for everything
}
```

### Completely locked model

```lite
model InternalEvent {
  id      Int    @id
  payload String

  @@gate("9")          // LOCKED — not even asSystem() can access
}
```

A read of a LOCKED model throws `AccessDeniedError` — `"InternalEvent.read" is LOCKED` — from `asSystem()` too; the rows are reachable only by raw SQL.
