// ─── what is inside a file ───────────────────────────────────────────────────
//
// Every other reading in the codegraph is per FILE, and a file is not where
// complexity lives: `client.js` is 5000 lines because one function in it is
// 1342 branches deep, and *big file* and *one monster* take different work.
// This reads functions.
//
// It uses the TYPESCRIPT PARSER, and this package depends on nothing to get it:
// `fli` is global, so the parser is looked for in the PROJECT being drawn, the
// same rule `core/app-schema.js` states for a shipped `.lite` — *installed
// HERE*, not *resolvable from here*. `require.resolve` is refused there for a
// measured reason: bun falls back to its global install CACHE and memoizes the
// answer, so it resolves a package the project does not have (`FJS-666`).
//
// A project with no typescript, and every `.mesa`, keeps the indent reading.
// That is not a fallback that can hide — `complexityFrom` is on the file, so
// *quiet* and *nobody parsed this* cannot draw the same tile.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The extensions the parser can read. A `.mesa` is not one: its script blocks are mesa's to hand out. */
export const PARSABLE = /\.([cm]?[jt]sx?)$/

/** The typescript module installed in `root`, or null. Never this package's own. */
export async function typeScriptAt(root) {
  const dir = join(root, 'node_modules', 'typescript')
  if (!existsSync(dir)) return null
  try {
    const main = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).main
    if (typeof main !== 'string') return null
    const file = join(dir, main)
    if (!existsSync(file)) return null
    const mod = await import(file)
    const ts = mod.default ?? mod
    return typeof ts?.createSourceFile === 'function' ? ts : null
  } catch {
    return null
  }
}

const KINDS = ts => ({
  fn: new Set([ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction,
               ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor]),
  // a decision the reader has to follow
  branch: new Set([ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement,
                   ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.CaseClause, ts.SyntaxKind.CatchClause,
                   ts.SyntaxKind.ConditionalExpression]),
  // a decision that also puts everything under it one level deeper
  nests: new Set([ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement,
                  ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.CatchClause, ts.SyntaxKind.SwitchStatement,
                  ts.SyntaxKind.ConditionalExpression]),
  logic: new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]),
})

/**
 * Every function in one file, each with:
 *
 * - **cyclo** — independent paths through it, the count of decisions plus one.
 * - **cognitive** — how hard it is to FOLLOW, which is the number worth having:
 *   a decision costs 1 plus however deep it is nested, so ten flat guards are
 *   cheap and three loops inside each other are not. An approximation of
 *   Sonar's measure and not a copy of it — no recursion increment, and an
 *   `else if` costs what an `if` costs.
 * - **nest** — the deepest of those.
 *
 * A one-line arrow (a callback, a comparator) is not a function anybody reads
 * as one, so it is left out; counting them puts the median at 1 and buries the
 * file's own shape under its map callbacks.
 */
export function measureFunctions(ts, path, text) {
  let src
  try { src = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true) } catch { return null }
  const K = KINDS(ts)
  const lineOf = pos => { try { return src.getLineAndCharacterOfPosition(pos).line + 1 } catch { return 0 } }

  const nameOf = node => {
    const own = node.name?.getText?.()
    if (own) return own
    const up = node.parent
    if (up && (ts.isVariableDeclaration(up) || ts.isPropertyAssignment(up) || ts.isPropertyDeclaration(up))) return up.name.getText()
    if (up && ts.isCallExpression(up) && ts.isIdentifier(up.expression)) return up.expression.getText() + '(…)'
    if (up && ts.isExportAssignment(up)) return 'default'
    return null
  }

  const measure = fn => {
    let cyclo = 1, cognitive = 0, nest = 0
    const walk = (node, depth) => {
      // a nested function is its own subject, but the code it sits in still nests it
      if (K.fn.has(node.kind) && node !== fn) { ts.forEachChild(node, c => walk(c, depth + 1)); return }
      if (K.branch.has(node.kind)) cyclo++
      const deeper = K.nests.has(node.kind)
      if (deeper) { cognitive += 1 + depth; nest = Math.max(nest, depth + 1) }
      if (node.kind === ts.SyntaxKind.BinaryExpression && K.logic.has(node.operatorToken.kind)) cognitive++
      ts.forEachChild(node, c => walk(c, depth + (deeper ? 1 : 0)))
    }
    if (fn.body) walk(fn.body, 0)
    return { cyclo, cognitive, nest }
  }

  const functions = []
  const visit = node => {
    if (K.fn.has(node.kind) && node.body) {
      const from = lineOf(node.body.pos), to = lineOf(node.body.end)
      if (to - from >= 1) functions.push({ name: nameOf(node) ?? '(anonymous)', line: lineOf(node.pos), lines: to - from + 1, ...measure(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return functions
}

/** The file's reading of its own functions: the WORST one, since a file is as hard as its hardest function. */
export function worstFunction(functions) {
  if (!functions?.length) return null
  return functions.reduce((a, b) => b.cognitive > a.cognitive ? b : a)
}
