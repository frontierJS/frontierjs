---
title: auth:list-users
description: List users in the database
alias: list-users
examples:
  - fli auth:list-users
  - fli auth:list-users --role admin
  - fli auth:list-users --json
  - fli auth:list-users --limit 50
flags:
  role:
    char: r
    type: string
    description: Filter by role
    defaultValue: ''
  limit:
    char: l
    type: number
    description: Maximum number of users to show
    defaultValue: 20
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
  sessions:
    char: s
    type: boolean
    description: Show active session count per user
    defaultValue: false
---

<script>
import { existsSync, writeFileSync } from 'fs'
import { resolve }                    from 'path'

// The input arrives as JSON in FLI_LIST_USERS — interpolating it into the
// source let a quote in --role end the string literal.
const SCRIPT = `
import { createClient } from '@frontierjs/litestone'

const input = JSON.parse(process.env.FLI_LIST_USERS)

const db  = await createClient({ path: input.schemaPath, resolveFrom: 'schema', encryptionKey: process.env.ENCRYPTION_KEY })
const sys = db.asSystem()

const users = await sys.user.findMany({
  where:   input.role ? { role: input.role } : {},
  orderBy: { createdAt: 'desc' },
  limit:   input.limit,
})

const result = []

for (const u of users) {
  const entry = {
    id:            u.id,
    email:         u.email,
    name:          u.name ?? '',
    role:          u.role,
    emailVerified: u.emailVerified,
    createdAt:     u.createdAt,
  }

  if (input.sessions) {
    entry.activeSessions = await sys.session.count({
      where: { userId: u.id, expiresAt: { gt: new Date() } }
    })
  }

  result.push(entry)
}

console.log(JSON.stringify(result))
await db.$close()
`
</script>

Lists users directly from the database. No running server required.

```js
const schemaPath = resolve($.paths.db, 'schema.lite')

// ─── Preflight ────────────────────────────────────────────────────────────────

if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  log.info('Run fli auth:install first')
  return
}

// `.env` is already loaded — bootstrap.js reads the project's before any
// command runs, and overrides the global one with it.
const encKey = process.env.ENCRYPTION_KEY

if (!encKey) {
  log.error('ENCRYPTION_KEY not set in .env')
  return
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const { unlinkSync } = await import('fs')
const tmpPath = resolve($.paths.root, `.fli-list-users-${Date.now()}.ts`)

try {
  writeFileSync(tmpPath, SCRIPT, 'utf8')

  const result = $.exec({
    command: `bun run "${tmpPath}"`,
    cwd:     $.paths.root,
    stdio:   ['ignore', 'pipe', 'inherit'],
    env:     {
      ...process.env,
      FLI_LIST_USERS: JSON.stringify({
        schemaPath,
        role:     flag.role,
        limit:    Number(flag.limit),
        sessions: flag.sessions,
      }),
    },
  })
  const output = (result?.stdout ?? result ?? '').toString().trim()
  const last   = output.split('\n').find(l => l.startsWith('['))

  if (!last) {
    log.error('Failed — check output above')
    return
  }

  const users = JSON.parse(last)

  if (users.length === 0) {
    log.info(flag.role ? `No users with role '${flag.role}'` : 'No users found')
    log.info('Run fli auth:create-user to add one')
    return
  }

  // ─── JSON output ──────────────────────────────────────────────────────────

  if (flag.json) {
    echo(JSON.stringify(users, null, 2))
    return
  }

  // ─── Table output ─────────────────────────────────────────────────────────

  const roleFilter = flag.role ? ` (role: ${flag.role})` : ''
  echo('')
  echo(`  Users${roleFilter}  ·  showing ${users.length}${users.length === flag.limit ? ` (limit ${flag.limit})` : ''}`)
  echo('')

  const colEmail    = Math.min(36, Math.max(20, ...users.map(u => u.email.length)) + 2)
  const colName     = Math.min(24, Math.max(8,  ...users.map(u => (u.name ?? '').length)) + 2)

  // Header
  const header = [
    'email'.padEnd(colEmail),
    'name'.padEnd(colName),
    'role'.padEnd(12),
    'verified'.padEnd(10),
    flag.sessions ? 'sessions' : '',
  ].filter(Boolean).join('')

  echo(`  ${header}`)
  echo(`  ${'─'.repeat(header.length)}`)

  for (const u of users) {
    const verified = u.emailVerified ? '✓' : '✗'
    const row = [
      u.email.padEnd(colEmail),
      (u.name ?? '').padEnd(colName),
      u.role.padEnd(12),
      verified.padEnd(10),
      flag.sessions ? String(u.activeSessions ?? 0) : '',
    ].filter(Boolean).join('')
    echo(`  ${row}`)
  }

  echo('')

} catch (err) {
  log.error(`Failed: ${err.message}`)
} finally {
  if (existsSync(tmpPath)) unlinkSync(tmpPath)
}
```
