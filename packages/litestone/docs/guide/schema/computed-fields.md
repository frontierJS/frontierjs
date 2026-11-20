# Computed fields

A computed field is a value the schema derives instead of storing it a caller's way. Which attribute you pick decides whether you can filter and sort by it.

```lite
model Person {
  id        Int       @id
  firstName String
  lastName  String?
  dueAt     DateTime?
  doneAt    DateTime?

  fullName  String?   @generated(`{firstName} {lastName}`)
  overdue   Boolean   @derived(dueAt < now() && doneAt == null)
}
```

```js
await db.person.create({ data: { firstName: 'Cher' } })
await db.person.create({ data: { firstName: 'Ada', lastName: 'Lovelace', dueAt: '2000-01-01T00:00:00Z' } })

const names = (await db.person.findMany({ orderBy: { id: 'asc' } })).map(p => p.fullName)
const late = await db.person.findMany({ where: { overdue: true } })
if (names.join('|') !== 'Cher|Ada Lovelace' || late.length !== 1) throw new Error(names.join('|'))
```

A missing last name takes its separator with it, so `Cher` has no trailing space. Neither field can be written.

## What else it can do

- `@generated(a * b)` is arithmetic a form can preview, with `+ - *` and `round()`
- `@generated("sql expr")` is SQL, server-only
- ``@generated(`...`, stored)`` materializes the column
- `@derived(expr)` is computed in the SELECT, with `now()` offsets like `now() + 2d`
- `@from(Model, count: true)` counts, sums or picks across a relation
- `@computed` is a JavaScript function in `computed.js`; it cannot be filtered or sorted
- `needs: [...]` on a computed function narrows what it fetches

**In depth:** [Schema § Derived & generated](../../schema.md#derived--generated), [§ `@generated(a * b)`](../../schema.md#generateda--b--arithmetic-a-screen-can-preview), [§ `@derived(expr)`](../../schema.md#derivedexpr--computed-in-sql-so-it-can-be-queried)
