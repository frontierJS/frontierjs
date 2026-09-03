// test/json-path-write.test.ts
//
// `{ 'settings.commute': { source } }` — a write key that is a PATH.
//
// It is not supported and it never was. What made it worth a test is what it
// did instead: `writeData` strips an unknown key silently as mass-assignment
// protection, so a request naming a real column with a real path was a 200
// that changed nothing — no throw, no warning, no `errors` array (FJS-658).
//
// The rule the strip already states is the one being applied here: *stripping
// an UNKNOWN key silently is the mass-assignment protection; stripping a key
// the model declares but cannot store is a different thing wearing the same
// clothes, and the caller has to hear about it.* A path whose head names a
// declared column is the second category.
//
// Half this file is therefore the OTHER side: the strip must keep working, or
// the fix has traded a silent no-op for a boundary that refuses every form
// body passed straight in.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  type Commute { source String? }
  type Settings {
    commute Json? @type(Commute)
    theme   String
  }

  model Account {
    id       Int    @id
    name     String
    settings Json   @type(Settings)
    loose    Json   @default("{}")
    words    String[]
  }
`

let db: any

beforeEach(async () => {
  db = (await createClient({ db: ':memory:', schema: SCHEMA })).asSystem()
  await db.account.create({ data: {
    id: 1, name: 'a', words: ['w'],
    settings: { commute: { source: 'x' }, theme: 'dark' },
    loose:    { a: 1, b: 2 },
  } })
})

const upd     = (data: any) => db.account.update({ where: { id: 1 }, data })
const thrown  = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)
const msg     = (e: any) => e?.errors?.[0]?.message ?? e?.message ?? ''
const stored  = () => db.account.findUnique({ where: { id: 1 } })

describe('a path into a declared column is refused by name', () => {
  // The sharpest reading: the type declares `commute`, so the schema knows the
  // column AND the sub-key, and the old behaviour still said nothing.
  test('a typed Json column', async () => {
    const e = await thrown(upd({ 'settings.commute': { source: 'bus' } }))
    expect(e).toBeTruthy()
    expect(msg(e)).toMatch(/"settings\.commute" reads as a path into "settings"/)
    expect(msg(e)).toMatch(/a write takes the whole document/)
    // The stored document is untouched, which it also was before the fix — the
    // difference is entirely in whether the caller was told.
    expect((await stored()).settings).toEqual({ commute: { source: 'x' }, theme: 'dark' })
  })

  test('an undescribed Json column', async () => {
    expect(msg(await thrown(upd({ 'loose.a': 9 })))).toMatch(/reads as a path into "loose"/)
  })

  test('the path names the way out and it is the column, not the sub-key', async () => {
    const m = msg(await thrown(upd({ 'settings.commute': {} })))
    expect(m).toMatch(/change "commute"/)
    expect(m).toMatch(/write "settings" back/)
  })

  // A different mistake gets a different sentence: there is no inside to reach.
  test('a scalar column reads as the other kind of mistake', async () => {
    const m = msg(await thrown(upd({ 'name.first': 'z' })))
    expect(m).toMatch(/which is String and has no "first" inside it/)
    expect(m).toMatch(/Write "name" itself/)
  })

  test('an array column', async () => {
    expect(msg(await thrown(upd({ 'words.0': 'z' })))).toMatch(/which is String\[\] and has no "0" inside it/)
  })

  test('a deep path names the whole tail', async () => {
    expect(msg(await thrown(upd({ 'settings.commute.source': 'bus' })))).toMatch(/change "commute\.source"/)
  })

  test('it is a ValidationError, so the path is the key the caller sent', async () => {
    const e: any = await thrown(upd({ 'settings.theme': 'light' }))
    expect(e.errors?.[0]?.path).toEqual(['settings.theme'])
  })
})

describe('one mistake, one sentence — the operator branch too', () => {
  // extractWriteOps runs BEFORE writeData, so a path carrying an operator was
  // answered by the operator branch ("settings.tags is not a column on
  // Account") while the same path carrying a value got the path refusal. Two
  // sentences for one mistake, and the operator one names a truth that is not
  // the point.
  test('a path carrying an operator gets the path refusal', async () => {
    const withOp    = msg(await thrown(upd({ 'words.0': { push: 'z' } })))
    const withValue = msg(await thrown(upd({ 'words.0': 'z' })))
    expect(withOp).toMatch(/reads as a path into "words"/)
    expect(withOp).toBe(withValue)
  })

  // The control: a key that really is not a column keeps the operator branch's
  // own sentence, which is the correct one there.
  test('an operator on a key that is not a column at all is unchanged', async () => {
    expect(msg(await thrown(upd({ nope: { push: 'z' } }))))
      .toMatch(/nope is not a column on Account, so "push" has nothing to apply to/)
  })
})

describe('the mass-assignment strip still works', () => {
  // Every one of these is a key with no column behind it, which is exactly what
  // the silent strip exists for — a form body or a request body passed straight
  // in. A fix that refused these would be worse than the defect.
  test('an unknown key is still dropped in silence', async () => {
    await upd({ totallyUnknown: 1, name: 'b' })
    expect((await stored()).name).toBe('b')
  })

  test('a dotted key whose HEAD is not a column is still just an unknown key', async () => {
    await upd({ 'nosuch.deep': 1, name: 'c' })
    expect((await stored()).name).toBe('c')
  })

  test('an ordinary whole-document write is unaffected', async () => {
    await upd({ settings: { commute: { source: 'bus' }, theme: 'light' } })
    expect((await stored()).settings).toEqual({ commute: { source: 'bus' }, theme: 'light' })
  })

  // The shape a caller reaches for instead, and the reason FJS-D176 is open:
  // it is two statements and it races. Asserted so the read-modify-write that
  // the refusal sends people to is known to work.
  test('the way out the message names actually works', async () => {
    const row = await stored()
    await upd({ settings: { ...row.settings, commute: { source: 'bus' } } })
    expect((await stored()).settings).toEqual({ commute: { source: 'bus' }, theme: 'dark' })
  })
})

describe('create refuses it too', () => {
  // The strip is in writeData, which every write path goes through, so this is
  // one assertion rather than a matrix — but a create is the payload a form
  // actually sends, so it is worth having by name.
  test('a path on create', async () => {
    expect(msg(await thrown(db.account.create({ data: {
      id: 2, name: 'b', 'settings.theme': 'dark',
    } })))).toMatch(/reads as a path into "settings"/)
  })
})
