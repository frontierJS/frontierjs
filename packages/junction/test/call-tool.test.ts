// test/call-tool.test.ts
//
// `junction call` — one service method, once, as somebody, then exit (`FJS-1560`).
//
// Run as a process against an app module on disk, because what it promises is
// about the process: the answer alone on stdout, a refusal on stderr with exit 1,
// and a boot that starts none of the app's work.
//
// PAIRED where the failure is a quiet one. A call with no --as is checked beside
// the same call --as somebody, because `runAs(null)` is the app's SYSTEM
// principal and a stranger's call ran with the app's authority; and the
// no-work assertion sits beside a plugin whose boot() did run.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync }                                 from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }                                    from 'node:os'
import { join, resolve }                             from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const at   = (p: string) => JSON.stringify(join(ROOT, p))

const APP = `
import { writeFileSync } from 'node:fs'
import { createClient } from ${at('../litestone/src/index.js')}
import { createApp, createService, createStubAuth } from ${at('index.ts')}
import { Forbidden } from ${at('src/core/errors.ts')}

export async function buildApp() {
  const db = await createClient({ db: ':memory:', schema: \`
    model User {
      id    Int    @id @default(autoincrement())
      email String
      @@auth
    }
    model Note {
      id      Int    @id @default(autoincrement())
      ownerId String
      body    String
      @@allow('read', ownerId == auth().id)
    }\` })
  const sys = db.asSystem()
  await sys.user.create({ data: { email: 'ann@x.test' } })
  await sys.user.create({ data: { email: 'bo@x.test' } })
  for (const [ownerId, body] of [['1', 'a1'], ['1', 'a2'], ['2', 'b1']])
    await sys.note.create({ data: { ownerId, body } })

  const app = createApp({
    db,
    auth:   createStubAuth({ users: [{ id: '1', role: 'member' }, { id: '2', role: 'member' }] }),
    system: { userId: 'app', role: 'system' },
  })
  app.services.register(createService({
    name: 'notes', model: 'Note',
    async whoami(ctx) { return { id: ctx.auth.user?.userId ?? null } },
    async refuse()    { throw new Forbidden('not today') },
  }))
  app.configure({
    name: 'clock',
    boot: () => { writeFileSync('BOOTED', '') },
    work: () => { writeFileSync('WORKED', '') },
  })
  return app
}
`

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'junction-call-'))
  writeFileSync(join(dir, 'app.ts'), APP)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function call(...args: string[]) {
  const run = spawnSync(process.execPath, [join(ROOT, 'tools/cli.ts'), 'call', '--app', 'app.ts', ...args], {
    cwd: dir, encoding: 'utf8',
  })
  return { code: run.status, out: run.stdout, err: run.stderr }
}

describe('junction call', () => {
  it('answers JSON alone on stdout, graded as the person named', () => {
    const r = call('notes.find', '--as', 'ann@x.test')
    expect(r.code).toBe(0)
    const rows = JSON.parse(r.out)
    expect((rows.data ?? rows).map((n: { body: string }) => n.body)).toEqual(['a1', 'a2'])
    expect(r.err).toContain('Standing: ann@x.test (User 1)')
  }, 60_000)

  it('with no --as it runs as no principal, never as the app', () => {
    const nobody = call('notes.whoami')
    const ann    = call('notes.whoami', '--as', 'ann@x.test')
    expect(JSON.parse(nobody.out)).toEqual({ id: null })
    expect(JSON.parse(ann.out)).toEqual({ id: '1' })
  }, 60_000)

  it('boots the app and starts none of its work', () => {
    rmSync(join(dir, 'BOOTED'), { force: true })
    rmSync(join(dir, 'WORKED'), { force: true })
    expect(call('notes.whoami').code).toBe(0)
    expect(existsSync(join(dir, 'BOOTED'))).toBe(true)
    expect(existsSync(join(dir, 'WORKED'))).toBe(false)
  }, 60_000)

  it('carries a $ key as a directive, and refuses one the table does not name', () => {
    const one = call('notes.find', '{"$limit":1}', '--as', 'ann@x.test')
    const rows = JSON.parse(one.out)
    expect((rows.data ?? rows)).toHaveLength(1)

    const bad = call('notes.find', '{"$limt":1}', '--as', 'ann@x.test')
    expect(bad.code).toBe(1)
    expect(bad.out).toBe('')
    expect(bad.err).toContain('Unknown directive $limt')
  }, 60_000)

  it('a thrown refusal prints its status on stderr and exits 1', () => {
    const r = call('notes.refuse', '--as', 'ann@x.test')
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/\(403\): not today/)
  }, 60_000)

  it('refuses a hook-bypass twin, an unknown method and an unknown person by name', () => {
    const twin = call('notes._find')
    expect(twin.code).toBe(1)
    expect(twin.err).toContain('Call find')

    const missing = call('notes.purge')
    expect(missing.code).toBe(1)
    expect(missing.err).toMatch(/no method 'purge'.*find/)

    const stranger = call('notes.find', '--as', 'cy@x.test')
    expect(stranger.code).toBe(1)
    expect(stranger.err).toContain('no User matches on email')
  }, 60_000)
})
