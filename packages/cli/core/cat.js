// ─── cat.js — a file read in a terminal ───────────────────────────────────────
//
// `fli cat`. Markdown is rendered, JSON is laid out and colored, JS/TS is
// highlighted, and anything else prints as it is.
//
// The markdown renderer is Bun's own (`Bun.markdown.ansi`, md4c underneath),
// so this owns only what it gets wrong on the files this repo writes:
//
//   frontmatter   md4c reads `---\ntitle: x\n---` as a rule plus a setext
//                 heading, so the block arrives as one bold line of yaml. It is
//                 handed over as a yaml fence instead.
//   <script>      a command file's lifted script is an HTML block to md4c and
//                 prints unhighlighted. It is handed over as a js fence.
//   a link        OSC-8 makes a link clickable only if the terminal can resolve
//                 the target, and `./a.md` resolves against nothing. A relative
//                 target becomes a `file://` URL against the file's own folder.
//
// A section is a row as `fli outline` names it — one reader of what a file's
// sections are, so the two commands cannot disagree. JSON has no outline, so
// its section is a key path.

import { readFileSync }                 from 'node:fs'
import { dirname, relative, resolve }   from 'node:path'
import { pathToFileURL }                from 'node:url'
import { splitFrontmatter, parseFrontmatter } from '@frontierjs/toolbelt/frontmatter'
import { outlineMarkdown, outlineFile, findRows, pathOf, MARKDOWN } from './outline.js'
import { PARSABLE }                     from './functions.js'
import { markdownFiles }                from './doc-commands.js'

export { MARKDOWN }

export const JSON_FILE = /(\.(json|jsonc|webmanifest)|(^|\/)bun\.lock)$/
const TYPED = /\.[cm]?tsx?$/

const FENCE  = /^\s{0,3}(`{3,}|~{3,})/
const SCRIPT = /^<script\b[^>]*>\s*$/
const LINK   = /\]\((?!(?:[a-z][a-z0-9+.-]*:|#|\/))([^)\s]+)\)/gi

/**
 * The markdown Bun is handed — frontmatter and column-0 `<script>` blocks
 * turned into fences, relative link targets made absolute when `file` is given.
 */
export function prepare(text, { file = null } = {}) {
  const { block, body } = splitFrontmatter(text)
  const out = block === null ? [] : ['```yaml', ...block.replace(/\r?\n$/, '').split('\n'), '```', '']
  const base = file ? dirname(resolve(file)) : null
  let fence = null
  let script = false
  for (const line of body.split('\n')) {
    const f = line.match(FENCE)
    if (script) {
      out.push(/^<\/script>\s*$/.test(line) ? '```' : line)
      if (/^<\/script>\s*$/.test(line)) script = false
      continue
    }
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      out.push(line)
      continue
    }
    if (!fence && SCRIPT.test(line)) {
      out.push('```js')
      script = true
      continue
    }
    out.push(fence || !base ? line : line.replace(LINK, (m, target) => {
      const [path, hash = ''] = target.split('#')
      return `](${pathToFileURL(resolve(base, decodeURI(path))).href}${hash ? `#${hash}` : ''})`
    }))
  }
  return out.join('\n')
}

/** `text` as ANSI for a terminal `columns` wide; `color: false` is plain text. */
export function render(text, { file = null, columns = 80, color = true } = {}) {
  return Bun.markdown.ansi(prepare(text, { file }), { columns, colors: color, hyperlinks: color })
}

/** `text` as `file`'s kind reads in a terminal; `color: false` is plain text. */
export function prettify(text, file, { columns = 80, color = true } = {}) {
  if (MARKDOWN.test(file))  return render(text, { file, columns, color })
  if (JSON_FILE.test(file)) return formatJson(text, { color })
  if (color && PARSABLE.test(file)) return highlightCode(text, TYPED.test(file) ? 'ts' : 'js', columns)
  return text.replace(/\n?$/, '\n')
}

// Bun draws a code fence in a box; a whole file read in one is a file whose
// lines cannot be copied out, so the box is cut back off.
const GUTTER = /^\x1b\[2m│ \x1b\[0m/

function highlightCode(text, lang, columns) {
  const source = text.replace(/\n?$/, '\n')
  // a fence longer than any backtick run inside, or a template literal closes it
  const longest = [...source.matchAll(/`+/g)].reduce((n, m) => Math.max(n, m[0].length), 0)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  const out = Bun.markdown.ansi(`${ticks}${lang}\n${source}${ticks}\n`, { columns, colors: true })
  const lines = out.split('\n').slice(1, -2).map(l => l.replace(GUTTER, ''))
  // Bun colors only `//` comments; a JSDoc block came out keyword-colored
  const src = source.split('\n')
  for (const i of blockCommentLines(source)) lines[i] = `\x1b[2m${src[i]}\x1b[0m`
  return lines.join('\n') + '\n'
}

/**
 * The 0-based lines that are block comment and nothing else — opened on an
 * earlier line or at the line's start, and not followed by code once closed.
 * Strings and regex literals are stepped over, so a `'/*'` opens nothing and
 * a backtick in a regex opens no template.
 */
const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^'

export function blockCommentLines(text) {
  const lines = new Set()
  let line = 0, quote = null, block = false, lineStart = true, commentOnly = false, prev = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') {
      if (commentOnly) lines.add(line)
      line++
      lineStart = true
      commentOnly = block
      if (quote !== '`') quote = null
      continue
    }
    if (block) {
      if (c === '*' && text[i + 1] === '/') { block = false; i++ }
      continue
    }
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      lineStart = false
      continue
    }
    if (c === ' ' || c === '\t') continue
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i) - 1; if (i < 0) break; continue }
    if (c === '/' && text[i + 1] === '*') {
      block = true
      if (lineStart) commentOnly = true
      i++
      continue
    }
    // code after a comment that closed on this line
    commentOnly = false
    lineStart = false
    if (c === '/' && (prev === '' || REGEX_AFTER.includes(prev))) {
      for (let cls = false, j = i + 1; j < text.length && text[j] !== '\n'; j++) {
        if (text[j] === '\\') j++
        else if (text[j] === '[') cls = true
        else if (text[j] === ']') cls = false
        else if (text[j] === '/' && !cls) { i = j; break }
      }
      prev = '/'
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    prev = c
  }
  if (commentOnly) lines.add(line)
  return lines
}

const JSON_TOKEN = /("(?:[^"\\\n]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)\b|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|([{}[\],:])|(\s+)|([\s\S])/g
const JSON_PAINT = { key: 36, string: 32, number: 33, literal: 35, comment: 2 }

/**
 * JSON laid out two-space and colored. Valid JSON is re-laid from its tokens,
 * never from a parse, so `1.0` and a 20-digit id print as written. Anything
 * else — a tsconfig's comments, bun.lock's trailing commas — is colored where
 * it stands.
 */
export function formatJson(text, { color = true } = {}) {
  const tokens = []
  for (const m of text.matchAll(JSON_TOKEN)) {
    const type = m[1] ? 'string' : m[2] ? 'number' : m[3] ? 'literal' : m[4] ? 'comment' : m[5] ? 'punct' : m[6] ? 'space' : 'other'
    tokens.push({ type, text: m[0] })
  }
  const significant = tokens.filter(t => t.type !== 'space' && t.type !== 'comment')
  significant.forEach((t, i) => { if (t.type === 'string' && significant[i + 1]?.text === ':') t.type = 'key' })
  const paint = t => color && JSON_PAINT[t.type] ? `\x1b[${JSON_PAINT[t.type]}m${t.text}\x1b[0m` : t.text

  let valid = true
  try { JSON.parse(text) } catch { valid = false }
  if (!valid) return tokens.map(paint).join('').replace(/\n?$/, '\n')

  let out = ''
  let depth = 0
  const newline = () => '\n' + '  '.repeat(depth)
  for (let i = 0; i < significant.length; i++) {
    const t = significant[i]
    const next = significant[i + 1]?.text
    if ((t.text === '{' && next === '}') || (t.text === '[' && next === ']')) { out += t.text + next; i++; continue }
    if (t.text === '{' || t.text === '[') { depth++; out += t.text + newline(); continue }
    if (t.text === '}' || t.text === ']') { depth--; out += newline() + t.text; continue }
    if (t.text === ',') { out += ',' + newline(); continue }
    if (t.text === ':') { out += ': '; continue }
    out += paint(t)
  }
  return out + '\n'
}

/**
 * The section `query` names in `file` — `{ text, row }`, the section's own
 * lines — or `{ refused, rows }` when none or several do. A markdown file is
 * read from `text`; code is read from disk by the outline.
 */
export async function section(file, text, query) {
  if (JSON_FILE.test(file)) return jsonSection(text, String(query))
  const outline = MARKDOWN.test(file) ? { rows: outlineMarkdown(text) } : await outlineFile(file)
  if (outline.refused) return { refused: outline.refused, rows: [] }
  const found = findRows(outline.rows, String(query))
  if (found.length === 1) {
    const [row] = found
    return { text: text.split('\n').slice(row.start - 1, row.end).join('\n'), row }
  }
  return {
    refused: found.length ? `${found.length} sections match ${query} — name one by its path:` : `no section matches ${query}`,
    rows:    found.map(r => `  ${r.start}-${r.end}  ${pathOf(r)}`),
  }
}

// A key may hold a dot (`@scope/pkg.json`, `./sub.js`), so each level takes
// the whole remaining path first and then the longest key it begins with.
function walk(value, path) {
  if (value === null || typeof value !== 'object') return null
  if (Object.hasOwn(value, path)) return { value: value[path] }
  for (const key of Object.keys(value).sort((a, b) => b.length - a.length)) {
    if (!path.startsWith(`${key}.`)) continue
    const got = walk(value[key], path.slice(key.length + 1))
    if (got) return got
  }
  return null
}

function jsonSection(text, query) {
  let value
  try { value = JSON.parse(text) } catch (e) { return { refused: `not JSON, so no key path: ${e.message}`, rows: [] } }
  const got = walk(value, query)
  if (got) return { text: JSON.stringify(got.value, null, 2) }
  const keys = value && typeof value === 'object' ? Object.keys(value) : []
  return { refused: `no key ${query}${keys.length ? ' — the top-level keys:' : ''}`, rows: keys.map(k => `  ${k}`) }
}

/** A file's title — its frontmatter `title`, else its first `#` heading, else null. */
export function titleOf(text) {
  const { body } = splitFrontmatter(text)
  let title = null
  // a block outside the yaml subset still has a heading below it
  try { title = parseFrontmatter(text).frontmatter.title } catch {}
  if (typeof title === 'string' && title) return title
  let fence = null
  for (const line of body.split('\n')) {
    const f = line.match(FENCE)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    const h = line.match(/^#\s+(.+?)\s*#*\s*$/)
    if (h) return h[1]
  }
  return null
}

/** Every markdown file under `dir` as `{ file, rel, title, lines }`, sorted by path. */
export function folderIndex(dir) {
  return markdownFiles(dir).sort().map(file => {
    const text = readFileSync(file, 'utf8')
    return { file, rel: relative(dir, file), title: titleOf(text), lines: text.split('\n').length }
  })
}
