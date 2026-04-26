---
title: auth:create-user
description: Create a user directly in the database — no running server needed
alias: create-user
examples:
  - fli auth:create-user alice@acme.com
  - fli auth:create-user alice@acme.com --name "Alice Chen" --role admin
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
import { randomBytes }                            from 'crypto'

// Inline Bun script that creates the user via the Litestone client.
// Written to a temp file, executed, then removed.
// This avoids needing a running server — auth operates directly on the db.

const makeScript = (schemaPath, encKey, email, password, name, role) => `
import { createClient, GatePlugin, LEVELS } from '@frontierjs/litestone'

const db = await createClient('${schemaPath}', {
  encryption: { key: '${encKey}' },
  plugins: [new GatePlugin({ getLevel: () => LEVELS.SYSTEM })]
})

const sys = db.asSystem()

const existing = await sys.users.findFirst({ where: { email: '${email}' } })
if (existing) {
  console.error('ERROR: Email already registered: ${email}')
  process.exit(1)
}

const user = await sys.users.create({
  data: {
    email: '${email}',
    name:  ${name ? `'${name}'` : 'null'},
    role:  '${role}',
    emailVerified: true,
  }
})

const hash = await Bun.password.hash('${password}', { algorithm: 'bcrypt', cost: 12 })

await sys.credentials.create({
  data: {
    userId: user.id,
    type:   'password',
    value:  hash,
  }
})

console.log(JSON.stringify({ id: user.id, email: user.email, role: user.role }))
await db.$close()
`
</script>

Creates a user directly in the database using the Litestone client.
No running server required — safe to use during initial setup and in CI.

```js
const schemaPath = resolve(context.paths.db, 'schema.lite')
const envPath    = resolve(context.paths.root, '.env')

// ─── Preflight ────────────────────────────────────────────────────────────────

if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  log.info('Run fli auth:install first')
  return
}

loadEnv({ path: envPath })
const encKey = process.env.ENCRYPTION_KEY

if (!encKey) {
  log.error('ENCRYPTION_KEY not set in .env')
  log.info('Run fli auth:install to generate it')
  return
}

// ─── Password ────────────────────────────────────────────────────────────────

let password = flag.password

if (!password) {
  password = await question('Password: ')
  if (!password) {
    log.error('Password is required')
    return
  }
  const confirm = await question('Confirm password: ')
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
  return
}

// ─── Write + run temp script ──────────────────────────────────────────────────

const tmpPath = resolve(context.paths.root, `.fli-auth-create-${Date.now()}.ts`)

try {
  const script = makeScript(
    schemaPath.replace(/\\/g, '/'),
    encKey,
    arg.email,
    password,
    flag.name,
    flag.role
  )

  writeFileSync(tmpPath, script, 'utf8')

  const result = context.exec({
    command: `bun run "${tmpPath}"`,
    capture: true,
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
