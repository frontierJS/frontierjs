/*
 * textedit.js — a page's text, changed where its source wrote it, with no model.
 *
 * A text edit is the swap of an element's visible words for new ones, made in
 * the `.mesa` or `.md` file its `data-fjs-loc` names. The answer is a span and
 * the new text as the source spells it, or `{ why }` when the swap cannot be
 * made without guessing: the words interpolated, split by markup, written more
 * than once where the element was, or the new words carrying markup. A caller
 * that gets a `why` hands the edit to something that can judge it — the ask
 * panel's model, or a form for the field.
 *
 * The caller is the ask panel's `/text` route (`@frontierjs/cli`
 * `core/vite-ask.js`), which holds the file on a dev server's disk. The swap
 * takes the source as text and returns a span, so a caller holding the file
 * as a git blob makes the same edit.
 *
 * Usage:
 *   const r = locateText(src, { ext: 'mesa', line: 6, col: 3, tag: 'h1', old: 'Hello world', next: 'Hi' })
 *   if (!r.why) src = src.slice(0, r.start) + r.text + src.slice(r.end)
 */

import { splitFrontmatter } from '../frontmatter/frontmatter.js'

// The index just past the `>` closing the tag that opens at `at`. A `>` inside
// a quoted attribute or a `{…}` expression does not close it.
function tagEnd(src, at) {
  let quote = null, depth = 0
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === quote) quote = null }
    else if (c === '"' || c === "'") quote = c
    else if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (c === '>' && !depth) return i + 1
  }
  return src.length
}

// The index just past the `}` closing the expression that opens at `at`.
function braceEnd(src, at) {
  let quote = null, depth = 0
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null }
    else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}' && !--depth) return i + 1
  }
  return src.length
}

// What `walk` steps over: a comment, a tag, a script or style block whole, an
// expression. The text between them is what a person reads on the page.
function step(src, i) {
  if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); return { kind: 'skip', end: e === -1 ? src.length : e + 3 } }
  if (src[i] === '<' && /[A-Za-z/]/.test(src[i + 1] ?? '')) {
    const m = /^<(\/?)([A-Za-z][\w.:-]*)/.exec(src.slice(i, i + 80))
    const end = tagEnd(src, i)
    if (!m) return { kind: 'skip', end }
    if (!m[1] && /^(script|style)$/i.test(m[2])) {
      const close = src.indexOf(`</${m[2]}`, end)
      return { kind: 'skip', end: close === -1 ? src.length : tagEnd(src, close) }
    }
    return { kind: m[1] ? 'close' : src[end - 2] === '/' ? 'empty' : 'open', name: m[2], end }
  }
  if (src[i] === '{') return { kind: 'skip', end: braceEnd(src, i) }
  return null
}

const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i

// The source span of the element whose open tag starts at `at`, or null.
function elementSpan(src, at, name) {
  const first = step(src, at)
  if (!first || first.kind !== 'open' || VOID.test(name)) return null
  let depth = 1
  for (let i = first.end; i < src.length;) {
    const s = step(src, i)
    if (!s) { i++; continue }
    if (s.name === name && s.kind === 'open') depth++
    if (s.name === name && s.kind === 'close' && !--depth) return { start: at, end: s.end }
    i = s.end
  }
  return null
}

// The plain-text runs of src between from and to.
function textRuns(src, from, to) {
  const out = []
  let start = from
  for (let i = from; i < to;) {
    const s = step(src, i)
    if (!s) { i++; continue }
    if (i > start) out.push([start, i])
    i = start = s.end
  }
  if (to > start) out.push([start, to])
  return out
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The page shows a character the source may have written as an entity:
// `Before &amp; after` reads `Before & after`.
const ENTITIES = {
  '&': ['&amp;', '&#38;'], '<': ['&lt;', '&#60;'], '>': ['&gt;', '&#62;'], '"': ['&quot;', '&#34;'], "'": ['&apos;', '&#39;'],
  '\u00a0': ['&nbsp;', '&#160;'], '—': ['&mdash;'], '–': ['&ndash;'], '…': ['&hellip;'], '©': ['&copy;'],
  '’': ['&rsquo;'], '‘': ['&lsquo;'], '“': ['&ldquo;'], '”': ['&rdquo;'],
}
const charRe = ch => ENTITIES[ch] ? `(?:${[ch, ...ENTITIES[ch]].map(escapeRe).join('|')})` : escapeRe(ch)
// Characters that would turn the new text into an expression or (in Markdown)
// emphasis, a link or HTML. A text edit carrying one is a change to the
// source's structure, which is the model's job. In a `.mesa` template the
// three HTML has entities for are written as entities instead.
const MARKUP = { mesa: /[{}]/, md: /[<>{}*_`[\]\\]/ }
const encode = { mesa: t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), md: t => t }

/**
 * Where to swap `old` for `next` in a source file, and `text`, the new text as
 * the source writes it — or `{ why }` when it cannot
 * be done without guessing. `line`/`col` is the element's `data-fjs-loc` and
 * `tag` its name; a `.mesa` element is searched between its own open and close
 * tags. In a `.md` file the whole body is searched and never the frontmatter,
 * so the same words twice anywhere in the body are refused. Whitespace in `old`
 * matches any run of it, since the page collapsed what the source wrapped.
 */
export function locateText(src, { ext, line, col, tag, old, next }) {
  const words = String(old ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { why: 'the element has no text of its own' }
  if (MARKUP[ext]?.test(next)) return { why: 'the new text holds markup characters' }

  let from = 0, to = src.length
  if (ext === 'mesa') {
    const lines = src.split('\n')
    if (line < 1 || line > lines.length) return { why: 'the source has changed since the page was built' }
    const lineStart = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    const lineText = lines[line - 1]
    const open = new RegExp(`<${escapeRe(tag)}(?![\\w.:-])`, 'g')
    let at = lineText.slice(col - 1).match(new RegExp(`^<${escapeRe(tag)}(?![\\w.:-])`)) ? col - 1 : lineText.search(open)
    if (at === -1) return { why: 'the element is not where the page says it was written' }
    const span = elementSpan(src, lineStart + at, tag)
    if (!span) return { why: 'the element has no closing tag to search up to' }
    from = span.start
    to = span.end
  } else {
    from = src.length - splitFrontmatter(src).body.length
  }

  // A word boundary at each end where the text has one, so `Item` is not found
  // inside `Items`.
  const edge = (w, side) => /\w/.test(side === 'start' ? w[0] : w.at(-1)) ? (side === 'start' ? '(?<!\\w)' : '(?!\\w)') : ''
  const re = new RegExp(edge(words[0], 'start') + words.map(w => [...w].map(charRe).join('')).join('\\s+') + edge(words.at(-1), 'end'), 'g')
  const hits = []
  for (const [a, b] of textRuns(src, from, to))
    for (const m of src.slice(a, b).matchAll(re)) hits.push({ start: a + m.index, end: a + m.index + m[0].length })
  if (!hits.length) return { why: 'the text is not written in the source — it is interpolated, or split by markup' }
  if (hits.length > 1) return { why: `the text occurs ${hits.length} times where the element was written` }
  return { start: hits[0].start, end: hits[0].end, from, to, text: encode[ext](next) }
}
