// db/test/schema.test.js
// What the schema promises a stranger, a member and a banned member — each
// rule admitted once and refused once, through a real scoped client. A policy
// that filters to nothing reads exactly like a working one, so every refusal
// here sits beside the row a rule must still let through.
//
// Litestone is imported by relative path: a `workspace:` dependency is a copy
// under node_modules/.bun/, and an edit to litestone would be invisible here.

import { test, expect, describe, beforeEach } from 'bun:test'
import { join } from 'node:path'

import { parseFile, createClient } from '../../../litestone/src/index.js'

const SCHEMA = join(import.meta.dir, '..', 'schema.lite')

let db, sys, sam, ana, rex, square

async function member (nick) {
  return sys.member.create({ data: { nick, publicKey: `key-${nick}` } })
}

beforeEach(async () => {
  db  = await createClient({ path: SCHEMA, databases: ':memory:' })
  sys = /** @type {any} */ (db.asSystem())
  square = await sys.room.create({ data: { slug: 'square', name: 'The square' } })
  sam = await member('sam')
  ana = await member('ana')
  rex = await member('rex')
  await sys.member.update({ where: { id: rex.id }, data: { bannedAt: new Date().toISOString() } })
  rex = await sys.member.findFirst({ where: { id: rex.id } })
})

const as = (m) => db.$setAuth(m)

describe('the schema', () => {
  test('parses with no errors', () => {
    const { errors } = parseFile(SCHEMA)
    expect(errors).toEqual([])
  })
})

describe('a stranger', () => {
  test('reads nothing of Haven', async () => {
    await expect(db.$setAuth(null).room.findMany()).rejects.toThrow(/Room/)
    await expect(db.$setAuth(null).message.findMany()).rejects.toThrow(/Message/)
  })
})

describe('a member', () => {
  test('says a line, stamped as themselves whatever the payload names', async () => {
    const line = await as(sam).message.create({ data: { roomId: square.id, memberId: ana.id, body: '  hi all  ' } })
    expect(line.memberId).toBe(sam.id)
    expect(line.body).toBe('hi all')
    expect((await as(ana).message.findMany()).map(m => m.body)).toEqual(['hi all'])
  })

  test('cannot rewrite a said line, and neither can the system', async () => {
    const line = await as(sam).message.create({ data: { roomId: square.id, body: 'hi' } })
    await expect(as(sam).message.update({ where: { id: line.id }, data: { body: 'bye' } })).rejects.toThrow(/Message/)
    await expect(sys.message.update({ where: { id: line.id }, data: { body: 'bye' } })).rejects.toThrow(/Message/)
  })

  test('renames themselves and nobody else', async () => {
    await as(sam).member.update({ where: { id: sam.id }, data: { nick: 'Samwise' } })
    expect((await sys.member.findFirst({ where: { id: sam.id } })).nick).toBe('samwise')
    expect(await as(sam).member.update({ where: { id: ana.id }, data: { nick: 'gone' } })).toBeNull()
    expect((await sys.member.findFirst({ where: { id: ana.id } })).nick).toBe('ana')
  })

  test('cannot lift a ban, move a key or walk in as a new member', async () => {
    await expect(as(sam).member.update({ where: { id: sam.id }, data: { bannedAt: null } })).rejects.toThrow(/bannedAt/)
    await expect(as(sam).member.update({ where: { id: sam.id }, data: { publicKey: 'other' } })).rejects.toThrow(/publicKey/)
    await expect(as(sam).member.create({ data: { nick: 'twin', publicKey: 'k2' } })).rejects.toThrow(/Member/)
  })

  test('cannot lay out a room', async () => {
    await expect(as(sam).room.create({ data: { slug: 'cellar', name: 'Cellar' } })).rejects.toThrow(/Room/)
  })

  test('a nick is refused by shape, and one taken twice is one figure', async () => {
    await expect(member('a b')).rejects.toThrow(/nick/)
    await expect(member('x')).rejects.toThrow(/nick/)
    await expect(member('SAM')).rejects.toThrow(/already taken/)
  })
})

describe('a ban', () => {
  test('is an empty room for the banned member', async () => {
    await as(sam).message.create({ data: { roomId: square.id, body: 'hi' } })
    expect(await as(rex).message.findMany()).toEqual([])
    expect(await as(rex).member.findMany()).toEqual([])
  })

  test('lets them say nothing', async () => {
    await expect(as(rex).message.create({ data: { roomId: square.id, body: 'buy now' } })).rejects.toThrow(/@@allow policy/)
  })

  test('takes them and what they said out of everyone else\'s Haven', async () => {
    await sys.message.create({ data: { roomId: square.id, memberId: rex.id, body: 'spam' } })
    await as(ana).message.create({ data: { roomId: square.id, body: 'hello' } })
    expect((await as(sam).message.findMany()).map(m => m.body)).toEqual(['hello'])
    expect((await as(sam).member.findMany()).map(m => m.nick).sort()).toEqual(['ana', 'sam'])
  })
})
