// db/test/schema.test.js
// What the schema promises a stranger, a member, a mod and a banned member —
// each rule admitted once and refused once, through a real scoped client. A
// policy that filters to nothing reads exactly like a working one, so every
// refusal here sits beside the row a rule must still let through.
//
// A field `@allow('write')` DROPS the key rather than throwing (`FJS-D22`), so
// a member unbanning themselves resolves and writes nothing: the assertion is
// the column after, never the promise.
//
// Litestone is imported by relative path: a `workspace:` dependency is a copy
// under node_modules/.bun/, and an edit to litestone would be invisible here.

import { test, expect, describe, beforeEach } from 'bun:test'
import { join } from 'node:path'

import { parseFile, createClient } from '../../../litestone/src/index.js'

const SCHEMA = join(import.meta.dir, '..', 'schema.lite')

let db, sys, sam, ana, rex, mod, square

async function member (nick, data = {}) {
  return sys.member.create({ data: { nick, publicKey: `key-${nick}`, ...data } })
}

const bannedAt = async (m) => (await sys.member.findFirst({ where: { id: m.id }, select: { bannedAt: true } })).bannedAt

beforeEach(async () => {
  db  = await createClient({ path: SCHEMA, databases: ':memory:' })
  sys = /** @type {any} */ (db.asSystem())
  square = await sys.room.create({ data: { slug: 'square', name: 'The square' } })
  sam = await member('sam')
  ana = await member('ana')
  rex = await member('rex')
  mod = await member('mod', { role: 'mod' })
  await sys.member.update({ where: { id: rex.id }, data: { bannedAt: new Date().toISOString() } })
  rex = await sys.member.findFirst({ where: { id: rex.id } })
})

const as = (m) => db.$setAuth(m)
// The API re-reads the row on every call (`api/src/principal.ts`); a test holds
// the row it read, so one that bans re-reads before standing as the banned.
const fresh = async (m) => sys.member.findFirst({ where: { id: m.id } })

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

  test('cannot ban, lift a ban, take a standing, move a key or walk in as a new member', async () => {
    expect(await as(sam).member.update({ where: { id: ana.id }, data: { bannedAt: new Date().toISOString() } })).toBeNull()
    expect(await bannedAt(ana)).toBeNull()
    await as(rex).member.update({ where: { id: rex.id }, data: { bannedAt: null } })
    expect(await bannedAt(rex)).not.toBeNull()
    await expect(as(sam).member.update({ where: { id: sam.id }, data: { role: 'mod' } })).rejects.toThrow(/role/)
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
    expect((await as(sam).member.findMany()).map(m => m.nick).sort()).toEqual(['ana', 'mod', 'sam'])
  })
})

describe('a mod', () => {
  test('bans a member and lifts the ban, each an ordinary update', async () => {
    const banned = await as(mod).member.update({ where: { id: ana.id }, data: { bannedAt: new Date().toISOString() } })
    expect(banned.bannedAt).not.toBeNull()
    expect(await as(await fresh(ana)).room.findMany()).toEqual([])
    expect((await as(sam).member.findMany()).map(m => m.nick).sort()).toEqual(['mod', 'sam'])

    const lifted = await as(mod).member.update({ where: { id: ana.id }, data: { bannedAt: null } })
    expect(lifted.bannedAt).toBeNull()
    expect((await as(await fresh(ana)).room.findMany()).map(r => r.slug)).toEqual(['square'])
  })

  test('sees the banned, who still see nothing', async () => {
    expect((await as(mod).member.findMany()).map(m => m.nick).sort()).toEqual(['ana', 'mod', 'rex', 'sam'])
    expect(await as(rex).member.findMany()).toEqual([])
  })

  test('cannot appoint a mod or rename anyone but themselves by column policy', async () => {
    await expect(as(mod).member.update({ where: { id: sam.id }, data: { role: 'mod' } })).rejects.toThrow(/role/)
    // The row policy admits a mod to every row; the nick is the member's own.
    await as(mod).member.update({ where: { id: sam.id }, data: { nick: 'renamed' } })
    expect((await sys.member.findFirst({ where: { id: sam.id } })).nick).toBe('renamed')
  })

  test('grades one rung above a member, and the schema spells no gate at that rung', async () => {
    expect(db.$levelOf('member', { id: mod.id, role: 'mod' })).toBe(4)
    expect(db.$levelOf('member', { id: sam.id, role: null })).toBe(3)
  })
})

describe('a booth', () => {
  let booth, line

  beforeEach(async () => {
    booth = await sys.room.create({ data: { slug: `booth-${sam.id}-${ana.id}`, name: 'A booth', pairLoId: sam.id, pairHiId: ana.id } })
    line  = await as(sam).message.create({ data: { roomId: booth.id, body: 'psst' } })
  })

  test('is read by its pair, line and room, and by nobody else', async () => {
    expect((await as(sam).room.findMany()).map(r => r.slug)).toContain(booth.slug)
    expect((await as(ana).message.findMany({ where: { roomId: booth.id } })).map(m => m.body)).toEqual(['psst'])
    expect((await as(mod).room.findMany()).map(r => r.slug)).toEqual(['square'])
    expect(await as(mod).message.findMany({ where: { roomId: booth.id } })).toEqual([])
    expect((await as(await fresh(rex)).room.findMany())).toEqual([])
  })

  test('is said into by its pair, and a third member writes nothing', async () => {
    const reply = await as(ana).message.create({ data: { roomId: booth.id, body: 'yes?' } })
    expect(reply.memberId).toBe(ana.id)
    await expect(as(mod).message.create({ data: { roomId: booth.id, body: 'hello' } })).rejects.toThrow()
    expect(await sys.message.count({ where: { roomId: booth.id } })).toBe(2)
  })

  test('holds a game its pair reads and nobody writes below the system', async () => {
    const game = await sys.game.create({ data: { roomId: booth.id, redId: sam.id, blackId: ana.id, board: '.'.repeat(64), turn: 'r' } })
    expect((await as(ana).game.findMany()).map(g => g.id)).toEqual([game.id])
    expect(await as(mod).game.findMany()).toEqual([])
    await expect(as(sam).game.update({ where: { id: game.id }, data: { turn: 'b' } })).rejects.toThrow()
    await expect(as(sam).game.create({ data: { roomId: booth.id, redId: sam.id, blackId: ana.id, board: '.'.repeat(64), turn: 'r' } })).rejects.toThrow()
  })

  test('leaves the square a square: no pair, everybody reads it', async () => {
    expect((await as(mod).room.findMany({ where: { slug: 'square' } })).length).toBe(1)
    await as(mod).message.create({ data: { roomId: square.id, body: 'hi all' } })
    expect((await as(sam).message.findMany({ where: { roomId: square.id } })).length).toBe(1)
  })
})

describe('a whisper', () => {
  beforeEach(async () => {
    await as(sam).message.create({ data: { roomId: square.id, body: 'psst', toId: ana.id } })
    await as(sam).message.create({ data: { roomId: square.id, body: 'hello' } })
  })

  test('is read by its speaker and the member it names, and by nobody else', async () => {
    const bodies = async (m) => (await as(m).message.findMany({ where: { roomId: square.id } })).map(l => l.body).sort()
    expect(await bodies(sam)).toEqual(['hello', 'psst'])
    expect(await bodies(ana)).toEqual(['hello', 'psst'])
    expect(await bodies(mod)).toEqual(['hello'])
    expect(await sys.message.count({ where: { roomId: square.id } })).toBe(2)
  })

  test('is not a stamp: the speaker is still the caller, and a null toId is a line said aloud', async () => {
    const line = await as(ana).message.create({ data: { roomId: square.id, body: 'back', toId: sam.id, memberId: sam.id } })
    expect(line).toMatchObject({ memberId: ana.id, toId: sam.id })
    const aloud = await as(ana).message.create({ data: { roomId: square.id, body: 'all', toId: null } })
    expect((await as(mod).message.findMany({ where: { id: aloud.id } })).length).toBe(1)
  })
})
