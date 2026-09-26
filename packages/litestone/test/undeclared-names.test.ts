// undeclared-names.test.ts — every name Litestone's JavaScript reads is declared.
//
// checkJs is off in this package (tsconfig.json says why), and nothing else
// reads a .js file for a name that resolves to nothing. Such a name is a
// ReferenceError on the one path that reaches it, which may be a path the
// suite never takes — and it is exactly what moving a function out of
// `makeTable` or `createClient` produces when the function read something the
// closure held.
//
// So TypeScript is a resolver here and nothing more: every file is parsed with
// `noResolve`, where an import declares its names whatever it points at, and
// the only diagnostics read are *cannot find name*. One inside a JSDoc comment
// is not code — `Json @type(Address)` in prose reads as a JSDoc tag — so only
// a diagnostic that lands on an identifier in the tree counts.

import { describe, it, expect } from 'bun:test'
import { readdirSync, statSync } from 'fs'
import { join, relative }        from 'path'
import ts                        from 'typescript'

const SRC = join(import.meta.dir, '../src')

// What the runtime provides, named one by one rather than pulled in as
// lib.dom: that library declares `name`, `origin`, `status` and `event`, and a
// variable of any of those spellings left behind by a move would resolve to
// the window's and pass.
const HOST_GLOBALS = new Set([
  'console', 'URL', 'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'crypto', 'CryptoKey',
  'fetch', 'Response', 'ReadableStream', 'Blob', 'File', 'Worker', 'performance',
  'setTimeout', 'setInterval', 'clearInterval', 'addEventListener',
  // a server's
  'process', 'Buffer', 'setImmediate', 'Bun',
])

// Derived from TypeScript's own table, so a variant it adds later — the Bun
// and test-runner spellings arrived that way — is read without an edit here.
const CANNOT_FIND = new Set(
  Object.values((ts as any).Diagnostics as Record<string, { code: number, message: string }>)
    .filter(d => /^Cannot find name '\{0\}'|^No value exists in scope for the shorthand property/.test(d.message))
    .map(d => d.code),
)

function jsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) jsFiles(p, out)
    else if (/\.m?js$/.test(name)) out.push(p)
  }
  return out
}

function identifierStarts(sf: ts.SourceFile): Set<number> {
  const at = new Set<number>()
  const walk = (node: ts.Node) => {
    if (ts.isIdentifier(node)) at.add(node.getStart(sf))
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return at
}

describe('every name in src/ resolves', () => {
  it('to a declaration, an import or a named host global', () => {
    const files   = jsFiles(SRC)
    const program = ts.createProgram(files, {
      allowJs: true, checkJs: true, noEmit: true, noResolve: true,
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, lib: ['lib.esnext.d.ts'],
    })

    const unresolved: string[] = []
    for (const file of files) {
      const sf   = program.getSourceFile(file)!
      const code = identifierStarts(sf)
      for (const d of program.getSemanticDiagnostics(sf)) {
        if (!CANNOT_FIND.has(d.code) || d.start == null || !code.has(d.start)) continue
        const name = sf.text.slice(d.start, d.start + (d.length ?? 0))
        if (HOST_GLOBALS.has(name)) continue
        const { line } = sf.getLineAndCharacterOfPosition(d.start)
        unresolved.push(`${relative(SRC, file)}:${line + 1}  ${name}`)
      }
    }

    expect(files.length).toBeGreaterThan(50)
    expect(unresolved).toEqual([])
  }, 60_000)
})
