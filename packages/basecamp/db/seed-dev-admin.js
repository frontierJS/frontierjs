// db/seed-dev-admin.js — the standing dev login (`bun run db:seed:admin`).
//
// dev@knight.works / test1234, `isSystemAdmin` and OWNER of every workspace in
// the first account. A level here is per workspace and read off the
// WorkspaceMember row, so a user with no membership signs in to an empty shell.
// Touches only this one user and its memberships — the dev db holds fleet data
// no seed recreates, so `db:seed --force` is not the way to get a login back.
// Run twice, it changes nothing.

import { createLitestoneAuth } from '@frontierjs/auth'

import { createBasecampDb } from '../api/src/core/db.ts'
import { env }              from '../api/src/core/env.ts'
import { grantsFor }        from '../api/src/core/capabilities.ts'

const EMAIL    = 'dev@knight.works'
const PASSWORD = 'test1234'
const NAME     = 'Dev Admin'

const db   = await createBasecampDb()
const sys  = db.asSystem()
const auth = createLitestoneAuth(db, { encryptionKey: env.ENCRYPTION_KEY })

const account = await sys.account.findFirst({ orderBy: { createdAt: 'asc' } })
if (!account) {
  console.error('no account yet — run `bun run db:seed` or finish /setup first')
  process.exit(1)
}

let user = await sys.user.findFirst({ where: { email: EMAIL } })
if (!user) {
  const { userId } = await auth.createUser({ email: EMAIL, name: NAME, password: PASSWORD })
  user = await sys.user.findFirst({ where: { id: userId } })
  console.log(`created ${EMAIL}`)
} else {
  const cred = await sys.credential.findFirst({ where: { userId: user.id, type: 'password' } })
  if (!cred || !(await Bun.password.verify(PASSWORD, cred.value))) {
    const value = await Bun.password.hash(PASSWORD, { algorithm: 'bcrypt', cost: 12 })
    if (cred) await sys.credential.update({ where: { id: cred.id }, data: { value } })
    else await sys.credential.create({ data: { userId: user.id, type: 'password', value } })
    console.log(`reset password for ${EMAIL}`)
  }
}

await sys.user.update({
  where: { id: user.id },
  data: {
    accountId: account.id, status: 'active', kind: 'user', name: NAME,
    displayName: NAME, emailVerified: true, isSystemAdmin: true,
  },
})

const workspaces = await sys.workspace.findMany({ where: { accountId: account.id } })
for (const ws of workspaces) {
  const member = await sys.workspaceMember.findFirst({ where: { workspaceId: ws.id, userId: user.id } })
  const data = { role: 'owner', capabilities: grantsFor('owner'), acceptedAt: member?.acceptedAt ?? new Date().toISOString() }
  if (member) await sys.workspaceMember.update({ where: { id: member.id }, data })
  else {
    await sys.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, ...data } })
    console.log(`joined ${ws.slug} as owner`)
  }
}

console.log(`${EMAIL} / ${PASSWORD} — system admin, owner of ${workspaces.length} workspace(s) in ${account.slug}`)
db.$close()
