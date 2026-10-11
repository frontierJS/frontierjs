// audit-browser-globals.test.ts — no module in the browser graph names a server
// global (audit run 2.3, `FJS-D305`).
//
// `engine-seam.test.ts` § the browser graph walks every module the two browser
// entries reach and refuses an import of a node or bun builtin. A GLOBAL needs
// no import: `process.env`, `Buffer.from`, `setImmediate(fn)` and `Bun.write`
// each pass that walk, pass `undeclared-names.test.ts` (whose `HOST_GLOBALS`
// admits all four, for every file in `src/`), and are a ReferenceError in a
// browser worker at the moment they run — which `test/browser/audit-browser-seams.mjs`
// measured for each of them. A `typeof process` guard is the one spelling that
// is safe, so a line that guards is not an offender; `process?.on` is not a
// guard, because `?.` evaluates its left side first.
//
// Bundling cannot stand in for this: `bun build --target=browser` resolves a
// bare `path` or `node:crypto` to a polyfill without a warning (0.9 MB for the
// two), so a build that succeeds says nothing about what the module reached for.

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(import.meta.dir, '../src')
const ENTRIES = ['browser/client.js', 'browser/worker.js', 'host/browser.js']

const specifiersIn = (source: string): string[] => {
  const out: string[] = []
  for (const m of source.matchAll(/from\s*['"]([^'"]+)['"]/g))       out.push(m[1]!)
  for (const m of source.matchAll(/import\s+['"]([^'"]+)['"]/g))     out.push(m[1]!)
  for (const m of source.matchAll(/import\s*\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]/g)) out.push(m[1]!)
  return out
}

function browserGraph(): string[] {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file) || !file.endsWith('.js')) return
    seen.add(file)
    let source: string
    try { source = readFileSync(file, 'utf8') } catch { seen.delete(file); return }
    for (const spec of specifiersIn(source)) if (spec.startsWith('.')) walk(join(file, '..', spec))
  }
  for (const e of ENTRIES) walk(join(SRC, e))
  return [...seen]
}

// A use is the name followed by `.`, `?.`, `(` or `[`, not preceded by a word
// character, `.` or a quote. A line whose only use is behind `typeof <name>` is
// a guard. A line that is a comment is prose.
const USE = /(^|[^\w.$'"`])(process|Bun|Buffer|setImmediate)(?=\s*(\.|\?\.|\(|\[))/g

export function serverGlobalUses(files: string[] = browserGraph()): string[] {
  const out: string[] = []
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      for (const m of line.matchAll(USE)) {
        const name = m[2]!
        // `typeof process` is a guard; `typeof process?.on` is not, because `?.`
        // evaluates `process` before `typeof` sees anything.
        const guarded = new RegExp(`typeof\\s+(globalThis\\.)?${name}\\b(?!\\s*(\\.|\\?\\.))`).test(line)
        if (guarded) continue
        // A message that TELLS a caller to write `process.env.X` is prose in a
        // string; `${process.pid}` inside a template literal is code.
        const before = line.slice(0, m.index! + m[1]!.length)
        const odd = (ch: string) => (before.split(ch).length - 1) % 2 === 1
        const tail = before.slice(before.lastIndexOf('`') + 1)
        const inTemplateExpr = odd('`') && tail.lastIndexOf('${') > tail.lastIndexOf('}')
        const inString = odd("'") || odd('"') || (odd('`') && !inTemplateExpr)
        if (inString) continue
        out.push(`${relative(SRC, file)}:${i + 1}  ${name}  ${t.slice(0, 90)}`)
      }
    })
  }
  return out
}

describe('the browser graph', () => {
  const graph = browserGraph()

  it('is the graph engine-seam.test.ts walks', () => {
    expect(graph.length).toBeGreaterThan(20)
  })

  // Per-file ceilings, the same ratchet as sql-idents.test.ts: most of these
  // modules are IMPORTED by the browser graph and their server paths are never
  // run there, so the number is the debt, not a verdict on each line. A new use
  // in any file fails; a conversion through #host lowers the number here.
  // encryption.js: FJS-2398.
  const CEILING: Record<string, number> = {
    'core/encryption.js':    15,
    'core/tenancy.js':       1,
  }

  const perFile = (uses: string[]) => {
    const n: Record<string, number> = {}
    for (const u of uses) { const f = u.slice(0, u.indexOf(':')); n[f] = (n[f] ?? 0) + 1 }
    return n
  }

  it('names no server global outside a typeof guard that a ceiling has not admitted', () => {
    const n = perFile(serverGlobalUses(graph))
    const over = Object.entries(n)
      .filter(([f, c]) => c > (CEILING[f] ?? 0))
      .map(([f, c]) => `${f}: ${c} > ${CEILING[f] ?? 0}`)
    expect(over,
      `a server global is a ReferenceError in a browser worker. Reach the facility through #host, ` +
      `or guard it with \`typeof\`; do not raise a ceiling.`,
    ).toEqual([])
  })

  it('a ceiling that has been beaten is lowered, not left', () => {
    const n = perFile(serverGlobalUses(graph))
    const slack = Object.entries(CEILING)
      .filter(([f, c]) => (n[f] ?? 0) < c)
      .map(([f, c]) => `${f}: ${n[f] ?? 0} < ${c}`)
    expect(slack, `lower these in CEILING (delete the entry at 0): ${slack.join(', ')}`).toEqual([])
  })

  it('reads a use it should: a bare Buffer call is an offender, a typeof guard is not', () => {
    const tmp = join(import.meta.dir, '../.tmp-audit-globals.js')
    const { writeFileSync, rmSync } = require('fs')
    try {
      writeFileSync(tmp, 'const a = Buffer.from(x)\nconst b = typeof process !== \'undefined\' && process.env\n')
      const uses = serverGlobalUses([tmp])
      expect(uses.length).toBe(1)
      expect(uses[0]).toContain('Buffer')
    } finally { rmSync(tmp, { force: true }) }
  })
})

// A browser worker has no `setImmediate`. The static walk above says no line
// names it unguarded; this runs the two paths that used to, with it removed.
describe('a runtime without setImmediate', () => {
  it('still delivers an onEvent listener and a $tapEvents tap', async () => {
    const { createClient } = await import('../src/index.js')
    const real = globalThis.setImmediate
    const heard: string[] = []
    const tapped: string[] = []
    try {
      const db: any = await createClient({
        db: ':memory:',
        schema: 'model Note {\n  id   Int    @id\n  body String\n}\n',
        onEvent: { create: () => { heard.push('onEvent') } },
      })
      db.$tapEvents((e: any) => { tapped.push(e.event) })
      ;(globalThis as any).setImmediate = undefined
      await db.note.create({ data: { id: 1, body: 'x' } })
      await new Promise((r) => setTimeout(r, 20))
    } finally { globalThis.setImmediate = real }
    expect(heard).toEqual(['onEvent'])
    expect(tapped).toEqual(['create'])
  })
})
