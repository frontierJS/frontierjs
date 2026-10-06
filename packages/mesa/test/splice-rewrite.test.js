/**
 * splice-rewrite.test.js
 *
 * The compiler's two rewrites of author JavaScript — the keyed-each key
 * expression and the `$.context` door — splice new text over acorn's node
 * offsets rather than re-printing the tree (FJS-1760). A reprint reflowed the
 * author's spacing and comments, and needed a printer dependency to do it.
 *
 * Run: npx vitest run splice-rewrite.test.js
 */

import { describe, it, expect } from 'vitest'
import { compile, replaceKeyword, spliceEdits, unspliceOffset } from '../src/compiler.js'

const link = { a: '$$item', i: '$index' }
const rk = (exp) => replaceKeyword(exp, (n) => link[n] ?? n)

describe('replaceKeyword splices names in place', () => {
  it('keeps the author spacing and comments', () => {
    expect(rk('a .id  + i')).toBe('$$item .id  + $index')
    expect(rk('a /* c */ .id')).toBe('$$item /* c */ .id')
    expect(rk('f(a, (a) => a)')).toBe('f($$item, (a) => $$item)')
  })

  it('returns the same string when nothing is renamed', () => {
    const exp = 'x.y + 1'
    expect(rk(exp)).toBe(exp)
  })

  // The reprint skipped every `property`, so `a[i]` kept a free `i` and the
  // key function threw ReferenceError at the first render.
  it('renames a computed member but not a dotted one', () => {
    expect(rk('a[i]')).toBe('$$item[$index]')
    expect(rk('a.i')).toBe('$$item.i')
  })

  it('expands a shorthand property and leaves a literal key alone', () => {
    expect(rk('{a}')).toBe('{a: $$item}')
    expect(rk('{a, i: a.x}')).toBe('{a: $$item, i: $$item.x}')
  })
})

describe('spliceEdits / unspliceOffset', () => {
  const src = 'const t = $.context.k\nconst u = $.mounted'
  const edits = [
    { start: 10, end: 19, text: '$context' },
    { start: 32, end: 41, text: '$mounted' }
  ]
  it('applies edits last-first so earlier offsets stay valid', () => {
    expect(spliceEdits(src, edits)).toBe('const t = $context.k\nconst u = $mounted')
    expect(spliceEdits(src, [])).toBe(src)
  })

  it('maps an offset in the result back onto the original', () => {
    const out = spliceEdits(src, edits)
    expect(unspliceOffset(out.indexOf('.k'), edits)).toBe(src.indexOf('.k'))
    expect(unspliceOffset(out.indexOf('const u'), edits)).toBe(src.indexOf('const u'))
    expect(unspliceOffset(out.indexOf('$context') + 3, edits)).toBe(10)
    expect(unspliceOffset(out.length, edits)).toBe(src.length)
  })
})

describe('the $.x door rewrite keeps the script as written', () => {
  it('leaves comments and spacing around the rewrite', async () => {
    const script = `let open = {}   // wide\n$.context.toggle = (id) => {\n  open = { ...open, [id]: true }\n}`
    const ctx = await compile(`<script>${script}</script><b>x</b>`, { filename: 'T.mesa', warning: () => {} })
    expect(ctx.script.source).toBe(script.replace('$.context', '$context'))
  })

  // The reprint discarded offsets, so a script using the door reported an
  // analysis error with no line at all.
  it('names the author line of an analysis error after the rewrite', async () => {
    const ctx = await compile(
      `<script>\nlet a = 1\n$.context.k = a\n$: a, foo()\n</script><p>x</p>`,
      { filename: 'T.mesa', warning: () => {} }
    )
    expect(ctx.analysis.errors.join('\n')).toMatch(/'foo\(\)' is the last element.* — T\.mesa:4:7$/m)
  })
})
