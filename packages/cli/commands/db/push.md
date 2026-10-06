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
  accept-data-loss:
    type: boolean
    description: Apply a push that drops columns or tables and the values in them
    defaultValue: false
---

```js
if (!requireSchema($)) return

const { schema } = resolveDb($, flag)

if (flag.dry) {
  log.info('Previewing schema changes (dry run)...')
  $.exec({ command: `${litestone($)} migrate dry-run --schema ${schema}` })
} else {
  log.info('Pushing schema to database...')
  // `db push` diffs the schema against the live database. `migrate apply`
  // replays migration FILES — on a project that has none it reports success
  // having done nothing, which is a new model that silently never got a table.
  $.exec({ command: `${litestone($)} db push --schema ${schema}${flag['accept-data-loss'] ? ' --accept-data-loss' : ''}` })
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
  $.exec({ command: `${litestone($)} jsonschema --schema ${schema} --out ${jsonOut}` })
  log.success(`JSON Schema updated — ${jsonOut}`)
}
```
