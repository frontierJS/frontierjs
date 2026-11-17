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
// each identifier in a reference position is looked up through the scope chain
// the binder built. Asking for semantic diagnostics instead gave the same
// answer by type-checking every file, five times the work, and that work timed
// the test out when other suites shared the machine (FJS-4414). Only the tree is
// walked, so a name inside a JSDoc comment is never read as code.

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
  'fetch', 'Response', 'ReadableStream', 'TransformStream', 'Blob', 'File', 'Worker', 'performance',
  'setTimeout', 'setInterval', 'clearInterval', 'addEventListener',
  // a server's
  'process', 'Buffer', 'setImmediate', 'Bun',
])

const OPTIONS: ts.CompilerOptions = {
  allowJs: true, noEmit: true, noResolve: true,
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, lib: ['lib.esnext.d.ts'],
}

// `isExpressionNode` and `checker.resolveName` are TypeScript internals; the
// fixture below fails the suite if an upgrade drops or narrows either.
const isExpressionNode = (ts as any).isExpressionNode as (node: ts.Node) => boolean
const VALUE = ts.SymbolFlags.Value | ts.SymbolFlags.Alias

function jsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) jsFiles(p, out)
    else if (/\.m?js$/.test(name)) out.push(p)
  }
  return out
}

// The positions where an identifier reads a binding: an expression, a
// shorthand property, a local export, `export default`. A property name after
// a dot and the `target` of `new.target` are expression nodes that read none.
function isReference(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isShorthandPropertyAssignment(p)) return p.name === id
  if (ts.isExportSpecifier(p)) return !p.parent.parent.moduleSpecifier && (p.propertyName ?? p.name) === id
  if (ts.isExportAssignment(p)) return p.expression === id
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if (ts.isMetaProperty(p)) return false
  return isExpressionNode(id)
}

function unresolvedNames(program: ts.Program, files: string[]): string[] {
  const checker = program.getTypeChecker() as ts.TypeChecker & {
    resolveName(name: string, location: ts.Node, meaning: ts.SymbolFlags, excludeGlobals: boolean): ts.Symbol | undefined
  }
  const unresolved: string[] = []
  for (const file of files) {
    const sf   = program.getSourceFile(file)!
    const walk = (node: ts.Node) => {
      if (ts.isIdentifier(node) && isReference(node) && !HOST_GLOBALS.has(node.text)
        && !checker.resolveName(node.text, node, VALUE, false)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        unresolved.push(`${file}:${line + 1}  ${node.text}`)
      }
      ts.forEachChild(node, walk)
    }
    walk(sf)
  }
  return unresolved
}

// One undeclared name in each reference position, and declared names in the
// positions that look like references and are not.
const FIXTURE = `
import { imported } from './nowhere.js'
const declared = 1
function f (p) { return p + declared + imported + inReturn }
const o = { inShorthand, k: inValue, declared, [inComputed]: 1, async m (d = inDefault) { return await inAwait } }
o.notAName = inMember.prop
export { inExport }
export default inDefaultExport
class K extends inExtends { static s = inStatic; m () { return new.target } }
;({ inAssignPattern } = o)
const { a: notAName2 } = o
lab: for (const a of inForOf) { inAssign = a; break lab }
if (typeof inTypeof === 'undefined') console.log(undefined, globalThis, import.meta)
/** @type {InJsDoc} */ const jd = \`\${inTemplate}\`
inCall()
`

describe('every name in src/ resolves', () => {
  it('finds an undeclared name in each reference position', () => {
    const file = '/fixture.js'
    const host = ts.createCompilerHost(OPTIONS)
    const read = host.getSourceFile
    host.getSourceFile = (name, version, ...rest) =>
      name === file ? ts.createSourceFile(file, FIXTURE, version) : read.call(host, name, version, ...rest)
    const program = ts.createProgram([file], OPTIONS, host)

    expect(unresolvedNames(program, [file]).map(u => u.split('  ')[1]).sort()).toEqual([
      'inAssign', 'inAssignPattern', 'inAwait', 'inCall', 'inComputed', 'inDefault', 'inDefaultExport',
      'inExport', 'inExtends', 'inForOf', 'inMember', 'inReturn', 'inShorthand', 'inStatic',
      'inTemplate', 'inTypeof', 'inValue',
    ])
  })

  it('to a declaration, an import or a named host global', () => {
    const files   = jsFiles(SRC)
    const program = ts.createProgram(files, OPTIONS)

    expect(files.length).toBeGreaterThan(50)
    expect(unresolvedNames(program, files).map(u => relative(SRC, u))).toEqual([])
  }, 60_000)
})
