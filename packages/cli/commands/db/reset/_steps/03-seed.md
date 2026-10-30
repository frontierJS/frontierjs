---
title: 03-seed
description: Run the app's seeder over the rebuilt database, when --seed asks for it
skip: "!flag.seed"
---

```js
// A missing seeder is not a failure here: the reset already succeeded, and an
// app with no seeder (the example app) is still a valid target for --seed.
const seeder = resolveSeeder($)

if (!seeder) {
  log.info('Skipping seed — no seeder found (see `fli db:seed` for where it looks)')
  return
}

log.info(`Seeding from ${seeder.describe}`)
$.exec({ command: seeder.command, dry: flag.dry })
log.success('Seed complete')
```
