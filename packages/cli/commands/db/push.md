---
title: db:push
description: Apply schema.lite changes to the database directly — no migration file created
alias: db-push
examples:
  - fli db:push
  - fli db:push --dry
flags:
  dry:
    type: boolean
    description: Preview the SQL that would be run without executing it
    defaultValue: false
---

```js
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)

if (flag.dry) {
  log.info('Previewing schema changes (dry run)...')
  context.exec({ command: `${litestone(context)} migrate dry-run --schema ${schema}` })
} else {
  log.info('Pushing schema to database...')
  // `db push` diffs the schema against the live database. `migrate apply`
  // replays migration FILES — on a project that has none it reports success
  // having done nothing, which is a new model that silently never got a table.
  context.exec({ command: `${litestone(context)} db push --schema ${schema}` })
  log.success('Schema applied')
  // `<db>/.json/schema.json`, not beside the .lite. It is a DERIVED document
  // meant to be copied out — into an editor, a validator, a client generator —
  // and it is regenerated on every push, so committing it means committing a
  // file nothing gates and everything can outdate. The dot-directory is this
  // repo's mark for exactly that (`api/src/emails/.preview/`), and it is
  // gitignored for the same reason.
  //
  const { jsonSchemaPath } = await import(path.resolve(global.fliRoot, 'core/derived-paths.js'))
  const jsonOut = jsonSchemaPath(path.dirname(schema))
  log.info('Regenerating JSON Schema...')
  context.exec({ command: `${litestone(context)} jsonschema --schema ${schema} --out ${jsonOut}` })
  log.success(`JSON Schema updated — ${jsonOut}`)
}
```
