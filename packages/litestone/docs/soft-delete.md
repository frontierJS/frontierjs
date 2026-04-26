# Soft Delete

Add `@@softDelete` to a model and Litestone handles all the details: filtering, restore, cascades, and partial indexes.

## Setup

```prisma
model Post {
  id        Integer  @id
  title     Text
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

// Restore — clears deletedAt
await db.post.restore({ where: { id: 1 } })

// Hard delete — physically removes row regardless of @@softDelete
await db.post.delete({ where: { id: 1 } })
```

## Cascading soft delete

Use `@@softDelete(cascade)` to propagate soft-deletes through FK children:

```prisma
model Account {
  id        Integer @id
  name      Text
  users     users[]
  sessions  sessions[] @hardDelete   // hard-deleted when account is soft-deleted
  deletedAt DateTime?
  @@softDelete(cascade)
}

model User {
  id        Integer  @id
  accountId Integer
  account   accounts @relation(fields: [accountId], references: [id])
  deletedAt DateTime?
  @@softDelete
}

model Session {
  id        Integer @id
  userId    Integer
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

`remove()` on a model with `@@softDelete` is a SQL `UPDATE`, not `DELETE`. Transition enforcement runs on `remove()` — you can gate soft-delete behind a state machine:

```prisma
model Order {
  status    Text  // 'pending' → 'cancelled' → soft-delete allowed
  deletedAt DateTime?
  @@softDelete
  @@transitions([
    { name: 'cancel', from: ['pending'], to: 'cancelled' },
  ])
}
```
