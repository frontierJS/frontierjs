# Optimistic concurrency

A `@version` column stops two editors overwriting each other. An update carries the version it read, and one that is out of date is refused instead of silently erasing the other.

```lite
model Order {
  id      Int    @id
  status  String
  version Int    @version
}
```

```js
await db.order.create({ data: { id: 1, status: 'new' } })

const alice = await db.order.findUnique({ where: { id: 1 } })
const bob   = await db.order.findUnique({ where: { id: 1 } })

await db.order.update({ where: { id: 1 }, data: { status: 'paid', version: alice.version } })

try { await db.order.update({ where: { id: 1 }, data: { status: 'void', version: bob.version } }) } catch (e) { if (e.name !== 'VersionConflictError') throw e }

const row = await db.order.findUnique({ where: { id: 1 } })
if (row.status !== 'paid' || row.version !== 2) throw new Error('the first write should stand')
```

## What else it can do

- The version starts at 1 and the database bumps it on every update
- The version travels in `data`, so a row from a form round-trips with no extra plumbing
- It is a precondition and never a value: it is never set to what arrived
- A refused update leaves the row as the first writer left it

**In depth:** [Schema § @version](../../schema.md#version--optimistic-concurrency)
