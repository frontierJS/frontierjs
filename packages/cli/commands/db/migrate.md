---
title: db:migrate
description: Create a migration file from schema changes and apply it
alias: db-migrate
examples:
  - fli db:migrate
  - fli db:migrate --create-only
  - fli db:migrate --apply-only
  - fli db:migrate --dry
flags:
  create-only:
    type: boolean
    description: Create the migration file but do not apply it
    defaultValue: false
  apply-only:
    type: boolean
    description: Apply pending migrations without creating a new one
    defaultValue: false
  dry:
    type: boolean
    description: Show what would be done without executing
    defaultValue: false
---

```js
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)
const ls = litestone(context)

if (flag['apply-only']) {
  if (flag.dry) {
    log.dry('Would run: litestone migrate apply')
    return
  }
  log.info('Applying pending migrations...')
  context.exec({ command: `${ls} migrate apply --schema ${schema}` })
  log.success('Migrations applied')
  return
}

if (flag.dry) {
  log.dry('Would run: litestone migrate create')
  log.dry('Would run: litestone migrate apply')
  return
}

log.info('Creating migration from schema changes...')
context.exec({ command: `${ls} migrate create --schema ${schema}` })
log.success('Migration file created in db/migrations/')

if (!flag['create-only']) {
  log.info('Applying migration...')
  context.exec({ command: `${ls} migrate apply --schema ${schema}` })
  log.success('Migration applied')
  log.info('Regenerating JSON Schema...')
  context.exec({ command: `${ls} jsonschema --schema ${schema}` })
  log.success('JSON Schema updated')
}
```
