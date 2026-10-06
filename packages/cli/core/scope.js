// ─── scope.js — the names a compiled command uses and binds nowhere ──────────
//
// A parse is not a run: `join` with no import parses clean and throws on the
// first call, and `fli check` itself once sat unexecutable behind a free
// `resolve` (FJS-269, FJS-730). This walks the compiled unit the runtime
// actually loads — namespace module script, own script, head and body as one
// module — resolves every identifier against real lexical scopes, and reports
// the ones bound nowhere and known to no global, plus a name declared twice in
// one scope, which is a SyntaxError the command never loads past.
//
// Real scope chains or nothing: a flat "declared somewhere in the file" test
// calls a parameter of some OTHER function bound (`IDEAS/scope-checking.md`).
//
// The parser is TypeScript's, loaded from the project being checked — the
// same way `functions.js` reads it, because `fli` is global and a dependency
// of the app is not beside the CLI. No parser is a skip, never a pass.
//
// What it does not see: a property (`$.confg` resolves), dynamic access
// (`globalThis[name]`), and use-before-`let`, which is bound here and a
// ReferenceError at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs'
import { createRequire }            from 'node:module'
import { join }                     from 'node:path'

// The host runtime's globals plus what a module may name without declaring.
// `Bun` is listed by hand: a check run under node grades a command bun runs.
const HOST = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  'Bun', 'arguments', 'require', 'undefined', 'NaN', 'Infinity',
])

/** TypeScript installed in `root`, synchronously, or null. Never this package's own. */
export function typeScriptIn(root) {
  const dir = join(root, 'node_modules', 'typescript')
  if (!existsSync(dir)) return null
  try {
    const main = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).main
    const file = join(dir, main)
    if (!existsSync(file)) return null
    // An absolute path, so nothing is resolved — bun answers a bare
    // `require.resolve` from its global cache and memoizes it (FJS-666).
    const ts = createRequire(import.meta.url)(file)
    return typeof ts?.createSourceFile === 'function' ? ts : null
  } catch {
    return null
  }
}

/**
 * `{ free, duplicates }` over one ES module, each entry `{ name, line }` with
 * a 1-based line of `code`. `globals` are the names the unit may use without
 * declaring beyond the host's own — for a command, the shim's three.
 */
export function scopeProblems(ts, code, { globals = [] } = {}) {
  const known = new Set([...HOST, ...globals])
  const sf    = ts.createSourceFile('unit.mjs', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

  const isFunction = (n) => ts.isFunctionLike(n)
  const isScope = (n) =>
    isFunction(n) || ts.isSourceFile(n) || ts.isBlock(n) || ts.isCaseBlock(n) ||
    ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) ||
    ts.isCatchClause(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)

  const declared   = new Map()   // scope node → Map<name, kind>
  const duplicates = []
  const free       = []
  const lineOf     = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  const declare = (scope, id, kind) => {
    let names = declared.get(scope)
    if (!names) declared.set(scope, names = new Map())
    const name = id.text
    const prior = names.get(name)
    // Two lexical declarations, or a lexical beside a var, of one name in one
    // scope is a SyntaxError; two vars or two parameters are not.
    if (prior && (kind !== 'var' || prior !== 'var') && kind !== 'param' && prior !== 'param') {
      duplicates.push({ name, line: lineOf(id) })
    }
    names.set(name, kind)
  }

  // Every identifier a binding pattern introduces: `{ a, b: [c], ...d }`.
  const bound = (name, out = []) => {
    if (ts.isIdentifier(name)) out.push(name)
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) if (ts.isBindingElement(el)) bound(el.name, out)
    }
    return out
  }

  const nearest   = (stack, test) => { for (let i = stack.length - 1; i >= 0; i--) if (test(stack[i])) return stack[i] }
  const fnScope   = (stack) => nearest(stack, n => isFunction(n) || ts.isSourceFile(n))
  const anyScope  = (stack) => stack[stack.length - 1]

  const walk = (node, stack, visit) => {
    const scoped = isScope(node)
    if (scoped) stack.push(node)
    visit(node, stack)
    ts.forEachChild(node, child => walk(child, stack, visit))
    if (scoped) stack.pop()
  }

  // ─── pass 1: what each scope binds ──────────────────────────────────────────
  walk(sf, [], (node, stack) => {
    if (ts.isVariableDeclarationList(node)) {
      const lexical = (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
      const scope   = lexical ? anyScope(stack) : fnScope(stack)
      for (const d of node.declarations) for (const id of bound(d.name)) declare(scope, id, lexical ? 'lexical' : 'var')
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      // The function's own scope is on the stack; its name belongs outside it.
      if (node.name) declare(stack[stack.length - 2], node.name, 'lexical')
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      declare(node, node.name, 'own')
    } else if (ts.isParameter(node)) {
      for (const id of bound(node.name)) declare(nearest(stack, isFunction), id, 'param')
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const id of bound(node.variableDeclaration.name)) declare(node, id, 'lexical')
    } else if (ts.isImportDeclaration(node) && node.importClause) {
      const { name, namedBindings } = node.importClause
      if (name) declare(sf, name, 'lexical')
      if (namedBindings) {
        if (ts.isNamespaceImport(namedBindings)) declare(sf, namedBindings.name, 'lexical')
        else for (const s of namedBindings.elements) declare(sf, s.name, 'lexical')
      }
    }
  })

  // ─── pass 2: every reference, resolved up the chain ─────────────────────────
  const isReference = (id) => {
    const p = id.parent
    if (!p) return false
    if (ts.isPropertyAccessExpression(p) && p.name === id) return false
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
         ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === id) return false
    if (ts.isBindingElement(p) && (p.propertyName === id || p.name === id)) return false
    if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) ||
         ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === id) return false
    if (ts.isImportSpecifier(p) || ts.isNamespaceImport(p) || (ts.isImportClause(p) && p.name === id)) return false
    if (ts.isExportSpecifier(p) && p.propertyName && p.name === id) return false
    if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false
    if (ts.isMetaProperty(p)) return false
    // `typeof x` on an unbound x is undefined, not a throw.
    if (ts.isTypeOfExpression(p) && p.expression === id) return false
    return true
  }

  const resolves = (name, stack) => {
    for (let i = stack.length - 1; i >= 0; i--) if (declared.get(stack[i])?.has(name)) return true
    return known.has(name)
  }

  const seen = new Set()
  walk(sf, [], (node, stack) => {
    if (!ts.isIdentifier(node) || !isReference(node)) return
    if (resolves(node.text, stack)) return
    const key = `${node.text}:${lineOf(node)}`
    if (seen.has(key)) return
    seen.add(key)
    free.push({ name: node.text, line: lineOf(node) })
  })

  return { free, duplicates }
}
