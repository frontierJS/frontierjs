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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }                                    from 'node:os'
import { join, resolve }                             from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const at   = (p: string) => JSON.stringify(join(ROOT, p))

const APP = `
import { writeFileSync } from 'node:fs'
import { createClient, GatePlugin } from ${at('../litestone/src/index.js')}
import { createApp, createService, createStubAuth } from ${at('index.ts')}
import { Forbidden } from ${at('src/core/errors.ts')}

export async function buildApp() {
  const db = await createClient({ db: ':memory:', schema: \`
    database audit { path "\${import.meta.dir}/audit/" driver trail }
    model User {
      id    Int    @id @default(autoincrement())
      email String
      @@auth
    }
    model Note {
      id      Int    @id @default(autoincrement())
      ownerId String
      body    String
      @@allow(read, ownerId == auth().id)
    }
    model Ledger {
      id    Int    @id @default(autoincrement())
      entry String
      @@gate(5)
      @@trail(audit)
    }\`,
    plugins: [new GatePlugin({ getLevel: auth => auth?.role === 'system' ? 7 : auth ? 5 : 0 })],
  })
  const sys = db.asSystem()
  await sys.user.create({ data: { email: 'ann@x.test' } })
  await sys.user.create({ data: { email: 'bo@x.test' } })
  for (const [ownerId, body] of [['1', 'a1'], ['1', 'a2'], ['2', 'b1']])
    await sys.note.create({ data: { ownerId, body } })
  await sys.ledger.create({ data: { entry: 'opening' } })

  const app = createApp({
    db,
    auth:   createStubAuth({ users: [{ id: '1', role: 'member' }, { id: '2', role: 'member' }] }),
    system: { id: 'app', role: 'system' },
  })
  app.services.register(createService({
    name: 'notes', model: 'Note',
    async whoami(ctx) { return { id: ctx.user?.id ?? null } },
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

// `-e` is the prompt run once (`FJS-D1532`), with `db:repl`'s contract: the
// answer alone on stdout as JSON, a throw on stderr and exit 1. PAIRED: each
// refusal sits beside the same reach at a standing that is let through, so a
// refusal that is really a broken boot reads apart.
describe('junction call -e', () => {
  const run = (code: string, ...args: string[]) => call('-e', code, ...args)
  const prod = (code: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools/cli.ts'), 'call', '--app', 'app.ts', '-e', code, ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' },
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }

  it('answers a call as JSON alone on stdout, the standing on stderr', () => {
    const r = run(`call('notes.find', { $limit: 1 })`, '--as', 'ann@x.test')
    expect(r.code).toBe(0)
    const rows = JSON.parse(r.out)
    expect((rows.data ?? rows).map((n: { body: string }) => n.body)).toEqual(['a1'])
    expect(r.err).toContain('Standing: ann@x.test (User 1)')
  }, 60_000)

  it('db reads at the standing: a row policy filters, a gate refuses', () => {
    const ann = run('db.note.count()', '--as', 'ann@x.test')
    expect(JSON.parse(ann.out)).toBe(2)
    expect(JSON.parse(run('db.note.count()').out)).toBe(0)

    const member = run('db.ledger.count()', '--as', 'ann@x.test')
    expect(member.code).toBe(0)
    expect(JSON.parse(member.out)).toBe(1)

    const nobody = run('db.ledger.count()')
    expect(nobody.code).toBe(1)
    expect(nobody.out).toBe('')
    expect(nobody.err).toContain('AccessDenied')
  }, 60_000)

  it('as() names a person or is refused, and a refusal exits 1', () => {
    const known = run(`as('bo@x.test').then(() => call('notes.whoami'))`)
    expect(known.code).toBe(0)
    expect(JSON.parse(known.out)).toEqual({ id: '2' })

    const stranger = run(`as('cy@x.test')`)
    expect(stranger.code).toBe(1)
    expect(stranger.out).toBe('')
    expect(stranger.err).toContain('no User matches on email')
  }, 60_000)

  it('-e beside a method word is refused by name', () => {
    const r = call('notes.find', '-e', 'db.note.count()')
    expect(r.code).toBe(1)
    expect(r.err).toContain('name one or the other')
  }, 60_000)

  it('in production sys reads unforced and refuses a write, $transaction and sys(fn)', () => {
    const read = prod('sys.ledger.count()')
    expect(read.code).toBe(0)
    expect(JSON.parse(read.out)).toBe(1)

    for (const code of [
      `sys.ledger.create({ data: { entry: 'x' } })`,
      `sys.$transaction(async () => 1)`,
      `sys(() => app.service('notes').find())`,
    ]) {
      const r = prod(code)
      expect(r.code).toBe(1)
      expect(r.out).toBe('')
      expect(r.err).toContain('--force')
    }
  }, 60_000)

  it('in production --force lets a sys write through', () => {
    const r = prod('sys.ledger.deleteMany({ where: { id: -1 } })', '--force')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({ count: 0 })
  }, 60_000)

  // `FJS-D1534`. PAIRED: the operator is the actor of a `sys` write and of
  // nothing else, and never the `--as` standing — a swap keyed on *is there a
  // prompt* passes the first row and fails the second, one keyed on `--as`
  // fails the third.
  describe('the trail names who was at the keyboard on a sys write', () => {
    // Read off the file, because the trail model answers `asSystem()` alone and
    // the app's own principal is not that.
    const lastEntry = (write: string, ...args: string[]) => {
      const r = spawnSync(process.execPath, [join(ROOT, 'tools/cli.ts'), 'call', '--app', 'app.ts', '-e',
        `await ${write}; await new Promise(r => setTimeout(r, 50))`, ...args], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, USER: 'op-test', NODE_ENV: 'development' },
      })
      expect(r.stderr).not.toContain('Error')
      expect(r.status).toBe(0)
      return readFileSync(join(dir, 'audit', 'AuditTrail.jsonl'), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line)).filter(row => row.model === 'Ledger').at(-1)
    }

    it('a sys write files the operator as actor, typed repl', () => {
      const row = lastEntry(`sys.ledger.create({ data: { entry: 'by hand' } })`)
      expect(row.actorId).toBe('op-test')
      expect(row.actorType).toBe('repl')
    }, 60_000)

    it('a db write at the standing files the standing, not the operator', () => {
      const row = lastEntry(`db.ledger.create({ data: { entry: 'as ann' } })`, '--as', 'ann@x.test')
      expect(String(row.actorId)).toBe('1')
      expect(row.actorType).toBe('user')
    }, 60_000)

    it('a sys write under --as still files the operator, never the standing', () => {
      const row = lastEntry(`sys.ledger.create({ data: { entry: 'by hand' } })`, '--as', 'ann@x.test')
      expect(row.actorId).toBe('op-test')
      expect(row.actorType).toBe('repl')
    }, 60_000)
  })
})
