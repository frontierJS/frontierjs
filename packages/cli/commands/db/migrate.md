---
title: db:migrate
description: Create a migration file from schema changes and apply it
alias: db-migrate
examples:
  - fli db:migrate
  - fli db:migrate --create-only
  - fli db:migrate --apply-only
  - fli db:migrate --dry
  - fli db:migrate --rename Issue.description=brief
  - fli db:migrate --operations ops.json
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
  rename:
    type: string
    multiple: true
    description: Keep a renamed column's values - Model.oldColumn=newField, repeatable
  operations:
    type: string
    description: A JSON document of row-keeping operations for the migration to carry
---

```js
if (!requireSchema($)) return

const { schema } = resolveDb($, flag)
const ls = litestone($)

// A rename is a drop plus an add to a diff, so the person says it was one. The
// flags go to migrate create, which writes RENAME COLUMN into the file.
const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`
const operationFlags = [
  ...[flag.rename ?? []].flat().filter(Boolean).map(r => `--rename ${sq(r)}`),
  ...(flag.operations ? [`--operations ${sq(flag.operations)}`] : []),
].join(' ')
const withOps = operationFlags ? ` ${operationFlags}` : ''

if (flag['apply-only']) {
  if (flag.dry) {
    log.dry('Would run: litestone migrate apply')
    return
  }
  log.info('Applying pending migrations...')
  $.exec({ command: `${ls} migrate apply --schema ${schema}` })
  log.success('Migrations applied')
  return
}

if (flag['create-only']) {
  if (flag.dry) {
    log.dry('Would run: litestone migrate create')
    return
  }
  log.info('Creating migration from schema changes...')
  $.exec({ command: `${ls} migrate create --schema ${schema}${withOps}` })
  log.success('Migration file created in db/migrations/')
  return
}

if (flag.dry) {
  log.dry('Would run: litestone migrate dev  (drift check, create, apply)')
  return
}

// `migrate dev` rather than create + apply as two commands. It adds the one
// check neither has: a database ahead of its own migration history — which is
// what `db push` leaves behind — cannot apply the migration that create is
// about to write, and `duplicate column name` from the middle of a generated
// file is not an answer anybody can act on (FJS-D123).
log.info('Creating and applying the migration...')
$.exec({ command: `${ls} migrate dev --schema ${schema}${withOps}` })
log.success('Migration created and applied')

log.info('Regenerating JSON Schema...')
$.exec({ command: `${ls} jsonschema --schema ${schema}` })
log.success('JSON Schema updated')
```
