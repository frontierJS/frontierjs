// test/secret-hashed.test.ts
//
// `@secret @hashed` — the credential a SERVER verifies (FJS-1249, FJS-D478).
// A device token is looked up by the value the device presents and never read
// back, so it wants the digest of `@hashed` and the lock and the audit trail of
// `@secret`. The refusal between the two protected a reversibility the author
// was choosing to give up.

import { describe, test, expect } from 'bun:test'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { parse, createClient } from '../src/index.js'
import { generateDDL } from '../src/core/ddl.js'
import { splitStatements } from '../src/core/migrate.js'

const KEY = 'a'.repeat(64)

const SCHEMA = `
  database main  { path env("MAIN_DB", "./main.db") }
  database audit { path "./audit/" driver logger }

  model Device {
    id    Int    @id @default(autoincrement())
    name  String
    token String @secret @hashed
    @@db(main)
  }
`

const flush = () => new Promise<void>(res => setTimeout(res, 20))

async function open(onLog?: (e: any) => void) {
  const r = parse(SCHEMA)
  if (!r.valid) throw new Error(r.errors.join('\n'))
  const dir = join(tmpdir(), `ls-secret-hashed-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(dir, 'audit'), { recursive: true })
  const mainPath = join(dir, 'main.db')
  const raw = new Database(mainPath)
  for (const s of splitStatements(generateDDL(r.schema)))
    if (!s.startsWith('PRAGMA')) raw.run(s)
  raw.close()
  return createClient({
    parsed: r,
    databases: { main: { path: mainPath }, audit: { path: join(dir, 'audit') } },
    encryptionKey: KEY,
    onLog,
  })
}

describe('@secret @hashed', () => {
  test('is a valid declaration, and is one-way: no @encrypted half', () => {
    const r = parse(SCHEMA)
    expect(r.errors).toEqual([])
    const kinds = r.schema.models[0].fields.find((f: any) => f.name === 'token').attributes.map((a: any) => a.kind)
    expect(kinds).toContain('hashed')
    expect(kinds).toContain('guarded')
    expect(kinds).not.toContain('encrypted')
  })

  test('a typed @guarded beside the pair is still refused', () => {
    const r = parse(`model D { id Int @id\n  t String @secret @hashed @guarded }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/@secret already implies @guarded/)
  })

  test('@encrypted or @allow beside the pair is still refused', () => {
    for (const [decl, re] of [
      ['t String @secret @hashed @encrypted', /conflicts with @encrypted/],
      [`t String @secret @hashed @allow('read', true)`, /conflicts with @allow/],
      ['t String @secret(deterministic: true) @hashed', /deterministic/],
    ] as [string, RegExp][]) {
      const r = parse(`model D { id Int @id\n  ${decl} }`)
      expect(r.valid).toBe(false)
      expect(r.errors.join(' ')).toMatch(re)
    }
  })

  test('matchable in a where, never readable, and the lock is on', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.device.create({ data: { name: 'wall', token: 'tok-1' } })
    await sys.device.create({ data: { name: 'door', token: 'tok-2' } })

    const hit = await sys.device.findFirst({ where: { token: 'tok-1' } })
    expect(hit.name).toBe('wall')
    expect(await sys.device.findFirst({ where: { token: 'nope' } })).toBeNull()
    expect('token' in hit).toBe(false)
    await expect(sys.device.findMany({ select: { token: true } })).rejects.toThrow()

    // @guarded: a caller who is not the system cannot issue one
    await expect(db.device.create({ data: { name: 'x', token: 'tok-3' } })).rejects.toThrow()
    db.$close()
  })

  test('the audit trail records that it was written, never the value', async () => {
    const calls: any[] = []
    const db = await open(e => { calls.push(e) })
    const row = await db.asSystem().device.create({ data: { name: 'wall', token: 'PLAINTEXT-TOKEN' } })
    await flush()
    expect(JSON.stringify(calls)).not.toContain('PLAINTEXT-TOKEN')
    const entry = calls.find(e => e.field === 'token')
    expect(entry).toBeDefined()
    expect(JSON.parse(entry.records)).toEqual([row.id])
    db.$close()
  })

  test('$rotateKey refuses it unless orphaned by name — a digest cannot be re-keyed', async () => {
    const db = await open()
    await db.asSystem().device.create({ data: { name: 'wall', token: 'tok-1' } })
    await expect(db.$rotateKey('b'.repeat(64))).rejects.toThrow(/Device\.token/)
    db.$close()
  })
})
