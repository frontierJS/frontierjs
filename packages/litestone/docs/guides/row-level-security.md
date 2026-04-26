# Guide: Row-Level Security

Combine row-level policies and GatePlugin to build a complete permission system — filtering in SQL, not JS.

---

## The two systems

**GatePlugin** answers: "can this user perform this operation at all?"
- Integer levels: STRANGER (0) through SYSADMIN (7)
- Declared per-model with `@@gate("R.C.U.D")`
- Evaluated before any SQL runs

**Row-level policies** answer: "which specific rows can this user access?"
- Boolean expressions against the row and `auth()`
- Compiled to SQL `WHERE` clauses — filter happens in SQLite
- Evaluated inside every query

Use both together for defence in depth.

---

## A complete example: blog with roles

```prisma
// schema.lite
enum Role { admin  editor  viewer }

model User {
  id    Integer @id
  email Text    @unique
  role  Role    @default(viewer)
  @@auth
}

model Post {
  id        Integer  @id
  authorId  Integer  @default(auth().id)
  status    Text     @default("draft")  // draft | published | archived
  title     Text
  body      Text
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

---

## Gate setup

```js
import { GatePlugin, LEVELS } from '@frontierjs/litestone'

const gate = new GatePlugin({
  async getLevel(user, model) {
    if (!user)                  return LEVELS.STRANGER       // 0
    if (user.role === 'admin')  return LEVELS.ADMINISTRATOR  // 5
    if (user.role === 'editor') return LEVELS.CREATOR        // 3
    return LEVELS.VISITOR                                    // 1
  }
})

const db = await createClient({ path: './schema.lite', plugins: [gate] })
```

---

## How they layer

For a viewer reading posts:

1. `getLevel(viewer, 'posts')` → `VISITOR` (1)
2. Gate check: `@@gate("1.3.4.5")` → read requires level 1 → ✓ passes
3. SQL injected: `WHERE (status = 'published' OR authorId = ?) AND deletedAt IS NULL`
4. Returns only published posts (viewer can't see drafts they don't own)

For an unauthenticated user:

1. `getLevel(null, 'posts')` → `STRANGER` (0)
2. Gate check: `@@gate("1...")` → read requires level 1 → ✗ blocked immediately
3. No SQL runs — `AccessDeniedError` thrown

For an editor trying to update an archived post:

1. `getLevel(editor, 'posts')` → `CREATOR` (3)
2. Gate check: `@@gate("1.3.4.5")` → update requires level 4 → ✗ blocked
3. `AccessDeniedError` thrown before policy check even runs

---

## Scoping per request

```js
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
const allPosts = await db.asSystem().posts.findMany({ withDeleted: true })
// → all posts, including soft-deleted, no policy filtering
```

`asSystem()` bypasses both GatePlugin (sets level to 8) and all `@@allow`/`@@deny` policies.

---

## Field-level policies

Restrict visibility of specific fields:

```prisma
model User {
  email  Text
  salary Real?   @allow('read',  auth().role == 'admin')  // hidden unless admin
  notes  Text?   @allow('write', auth().role == 'admin')  // read-only unless admin
}
```

```js
const user = await req.db.user.findUnique({ where: { id: 1 } })
// viewer: { id: 1, email: 'alice@example.com', salary: null, notes: null }
// admin:  { id: 1, email: 'alice@example.com', salary: 85000, notes: 'VIP' }
```

Fields are silently stripped (not thrown) when `auth()` doesn't pass the expression.

---

## Debugging policies

```js
const result = await req.db.post.findMany({ policyDebug: true })
// Attaches _policyFilter to the result showing which WHERE clauses were injected
```

Useful during development to verify the SQL being generated.

---

## Common patterns

### Public read, authenticated write

```prisma
@@allow('read', true)              // anyone can read
@@allow('create', auth() != null)  // must be logged in to write
@@allow('update', ownerId == auth().id)
@@allow('delete', ownerId == auth().id)
```

### Team-scoped data

```prisma
model Task {
  teamId Integer

  @@allow('read',   teamId == auth().teamId)
  @@allow('create', teamId == auth().teamId)
  @@allow('update', teamId == auth().teamId)
  @@allow('delete', teamId == auth().teamId)
}
```

### Admin-only model

```prisma
model SystemConfig {
  @@gate("5.5.5.5")    // ADMINISTRATOR required for everything
}
```

### Completely locked model

```prisma
model InternalEvent {
  @@gate("9")          // LOCKED — not even asSystem() can access
}
```
