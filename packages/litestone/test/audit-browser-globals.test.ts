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

import { describe, it, expect, test } from 'bun:test'
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

  // AUDIT-2.3-7: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('names no server global outside a typeof guard', () => {
    const uses = serverGlobalUses(graph)
    if (uses.length) console.warn(`[audit-browser-globals] ${uses.length} use(s) of a server global in the browser graph:\n  ${uses.join('\n  ')}`)
    expect(uses).toEqual([])
  })
})
