# Field policies

A field `@allow` decides which callers may read or write one column. A caller who may not read it never sees the key, and a write they may not make is dropped while the rest of the write lands.

```lite
model User { id Int @id  @@auth  @@gate(4) }

model Staff {
  id     Int     @id
  name   String
  salary Float?  @allow(read,  auth().role == 'admin')
  grade  String? @allow(write, auth().role == 'admin')

  @@gate(0)
}
```

```js
const admin = db.$setAuth({ id: 1, role: 'admin' })
const user  = db.$setAuth({ id: 2, role: 'user' })

const row = await admin.staff.create({ data: { name: 'Ann', salary: 90000, grade: 'A' } })

const seenByUser = await user.staff.findUnique({ where: { id: row.id } })
if ('salary' in seenByUser) throw new Error('a user must not see salary')

await user.staff.update({ where: { id: row.id }, data: { name: 'Ann B', grade: 'Z' } })
const after = await db.asSystem().staff.findUnique({ where: { id: row.id } })
if (after.name !== 'Ann B' || after.grade !== 'A') throw new Error('the grade write should be dropped and the name kept')
```

The rule is written in the same expression language as a row policy, and it is compiled into the SQL of the read.

## What else it can do

- `@allow(read, expr)` strips the column, `@allow(write, expr)` drops it from a write, and `@allow(all, expr)` does both
- `asSystem()` always sees and writes every field
- `@guarded` is the lock for a column only the system touches: stripped from reads and refused on writes
- A field cannot carry both `@guarded` and `@allow`, because each answers who may touch the column
- `@omit` leaves a column out of the default payload, and `select` brings it back; `@omit(all)` removes it from every read
- A `where` naming a hidden column matches nothing, and an `orderBy` sorts a hidden cell as null
- A field `@allow` on a relation is refused at parse; put it on the foreign key
- A column your level resolver reads, such as `role`, needs its own `@allow(write, ...)` so a caller cannot grade themselves up

**In depth:** [Access control § Field-level policies](../../access-control.md#field-level-policies), [§ The identity models](../../access-control.md#the-identity-models--the-one-recipe-worth-copying), [Schema § Visibility & security](../../schema.md#visibility--security)
