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
  context.exec({ command: `${litestone(context)} migrate apply --schema ${schema}` })
  log.success('Schema applied')
  log.info('Regenerating JSON Schema...')
  context.exec({ command: `${litestone(context)} jsonschema --schema ${schema}` })
  log.success('JSON Schema updated')
}
```
