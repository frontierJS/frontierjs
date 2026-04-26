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
import { existsSync, writeFileSync } from 'fs'
import { resolve }                    from 'path'

const makeScript = (schemaPath, encKey, email, revokeAll) => `
import { createClient } from '@frontierjs/litestone'

const db  = await createClient('${schemaPath}', { encryption: { key: '${encKey}' } })
const sys = db.asSystem()

${revokeAll ? `
const result = await sys.sessions.deleteMany({ where: {} })
console.log(JSON.stringify({ revoked: result?.count ?? 0, target: 'all' }))
` : `
const user = await sys.users.findFirst({ where: { email: '${email}' } })
if (!user) {
  console.error('ERROR: User not found: ${email}')
  process.exit(1)
}
const result = await sys.sessions.deleteMany({ where: { userId: user.id } })
console.log(JSON.stringify({ revoked: result?.count ?? 0, target: '${email}' }))
`}

await db.$close()
`
</script>

Revokes active sessions by deleting them from the database.
The user will be required to log in again on all devices.

```js
const schemaPath = resolve(context.paths.db, 'schema.lite')
const envPath    = resolve(context.paths.root, '.env')

// ─── Preflight ────────────────────────────────────────────────────────────────

if (!flag.all && !arg.email) {
  log.error('Provide an email address or use --all to revoke all sessions')
  log.info('Usage:')
  log.info('  fli auth:revoke-sessions alice@acme.com')
  log.info('  fli auth:revoke-sessions --all')
  return
}

if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  return
}

loadEnv({ path: envPath })
const encKey = process.env.ENCRYPTION_KEY

if (!encKey) {
  log.error('ENCRYPTION_KEY not set in .env')
  return
}

// ─── Dry run ──────────────────────────────────────────────────────────────────

if (flag.dry) {
  if (flag.all) {
    log.dry('Would revoke ALL sessions for ALL users')
  } else {
    log.dry(`Would revoke all sessions for: ${arg.email}`)
  }
  return
}

// ─── Confirm --all ────────────────────────────────────────────────────────────

if (flag.all) {
  echo('')
  log.warn('This will revoke ALL sessions for ALL users.')
  const confirmed = await question('Continue? (y/n) › ')
  if (confirmed.toLowerCase() !== 'y' && confirmed.toLowerCase() !== 'yes') {
    log.info('Aborted')
    return
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const { unlinkSync } = await import('fs')
const tmpPath = resolve(context.paths.root, `.fli-revoke-sessions-${Date.now()}.ts`)

try {
  writeFileSync(tmpPath, makeScript(
    schemaPath.replace(/\\/g, '/'),
    encKey,
    arg.email ?? '',
    flag.all
  ), 'utf8')

  const result = context.exec({ command: `bun run "${tmpPath}"`, capture: true })
  const output = (result?.stdout ?? result ?? '').toString().trim()
  const last   = output.split('\n').find(l => l.startsWith('{'))

  if (!last) {
    log.error('Failed — check output above')
    return
  }

  const { revoked, target } = JSON.parse(last)

  echo('')
  if (revoked === 0) {
    log.info(`No active sessions found for ${target}`)
  } else {
    log.success(`Revoked ${revoked} session${revoked !== 1 ? 's' : ''} for ${target}`)
  }
  echo('')

} catch (err) {
  if (err.message?.includes('User not found')) {
    log.error(`User not found: ${arg.email}`)
  } else {
    log.error(`Failed: ${err.message}`)
  }
} finally {
  if (existsSync(tmpPath)) unlinkSync(tmpPath)
}
```
