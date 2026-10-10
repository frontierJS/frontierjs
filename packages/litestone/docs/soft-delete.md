# Soft Delete

Add `@@softDelete` to a model and Litestone handles all the details: filtering, restore, cascades, and partial indexes.

## Setup

```lite
model Post {
  id        Int  @id
  title     String
  deletedAt DateTime?

  @@softDelete
}
```

`@@softDelete` requires a `deletedAt` field and is **refused at parse** without one — the attribute names that column, so a model missing it answers an empty list to every read with no error, because SQLite reads the unknown identifier in `WHERE "deletedAt" IS NULL` as a string literal rather than raising. The column must be OPTIONAL (a live row holds NULL there); its type is not checked, because `introspect` reads one out of a real database's TEXT column as `String?` and that behaves identically. All reads automatically filter `WHERE deletedAt IS NULL`. An `@@index` on a soft-delete model is partial — `WHERE "deletedAt" IS NULL`, live rows only — and a `@unique`/`@@unique` is not, which § `@unique` and a deleted row explains.

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

## exists() and count() with soft delete

Both automatically exclude soft-deleted rows. Use `withDeleted: true` to include them:

```js
await db.post.exists({ where: { id: 1 } })                      // false if soft-deleted
await db.post.exists({ where: { id: 1 }, withDeleted: true })   // true
await db.post.count()                                            // live rows only
await db.post.count({ withDeleted: true })                       // all rows
```

## Cascading soft delete

Use `@@softDelete(cascade)` to propagate soft-deletes through FK children:

```lite
model Account {
  id        Int @id
  name      String
  users     User[]
  sessions  Session[] @hardDelete   // hard-deleted when account is soft-deleted
  deletedAt DateTime?
  @@softDelete(cascade)
}

model User {
  id        Int  @id
  accountId Int
  account   Account @relation(fields: [accountId], references: [id])
  deletedAt DateTime?
  @@softDelete
}

model Session {
  id        Int @id
  accountId Int
  account   Account @relation(fields: [accountId], references: [id])
  deletedAt DateTime?
  @@softDelete
}
```

When `db.account.remove()` is called:
- the account's `deletedAt` is stamped
- every related `User` row's `deletedAt` is stamped (cascade)
- every related `Session` row is hard-deleted (`@hardDelete`)

```js
await db.account.create({ data: { id: 1, name: 'acme' } })
await db.user.create({ data: { id: 1, accountId: 1 } })
await db.user.create({ data: { id: 2, accountId: 1 } })
await db.session.create({ data: { id: 1, accountId: 1 } })

await db.user.remove({ where: { id: 2 } })        // deleted on their own, before the account
await db.account.remove({ where: { id: 1 } })

if (await db.user.count() !== 0) throw new Error('the cascade stamps every live user')
if (await db.session.count({ withDeleted: true }) !== 0) throw new Error('@hardDelete removes the rows')

await db.account.restore({ where: { id: 1 } })
const live = await db.user.findMany()
if (live.length !== 1 || live[0].id !== 1) throw new Error('user 2 was deleted before the account and stays deleted')
```

`restore()` reverses the cascade — restores the account and the children that cascade stamped. The cascade stamps every child with the parent's own timestamp and leaves a child that was already deleted with its older one, so `restore()` matches the stamp: a user deleted on their own before the account stays deleted when the account comes back. Hard-deleted children cannot be restored.

## @hardDelete on a relation field

Overrides cascade behavior for a specific child model:

```lite
model Account {
  id        Int @id
  users     User[]                 // soft-deleted when account is soft-deleted
  sessions  Session[] @hardDelete  // hard-deleted (rows gone) when account is soft-deleted
  deletedAt DateTime?
  @@softDelete(cascade)
}

model User    { id Int @id  accountId Int  account Account @relation(fields: [accountId], references: [id])  deletedAt DateTime?  @@softDelete }
model Session { id Int @id  accountId Int  account Account @relation(fields: [accountId], references: [id])  deletedAt DateTime?  @@softDelete }
```

## @keep on a relation field — the children outlive the parent

The third fate, and the one that used to have no spelling. `@hardDelete`
destroys the children; cascade stamps them; `@keep` says they stay live and that
this was the intention:

```lite
model Customer {
  id        Int @id
  orders    Order[] @keep   // a receipt outlives the customer record it names
  notes     Note[]          // cascaded with the parent
  deletedAt DateTime?
  @@softDelete(cascade)
}

model Order { id Int @id  customerId Int  customer Customer @relation(fields: [customerId], references: [id])  deletedAt DateTime?  @@softDelete }
model Note  { id Int @id  customerId Int  customer Customer @relation(fields: [customerId], references: [id])  deletedAt DateTime?  @@softDelete }
```

`@keep` covers the whole subtree beneath that child — if the order survives, its
lines survive with it, or the receipt is half a receipt. It says nothing about
removing the child directly: `db.order.remove()` still works and still cascades
into the order's own children. It holds for the relation it is written on: a row
the cascade reaches through another relation, or through a self-relation such
as a page's sub-pages, is stamped by that one.

It is also what silences the warning below, which is why it exists. Without it
the only way to stop a schema warning about children left live is to stop
leaving them live — and *the customer goes, the orders stay* is a shape any app
holding financial records has.

## Footgun warning

The parser emits a warning when a `@@softDelete` model has `hasMany` relations to other `@@softDelete` models but uses plain `@@softDelete` (not cascade):

```
Model 'Account': has @@softDelete and a hasMany relation to 'User' which also uses @@softDelete.
Soft-deleting a 'Account' row will NOT cascade to 'User' rows — they will remain live.
Add @@softDelete(cascade) to propagate, @hardDelete on the 'users' field to hard-delete
children, or @keep on it to say they outlive the parent on purpose.
```

Three ways to answer it: `@@softDelete(cascade)` on the parent, `@hardDelete` on
the field, or `@keep` on the field.

## Transitions and soft-delete

The two are independent. `@@transitions` is enforced on `update()` and `upsert()` — the operations that write the status column. `remove()` stamps `deletedAt` and **does not** consult the state machine, even on a `@@softDelete` model where it is a SQL `UPDATE` rather than a `DELETE`.

So a state machine cannot, by itself, stop a row being removed:

```lite
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

To require a state before deletion, express it as access rather than as a transition. A row-level policy narrows the `WHERE`, and `remove()` does honor it:

```lite
enum OrderStatus { pending  cancelled }

model Order {
  id        Int @id
  status    OrderStatus @default(pending)
  deletedAt DateTime?

  @@softDelete
  @@transitions(status, cancel: pending -> cancelled)
  @@deny('delete', status != 'cancelled')
}
```

```js
await db.order.create({ data: { id: 1 } })
const gone = await db.order.remove({ where: { id: 1 } })   // → null while pending; the row is untouched
if (gone !== null || await db.order.count() !== 1) throw new Error('a pending order is not removable')
```

Note it returns `null` rather than throwing — a policy filters rather than refuses, so "no such deletable row" and "not allowed" are the same answer.

See [schema.md](./schema.md#state-machines) for `@@transitions` itself.

## `@unique` and a deleted row

**A soft-deleted row keeps its `@unique` values.** The row is still there — soft
delete is a visibility rule, not a deletion — so the slot it holds is still
held:

```lite
model Doc {
  id        Int    @id @default(autoincrement())
  code      String @unique
  deletedAt DateTime?
  @@softDelete
}
```

```js
await db.doc.create({ data: { code: 'x' } })
await db.doc.remove({ where: { id: 1 } })
await db.doc.count()                            // 0
try {
  await db.doc.create({ data: { code: 'x' } })  // SoftDeletedUniqueError
  throw new Error('the slot is still held')
} catch (e) {
  if (e.name !== 'SoftDeletedUniqueError' || e.status !== 409) throw e
}
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
await db.doc.create({ data: { code: 'x' } })
await db.doc.remove({ where: { id: 1 } })

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
