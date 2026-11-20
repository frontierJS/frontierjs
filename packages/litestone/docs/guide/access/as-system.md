# Running as the system

`db.asSystem()` is the explicit way past the Warden, for a seed, a migration or a repair. It lifts authority, meaning who may, and still holds integrity, meaning what must be true.

```lite
model User { id Int @id  @@auth  @@gate(4) }

model Account {
  id      Int    @id @default(autoincrement())
  ownerId Int
  balance Int
  secret  String? @guarded

  @@gate(4)
  @@allow(read, ownerId == auth().id)
  @@check("balance >= 0")
}
```

```js
const sys = db.asSystem()
await sys.account.create({ data: { ownerId: 9, balance: 10, secret: 'k' } })

const ann = db.$setAuth({ id: 1, role: 'user' })
if ((await ann.account.findMany()).length !== 0) throw new Error('ann should not see it')
const seen = await sys.account.findMany()
if (seen.length !== 1 || seen[0].secret !== 'k') throw new Error('the system reads past policy and @guarded')

let held = false
try { await sys.account.update({ where: { id: 1 }, data: { balance: -5 } }) } catch (e) { if (e.name !== 'ValidationError') throw e; held = true }
if (!held) throw new Error('the system must not break a check')
```

The system sees past the policy and `@guarded`, but the `@@check` still refuses.

## What else it can do

- It lifts the gate at levels 0 to 8, `@@allow` and `@@deny`, `@guarded`, a move's `@gate` and `@system`
- It holds the gate at 9, soft-delete and template filters, `@check`, `@@check`, `@@arc` and `@immutable`
- It holds the `@@transitions` graph, and a create still starts at the column's `@default`
- `@hashed` stays unreadable, because nobody reads it back
- `update({ ..., system: ['col'] })` writes one `@system` column and keeps the gate, policies and audit actor
- `create({ ..., system: ['@@gate'] })` grades one call as the system against the model's own gate, keeping policies
- ``where: { $raw: sql`...` }`` puts raw SQL in a `where` with every policy still ANDed around it
- `db.asSystem().sql` is the one bypass that drops integrity too, and plain `db.sql` throws once a schema declares access rules
- Row tenancy survives `$setAuth(user).asSystem()`, and the unscoped `db.asSystem()` has no tenant to keep

**In depth:** [Warden § asSystem() lifts the Warden and holds integrity](../../warden.md#assystem-lifts-the-warden-and-holds-integrity)
