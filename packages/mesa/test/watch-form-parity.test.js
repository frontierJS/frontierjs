/**
 * Every `$:` form that NAMES a path makes that path's root reactive — for the
 * emitter and for the analyzer alike, because they are one derivation.
 *
 * They were two. The emitter merged all three dep lists (`FJS-599`); the
 * analyzer's `reactiveSet` seed went on reading `watchPaths` alone, so
 * `$: page.query, page.directives, () => load()` subscribed at runtime and left
 * `const urlQuery = { ...page.query, ... }` compiled as a plain const
 * (`FJS-1065`). The cost was a component that is half live: the list re-asked
 * the server on every navigation and the filter bar above it kept rendering the
 * query the page had arrived with.
 *
 * The claim is asserted as a PROPERTY over the whole matrix rather than as four
 * expectations — a const reading an import is a derivation exactly when the
 * module declares that import's proxy — so a form added to the language fails
 * here if it wires only one of the two halves.
 *
 * Two controls carry it. `$: { load() }` names nothing and must promote
 * nothing, or the property is satisfied by promoting everything. And a form
 * naming a DIFFERENT import must leave `page` alone, which is the row that
 * separates *the named root became reactive* from *every import did*.
 */

import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'

const SCRIPT = (line) => `<script>
  import { page } from './page.js'
  import { other } from './other.js'
  function load() {}
  const urlQuery = { ...page.query, ...page.directives }
${line}
</script><p>{urlQuery.x}</p>`

const emit = async (line) => String((await compile(SCRIPT(line), { debug: false, css: false })).result)

/** The two halves, read off the emitted module. */
const halves = (js) => ({
  derived: /const urlQuery = \$\$runtime\.trackDerived/.test(js),
  proxied: /const \$\$proxy_page = \$\$runtime\.watchProxy\(page\)/.test(js),
})

// Forms that NAME a path on `page`. Each must reach both halves.
const NAMING = {
  'a bare path':           '  $: page.query',
  'parenthesized paths':   '  $: (page.query, page.directives)',
  'a handler':             '  $: page.query, page.directives, () => load()',
  'an ordered group':      '  $: { page.query, page.directives, () => load() }',
  'a group of two entries': '  $: { page.query, () => load()\n     page.directives, () => load() }',
}

// Forms that name nothing on `page`. Each must reach neither.
const NOT_NAMING = {
  'no $: at all':            '',
  'a bare call in a block':  '  $: { load() }',
  'a path on another import': '  $: other.x, () => load()',
}

describe('every $: form that names a path makes its root reactive', () => {
  for (const [name, line] of Object.entries(NAMING)) {
    it(`${name} promotes the const that reads it`, async () => {
      expect(halves(await emit(line))).toEqual({ derived: true, proxied: true })
    })
  }
})

describe('a form that names nothing makes nothing reactive', () => {
  for (const [name, line] of Object.entries(NOT_NAMING)) {
    it(`${name} leaves the const a plain value`, async () => {
      expect(halves(await emit(line))).toEqual({ derived: false, proxied: false })
    })
  }
})

describe('the analyzer and the emitter are one derivation', () => {
  it('a const reading an import is derived exactly when that import is proxied', async () => {
    const rows = []
    for (const [name, line] of Object.entries({ ...NAMING, ...NOT_NAMING })) {
      const { derived, proxied } = halves(await emit(line))
      rows.push({ form: name, derived, proxied })
    }
    // Stated as the disagreements rather than as a count, so a failure names the
    // form that wired one half.
    expect(rows.filter((r) => r.derived !== r.proxied)).toEqual([])
  })
})
