# Adopting a database

`litestone introspect` reads a live SQLite file into a `.lite` schema, and `litestone import` does the same from a Prisma schema, a Rails `schema.rb`, a PostgreSQL dump or a Frappe app.

```sh
litestone introspect ./existing.db --out schema.lite
litestone import prisma/schema.prisma --out db/schema.lite
```

```lite
model Note {
  id    Int    @id
  title String
}
```

```js
import { generateLiteSchema } from '@frontierjs/litestone'

const lite = generateLiteSchema(db.$rawDbs.main)
if (!lite.includes('model Note')) throw new Error('the table should read back as a model')
```

## What else it can do

- `--report=<path>` writes what the reading could not carry, as JSON
- `--strict` exits 1 when anything changed meaning
- Every gap is graded `changed`, `lost` or `noted`, and `changed` is marked on its own line in the file
- `--from=prisma|rails|sql|frappe` states the format when the path does not
- Without `--out` the schema goes to stdout and the report to stderr
- Introspection cannot recover `@@allow`, `@@gate`, `@secret`, `@encrypted`, `@@trail` or `@@fts`
- `DateTime` and `Boolean` come back as `String` and `Int`, since SQLite stores them alike
- The output parses and reading it back is a fixed point
- `import` never guesses a polymorphic pair or single-table inheritance into `@@arc`
- Next: declare access, then `litestone migrate create`

**In depth:** [Migrations § Introspect an existing database](../../migrations.md#introspect-an-existing-database), [§ What introspection cannot recover](../../migrations.md#what-introspection-cannot-recover), [Importing a schema](../../import.md), [§ The output is not the whole answer](../../import.md#the-output-is-not-the-whole-answer)
