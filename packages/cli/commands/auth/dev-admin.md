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
// The upsert and its production guard are @frontierjs/auth's (FJS-D2005), run
// from the app's own copy: that copy is the auth that verifies the hash.
const seedEntry = (root) => {
  try { return Bun.resolveSync('@frontierjs/auth/seed-login', root) } catch { return null }
}

// The input goes on stdin, never argv, where a password is readable through `ps`.
const runSeedLogin = ($, entry, input) => {
  try {
    const out = $.exec({
      command: `bun "${entry}"`,
      cwd:     $.paths.root,
      input:   JSON.stringify(input),
      stdio:   ['pipe', 'pipe', 'inherit'],
      dry:     false,
    })
    const line = String(out ?? '').trim().split('\n').findLast(l => l.startsWith('{'))
    return line ? JSON.parse(line) : null
  } catch (err) {
    if (err.interrupt) throw err
    return null
  }
}

// The app's own seeder knows its standing and its tenant link, which the
// generic upsert cannot: basecamp needs a WorkspaceMember row, chatwoot an
// org and every inbox, or the login signs in to an empty shell.
const appSeeder = (root) => {
  const pkgPath = path.resolve(root, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts ?? {}
    if (scripts['db:seed:admin']) return { command: 'bun run db:seed:admin', describe: '`db:seed:admin` in package.json' }
  }
  for (const rel of ['db/seed-dev-admin.ts', 'db/seed-dev-admin.js']) {
    if (fs.existsSync(path.resolve(root, rel))) return { command: `bun ${rel}`, describe: rel }
  }
  return null
}
</script>

Upserts one login and nothing else: run twice, it changes nothing; run after
a password or role changed, it puts them back. No running server needed.

When the app has its own `db:seed:admin` script (or `db/seed-dev-admin.*`),
that runs instead — it is the app's authority on what "top standing" means.
Otherwise the generic upsert -- the app's own `@frontierjs/auth/seed-login`,
the one Basecamp's seedOwner runs -- sets the password credential, `isEmailVerified`,
`isSystemAdmin` and `role` where the User model has them, and makes no tenant
or membership link.

In production — `NODE_ENV=production`, or a `DATABASE_URL` or database path
naming prod — it refuses the default login and takes an explicit `--email` and
`--password`, which skip the app's own seeder.

```js
const entry = seedEntry($.paths.root)
if (!entry) return refuse($, 'This app has no @frontierjs/auth seed-login entry', 'Install or update @frontierjs/auth: fli auth:install')
const { DEFAULT_LOGIN, productionRefusal } = await import(entry)

const refusal = productionRefusal(flag)
if (refusal) return refuse($, refusal, 'Pass both --email and --password to seed a production login')

const custom = flag.email !== DEFAULT_LOGIN.email || flag.password !== DEFAULT_LOGIN.password
const seeder = flag.generic ? null : appSeeder($.paths.root)

if (seeder && !custom) {
  echo(chalk`  {dim the app's own dev-admin seeder:} ${seeder.describe}`)
  if (flag.dry) return log.dry(seeder.command)
  $.exec({ command: seeder.command, cwd: $.paths.root })
  return echo(chalk`  {green ✓} ${DEFAULT_LOGIN.email} / ${DEFAULT_LOGIN.password}`)
}
if (seeder) echo(chalk`  {dim the app's ${seeder.describe} seeds only its own login — the generic upsert for} ${flag.email}`)

const schemaPath = requireSchema($)
if (!schemaPath || !requireEncryptionKey($)) return

if (flag.dry) return log.dry(`Would upsert ${flag.email} (name ${flag.name}, role ${flag.role}, isSystemAdmin where declared)`)

const out = runSeedLogin($, entry, {
  schemaPath,
  email:    flag.email,
  password: flag.password,
  name:     flag.name,
  role:     flag.role,
})
if (!out) return refuse($, `Upserting ${flag.email} failed — the reason is above`)

// Only the default password is printed: a chosen one is the caller's to keep.
echo(chalk`  {green ✓} ${out.email}${flag.password === DEFAULT_LOGIN.password ? ` / ${flag.password}` : ''}`)
echo(chalk`  {dim ${out.done.length ? out.done.join(', ') : 'password already current'} · set ${out.set.join(', ')}}`)
if (!out.set.includes('isSystemAdmin')) echo(chalk`  {dim no isSystemAdmin column — standing comes from role alone}`)
echo(chalk`  {dim no tenant or membership link made — add a db:seed:admin script if the app needs one}`)
```
