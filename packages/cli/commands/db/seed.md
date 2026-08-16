---
title: db:seed
description: Run the app's database seeder, however this app declares one
alias: db-seed
examples:
  - fli db:seed
  - fli db:seed --force
  - fli db:seed --dry
flags:
  force:
    type: boolean
    description: Re-seed from scratch — passes --force to the seeder
    defaultValue: false
  dry:
    type: boolean
    description: Show what would be done without executing
    defaultValue: false
---

There is no single seeder convention and there are three competing ones, so this
asks the app rather than adding a fourth: `litestone.config.js`'s `seeder:`
first, then the `db:seed` / `seed` script in `package.json`, then a probe of the
known locations.

It used to name `db/seeders/seed.ts` and nothing else — **a path nothing in the
FrontierJS repo produces.** Basecamp's seeder is `db/seed.js` behind a `db:seed`
script, litestone's own default is `seeders/DatabaseSeeder.js`, and the example
app has no seeder at all. So the one command whose whole job is finding the
seeder reported *Seeder not found* for an app that seeds perfectly well.

The app's own script is preferred over a path it resolves to, because a script
often does more than run one file — reset first, migrate, set an env var — and
that is the thing the app author actually meant by "seed".

```js
const seeder = resolveSeeder(context, { force: flag.force })

if (!seeder) {
  log.error('No seeder found for this app')
  log.info('Looked for, in order:')
  log.info('  · a `seeder:` path in db/litestone.config.js')
  log.info('  · a `db:seed` or `seed` script in package.json')
  log.info('  · db/seed.js · db/seed.ts · db/seeders/seed.ts · db/seeders/seed.js')
  log.info('    db/seeders/DatabaseSeeder.js')
  return
}

log.info(`Seeding from ${seeder.describe}`)
if (flag.dry) {
  log.dry(seeder.command)
  return
}

// context.exec throws on a non-zero exit, so reaching the next line means the
// seeder actually finished — the old version announced success unconditionally.
context.exec({ command: seeder.command })
log.success('Seed complete')
```
