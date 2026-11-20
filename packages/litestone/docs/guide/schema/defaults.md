# Defaults

A `@default` fills a field the caller left out. A value in the write always wins.

```lite
model Ticket {
  id        Int      @id
  status    String   @default("open")
  priority  Int      @default(3)
  ref       String   @default(nanoid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

```js
const t = await db.ticket.create({ data: {} })
const urgent = await db.ticket.create({ data: { priority: 1 } })
if (t.status !== 'open' || t.priority !== 3 || t.ref.length !== 21 || urgent.priority !== 1) throw new Error('unexpected defaults')

const later = await db.ticket.update({ where: { id: t.id }, data: { status: 'closed' } })
if (later.updatedAt < t.updatedAt) throw new Error('updatedAt did not move')
```

## What else it can do

- `@default(now())`, `uuid()`, `ulid()`, `cuid()`, `nanoid()`: a clock reading or a minted id
- `@default(true)`, `@default("text")`, `@default(0)`: a literal
- `@default([])` and `@default(["a", "b"])`: an array literal
- `@default(Active)`: an enum member, written bare
- `@default(auth().id)` stamps the caller's id from `$setAuth`, when the write does not name one
- `@default(title)` copies a sibling field on create
- `@updatedAt` sets the time on every update
- `@createdBy` and `@updatedBy` stamp the caller, and a caller cannot forge them
- `@@createdBy` and `@@updatedBy` declare the pair on the model

**In depth:** [Schema § Default values](../../schema.md#default-values), [§ Lifecycle](../../schema.md#lifecycle), [Access control § `@default(auth().id)`](../../access-control.md#defaultauthid)
