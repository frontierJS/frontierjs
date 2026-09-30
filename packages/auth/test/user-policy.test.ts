// test/user-policy.test.ts
//
// The shipped `User` fragment, graded as a caller would reach it: the gate says
// any signed-in caller may update a user row, and what makes that safe is the
// row policy (whose row) and the field policies (which columns). Auth writes
// the row only through asSystem(), so nothing in this package exercises the
// caller's path; an app's first profile form is where a missing field policy
// would show, and it shows as a session holder changing the address a
// password reset is mailed to (`FJS-1591`).
//
// A field policy DROPS the value and lets the rest of the write land, so every
// assertion here reads the row back rather than trusting the answer.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness } from './harness.ts'

let h: Harness
let me: any, other: any

beforeAll(async () => {
  h     = await makeAuth()
  me    = await h.sys.user.create({ data: { email: 'me@example.com', name: 'Me' } })
  other = await h.sys.user.create({ data: { email: 'other@example.com', name: 'Other' } })
})
afterAll(() => h.cleanup())

const reread = (id: string) => h.sys.user.findUnique({ where: { id } })

describe('the User fragment, written by its own person', () => {
  test('their name lands', async () => {
    await h.db.$setAuth({ id: me.id, role: 'user' }).user.update({ where: { id: me.id }, data: { name: 'Renamed' } })
    expect((await reread(me.id)).name).toBe('Renamed')
  })

  test('their address, organization, verification and role do not', async () => {
    await h.db.$setAuth({ id: me.id, role: 'user' }).user.update({ where: { id: me.id }, data: {
      email: 'taken@example.com', accountId: 'acct-elsewhere', emailVerified: true, role: 'admin',
    } })
    const row = await reread(me.id)
    expect(row.email).toBe('me@example.com')
    expect(row.accountId).toBeNull()
    expect(row.emailVerified).toBe(false)
    expect(row.role).toBe('user')
  })

  test('nobody else\'s row moves at all', async () => {
    await h.db.$setAuth({ id: me.id, role: 'user' }).user.update({ where: { id: other.id }, data: { name: 'Rewritten' } })
    expect((await reread(other.id)).name).toBe('Other')
  })

  test('an administrator may set them, which is how a person is corrected', async () => {
    await h.db.$setAuth({ id: other.id, role: 'user', isAdmin: true }).user.update({ where: { id: me.id }, data: {
      email: 'fixed@example.com', emailVerified: true,
    } })
    const row = await reread(me.id)
    expect(row.email).toBe('fixed@example.com')
    expect(row.emailVerified).toBe(true)
  })
})
