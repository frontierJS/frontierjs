// test/dev-run.test.js — `fli dev`'s surfaces, run as real children.
//
// Compact output HOLDS a server's lines until every surface has reported, so
// the failure to fear is a held line that never prints: an error a crashed
// surface wrote before it could say it was up. Each case asserts what reached
// the terminal, in order, from processes that really ran.

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { formatDevLine } from '@frontierjs/toolbelt/devline'
import { runSurfaces } from '../core/dev-run.js'
import { plain } from '../core/text.js'

const roots = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

/** An app root whose scripts are the given bodies, each a file run with bun. */
function app(scripts) {
  const root = mkdtempSync(resolve(tmpdir(), 'fli-dev-run-'))
  roots.push(root)
  const pkg = { name: 'probe', scripts: {} }
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(resolve(root, `${name}.js`), body)
    pkg.scripts[name] = `bun ${name}.js`
  }
  writeFileSync(resolve(root, 'package.json'), JSON.stringify(pkg))
  return root
}

const say = (line) => `console.log(${JSON.stringify(line)});`

async function run(root, surfaces, opts = {}) {
  const out = []
  let handle = null, summaryAt = null
  // What a footer asking `summarized` would see at each line written.
  const seen = []
  handle = runSurfaces({
    root, runner: process.execPath,
    rows: surfaces.map(s => ({ surface: s, script: s })),
    env: process.env, onExit: () => {},
    echo: (l) => { out.push(plain(l)); seen.push(handle?.summarized ?? false) },
    onSummary: () => { summaryAt ??= { lines: out.length, summarized: handle.summarized } },
    columns: 0, ...opts,
  })
  const code = await handle.done
  return { out, code, seen, summaryAt }
}

describe('compact', () => {
  test('one summary from the ready lines, and every held line after it', async () => {
    const root = app({
      api: say('booting the api') + say(formatDevLine({ ready: { url: 'http://localhost:1/api', rows: [{ name: 'Junction', facts: ['3 routes'] }, { name: 'Litestone', facts: ['2 models'] }] } })) + 'setTimeout(() => {' + say('GET /api/x') + '}, 300)',
      web: say(formatDevLine({ warn: { file: 'src/a.mesa', text: 'read is static' } })) + say(formatDevLine({ ready: { url: 'http://localhost:2/', rows: [{ name: 'Sierra', facts: [] }] } })),
    })
    const { out } = await run(root, ['api', 'web'], { title: 'probe' })
    const text = out.join('\n')
    expect(text).not.toContain('::fli')
    const summary = out.findIndex(l => l.includes('http://localhost:1/api'))
    expect(out[summary]).toContain('Junction · 3 routes')
    expect(out[summary + 1].trim()).toBe('Litestone · 2 models')
    expect(out.some(l => l.includes('http://localhost:2/') && l.includes('Sierra'))).toBe(true)
    // Held until the summary, then printed — not lost.
    expect(out.findIndex(l => l.includes('booting the api'))).toBeGreaterThan(summary)
    expect(out.findIndex(l => l.includes('src/a.mesa'))).toBeGreaterThan(summary)
    expect(out.findIndex(l => l.includes('GET /api/x'))).toBeGreaterThan(summary)
    const head = out.findIndex(l => l.includes('probe'))
    expect(head).toBeLessThan(summary)
    expect(out[head]).toMatch(/^  READY  probe  in \d+\.\ds$/)
  })

  // The key footer waits on `summarized`; drawn mid-summary it splits the rows.
  test('summarized is false for every summary line and true when onSummary runs', async () => {
    const root = app({
      api: say(formatDevLine({ ready: { url: 'http://localhost:1/api', rows: [{ name: 'Junction', facts: [] }] } })),
      web: say(formatDevLine({ ready: { url: 'http://localhost:2/', rows: [{ name: 'Sierra', facts: [] }] } })),
    })
    const { out, seen, summaryAt } = await run(root, ['api', 'web'], { title: 'probe' })
    const last = out.findIndex(l => l.includes('http://localhost:2/'))
    expect(summaryAt.summarized).toBe(true)
    expect(summaryAt.lines).toBeGreaterThan(last)
    expect(seen.slice(0, last + 1).every(s => s === false)).toBe(true)
  })

  test('a surface that exits before reporting lets everything it said through', async () => {
    const root = app({
      api: say('Cannot find module x') + 'process.exit(1)',
      web: 'setTimeout(() => {}, 200);' + say(formatDevLine({ ready: { url: 'http://localhost:2/', rows: [{ name: 'Sierra' }] } })),
    })
    const { out, code } = await run(root, ['api', 'web'])
    expect(code).toBe(1)
    expect(out.some(l => l.includes('no ready line'))).toBe(true)
    expect(out.some(l => l.includes('Cannot find module x'))).toBe(true)
    expect(out.some(l => l.includes('exited with code 1'))).toBe(true)
    // A surface that never reported is not ready, so nothing says it is.
    expect(out.some(l => l.includes('READY'))).toBe(false)
  })

  test('a surface that never reports is summarized after settleMs', async () => {
    const root = app({ web: say('a server with no devline') + 'setTimeout(() => {}, 600)' })
    const { out } = await run(root, ['web'], { settleMs: 100 })
    const summary = out.findIndex(l => l.includes('no ready line'))
    expect(summary).toBeGreaterThan(-1)
    expect(out.findIndex(l => l.includes('a server with no devline'))).toBeGreaterThan(summary)
  })

  test('the children are told, and a verbose run is not', async () => {
    const root = app({ web: 'console.log("FLI_DEV=" + (process.env.FLI_DEV ?? "unset"))' })
    expect((await run(root, ['web'], { settleMs: 50 })).out.join('\n')).toContain('FLI_DEV=1')
    const verbose = await run(root, ['web'], { compact: false, env: { ...process.env, FLI_DEV: '1' } })
    expect(verbose.out.join('\n')).toContain('FLI_DEV=unset')
    expect(verbose.out.some(l => l.includes('no ready line'))).toBe(false)
  })
})
