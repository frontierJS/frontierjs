---
title: db:seed
description: Run the database seeder — db/seeders/seed.ts
alias: db-seed
examples:
  - fli db:seed
  - fli db:seed --dry
flags:
  dry:
    type: boolean
    description: Show what would be done without executing
    defaultValue: false
---

```js
const seedPath = `${context.paths.db}/seeders/seed.ts`
const { existsSync } = await import('fs')

if (!existsSync(seedPath)) {
  log.error(`Seeder not found at ${seedPath}`)
  log.info('Create db/seeders/seed.ts to define your seed data')
  return
}

if (flag.dry) {
  log.dry(`Would run: bun run ${seedPath}`)
  return
}

log.info('Running seeder...')
context.exec({ command: `cd ${context.paths.root} && bun run ${seedPath}` })
log.success('Seed complete')
```
