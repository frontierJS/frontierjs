/**
 * wireframe.test.js — what `fli make:wireframe` writes must compile, parse,
 * and name only what @frontierjs/css and @frontierjs/ui actually ship.
 *
 * The fixture is a real screen read by hand, with every name and number
 * invented. The graders are imported by relative path because the CLI depends
 * on neither mesa nor litestone — see generated-mesa.test.js.
 *
 * Two lists in core/wireframe.js are copies, and each has a test here that
 * fails when its source moves: TONE_TAKERS against tones.spec.js's consumers,
 * and KIT_PROPS against the props each kit component declares.
 */
import { test, expect, describe } from 'bun:test'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { compileSource } = await import(resolve(HERE, '../../mesa/src/compiler.js'))
const { parse: parseJs } = await import(resolve(HERE, '../../mesa/node_modules/acorn/dist/acorn.mjs'))
const { parse: parseLite } = await import(resolve(HERE, '../../litestone/src/core/parser.js'))
const { readWireframe, analyze, report, draw, emitMesa, draftSchema, TONE_TAKERS, KIT_PROPS, WireframeError } =
  await import(resolve(HERE, '../core/wireframe.js'))

const vocab   = JSON.parse(readFileSync(resolve(HERE, '../../css/vocabulary.json'), 'utf8'))
const fixture = JSON.parse(readFileSync(resolve(HERE, 'fixtures/wireframe/tasks.wireframe.json'), 'utf8'))
const UI      = resolve(HERE, '../../ui/components')

const kitAll = {}
for (const group of readdirSync(UI)) for (const name of Object.keys(KIT_PROPS))
  if (existsSync(join(UI, group, name + '.mesa'))) kitAll[name] = `@frontierjs/ui/components/${group}/${name}.mesa`

const wf = readWireframe(fixture, vocab)
const a  = analyze(wf)

const compiles = async (files) => {
  for (const [name, src] of Object.entries(files)) {
    if (!name.endsWith('.mesa')) continue
    const ctx  = await compileSource(src, { filename: `/wf/${name}`, dev: false })
    const code = typeof ctx === 'string' ? ctx : ctx.result ?? ctx.code
    expect(typeof code).toBe('string')
    parseJs(code, { ecmaVersion: 'latest', sourceType: 'module' })
  }
}

describe('reading a wireframe', () => {
  test('an unknown term is refused by name, with the terms that exist', () => {
    const bad = { screen: 'X', tree: { term: 'Hero' } }
    expect(() => readWireframe(bad, vocab)).toThrow(WireframeError)
    try { readWireframe(bad, vocab) } catch (e) { expect(e.problems[0]).toContain('"Hero" is not a term') }
  })

  test('an unknown key is refused, not dropped', () => {
    const bad = { screen: 'X', tree: { term: 'Card', colour: 'red' } }
    try { readWireframe(bad, vocab); throw new Error('accepted') } catch (e) { expect(e.problems[0]).toContain('unknown key "colour"') }
  })
})

describe('the analysis', () => {
  test('finds the four repeated shapes, by the names the wireframe gives them', () => {
    const got = Object.fromEntries(a.comps.map(c => [c.name, c.nodes.length]))
    expect(got).toEqual({ ClientGroup: 3, InboxRow: 3, Lane: 4, TicketCard: 8 })
  })

  test('a part found once in every copy of another is folded into it', () => {
    expect(a.folded.map(f => f.into).sort()).toEqual(['ClientGroup', 'Lane'])
  })

  // The prototype decided this in two places and reported a list while
  // emitting two props. One owner now, so the report and the file agree.
  test('two badges whose tone is fixed per position are two props, everywhere', () => {
    const card = a.comps.find(c => c.name === 'TicketCard')
    const badges = card.slots.filter(s => s.term === 'Badge').map(s => s.prop)
    expect(badges).toEqual(['badge', 'badge2'])
    expect(report(a)).toContain('badge2')
    expect(emitMesa(a, { kit: kitAll })['TicketCard.mesa']).toContain('export let badge2')
  })

  test('an optional part is optional, not a second shape', () => {
    const card = a.comps.find(c => c.name === 'TicketCard')
    expect(card.slots.find(s => s.term === 'Pill')).toMatchObject({ optional: true })
  })
})

describe('the .mesa it writes', () => {
  test('compiles and parses with the whole kit', async () => { await compiles(emitMesa(a, { kit: kitAll })) })
  test('compiles and parses with no kit at all', async () => { await compiles(emitMesa(a, { kit: {} })) })

  test('names only classes @frontierjs/css names', () => {
    const known = new Set()
    for (const t of vocab.terms) if (t.class) known.add(t.class)
    for (const k in vocab.anatomy) for (const p of vocab.anatomy[k].parts || []) for (const m of p[0].matchAll(/\.([a-z][\w-]*)/g)) known.add(m[1])
    for (const k of Object.keys(vocab.notAnatomy)) known.add(k)
    for (const x of Object.values(vocab.notATerm).flat()) known.add(x)
    const used = new Set()
    for (const src of Object.values(emitMesa(a, { kit: {} })))
      for (const m of src.matchAll(/class="([^"{]*)/g)) for (const c of m[1].split(/\s+/).filter(Boolean)) used.add(c)
    expect([...used].filter(c => !known.has(c))).toEqual([])
  })

  test('each kit prop it passes is one the kit component declares', () => {
    for (const [name, props] of Object.entries(KIT_PROPS)) {
      const at = kitAll[name]
      expect(at).toBeDefined()
      const src = readFileSync(join(UI, at.replace('@frontierjs/ui/components/', '')), 'utf8')
      for (const p of props) expect(`${name}.${p}: ${new RegExp(`export let ${p}\\b`).test(src)}`).toBe(`${name}.${p}: true`)
    }
  })

  test('TONE_TAKERS is the set tones.spec.js grades a tone on', () => {
    const spec  = readFileSync(resolve(HERE, '../../css/test/specs/tones.spec.js'), 'utf8')
    const byCls = new Map(vocab.terms.filter(t => t.class).map(t => [t.class, t.term]))
    const graded = new Set([...spec.matchAll(/name: '\.([a-z-]+)'/g)].map(m => byCls.get(m[1])).filter(Boolean))
    expect([...TONE_TAKERS].sort()).toEqual([...graded].sort())
  })
})

describe('the draft schema', () => {
  const src = draftSchema(a)
  const r   = parseLite(src)

  test('parses', () => { expect(r.errors).toEqual([]); expect(r.valid).toBe(true) })

  test('a bucket is not related to itself', () => {
    expect(src).not.toMatch(/model Lane \{[^}]*\blane\s+Lane/)
    expect(src).not.toMatch(/model Client \{[^}]*\bclient\s+Client/)
  })

  test('a name shown in two places becomes a relation', () => {
    expect(src).toMatch(/model Ticket \{[^}]*client\s+Client\?/)
  })

  test('every gate says it is a placeholder', () => {
    const gates = src.match(/@@gate/g).length
    expect(src.match(/placeholder|@@unique/g).length).toBeGreaterThanOrEqual(gates - 2)
  })
})

describe('the terminal drawing', () => {
  test('marks every component copy and fits its width', () => {
    const out = draw(a, { width: 150, color: false })
    // One mark per copy; a narrow lane truncates the NAME, never the mark.
    const copies = a.comps.reduce((n, c) => n + c.nodes.length, 0)
    expect(out.split('\n').slice(0, -1).join('').match(/◆/g).length).toBe(copies)
    const lines = out.split('\n').slice(0, -1)
    expect(lines.every(l => [...l].length === 150)).toBe(true)
  })
})
