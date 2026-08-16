# Soft Delete

Add `@@softDelete` to a model and Litestone handles all the details: filtering, restore, cascades, and partial indexes.

## Setup

```prisma
model Post {
  id        Int  @id
  title     String
  deletedAt DateTime?

  @@softDelete
}
```

`@@softDelete` requires a `deletedAt DateTime?` field. All reads automatically filter `WHERE deletedAt IS NULL`. Indexes on soft-delete models are automatically partial (covering live rows only).

## Operations

```js
// Soft delete — sets deletedAt to now()
await db.post.remove({ where: { id: 1 } })

// Read including soft-deleted rows
await db.post.findMany({ withDeleted: true })

// Read only soft-deleted rows
await db.post.findMany({ onlyDeleted: true })

// Restore — clears deletedAt, answers the restored rows (an array; `where`
// can match many, and an empty array means nothing was deleted to restore)
await db.post.restore({ where: { id: 1 } })

// Hard delete — physically removes row regardless of @@softDelete
await db.post.delete({ where: { id: 1 } })
```

## Cascading soft delete

Use `@@softDelete(cascade)` to propagate soft-deletes through FK children:

```prisma
model Account {
  id        Int @id
  name      String
  users     users[]
  sessions  sessions[] @hardDelete   // hard-deleted when account is soft-deleted
  deletedAt DateTime?
  @@softDelete(cascade)
}

model User {
  id        Int  @id
  accountId Int
  account   accounts @relation(fields: [accountId], references: [id])
  deletedAt DateTime?
  @@softDelete
}

model Session {
  id        Int @id
  userId    Int
  deletedAt DateTime?
  @@softDelete
}
```

When `accounts.remove()` is called:
- `accounts.deletedAt` is stamped
- All related `users.deletedAt` is stamped (cascade)
- All related `sessions` rows are hard-deleted (`@hardDelete`)

`restore()` reverses the cascade — restores the account and its soft-deleted children. Hard-deleted children cannot be restored.

## @hardDelete on a relation field

Overrides cascade behavior for a specific child model:

```prisma
model Account {
  users    users[]                 // soft-deleted when account is soft-deleted
  sessions sessions[] @hardDelete  // hard-deleted (rows gone) when account is soft-deleted
  @@softDelete(cascade)
}
```

## Footgun warning

The parser emits a warning when a `@@softDelete` model has `hasMany` relations to other `@@softDelete` models but uses plain `@@softDelete` (not cascade):

```
Warning: model 'accounts' has @@softDelete but its 'users' relation also has @@softDelete.
Consider using @@softDelete(cascade) to avoid leaving orphaned deleted children.
```

## exists() and count() with soft delete

Both automatically exclude soft-deleted rows. Use `withDeleted: true` to include them:

```js
await db.post.exists({ where: { id: 1 } })                      // false if soft-deleted
await db.post.exists({ where: { id: 1 }, withDeleted: true })   // true
await db.post.count()                                            // live rows only
await db.post.count({ withDeleted: true })                       // all rows
```

## Transitions and soft-delete

The two are independent. `@@transitions` is enforced on `update()` and `upsert()` — the operations that write the status column. `remove()` stamps `deletedAt` and **does not** consult the state machine, even on a `@@softDelete` model where it is a SQL `UPDATE` rather than a `DELETE`.

So a state machine cannot, by itself, stop a row being removed:

```prisma
enum OrderStatus { pending  cancelled }

model Order {
  id        Int @id
  status    OrderStatus @default(pending)
  deletedAt DateTime?

  @@softDelete
  @@transitions(status, cancel: pending -> cancelled)
}
```

```js
await db.order.update({ where: { id: 1 }, data: { status: 'cancelled' } })  // enforced
await db.order.remove({ where: { id: 1 } })                                  // not enforced
```

To require a state before deletion, express it as access rather than as a transition. A row-level policy narrows the `WHERE`, and `remove()` does honour it:

```prisma
@@deny('delete', status != 'cancelled')
```

```js
await db.order.remove({ where: { id: 1 } })   // → null while pending; the row is untouched
```

Note it returns `null` rather than throwing — a policy filters rather than refuses, so "no such deletable row" and "not allowed" are the same answer.

See [schema.md](./schema.md#state-machines) for `@@transitions` itself.

## `@unique` and a deleted row

**A soft-deleted row keeps its `@unique` values.** The row is still there — soft
delete is a visibility rule, not a deletion — so the slot it holds is still
held:

```js
await db.doc.create({ data: { code: 'x' } })
await db.doc.remove({ where: { id: 1 } })
await db.doc.count()                            // 0
await db.doc.create({ data: { code: 'x' } })    // SoftDeletedUniqueError
```

That refusal names the field, the value and the row holding it, and it is a 409
rather than a 500. Every write path gives the same answer — `create`,
`createMany`, `upsert` and `upsertMany`.

**Why not free the slot?** Because `@unique` would stop being true. A partial
index (`… WHERE "deletedAt" IS NULL`) lets two rows hold one value, so
`findUnique({ code: 'x' }, { withDeleted: true })` would legitimately match two,
and every export, audit query and migration that reads deleted rows would see
duplicates on a column declared unique. It would also make `restore()`
conditionally impossible — a way back that fails because a stranger took the
value in the meantime is not a way back. Ruled in `DECISIONS.md` § Query & write
semantics.

### Releasing a slot on purpose

The row owns the value, so releasing it is a decision the app makes rather than
a side effect:

```js
// 1. keep the row, move the value out of the way
await db.doc.update({ where: { id: 1 }, data: { code: 'x-archived' }, withDeleted: true })

// 2. or stop keeping the row
await db.doc.delete({ where: { id: 1 }, withDeleted: true })

await db.doc.create({ data: { code: 'x' } })    // fine, either way
```

An app that lets a departed user's email be re-registered does this in its
account-deletion flow. That is the explicit version of what a partial index
would have done silently — and the point is that impersonating a closed account
should be a decision somebody made.
