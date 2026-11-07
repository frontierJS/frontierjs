// test/console.test.ts
//
// `resetPasswords`, the command an app's `db/repl.js` borrows. Graded by
// SIGNING IN, never by reading the column: a hash auth cannot verify is still a
// changed column, and that is the failure a copy of the hashing would produce.
// The refusal is paired with the same call forced, so a command that did
// nothing at all could not pass it.

import { describe, test, expect, beforeAll, afterEach } from 'bun:test'
import { makeAuth, rejectsWith, signedIn, type Harness } from './harness.ts'
import { InvalidCredentialsError } from '../index.ts'
import { resetPasswords } from '../console.ts'
import { seedLogin, productionRefusal, DEFAULT_LOGIN } from '../seed-login.ts'
import { authSchemaFragments } from '../schema.ts'
import { auditDatabase } from './audit-trail-model.ts'
import { TEST_KEY } from './harness.ts'
import { writeFileSync } from 'fs'
import { dirname, join } from 'path'

let h: Harness
const said: string[] = []
const run = (args: string[] = []) =>
  resetPasswords.run({ db: h.db, sys: h.sys, args, out: l => said.push(l), tenant: null })

beforeAll(async () => {
  h = await makeAuth()
  await h.auth.createUser({ email: 'a@console.test', password: 'original-pass-1', name: 'a' })
  const b = await h.auth.createUser({ email: 'b@console.test', password: 'original-pass-2', name: 'b' })
  await h.sys.credential.create({ data: { userId: b.id, type: 'oauth:github', value: 'github-subject-42' } })
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

// ─── seed-login ──────────────────────────────────────────────────────────
// The one login upsert (`FJS-D2005`): `fli auth:dev-admin` and Basecamp's
// seedOwner both run the FILE, with JSON on stdin, from the App's own
// node_modules. Graded by signing in through this auth, so a hash a copy wrote
// that auth cannot verify fails here.

const ENTRY = join(import.meta.dir, '..', 'seed-login.ts')
const OWNER_PASSWORD = `it's $(rm -rf /) "quoted" \\ long`

async function runEntry(input: object, env: Record<string, string> = {}) {
  const dir = dirname(process.env.MAIN_DB_PATH!)
  const schemaPath = join(dir, 'seed-login.lite')
  writeFileSync(schemaPath, `database main { path "${process.env.MAIN_DB_PATH}" }\n${auditDatabase(dir)}\n${authSchemaFragments('main')}`)
  const proc = Bun.spawn(['bun', ENTRY], {
    cwd: dir, stdin: new TextEncoder().encode(JSON.stringify({ schemaPath, ...input })),
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, ENCRYPTION_KEY: TEST_KEY, NODE_ENV: 'development', ...env },
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}

describe('seed-login', () => {
  test('the entry upserts a login this auth signs in with, and a second run changes nothing', async () => {
    const first = await runEntry({ email: 'owner@seed.test', password: OWNER_PASSWORD, name: 'Owner', role: 'admin' }, { NODE_ENV: 'production' })
    expect(first.code).toBe(0)
    expect(JSON.parse(first.out.trim().split('\n').at(-1)!).done).toEqual(['created', 'password set'])
    expect(first.out + first.err).not.toContain(OWNER_PASSWORD)
    expect(signedIn(await h.auth.login('owner@seed.test', OWNER_PASSWORD)).token).toBeTruthy()

    const again = await runEntry({ email: 'owner@seed.test', password: OWNER_PASSWORD })
    expect(JSON.parse(again.out.trim().split('\n').at(-1)!).done).toEqual([])
  })

  test('production refuses the default login, and either default half, before a client opens', async () => {
    for (const login of [
      { email: DEFAULT_LOGIN.email, password: DEFAULT_LOGIN.password },
      { email: 'other@seed.test', password: DEFAULT_LOGIN.password },
      { email: DEFAULT_LOGIN.email, password: 'a-long-random-one' },
    ]) {
      const r = await runEntry(login, { NODE_ENV: 'production' })
      expect(r.code).toBe(1)
      expect(r.err).toContain('Refused: this environment points at production')
    }
    await rejectsWith(() => h.auth.login('other@seed.test', DEFAULT_LOGIN.password), InvalidCredentialsError)

    const dev = await runEntry({ email: DEFAULT_LOGIN.email, password: DEFAULT_LOGIN.password })
    expect(dev.code).toBe(0)
    expect(signedIn(await h.auth.login(DEFAULT_LOGIN.email, DEFAULT_LOGIN.password)).token).toBeTruthy()
  })

  test('a database path naming prod refuses the default login in-process too', async () => {
    const fake = { $databases: { main: { path: '/srv/prod/app.db' } }, $schema: { models: [] } }
    await expect(seedLogin(fake, { email: DEFAULT_LOGIN.email, password: DEFAULT_LOGIN.password }))
      .rejects.toThrow('/srv/prod/app.db looks like a production database')
    expect(productionRefusal({ email: 'a@b.test', password: 'x-long-one' }, { NODE_ENV: 'production' })).toBeNull()
  })
})
