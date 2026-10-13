---
title: auth:dev-admin
description: Create or reset the standing dev login — dev@knight.works / test1234, top standing
alias: dev-admin
examples:
  - fli auth:dev-admin
  - fli auth:dev-admin --generic
  - fli auth:dev-admin --role sysadmin
  - fli auth:dev-admin --email me@acme.com --password hunter2hunter2
flags:
  email:
    char: e
    type: string
    description: Login email
    defaultValue: dev@knight.works
  password:
    char: p
    type: string
    description: Login password
    defaultValue: test1234
  name:
    char: n
    type: string
    description: Display name
    defaultValue: Dev Admin
  role:
    char: r
    type: string
    description: "Value written to User.role when the model has one (generic path only)"
    defaultValue: admin
  generic:
    char: g
    type: boolean
    description: Skip the app's own db:seed:admin and run the generic upsert
    defaultValue: false
  dry:
    type: boolean
    description: Show what would be done without writing anything
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { resolve }                                            from 'path'

const DEFAULT_EMAIL    = 'dev@knight.works'
const DEFAULT_PASSWORD = 'test1234'

// The input arrives as JSON in FLI_DEV_ADMIN — interpolating it into the
// source let a quote in a password end the string literal.
const SCRIPT = `
import { createClient } from '@frontierjs/litestone'

const input = JSON.parse(process.env.FLI_DEV_ADMIN)

const db = await createClient({
  path:          input.schemaPath,
  resolveFrom:   'schema',
  encryptionKey: process.env.ENCRYPTION_KEY,
})

const prod = Object.values(db.$databases ?? {}).find(d => /prod/i.test(d.path ?? ''))
if (prod) {
  console.error('REFUSED: ' + prod.path + ' looks like a production database')
  db.$close()
  process.exit(1)
}

const model = db.$schema.models.find(m => m.name === 'User')
if (!model) {
  console.error('REFUSED: no model User in this schema')
  db.$close()
  process.exit(1)
}
const has = (name, type) => model.fields.some(f => f.name === name && (!type || f.type?.name === type))

const sys  = db.asSystem()
const done = []

let user = await sys.user.findFirst({ where: { email: input.email } })
if (!user) {
  user = await sys.user.create({ data: { email: input.email } })
  done.push('created')
}

const cred = await sys.credential.findFirst({ where: { userId: user.id, type: 'password' } })
if (!cred || !(await Bun.password.verify(input.password, cred.value))) {
  const value = await Bun.password.hash(input.password, { algorithm: 'bcrypt', cost: 12 })
  if (cred) await sys.credential.update({ where: { id: cred.id }, data: { value } })
  else await sys.credential.create({ data: { userId: user.id, type: 'password', value } })
  done.push('password set')
}

const data = {}
if (has('name'))                       data.name = input.name
if (has('displayName'))                data.displayName = input.name
if (has('emailVerified', 'Boolean'))   data.emailVerified = true
if (has('isSystemAdmin', 'Boolean'))   data.isSystemAdmin = true
if (has('role', 'String'))             data.role = input.role
await sys.user.update({ where: { id: user.id }, data })

console.log(JSON.stringify({ id: user.id, email: input.email, done, set: Object.keys(data) }))
db.$close()
`

// The app's own seeder knows its standing and its tenant link, which the
// generic upsert cannot: basecamp needs a WorkspaceMember row, chatwoot an
// org and every inbox, or the login signs in to an empty shell.
const appSeeder = (root) => {
  const pkgPath = resolve(root, 'package.json')
  if (existsSync(pkgPath)) {
    const scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {}
    if (scripts['db:seed:admin']) return { command: 'bun run db:seed:admin', describe: '`db:seed:admin` in package.json' }
  }
  for (const rel of ['db/seed-dev-admin.ts', 'db/seed-dev-admin.js']) {
    if (existsSync(resolve(root, rel))) return { command: `bun ${rel}`, describe: rel }
  }
  return null
}
</script>

Upserts one login and nothing else: run twice, it changes nothing; run after
a password or role changed, it puts them back. No running server needed.

When the app has its own `db:seed:admin` script (or `db/seed-dev-admin.*`),
that runs instead — it is the app's authority on what "top standing" means.
Otherwise the generic upsert sets the password credential, `emailVerified`,
`isSystemAdmin` and `role` where the User model has them, and makes no tenant
or membership link.

```js
if (process.env.NODE_ENV === 'production' || /prod/i.test(process.env.DATABASE_URL ?? '')) {
  log.error('Refused: this environment points at production')
  return
}

const custom = flag.email !== DEFAULT_EMAIL || flag.password !== DEFAULT_PASSWORD
const seeder = flag.generic ? null : appSeeder($.paths.root)

if (seeder && !custom) {
  log.info(`Running the app's own dev-admin seeder: ${seeder.describe}`)
  if (flag.dry) return log.dry(seeder.command)
  $.exec({ command: seeder.command, cwd: $.paths.root })
  return log.success(`${DEFAULT_EMAIL} / ${DEFAULT_PASSWORD}`)
}
if (seeder) log.info(`The app's ${seeder.describe} seeds only its own login — using the generic upsert for ${flag.email}`)

const schemaPath = resolve($.paths.db, 'schema.lite')
if (!existsSync(schemaPath)) {
  log.error(`schema.lite not found at ${schemaPath}`)
  return
}
if (!process.env.ENCRYPTION_KEY) {
  log.error('ENCRYPTION_KEY not set in .env')
  return
}

if (flag.dry) {
  log.dry(`Would upsert ${flag.email} (name ${flag.name}, role ${flag.role}, isSystemAdmin where declared)`)
  return
}

const tmpPath = resolve($.paths.root, `.fli-dev-admin-${Date.now()}.ts`)

try {
  writeFileSync(tmpPath, SCRIPT, 'utf8')
  const result = $.exec({
    command: `bun run "${tmpPath}"`,
    cwd:     $.paths.root,
    stdio:   ['ignore', 'pipe', 'inherit'],
    env:     {
      ...process.env,
      FLI_DEV_ADMIN: JSON.stringify({ schemaPath, email: flag.email, password: flag.password, name: flag.name, role: flag.role }),
    },
  })
  const line = (result ?? '').toString().trim().split('\n').find(l => l.startsWith('{'))
  if (!line) {
    log.error('Upsert failed — check output above')
    return
  }
  const out = JSON.parse(line)
  log.success(`${out.email} / ${flag.password}`)
  echo(`  ${out.done.length ? out.done.join(', ') : 'password already current'} · set ${out.set.join(', ')}`)
  if (!out.set.includes('isSystemAdmin')) log.info('User has no isSystemAdmin column — standing comes from role alone')
  log.info('No tenant or membership link made — add a db:seed:admin script if the app needs one')
} catch (err) {
  log.error(`Failed: ${err.message}`)
} finally {
  if (existsSync(tmpPath)) unlinkSync(tmpPath)
}
```
