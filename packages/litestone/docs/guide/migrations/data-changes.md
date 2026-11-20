# Data changes

A migration file holds schema changes only. A backfill or a correction is an ordinary script, run after `migrate apply`, that touches only the rows still needing it.

```lite
model Post {
  id    Int     @id
  title String
  slug  String?
}
```

```js
const sys = db.asSystem()
await sys.post.create({ data: { id: 1, title: 'Hello World' } })

for (const post of await sys.post.findMany({ where: { slug: null } }))
  await sys.post.update({ where: { id: post.id }, data: { slug: post.title.toLowerCase().replace(/\s+/g, '-') } })

if ((await sys.post.findUnique({ where: { id: 1 } })).slug !== 'hello-world') throw new Error('the backfill should fill the slug')
if ((await sys.post.findMany({ where: { slug: null } })).length !== 0) throw new Error('a rerun would have nothing to do')
```

Because it selects only `slug: null`, running it twice is a no-op.

## What else it can do

- Chain it after the migration: `litestone migrate apply && bun db/backfill-slugs.js`
- `asSystem()` reads and writes past the gate and policies
- A `.js` file in `migrations/` is refused everywhere, with a nonzero exit
- A script cannot be replayed into the shadow database, which is why it is not a migration

**In depth:** [Migrations § Data changes are not migrations](../../migrations.md#data-changes-are-not-migrations)
