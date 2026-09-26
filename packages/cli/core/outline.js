// ─── the shape of one file, as line ranges ───────────────────────────────────
//
// A reader who cannot see a file's shape reads it in guessed windows: a
// 4700-line module costs three `sed -n` tries to land on one function, and each
// miss is a few thousand tokens of the wrong function. This is the shape — every
// declaration a reader would name, with the lines it spans — so the next read
// is exact, or is the body itself.
//
// A row's range STARTS AT ITS COMMENT. A comment here explains a failure, and a
// body read without the paragraph above it is the half that does not say why.
// A comment separated by a blank line is a section banner and is left out.
//
// Code is read with the TYPESCRIPT PARSER, found the way `functions.js` finds it
// and named the way it names them, so the codegraph's worst function and the
// row that prints it agree. Markdown is its headings. A `.lite` is read with the
// lexer litestone parses it with, and a `.mesa` is its blocks with each script
// read as code. Anything else is refused by name, never guessed at by indent.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tokenize, TK } from '@frontierjs/toolbelt/predicate'
import { PARSABLE, typeScriptAt, functionName } from './functions.js'

/** A row this long shows what is inside it; a shorter one is read whole. */
export const EXPAND_AT = 150

/** A body this long prints its outline instead, unless asked for in full. */
export const BODY_AT = 500

export const MARKDOWN = /\.(md|markdown)$/
const LITE = /\.lite$/
const MESA = /\.mesa$/

/** Whether `path` has a reading. */
export const outlinable = path => PARSABLE.test(path) || MARKDOWN.test(path) || LITE.test(path) || MESA.test(path)

/**
 * The typescript installed in the nearest directory above `file` that has one.
 * Walked by `existsSync` rather than `require.resolve`, for the reason
 * `typeScriptAt` gives: bun resolves from its global cache what no project here
 * installed (`FJS-666`).
 */
export async function typeScriptFor(file) {
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', 'typescript'))) return typeScriptAt(dir)
    if (dirname(dir) === dir) return null
  }
}

/**
 * `{ rows }` for a file, or `{ refused }` naming why there are none. A row is
 * `{ name, kind, start, end, children }`, lines 1-based and inclusive.
 */
export async function outlineFile(path) {
  if (!existsSync(path)) return { refused: `no such file: ${path}` }
  if (!outlinable(path)) return { refused: `no outline for ${path} — reads .js/.ts (and jsx, mjs, cjs, mts, cts), .md, .lite and .mesa` }
  const text = readFileSync(path, 'utf8')
  if (MARKDOWN.test(path)) return { rows: outlineMarkdown(text), lines: text.split('\n') }
  if (LITE.test(path)) {
    try { return { rows: outlineLite(text), lines: text.split('\n') } } catch (e) { return { refused: `${path} does not lex: ${e.message}` } }
  }
  const ts = await typeScriptFor(path)
  // a component's blocks need no parser; only the functions inside its scripts do
  if (MESA.test(path)) return { rows: outlineMesa(ts, path, text), lines: text.split('\n') }
  if (!ts) return { refused: `no typescript installed above ${path} — the outline reads code with its parser` }
  return { rows: outlineCode(ts, path, text), lines: text.split('\n') }
}

const FUNCTION_KINDS = ts => new Map([
  [ts.SyntaxKind.FunctionDeclaration, 'function'], [ts.SyntaxKind.FunctionExpression, 'function'],
  [ts.SyntaxKind.ArrowFunction, 'function'], [ts.SyntaxKind.MethodDeclaration, 'method'],
  [ts.SyntaxKind.Constructor, 'method'], [ts.SyntaxKind.GetAccessor, 'get'], [ts.SyntaxKind.SetAccessor, 'set'],
])
const DECLARATION_KINDS = ts => new Map([
  [ts.SyntaxKind.ClassDeclaration, 'class'], [ts.SyntaxKind.ClassExpression, 'class'],
  [ts.SyntaxKind.InterfaceDeclaration, 'interface'], [ts.SyntaxKind.TypeAliasDeclaration, 'type'],
  [ts.SyntaxKind.EnumDeclaration, 'enum'], [ts.SyntaxKind.ModuleDeclaration, 'namespace'],
])

export function outlineCode(ts, path, text) {
  const src = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const FN = FUNCTION_KINDS(ts), DECL = DECLARATION_KINDS(ts)
  const lineAt = pos => src.getLineAndCharacterOfPosition(pos).line + 1

  // The statement a declaration is written as — `export const f = () => {}` is
  // one statement, and its comment sits above `export`, not above the arrow.
  const anchorOf = node => {
    let at = node
    for (;;) {
      const up = at.parent
      if (!up) return at
      if (ts.isVariableDeclaration(up) || ts.isVariableDeclarationList(up) || ts.isVariableStatement(up)
          || ts.isPropertyAssignment(up) || ts.isExportAssignment(up)) { at = up; continue }
      if (ts.isCallExpression(up) && ts.isExpressionStatement(up.parent)) return up.parent
      return at
    }
  }

  const commentStart = anchor => {
    let cursor = anchor.getStart(src)
    const comments = ts.getLeadingCommentRanges(text, anchor.getFullStart()) ?? []
    for (let i = comments.length - 1; i >= 0; i--) {
      if ((text.slice(comments[i].end, cursor).match(/\n/g) ?? []).length > 1) break
      cursor = comments[i].pos
    }
    return cursor
  }

  const rowFor = node => {
    let kind = FN.has(node.kind) && node.body ? FN.get(node.kind) : DECL.get(node.kind)
    let name = kind ? functionName(ts, node) : null
    if (!kind && ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      kind = 'object'
      name = node.name.getText(src)
    }
    if (!kind || !name) return null
    const anchor = kind === 'object' ? anchorOf(node.initializer) : anchorOf(node)
    const end = lineAt(anchor.getEnd())
    // a one-liner is read by reading the row above it
    if (end - lineAt(anchor.getStart(src)) < 2) return null
    return { name, kind, start: lineAt(commentStart(anchor)), end, children: [] }
  }

  const root = { children: [] }
  const visit = (node, parent) => {
    let row = rowFor(node)
    // `const f = function f() {}` and a factory returning its namesake are one row
    if (row && row.name === parent.name) row = null
    if (row) parent.children.push(row)
    ts.forEachChild(node, c => visit(c, row ?? parent))
  }
  visit(src, root)
  return root.children
}

export function outlineMarkdown(text) {
  const lines = text.split('\n')
  const root = { level: 0, children: [] }
  const stack = [root]
  let fence = null
  let i = 0
  // front matter's `# comment` is yaml, not a heading
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close > 0) i = close + 1
  }
  const close = (row, endLine) => {
    let end = endLine
    while (end > row.start && !lines[end - 1].trim()) end--
    row.end = end
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!h) continue
    const level = h[1].length
    while (stack.length > 1 && stack.at(-1).level >= level) close(stack.pop(), i)
    const row = { name: h[2].replace(/<[^>]+>/g, '').trim(), kind: h[1], level, start: i + 1, end: 0, children: [] }
    stack.at(-1).children.push(row)
    stack.push(row)
  }
  while (stack.length > 1) close(stack.pop(), lines.length)
  const strip = rows => rows.map(({ level, ...r }) => ({ ...r, children: strip(r.children) }))
  return strip(root.children)
}

// The first line of the `//` run directly above `line`, or `line` itself.
const commentAbove = (lines, line) => {
  let at = line
  while (at > 1 && lines[at - 2].trimStart().startsWith('//')) at--
  return at
}

/**
 * A `.lite` is its top-level blocks, found by brace depth over the tokens
 * litestone parses it from. No keyword list is kept here to fall behind the
 * grammar: whatever words stand before a block's `{` are its kind and name —
 * `extend model User` is kind `extend model`, name `User` — and a brace inside
 * a string or a comment never reaches a token.
 */
export function outlineLite(text) {
  const lines = text.split('\n')
  const tokens = tokenize(text)
  const rows = []
  let depth = 0, open = -1
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.type === TK.LBRACE && depth++ === 0) open = k
    if (t.type !== TK.RBRACE || --depth !== 0 || open < 1) continue
    // the head is the line the `{` closes, which is the token before it
    const headLine = tokens[open - 1].line
    let from = open - 1
    while (from > 0 && tokens[from - 1].line === headLine && tokens[from - 1].type !== TK.RBRACE && tokens[from - 1].type !== TK.COMMENT) from--
    const words = []
    for (let h = from; h < open && tokens[h].type === TK.IDENT; h++) words.push(tokens[h].value)
    if (!words.length || t.line - headLine < 2) continue
    rows.push({ name: words.at(-1), kind: words.slice(0, -1).join(' '), start: commentAbove(lines, headLine), end: t.line, children: [] })
  }
  return rows
}

const MESA_BLOCK = /^<(script|style)\b([^>]*)>/

/**
 * A `.mesa` is its blocks — `<script module>`, `<script>`, `<style>` and the
 * markup between them — with each script's functions inside it at their real
 * lines. A block is one opened at column 0, which is how all 460 components in
 * this repo write one. With no parser, the blocks alone.
 */
export function outlineMesa(ts, path, text) {
  const lines = text.split('\n')
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(MESA_BLOCK)
    if (!open) continue
    let j = i
    while (j < lines.length && !lines[j].includes(`</${open[1]}>`)) j++
    if (j === lines.length) break
    const module = open[1] === 'script' && /\smodule\b|context=["']module["']/.test(open[2])
    const block = { name: module ? 'script module' : open[1], kind: '', start: i + 1, end: j + 1, children: [] }
    if (ts && open[1] === 'script') {
      // every line outside the script blanked, so the parser's lines are the file's
      const only = lines.map((l, k) => k >= i + 1 && k < j ? l : '').join('\n')
      block.children = outlineCode(ts, path.replace(MESA, '.ts'), only)
    }
    blocks.push(block)
    i = j
  }
  const markup = []
  // a route's `---` meta is not markup, and `markup` would send a reader to the wrong lines
  const meta = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0
  if (meta > 0) markup.push({ name: 'front matter', kind: '', start: 1, end: meta, children: [] })
  for (let k = 0, from = meta + 1; k <= blocks.length; k++) {
    let start = from, end = k < blocks.length ? blocks[k].start - 1 : lines.length
    while (start <= end && !lines[start - 1].trim()) start++
    while (end >= start && !lines[end - 1].trim()) end--
    markup.push({ name: 'markup', kind: '', start, end, children: [] })
    if (k < blocks.length) from = blocks[k].end + 1
  }
  return [...blocks, ...markup]
    .filter(r => r.end - r.start >= 2)
    .sort((a, b) => a.start - b.start)
}

const span = r => r.end - r.start + 1
const count = rows => rows.reduce((n, r) => n + 1 + count(r.children), 0)
// a ruling's heading is its whole sentence; the range is what the row is for
const LABEL_AT = 90
const label = r => {
  const text = (!r.kind || r.kind === 'function' || r.kind === 'method' ? '' : `${r.kind} `) + r.name
  return text.length > LABEL_AT ? text.slice(0, LABEL_AT - 1) + '…' : text
}

/**
 * Children averaging fewer lines than this are a LIST — forty five-line rulings
 * under one heading — and listing them costs what reading them would. They are
 * reached by name instead.
 */
export const LIST_BELOW = 8

/**
 * One line per row: `start-end  name (lines)`. Every top-level row prints; a
 * row's children print when it is `expandAt` lines or longer and they are not a
 * list, or when it is `open` — the row somebody asked for. A row that hides
 * them says how many.
 */
export function renderOutline(rows, { expandAt = EXPAND_AT, open: forced = null } = {}) {
  const width = String(Math.max(0, ...flatten(rows).map(r => r.end))).length
  const out = []
  const opens = r => r.children.length > 0 && (r === forced
    || (span(r) >= expandAt && span(r) / r.children.length >= LIST_BELOW))
  const walk = (list, d) => {
    for (const r of list) {
      const open = opens(r)
      const hidden = r.children.length && !open ? ` +${count(r.children)} inside` : ''
      out.push(`${String(r.start).padStart(width)}-${String(r.end).padEnd(width)}  ${'  '.repeat(d)}${label(r)} (${span(r)})${hidden}`)
      if (open) walk(r.children, d + 1)
    }
  }
  walk(rows, 0)
  return out
}

const flatten = (rows, path = []) => rows.flatMap(r => [{ ...r, path: [...path, r.name] }, ...flatten(r.children, [...path, r.name])])

/**
 * The rows a query names. A line number is the innermost row holding it — a
 * stack trace's frame. Otherwise the query is a whole name, or a dotted path
 * whose last segment is the row and whose earlier segments are ancestors in
 * order, not necessarily adjacent (`createClient.update`). Exact names first;
 * with none, a case-insensitive substring.
 */
export function findRows(rows, query) {
  const all = flatten(rows)
  if (/^\d+$/.test(query)) {
    const line = Number(query)
    const holding = all.filter(r => r.start <= line && line <= r.end)
    return holding.length ? [holding.reduce((a, b) => span(b) <= span(a) ? b : a)] : []
  }
  const whole = all.filter(r => r.name === query)
  if (whole.length) return whole
  const segs = query.split('.')
  const matching = eq => all.filter(r => {
    if (!eq(r.name, segs.at(-1))) return false
    let i = 0
    for (const name of r.path.slice(0, -1)) if (i < segs.length - 1 && eq(name, segs[i])) i++
    return i === segs.length - 1
  })
  const exact = matching((a, b) => a === b)
  return exact.length ? exact : matching((a, b) => a.toLowerCase().includes(b.toLowerCase()))
}

/** Lines `start..end` numbered as `cat -n` numbers them. */
export function renderBody(lines, row) {
  const width = String(row.end).length
  return lines.slice(row.start - 1, row.end).map((l, i) => `${String(row.start + i).padStart(width)}\t${l}`)
}

export const pathOf = row => row.path.join('.')

// ─── the hint in front of a wide read ────────────────────────────────────────

/** A file this long is not read whole, or in a guessed window. */
export const HINT_AT = 1000

const SED_WINDOW = /\bsed\s+-n\s+['"]?\d+,\d+p['"]?\s+(['"]?)([^\s'"|;&]+)\1/

/**
 * The file a tool call is about to read wide — a Read with no `limit`, or a
 * `sed -n 'a,bp'` window — or null. What the PreToolUse hook asks, so the hook
 * holds no policy of its own.
 */
export function wideRead({ tool_name, tool_input } = {}) {
  if (tool_name === 'Read') {
    const path = tool_input?.file_path
    return path && tool_input.limit == null && outlinable(path) ? path : null
  }
  if (tool_name === 'Bash') {
    const path = String(tool_input?.command ?? '').match(SED_WINDOW)?.[2]
    return path && outlinable(path) ? path : null
  }
  return null
}

/** The hint for a wide read of a file `lines` long, or null under `HINT_AT`. */
export function outlineHint(path, lines) {
  if (lines < HINT_AT) return null
  return `${path} is ${lines} lines. \`fli outline ${path}\` lists what is in it, each with its line range; ` +
    `\`fli outline ${path} <name|a.b|line>\` prints just that one.`
}
