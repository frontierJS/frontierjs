# Row policies

`@@allow` and `@@deny` say whose rows a caller may touch. They compile into the `WHERE` of every read, update and delete, so the filtering happens inside SQLite and cannot be forgotten.

```lite
model User { id Int @id  @@auth }

model Post {
  id      Int    @id @default(autoincrement())
  ownerId Int    @default(auth().id)
  status  String @default("draft")
  title   String

  @@allow(read,   status == 'published' || ownerId == auth().id)
  @@allow(create, auth() != null)
  @@allow(update, ownerId == auth().id)
  @@deny(delete,  status == 'published')
}
```

```js
const ann = db.$setAuth({ id: 1 })
const bob = db.$setAuth({ id: 2 })
const post = await ann.post.create({ data: { title: 'Draft' } })

const bobReads   = await bob.post.findMany()
const bobUpdates = await bob.post.update({ where: { id: post.id }, data: { title: 'Mine now' } })
if (bobReads.length !== 0 || bobUpdates !== null) throw new Error('bob should see and change nothing')

await ann.post.update({ where: { id: post.id }, data: { status: 'published' } })
const gone = await ann.post.delete({ where: { id: post.id } })
if (gone !== null) throw new Error('a published post cannot be deleted')
```

A policy filters rather than throws, so a wrong policy is an empty screen and a refusal never confirms that a row exists.

## What else it can do

- No `@@allow` for an operation leaves it unrestricted, and the first one makes it deny-by-default
- Several `@@allow` on one operation are ORed, and `@@deny` always wins
- The operations are `read`, `create`, `update`, `postUpdate`, `delete`, `write` and `all`
- A third argument is the refusal message: `@@allow(update, expr, "Only your own posts")`
- Expressions use `==`, `!=`, comparisons, `&&`, `||`, `!`, `in`, `cond ? a : b`, `now()` and arithmetic
- `auth()` is the principal, `null` when nobody is signed in
- `check(field)` delegates to a related model's policy
- `relation.column` and `relation.some(...)` reach one relation away
- Create is the exception: the payload is the row, so a refused create throws
- A `@default(auth().id)` stamps the owner from the scoped client
- A policy is compiled twice, to SQL for reads and updates and to JS for creates, and the two agree

**In depth:** [Access control § Row-level policies](../../access-control.md#row-level-policies), [§ Policy expressions](../../access-control.md#policy-expressions), [§ Applying policies](../../access-control.md#applying-policies)
