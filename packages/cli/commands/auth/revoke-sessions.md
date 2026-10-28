---
title: auth:revoke-sessions
description: Revoke all active sessions for a user — forces re-login on all devices
alias: revoke-sessions
examples:
  - fli auth:revoke-sessions alice@acme.com
  - fli auth:revoke-sessions alice@acme.com --dry
  - fli auth:revoke-sessions --all
args:
  -
    name: email
    description: Email address of the user whose sessions to revoke
flags:
  all:
    type: boolean
    description: Revoke ALL sessions for ALL users (use with caution)
    defaultValue: false
  dry:
    type: boolean
    description: Show what would be done without writing anything
    defaultValue: false
---

<script>
const SCRIPT = `
import { createClient } from '@frontierjs/litestone'

const input = JSON.parse(process.env.FLI_INPUT)

const db  = await createClient({ path: input.schemaPath, resolveFrom: 'schema', encryptionKey: process.env.ENCRYPTION_KEY })
const sys = db.asSystem()

let where = {}
if (!input.all) {
  const user = await sys.user.findFirst({ where: { email: input.email } })
  if (!user) {
    console.error('ERROR: User not found: ' + input.email)
    process.exit(1)
  }
  where = { userId: user.id }
}

const result = await sys.session.deleteMany({ where })
console.log(JSON.stringify({ revoked: result?.count ?? 0 }))
await db.$close()
`
</script>

Revokes active sessions by deleting them from the database.
The user will be required to log in again on all devices.

```js
if (!flag.all && !arg.email) {
  return refuse($, 'Name a user, or pass --all to revoke every session',
    'fli auth:revoke-sessions alice@acme.com',
    'fli auth:revoke-sessions --all')
}

const schemaPath = requireSchema($)
if (!schemaPath || !requireEncryptionKey($)) return

const target = flag.all ? 'every user' : arg.email
if (flag.dry) return log.dry(`Would revoke every session for ${target}`)

if (flag.all) {
  log.warn('This revokes every session for every user.')
  if (!await confirm($)) return log.info('Aborted')
}

const out = runAppScript($, 'revoke-sessions', SCRIPT, { schemaPath, email: arg.email, all: flag.all })
if (!out) return refuse($, `Revoking sessions for ${target} failed — the reason is above`)

if (out.revoked === 0) log.info(`No active sessions for ${target}`)
else log.success(`Revoked ${plural(out.revoked, 'session')} for ${target}`)
```
