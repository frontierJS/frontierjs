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
  id        Integer  @id
  accountId Integer
  ownerId   Integer  @default(auth().id)
  status    Text     @default("draft")
  title     Text

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
now()                 — current UTC timestamp
check(field)          — delegates to related model's read policy
field == value        field != value  field > value  field >= value  field < value  field <= value
expr1 && expr2        expr1 || expr2  !expr
```

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

### Field-level policies

```prisma
model User {
  salary Real?   @allow('read',  auth().role == 'admin')   // hidden unless admin
  apiKey Text?   @allow('write', auth().role == 'admin')   // read-only unless admin
}
```

`@allow('read', expr)` — field silently stripped when expr is false
`@allow('write', expr)` — field silently dropped from write data when expr is false
`@allow('all', expr)` — both

`asSystem()` always sees and writes all fields. Conflicts with `@guarded` and `@secret`.

## GatePlugin — level-based access control

Assigns numeric levels to users (0–7) and declares the minimum level required per operation.

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

### @@gate syntax

```prisma
@@gate("R.C.U.D")      // four positions: Read.Create.Update.Delete — required level for each op
@@gate("4")            // shorthand: all ops require USER (level 4+)
@@gate("2.4.4.6")      // READER to read, USER to write, OWNER to delete
@@gate("1.8.8.9")      // anyone can read, SYSTEM to write, LOCKED to delete
```

```prisma
model Post {
  @@gate("1.3.4.6")    // VISITOR=read, CREATOR=create, USER=update, OWNER=delete
}

model AdminSetting {
  @@gate("5.5.5.9")    // ADMINISTRATOR for all ops, LOCKED to delete
}
```

## Combining both systems

GatePlugin checks run before row-level policies. If a user's level is below the `@@gate` threshold, the request is rejected before any SQL runs. If level passes, row-level policies are then applied as WHERE injections.

```prisma
model Post {
  ownerId Integer @default(auth().id)

  @@gate("1.2.4.6")                           // level check first
  @@allow('update', ownerId == auth().id)     // row check second
}
```

## @default(auth().id)

Stamp a field from `ctx.auth` at create time — no SQL DEFAULT emitted:

```prisma
model Post {
  ownerId   Integer  @default(auth().id)
  ownerType Text     @default(auth().type)
}
```

Requires a scoped client (`db.$setAuth(user)`).
