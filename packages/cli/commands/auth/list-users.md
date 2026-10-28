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
const SCRIPT = `
import { createClient } from '@frontierjs/litestone'

const input = JSON.parse(process.env.FLI_INPUT)

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

// Each column as wide as its longest value, capped. Padded before it is
// colored, since an escape code counts toward padEnd's width.
const userTable = (users, { sessions, chalk }) => {
  const email = Math.min(36, Math.max(20, ...users.map(u => u.email.length)) + 2)
  const name  = Math.min(24, Math.max(8,  ...users.map(u => u.name.length)) + 2)
  const row   = (cells) => cells.filter(c => c != null).join('')
  const head  = row(['email'.padEnd(email), 'name'.padEnd(name), 'role'.padEnd(12), 'verified'.padEnd(10), sessions ? 'sessions' : null])
  return [
    chalk.dim(head),
    chalk.dim('─'.repeat(head.length)),
    ...users.map(u => row([
      u.email.padEnd(email),
      u.name.padEnd(name),
      u.role.padEnd(12),
      u.emailVerified ? chalk.green('✓'.padEnd(10)) : chalk.dim('✗'.padEnd(10)),
      sessions ? String(u.activeSessions ?? 0) : null,
    ])),
  ]
}
</script>

Lists users directly from the database. No running server required.

```js
const schemaPath = requireSchema($)
if (!schemaPath || !requireEncryptionKey($)) return

const users = runAppScript($, 'list-users', SCRIPT, {
  schemaPath,
  role:     flag.role,
  limit:    Number(flag.limit),
  sessions: flag.sessions,
})
if (!users) return refuse($, 'Listing users failed — the reason is above')

if (flag.json) return echo(JSON.stringify(users, null, 2))

if (users.length === 0) {
  log.info(flag.role ? `No users with role '${flag.role}'` : 'No users found')
  return log.info('Run fli auth:create-user to add one')
}

const scope = [flag.role && `role ${flag.role}`, users.length === Number(flag.limit) && `limit ${flag.limit}`]
  .filter(Boolean).join(', ')

echo(chalk`\n  {bold Users} {dim · ${plural(users.length, 'user')} shown${scope ? ` (${scope})` : ''}}\n`)
echo.lines(userTable(users, { sessions: flag.sessions, chalk }), { indent: 2 })
echo('')
```
