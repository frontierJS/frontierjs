# Scopes

A scope is a named, reusable query fragment registered per model. Call it on the accessor, add your own arguments, and chain scopes to combine them.

```lite
model Customer {
  id     Int    @id
  name   String
  status String @default("active")
  tier   String @default("basic")
}
```

```js
const db = await createClient({
  path: './schema.lite',
  db: ':memory:',
  scopes: { Customer: {
    active:  { where: { status: 'active' } },
    premium: { where: { tier: 'premium' } },
  } },
})

await db.customer.createMany({ data: [
  { name: 'Ann', tier: 'premium' },
  { name: 'Bob' },
  { name: 'Cy', status: 'lapsed', tier: 'premium' },
] })

const active  = await db.customer.active({ orderBy: { name: 'asc' } })
const both    = await db.customer.active.premium()
const counted = await db.customer.active.count()

if (active.length !== 2 || both.length !== 1 || both[0].name !== 'Ann' || counted !== 2) throw new Error('scopes disagree')
```

## What else it can do

- A scope's `where` may be a function of the context, for filters that depend on who is asking
- Every read method works under a scope: `count`, `findFirst`, `aggregate`, `groupBy`, `search`
- Scope wheres and your own `where` are always combined with AND
- For `orderBy`, `limit` and `include`, the last scope wins and your own argument overrides all
- Soft-delete filtering still applies under a scope
- A scope name that collides with a built-in method, a relation or `$` and `_` names is refused at startup
- A scope is a convenience, not a policy; a rule that must hold belongs in `@@allow`
- `@@scope` names a predicate in the schema, asked for with `where: { $scope: "name" }`, which also travels over HTTP

**In depth:** [Querying § Scopes](../../querying.md#scopes), [§ Merge rules](../../querying.md#merge-rules), [§ Scopes are not policies](../../querying.md#scopes-are-not-policies), [Filtering § @@scope](../../filtering.md#scope--a-named-predicate)
