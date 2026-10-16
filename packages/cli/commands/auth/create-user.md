---
title: auth:create-user
description: Create a user directly in the database — no running server needed
alias: create-user
examples:
  - fli auth:create-user alice@acme.com
  - fli auth:create-user alice@acme.com --name "Alice Chen" --role admin
  - fli auth:create-user alice@acme.com --tenant acme --role admin
  - fli auth:create-user alice@acme.com --password secret --dry
args:
  -
    name: email
    description: User's email address
    required: true
flags:
  name:
    char: n
    type: string
    description: Display name
    defaultValue: ''
  role:
    char: r
    type: string
    description: "User role: user, admin"
    defaultValue: user
  tenant:
    type: string
    description: Tenant to put the user in — written to the User column the app's row tenancy names
    defaultValue: ''
  password:
    char: p
    type: string
    description: Password (prompted interactively if not provided)
    defaultValue: ''
  dry:
    type: boolean
    description: Show what would be done without writing anything
    defaultValue: false
---

<script>
import { existsSync, writeFileSync, unlinkSync } from 'fs'
import { resolve }                                from 'path'

// Inline Bun script that creates the user through the app's own
// @frontierjs/auth, so the password policy, the hash and which column a tenant
// is written to are auth's answers rather than a copy of them (FJS-D1117).
// Written to a temp file, executed, then removed — no running server needed.
// The input arrives as JSON in FLI_CREATE_USER — interpolating it into the
// source let a quote in a password or name end the string literal.

const SCRIPT = `
import { createClient, GatePlugin, LEVELS } from '@frontierjs/litestone'
import { createLitestoneAuth }               from '@frontierjs/auth'

const input = JSON.parse(process.env.FLI_CREATE_USER)

const db = await createClient({
  path:          input.schemaPath,
  resolveFrom:   'schema',
  encryptionKey: process.env.ENCRYPTION_KEY,
  plugins:       [new GatePlugin({ getLevel: () => LEVELS.SYSTEM })]
})

const auth = createLitestoneAuth(db, { encryptionKey: process.env.ENCRYPTION_KEY })

let made
try {
  made = await auth.createUser({
    email:    input.email,
    password: input.password,
    role:     input.role,
    ...(input.name   ? { name:   input.name }   : {}),
    ...(input.tenant ? { tenant: input.tenant } : {}),
  })
} catch (err) {
  console.error('ERROR: ' + err?.message + (err?.status === 409 ? ': ' + input.email : ''))
  process.exit(1)
}

// An operator made this person, so there is no address to prove.
await db.asSystem().user.update({ where: { id: made.userId }, data: { emailVerified: true } })

console.log(JSON.stringify({ id: made.userId, email: made.email, role: made.role }))
await db.$close()
`
</script>

Creates a user directly in the database using the Litestone client.
No running server required — safe to use during initial setup and in CI.

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
  log.info('Run fli auth:install to generate it')
  return
}

// ─── Password ────────────────────────────────────────────────────────────────

let password = flag.password

if (!password) {
  password = await tty.secret('Password:')
  if (!password) {
    log.error('Password is required')
    return
  }
  const confirm = await tty.secret('Confirm password:')
  if (password !== confirm) {
    log.error('Passwords do not match')
    return
  }
}

// ─── Dry run ──────────────────────────────────────────────────────────────────

if (flag.dry) {
  log.dry(`Would create user: ${arg.email}`)
  log.dry(`  name: ${flag.name || '(none)'}`)
  log.dry(`  role: ${flag.role}`)
  if (flag.tenant) log.dry(`  tenant: ${flag.tenant}`)
  return
}

// ─── Write + run temp script ──────────────────────────────────────────────────

const tmpPath = resolve($.paths.root, `.fli-auth-create-${Date.now()}.ts`)

try {
  writeFileSync(tmpPath, SCRIPT, 'utf8')

  const result = $.exec({
    command: `bun run "${tmpPath}"`,
    cwd:     $.paths.root,
    stdio:   ['ignore', 'pipe', 'inherit'],
    env:     {
      ...process.env,
      FLI_CREATE_USER: JSON.stringify({
        schemaPath,
        email:     arg.email,
        password,
        name:      flag.name,
        role:      flag.role,
        tenant:    flag.tenant,
      }),
    },
  })

  const output = (result?.stdout ?? result ?? '').toString().trim()
  const last   = output.split('\n').find(l => l.startsWith('{'))

  if (!last) {
    log.error('User creation failed — check output above')
    return
  }

  const user = JSON.parse(last)

  echo('')
  log.success(`Created user`)
  echo(`  id:    ${user.id}`)
  echo(`  email: ${user.email}`)
  echo(`  role:  ${user.role}`)
  echo('')

} catch (err) {
  if (err.message?.includes('Email already registered')) {
    log.error(`Email already registered: ${arg.email}`)
  } else {
    log.error(`Failed: ${err.message}`)
  }
} finally {
  if (existsSync(tmpPath)) unlinkSync(tmpPath)
}
```
