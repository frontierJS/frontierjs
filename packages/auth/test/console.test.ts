// test/console.test.ts
//
// `resetPasswords`, the command an app's `db/tinker.js` borrows. Graded by
// SIGNING IN, never by reading the column: a hash auth cannot verify is still a
// changed column, and that is the failure a copy of the hashing would produce.
// The refusal is paired with the same call forced, so a command that did
// nothing at all could not pass it.

import { describe, test, expect, beforeAll, afterEach } from 'bun:test'
import { makeAuth, rejectsWith, signedIn, type Harness } from './harness.ts'
import { InvalidCredentialsError } from '../index.ts'
import { resetPasswords } from '../console.ts'

let h: Harness
const said: string[] = []
const run = (args: string[] = []) =>
  resetPasswords.run({ db: h.db, sys: h.sys, args, out: l => said.push(l), tenant: null })

beforeAll(async () => {
  h = await makeAuth()
  await h.auth.createUser({ email: 'a@console.test', password: 'original-pass-1', name: 'a' })
  const b = await h.auth.createUser({ email: 'b@console.test', password: 'original-pass-2', name: 'b' })
  await h.sys.credential.create({ data: { userId: b.userId, type: 'oauth:github', value: 'github-subject-42' } })
})

afterEach(() => { delete process.env.NODE_ENV })

describe('resetPasswords', () => {
  test('every account signs in with the new password, and not with its old one', async () => {
    await run(['fresh-pass-9'])

    for (const email of ['a@console.test', 'b@console.test'])
      expect(signedIn(await h.auth.login(email, 'fresh-pass-9')).token).toBeTruthy()
    await rejectsWith(() => h.auth.login('a@console.test', 'original-pass-1'), InvalidCredentialsError)
    expect(said.at(-1)).toContain('2 password credentials set to fresh-pass-9')
  })

  test('a credential that is not a password keeps its value', async () => {
    const github = await h.sys.credential.findFirst({ where: { type: 'oauth:github' } })
    expect(github.value).toBe('github-subject-42')
  })

  test('no argument is the default password', async () => {
    await run()
    expect(signedIn(await h.auth.login('a@console.test', 'test1234')).token).toBeTruthy()
  })

  test('refused under production, and --force is the same call going through', async () => {
    process.env.NODE_ENV = 'production'

    await expect(run(['prod-pass-1'])).rejects.toThrow('NODE_ENV is production')
    await rejectsWith(() => h.auth.login('a@console.test', 'prod-pass-1'), InvalidCredentialsError)

    await run(['prod-pass-1', '--force'])
    expect(signedIn(await h.auth.login('a@console.test', 'prod-pass-1')).token).toBeTruthy()
  })
})
