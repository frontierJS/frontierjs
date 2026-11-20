# Models and fields

A model is a table; a field is a column. A field's type decides how it is stored and what JavaScript gives back.

```lite
model Task {
  id       Int       @id
  title    String
  notes    String?
  points   Float     @default(1)
  done     Boolean   @default(false)
  dueAt    DateTime?
  meta     Json?
  tags     String[]

  @@index([done, dueAt])
}
```

```js
const t = await db.task.create({ data: { title: 'Write docs', meta: { team: 'core' }, tags: ['a', 'b'] } })
if (t.done !== false || t.meta.team !== 'core' || t.tags.length !== 2 || t.notes !== null) throw new Error('unexpected row')
```

A `Boolean` is stored as 0 or 1 and read back as `true` or `false`. A `Json` or array column is stored as text and parsed on the way out. A trailing `?` makes a field nullable, and a list with no `?` reads back as `[]` when absent.

## What else it can do

- `Int`, `Float`, `String`, `Boolean`, `DateTime` (ISO-8601 text), `Json`, `Bytes`
- `File` and `File[]` for stored files
- An enum name, or `EnumName[]` for a set of its values
- `Type[]` for a list of typed JSON objects
- `@map("column")` names the column; `@@map("table")` names the table
- `@@index([a, b])`, including `b(sort: Desc)` and `where:` for a partial index
- `@@unique([a, b])` for a composite constraint
- `@@noStrict` opts a table out of SQLite `STRICT` mode

**In depth:** [Schema § Types](../../schema.md#types), [§ Field attributes](../../schema.md#field-attributes), [§ Table structure](../../schema.md#table-structure)
