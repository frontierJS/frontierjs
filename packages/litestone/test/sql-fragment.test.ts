// A fragment is SQL text and its binds, together — the currency a clause
// builder answers and a verb assembles (IDEAS/shipped/litestone-by-construction.md § Step 1).
//
// The failure it removes is a placeholder and its value travelling apart:
// FJS-262 and FJS-216 were a filter's text spliced in one order and its binds
// pushed in another. These rows pin that nesting keeps each bind beside its
// text, that an empty operand costs the assembler no branch, and that `ident`
// is `quoteIdent` under a brand — it quotes, and it refuses nothing, because the
// refusal of a caller's name belongs to the resolver that admitted it.

import { describe, it, expect } from 'bun:test'
import { sqlFragment, isSqlFragment, ident, and, or, join, sql, quoteIdent } from '../src/core/query.js'

const frag = (text: string, ...params: any[]) => sqlFragment(text, params)

describe('sqlFragment', () => {
  it('carries sql and params under the brand', () => {
    const f = frag('"a" = ?', 1)
    expect(f.sql).toBe('"a" = ?')
    expect(f.params).toEqual([1])
    expect(isSqlFragment(f)).toBe(true)
  })

  it('a plain object shaped like one is not one', () => {
    expect(isSqlFragment({ sql: '"a" = ?', params: [1] })).toBe(false)
    expect(isSqlFragment(JSON.parse(JSON.stringify(frag('x', 1))))).toBe(false)
    expect(isSqlFragment(null)).toBe(false)
    expect(isSqlFragment('x')).toBe(false)
  })
})

describe('ident', () => {
  it('is quoteIdent under the brand, with no binds', () => {
    const f = ident('user')
    expect(f.sql).toBe(quoteIdent('user'))
    expect(f.sql).toBe('"user"')
    expect(f.params).toEqual([])
    expect(isSqlFragment(f)).toBe(true)
  })

  it('quotes a double quote rather than refusing it', () => {
    const f = ident('we"ird')
    expect(f.sql).toBe('"we""ird"')
    expect(f.params).toEqual([])
  })
})

describe('join', () => {
  it('concatenates text with the separator and keeps the binds in text order', () => {
    const f = join([frag('"a" = ?', 1), frag('"b" IN (?, ?)', 2, 3), frag('"c" = ?', 4)], ', ')
    expect(f.sql).toBe('"a" = ?, "b" IN (?, ?), "c" = ?')
    expect(f.params).toEqual([1, 2, 3, 4])
  })

  it('skips nulls and empty fragments without leaving a separator behind', () => {
    const f = join([null, frag('"a" = ?', 1), undefined, frag('', 9), frag('"b" = ?', 2)], ' AND ')
    expect(f.sql).toBe('"a" = ? AND "b" = ?')
    expect(f.params).toEqual([1, 2])
  })

  it('an empty list is an empty fragment', () => {
    const f = join([], ', ')
    expect(f.sql).toBe('')
    expect(f.params).toEqual([])
    expect(isSqlFragment(f)).toBe(true)
  })

  it('splices an identifier beside a bound value', () => {
    const f = join([ident('tbl'), frag('WHERE'), join([ident('col'), frag('= ?', 5)], ' ')], ' ')
    expect(f.sql).toBe('"tbl" WHERE "col" = ?')
    expect(f.params).toEqual([5])
  })
})

describe('and / or', () => {
  it('zero operands is null, so a caller can tell no WHERE from an empty one', () => {
    expect(and()).toBeNull()
    expect(or()).toBeNull()
    expect(and(null, undefined, frag(''))).toBeNull()
  })

  it('one operand is that fragment, unwrapped and unparenthesized', () => {
    const only = frag('"a" = ?', 1)
    expect(and(null, only, undefined)).toBe(only)
    expect(or(only)).toBe(only)
  })

  it('two or more operands are each parenthesized', () => {
    const f = and(frag('"a" = ?', 1), frag('"b" = ? OR "c" = ?', 2, 3))
    expect(f?.sql).toBe('("a" = ?) AND ("b" = ? OR "c" = ?)')
    expect(f?.params).toEqual([1, 2, 3])
    const g = or(frag('x = ?', 'x'), frag('y = ?', 'y'), frag('z = ?', 'z'))
    expect(g?.sql).toBe('(x = ?) OR (y = ?) OR (z = ?)')
    expect(g?.params).toEqual(['x', 'y', 'z'])
  })

  it('keeps bind order through nesting', () => {
    const where  = frag('"name" = ?', 'ann')
    const policy = or(frag('"ownerId" = ?', 7), frag('"public" = ?', 1))
    const seal   = frag('"state" NOT IN (?, ?)', 'sealed', 'void')
    const f = and(where, null, policy, seal)
    expect(f?.sql).toBe('("name" = ?) AND (("ownerId" = ?) OR ("public" = ?)) AND ("state" NOT IN (?, ?))')
    expect(f?.params).toEqual(['ann', 7, 1, 'sealed', 'void'])
  })

  it('a nested and() with no live operand vanishes from the outer one', () => {
    const f = and(frag('"a" = ?', 1), and(null, frag('')), frag('"b" = ?', 2))
    expect(f?.sql).toBe('("a" = ?) AND ("b" = ?)')
    expect(f?.params).toEqual([1, 2])
  })
})

describe('sql`…` splices a fragment', () => {
  it('a nested and() keeps its binds in place among the template values', () => {
    const inner = and(frag('"a" = ?', 'A'), frag('"b" = ?', 'B'))
    const raw = sql`"x" = ${1} AND ${inner} AND "y" = ${2}`
    expect(raw.sql).toBe('"x" = ? AND ("a" = ?) AND ("b" = ?) AND "y" = ?')
    expect(raw.params).toEqual([1, 'A', 'B', 2])
  })

  it('an ident is spliced as text and binds nothing', () => {
    const raw = sql`${ident('price')} > ${10}`
    expect(raw.sql).toBe('"price" > ?')
    expect(raw.params).toEqual([10])
  })
})
