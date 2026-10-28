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
// Creates the user through the app's own @frontierjs/auth, so the password
// policy, the hash and which column a tenant is written to are auth's answers
// rather than a copy of them (FJS-D1117).
const SCRIPT = `
import { createClient, GatePlugin, LEVELS } from '@frontierjs/litestone'
import { createLitestoneAuth }               from '@frontierjs/auth'

const input = JSON.parse(process.env.FLI_INPUT)

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
await db.asSystem().user.update({ where: { id: made.id }, data: { emailVerified: true } })

console.log(JSON.stringify({ id: made.id, email: made.email, role: made.role }))
await db.$close()
`

const askPassword = async ($) => {
  const password = await $.tty.secret('Password:')
  if (!password) return refuse($, 'Password is required')
  if (password !== await $.tty.secret('Confirm password:')) return refuse($, 'Passwords do not match')
  return password
}
</script>

Creates a user directly in the database using the Litestone client.
No running server required — safe to use during initial setup and in CI.

```js
const schemaPath = requireSchema($)
if (!schemaPath || !requireEncryptionKey($)) return

const password = flag.password || await askPassword($)
if (!password) return

const who = [arg.email, `role ${flag.role}`, flag.name && `name ${flag.name}`, flag.tenant && `tenant ${flag.tenant}`]
  .filter(Boolean).join(' · ')
if (flag.dry) return log.dry(`Would create ${who}`)

const user = runAppScript($, 'create-user', SCRIPT, {
  schemaPath,
  email:  arg.email,
  password,
  name:   flag.name,
  role:   flag.role,
  tenant: flag.tenant,
})
if (!user) return refuse($, `Creating ${arg.email} failed — the reason is above`)

log.success('Created user')
echo`  id     ${user.id}
  email  ${user.email}
  role   ${user.role}
`
```
