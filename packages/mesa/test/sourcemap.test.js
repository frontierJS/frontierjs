/**
 * Source maps for a compiled `.mesa` module (`FJS-874`).
 *
 * The end-to-end row is the one that matters and it uses NODE'S OWN consumer,
 * not a decoder written here: a decoder of mine would agree with my encoder
 * about a map no real tool can read. `node --enable-source-maps` rewrites the
 * stack, and the assertion is on the file and line it prints.
 *
 * The map is an ALIGNMENT against the finished text rather than a record of
 * what was emitted, because four passes rewrite the module after `xBuild` and
 * one of them hoists — see `src/sourcemap.js`. So a line that was rewritten
 * gets no mapping, and the tests say which lines are expected to survive.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import { buildSourceMap, encodeVLQ } from '../src/sourcemap.js'

const RT = path.join(process.cwd(), 'src/runtime.js')

describe('base64 VLQ', () => {
  // The spec's own examples, so the encoder is graded against the format and
  // not against itself.
  it.each([[0, 'A'], [1, 'C'], [-1, 'D'], [16, 'gB'], [123, '2H'], [-123, '3H']])(
    '%i encodes to %s', (n, want) => { expect(encodeVLQ(n)).toBe(want) })
})

describe('what gets a mapping', () => {
  const map = (src, gen) => buildSourceMap(src, gen, '/T.mesa')

  it('a line that survived compilation unchanged', () => {
    const m = map(`  throw new Error('boom')\n`, `x\n  throw new Error('boom')\ny\n`)
    expect(m).not.toBeNull()
    expect(m.mappings.split(';').length).toBeGreaterThan(1)
    expect(m.sourcesContent[0]).toContain('boom')
  })

  it('nothing, when the line appears twice in the source', () => {
    const line = `  callTheThing(value)\n`
    expect(map(line + line, `a\n${line}b\n`)).toBeNull()
  })

  it('nothing, when the line appears twice in the output', () => {
    const line = `  callTheThing(value)`
    expect(map(line, `${line}\n${line}\n`)).toBeNull()
  })

  it('nothing for punctuation and short lines', () => {
    expect(map('  }\n  })\n', '  }\n  })\n')).toBeNull()
  })

  it('nothing for a comment', () => {
    expect(map('  // an explanatory remark\n', 'x\n  // an explanatory remark\n')).toBeNull()
  })

  it('one mapping per generated line, in ascending order', () => {
    // The failure this guards is a consumer reporting "a negative line, column,
    // source index, or name index" — what an unordered or duplicated segment
    // list produces, and what Svelte carries open reports of.
    const src = ['const alpha = compute(1)', 'const bravo = compute(2)', 'const delta = compute(3)'].join('\n')
    const gen = ['header();', src.split('\n')[2], 'middle();', src.split('\n')[0]].join('\n')
    const m = map(src, gen)
    const lines = m.mappings.split(';')
    let seen = 0
    for (const l of lines) { if (l) seen++ }
    expect(seen).toBeGreaterThan(0)
    expect(lines.length).toBeLessThanOrEqual(gen.split('\n').length)
  })
})

describe('a declaration that was REWRITTEN still maps', () => {
  // The half whole-line matching cannot reach: `let count = 0` becomes a
  // `track()` call and shares no text with its source. A declaration carries a
  // NAME into the generated binding, so the two are matched on that instead —
  // which maps the declaration to where the declaration went, and is what a
  // breakpoint on that line should stop at.
  const compiled = async (src) => {
    const ctx = await compileSource(src, { filename: '/T.mesa', dev: false })
    return { gen: ctx.result, map: buildSourceMap(src, ctx.result, '/T.mesa') }
  }

  it('a let becomes a signal and keeps its mapping', async () => {
    const { map } = await compiled(
      `<script>\n  let counter = 0\n</script>\n<p>{counter}</p>`)
    expect(map).not.toBeNull()
    expect(map.mappings.split(';').filter(Boolean).length).toBeGreaterThan(0)
  })

  it('an ambiguous name maps to nothing rather than to a guess', () => {
    // Neither tier can separate these: the source lines are identical, so
    // whole-line matching refuses them, and the name is declared twice, so the
    // declaration tier refuses them too. The wrong answer here is a mapping.
    const src = 'let thing = 0\nlet thing = 0'
    const gen = 'const $$sig_thing = $$runtime.track(0)\nconst $$sig_thing = $$runtime.track(0)'
    expect(buildSourceMap(src, gen, '/T.mesa')).toBeNull()
  })

  it('a name with two generated declaration sites maps to neither', () => {
    const src = 'let thing = 0'
    const gen = 'const $$sig_thing = $$runtime.track(0)\nconst $$sig_thing = $$runtime.track(1)'
    expect(buildSourceMap(src, gen, '/T.mesa')).toBeNull()
  })

  it('an import survives the semicolon the emitter adds', async () => {
    const { map, gen } = await compiled(
      `<script>\n  import { helper } from './util.js'\n  const v = helper()\n</script>\n<p>{v}</p>`)
    expect(gen).toContain(`import { helper } from './util.js';`)
    expect(map).not.toBeNull()
  })
})

describe('a real stack trace resolves to the .mesa', () => {
  const RT_LIT = JSON.stringify(RT)

  /** Compile, mount and throw in a child process with Node's own source maps on. */
  const stackOf = (lines) => {
    const DIR = path.join(process.cwd(), '_sm_' + Math.random().toString(36).slice(2, 8))
    mkdirSync(DIR, { recursive: true })
    try {
      const file = path.join(DIR, 'Widget.mesa')
      writeFileSync(file, lines.join('\n'))
      const out = path.join(DIR, 'W.mjs')
      writeFileSync(path.join(DIR, 'run.mjs'), `
import { compileSource, readSourceMarks, stripSourceMarks } from ${JSON.stringify(path.join(process.cwd(), 'src/compiler.js'))}
import { buildSourceMap } from ${JSON.stringify(path.join(process.cwd(), 'src/sourcemap.js'))}
import { writeFileSync, readFileSync } from 'fs'
import { Window } from ${JSON.stringify(path.join(process.cwd(), 'node_modules/happy-dom/lib/index.js'))}
const w = new Window()
global.document = w.document; global.window = w
for (const k of ['ShadowRoot','HTMLElement','Element','Node','Event','CustomEvent','MutationObserver','DocumentFragment','Text','Comment']) global[k] = w[k]
const { mount, flushSync } = await import(${RT_LIT})
const file = ${JSON.stringify(file)}
const src = readFileSync(file, 'utf8')
const ctx = await compileSource(src, { filename: file, dev: false, sourceMarks: true })
let js = ctx.result.replace(/'@frontierjs\\/mesa\\/runtime\\.js'/g, ${JSON.stringify(`'${RT}'`)})
const marks = readSourceMarks(js)
js = stripSourceMarks(js)
const map = buildSourceMap(src, js, file, marks)
if (!map) { console.log('NO_MAP'); process.exit(0) }
const b64 = Buffer.from(JSON.stringify(map)).toString('base64')
writeFileSync(${JSON.stringify(out)}, js + '\\n//# sourceMappingURL=data:application/json;base64,' + b64 + '\\n')
const C = (await import('file://' + ${JSON.stringify(out)})).default
const wrap = document.createElement('div'); document.body.appendChild(wrap)
const l = document.createElement('span'); wrap.appendChild(l)
try { mount(l, C, { props: {} }); flushSync(); console.log('NO_THROW') }
catch (e) { console.log(e.stack) }
`)
      return execFileSync(process.execPath, ['--enable-source-maps', path.join(DIR, 'run.mjs')], {
        encoding: 'utf8', cwd: DIR,
      })
    } finally { rmSync(DIR, { recursive: true, force: true }) }
  }

  it('names the file and the line a surviving throw is on', () => {
    const out = stackOf([
      '<script>',                               // 1
      '  function explode(reason) {',           // 2
      `    throw new Error('boom: ' + reason)`, // 3
      '  }',                                    // 4
      '',                                       // 5
      '  function trigger() {',                 // 6
      `    explode('from the body')`,           // 7
      '  }',                                    // 8
      '</script>',                              // 9
      '<button>{trigger()}</button>',           // 10
    ])
    expect(out).not.toContain('NO_MAP')
    expect(out).not.toContain('NO_THROW')
    expect(out).toContain('Widget.mesa:3:')
    expect(out).toContain('Widget.mesa:7:')
    // Without a map these name the generated module, so a test that only
    // asserted "a stack was printed" would pass against `map: null`.
    expect(out).not.toMatch(/at explode \([^)]*W\.mjs/)
  }, 30000)

  it('names the source line of a TEMPLATE EXPRESSION', () => {
    // Nothing can align this one: `_renderGroup` folds the bind into a shared
    // `render()` block, so the expression's line is gone and its text has been
    // rewritten into a `get()` call. Only a marker the compiler carried
    // through the passes can put it back.
    const out = stackOf([
      '<script>',                            // 1
      '  let seed = 1',                      // 2
      '  function explode(n) {',             // 3
      `    throw new Error('tpl: ' + n)`,    // 4
      '  }',                                 // 5
      '</script>',                           // 6
      '<p>ok</p>',                           // 7
      '<b>{explode(seed)}</b>',              // 8
    ])
    expect(out).not.toContain('NO_MAP')
    expect(out).not.toContain('NO_THROW')
    expect(out).toContain('Widget.mesa:4:')   // the throw itself
    expect(out).toContain('Widget.mesa:8:')   // the interpolation that called it
  }, 30000)

  it('names the source line of a declaration that was REWRITTEN', () => {
    // The frame lands on the generated `trackDerived` call, which shares no
    // text with `const answer = explode()`. Only the declaration tier can put
    // it back, so this row is the one that fails if that tier is removed.
    // The `const` must depend on something REACTIVE or it is emitted verbatim
    // and tier 1 maps it — which is how the first version of this row passed
    // with the declaration tier removed.
    const out = stackOf([
      '<script>',                               // 1
      '  let seed = 1',                         // 2
      '  function explode(n) {',                // 3
      `    throw new Error('derived: ' + n)`,   // 4
      '  }',                                    // 5
      '',                                       // 6
      '  const answer = explode(seed)',         // 7
      '</script>',                              // 8
      '<p>{answer}</p>',                        // 9
    ])
    expect(out).not.toContain('NO_MAP')
    expect(out).not.toContain('NO_THROW')
    expect(out).toContain('Widget.mesa:4:')   // the throw, which survives verbatim
    expect(out).toContain('Widget.mesa:7:')   // the rewritten declaration
    expect(out).not.toMatch(/W\.mjs:\d+/)
  }, 30000)
})
