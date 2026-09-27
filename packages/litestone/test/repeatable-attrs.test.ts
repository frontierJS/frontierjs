// repeatable-attrs.test.ts — a single-valued attribute answered twice, and the
// two lists that decide which ones are single-valued ([FJS-1174](../../ISSUES.md#fjs-1174)).
//
// Every consumer reads an attribute with `.find(a => a.kind === …)`. A second
// one is therefore not merged and not preferred — it is ignored, in source
// order, with nothing said. The shape that bites is somebody TIGHTENING a gate
// by writing the stricter one underneath the old one: the schema reads as
// tightened and the boundary is unchanged.
//
// **The lists hold PARSE KINDS, and that is what this file is really guarding.**
// `@@unique` parses as `uniqueIndex` and field `@allow` as `fieldAllow`, so an
// entry spelled the way a reader types it matches nothing and the rule silently
// stops applying to it. That had already happened once — `REPEATABLE_MODEL_ATTRS`
// listed `'unique'`, a kind no parse emits, which let every real duplicate
// through AND refused a legitimate second `@@unique` on an `extend model` with
// a message naming `@@uniqueIndex`, a word nobody can type. The second half of
// this file parses each listed kind twice and fails on any that no longer
// matches, so the next wrong spelling is red rather than quiet.

import { describe, it, expect } from 'bun:test'
import { parse, REPEATABLE_MODEL_ATTRS, REPEATABLE_FIELD_ATTRS } from '../src/core/parser.js'

const refusal = (src: string) => {
  const r = parse(src)
  return r.valid ? null : String(r.errors[0] ?? '')
}

describe('an attribute answered twice is refused', () => {
  it('names the word as typed and BOTH answers, so the reader knows which is in force', () => {
    const err = refusal('model M {\n  id Int @id\n  @@gate("2")\n  @@gate("9")\n}')
    expect(err).toContain('@@gate')
    expect(err).toContain('@@gate("2") is the one in force')
    expect(err).toContain('@@gate("9") is ignored')
  })

  it('covers field attributes, which had the same hole', () => {
    const err = refusal('model M {\n  id Int @id\n  n Int @default(1) @default(2)\n}')
    expect(err).toContain("field 'n'")
    expect(err).toContain('@default(1) is the one in force')
    expect(err).toContain('@default(2) is ignored')
  })

  it('a duplicate whose argument has no short spelling still refuses', () => {
    expect(refusal('model M {\n  id Int @id\n  a String\n  @@fts([a])\n  @@fts([a])\n}')).toContain('@@fts')
  })
})

// Each of these is parsed TWICE on one model. A kind in the list that no parse
// emits is the failure mode this catches — the entry would be inert, and the
// attribute it was meant to permit would start being refused.
const MODEL_FIXTURES: Record<string, string> = {
  index:       '@@index([a])\n  @@index([b])',
  uniqueIndex: '@@unique([a])\n  @@unique([b])',
  partialUnique: '@@unique([a], where: b > 0)\n  @@unique([b], where: a > 0)',
  check:       '@@check("a > 0", "a must be positive")\n  @@check("b > 0", "b must be positive")',
  scope:       '@@scope(mine, a > 0)\n  @@scope(other, b > 0)',
  allow:       "@@allow('read', a > 0)\n  @@allow('read', b > 0)",
  deny:        "@@deny('read', a > 0)\n  @@deny('read', b > 0)",
  trait:       '@@trait(T1)\n  @@trait(T2)',
  // One per move owed — the same deadline twice is @@commitment's own refusal.
  // One per FIELD — two machines on one row, as an invoice's status and its
  // reminder are. The same field twice is @@transitions' own refusal.
  transitions: 's S @default(open)\n  r Boolean @default(false)\n' +
               '  @@transitions(s, close: open -> closed)\n  @@transitions(r, remind: false -> true)',
  commitment:  's S @default(open)\n  at DateTime\n' +
               '  @@transitions(s, close: open -> closed @system, drop: open -> dropped @system)\n' +
               '  @@commitment(close, on: at + 1d)\n  @@commitment(drop, on: at + 2d)',
}

const FIELD_FIXTURES: Record<string, string> = {
  fieldAllow: "@allow('read', true) @allow('write', true)",
}

describe('every listed kind is a kind the parser actually emits', () => {
  it('the two lists and the fixtures name the same kinds', () => {
    expect(Object.keys(MODEL_FIXTURES).sort()).toEqual([...REPEATABLE_MODEL_ATTRS].sort())
    expect(Object.keys(FIELD_FIXTURES).sort()).toEqual([...REPEATABLE_FIELD_ATTRS].sort())
  })

  for (const [kind, attrs] of Object.entries(MODEL_FIXTURES))
    it(`@@${kind} may be written twice`, () => {
      const src = `enum S { open closed dropped }\ntrait T1 {\n  t1 Int\n}\ntrait T2 {\n  t2 Int\n}\nmodel M {\n  id Int @id\n  a Int\n  b Int\n  ${attrs}\n}`
      expect(refusal(src)).toBe(null)
    })

  for (const [kind, attrs] of Object.entries(FIELD_FIXTURES))
    it(`@${kind} may be written twice`, () => {
      expect(refusal(`model M {\n  id Int @id\n  a Int ${attrs}\n}`)).toBe(null)
    })
})

describe('two partial uniques, one per predicate (FJS-1306)', () => {
  it('an entry row and a move row both declare, and `col != null` counts as excluding NULLs', () => {
    expect(refusal('model W {\n  id Int @id\n  teamId Int\n  fromId Int?\n  toId Int\n' +
      '  @@unique([fromId, toId], where: fromId != null)\n  @@unique([teamId, toId], where: fromId == null)\n}')).toBe(null)
  })
  it('a nullable member the predicate does NOT exclude is still refused', () => {
    expect(refusal('model W {\n  id Int @id\n  fromId Int?\n  toId Int\n  @@unique([fromId, toId], where: toId > 0)\n}'))
      .toContain('two NULLs never compare equal')
  })
})
