// ─── cat.js — markdown read in a terminal ────────────────────────────────────
//
// `fli cat`. The renderer is Bun's own (`Bun.markdown.ansi`, md4c underneath),
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
// A section is a heading row as `fli outline` names it — one reader of what a
// markdown file's sections are, so the two commands cannot disagree.

import { readFileSync }                 from 'node:fs'
import { dirname, relative, resolve }   from 'node:path'
import { pathToFileURL }                from 'node:url'
import { splitFrontmatter, parseFrontmatter } from '@frontierjs/toolbelt/frontmatter'
import { outlineMarkdown, findRows, pathOf, MARKDOWN } from './outline.js'
import { markdownFiles }                from './doc-commands.js'

export { MARKDOWN }

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

/**
 * The heading row `query` names — `{ text, row }`, the section's own lines — or
 * `{ refused, rows }` when none or several do.
 */
export function section(text, query) {
  const rows  = outlineMarkdown(text)
  const found = findRows(rows, String(query))
  if (found.length === 1) {
    const [row] = found
    return { text: text.split('\n').slice(row.start - 1, row.end).join('\n'), row }
  }
  return {
    refused: found.length ? `${found.length} sections match ${query} — name one by its path:` : `no section matches ${query}`,
    rows:    found.map(r => `  ${r.start}-${r.end}  ${pathOf(r)}`),
  }
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
