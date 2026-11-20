# Reading rows

Every model has the same read methods: many rows, one row, a count, an existence check. Each returns plain objects, and a method that finds nothing says so with `null` or an empty list.

```lite
model User {
  id    Int    @id
  email String @unique
  role  String @default("member")
}
```

```js
await db.user.createMany({ data: [
  { email: 'ann@example.com', role: 'admin' },
  { email: 'bob@example.com' },
  { email: 'cy@example.com' },
] })

const admins = await db.user.findMany({ where: { role: 'admin' }, orderBy: { email: 'asc' }, limit: 10 })
const ann    = await db.user.findUnique({ where: { email: 'ann@example.com' } })
const nobody = await db.user.findFirst({ where: { role: 'owner' } })
const n      = await db.user.count({ where: { role: 'member' } })
const has    = await db.user.exists({ where: { email: 'bob@example.com' } })

if (admins.length !== 1 || ann.role !== 'admin' || nobody !== null || n !== 2 || has !== true) throw new Error('reads disagree')

try { await db.user.findUniqueOrThrow({ where: { email: 'nobody@example.com' } }) } catch (e) { if (e.code !== 'NOT_FOUND') throw e }
```

## What else it can do

- `findFirst` returns the first match, or `null`
- `findFirstOrThrow` and `findUniqueOrThrow` throw with `code: 'NOT_FOUND'` instead
- `exists` is a `SELECT 1 LIMIT 1`, cheaper than `count > 0`
- `findManyAndCount` returns `{ rows, total }` from one consistent read
- `distinct: true` with a `select` removes duplicate projected rows
- `withDeleted` and `onlyDeleted` widen a read on a soft-delete model
- `limit` and `offset` page a result

**In depth:** [Querying § Read operations](../../querying.md#read-operations)
