---
title: make:enc
description: Give the app an ENCRYPTION_KEY — in .env, or .env.production with --production
alias: mkenc
examples:
  - fli make:enc
  - fli make:enc --production
  - fli make:enc --production --dry
flags:
  production:
    char: P
    type: boolean
    description: Write .env.production instead of .env
    defaultValue: false
---

<script>
import { existsSync, readFileSync, copyFileSync } from 'fs'
import { resolve } from 'path'

const { envValue, KEY } =
  await import(resolve(global.fliRoot, 'core/env-preflight.js'))
</script>

Write a new `ENCRYPTION_KEY` into the app's `.env`, or `.env.production` with
`--production` — the file `deploy:setup` seeds onto the server.

**A key that is already set is refused, never replaced.** Every `@encrypted`,
`@secret` and `@guarded` value in the database was sealed with it, and a new key
leaves them unreadable; changing it is `fli auth:rotate-key`, which re-seals
them. `fli keygen --env` overwrites, so this is the form to reach for.

With no target file and a `.env.example` beside it, the example is copied first,
so the rest of its blanks are there to fill. The key itself is written by
`fli keygen`, the generator `fli dev` and `auth:install` use.

```js
const root   = $.paths.root
const file   = flag.production ? '.env.production' : '.env'
const target = resolve(root, file)

// The file, not process.env: fli loaded .env at startup, which says nothing
// about .env.production and would refuse --production for the wrong file.
if (existsSync(target) && envValue(readFileSync(target, 'utf8'), KEY)) {
  log.error(`${KEY} is already set in ${file} — replacing it leaves every encrypted value unreadable`)
  log.info('  to change it: fli auth:rotate-key')
  process.exit(1)
}

const example = resolve(root, '.env.example')
if (!existsSync(target) && existsSync(example)) {
  if (flag.dry) log.dry(`Would copy .env.example to ${file}`)
  else {
    copyFileSync(example, target)
    log.success(`Created ${file} from .env.example`)
  }
}

$.exec({ command: `cd ${root} && ${$.fli} keygen aes --format hex --name ${KEY} --env ${file}` })

if (flag.production && !flag.dry) {
  log.info(`fill the rest of ${file}; deploy:setup copies it to the server once`)
}
```
