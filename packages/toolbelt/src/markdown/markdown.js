/*
 * markdown.js — Markdown text → HTML, with nothing in it the text did not say.
 *
 * `IDEAS/markdown-kit.md` option C: a small safe subset, zero dependencies,
 * the same pure function at prerender and in the browser (`FJS-D821`). The
 * text it is written for is somebody else's — a `@syntax(md)` column a
 * stranger filled, a model's reply in a chat — so the one property is that
 * no input reaches the page as markup:
 *
 *   - **Raw HTML is never passed through.** `<b>` in the source is the four
 *     characters `<b>` on the page. There is no sanitizer to configure because
 *     there is nothing to sanitize: every slice of the source is escaped, and
 *     the only tags in the answer are the ones this file writes.
 *   - **A link goes only where a link may go.** `http:`, `https:`, `mailto:`
 *     and a relative path. Any other scheme — `javascript:`, `data:`,
 *     `vbscript:`, spelled with tabs or case in it — draws the text and no
 *     anchor. An entity in a URL is escaped, never decoded, so `javascript&#58;`
 *     cannot become a colon in the browser after the check passed.
 *   - **An image is a link to it.** `![alt](src)` loading on sight would let
 *     anyone who writes the text learn who read it, and when.
 *
 * What it reads: ATX headings, paragraphs, hard breaks, fenced code (painted
 * by glow when the fence names a language), block quotes, bullet, ordered and
 * task lists with nesting, GFM pipe tables, thematic breaks; inline code,
 * emphasis, strong, `~~strikethrough~~`, links, `<autolinks>` and bare
 * `https://` URLs. Not read: setext headings, indented code, link reference
 * definitions, footnotes — each draws as the text it was.
 *
 * Usage:
 *   markdown('## Hello **world**')                → '<h2>Hello <strong>world</strong></h2>'
 *   markdown(reply, { headingBase: 3 })            → `#` is an <h3>, for a heading inside a page
 *   markdown(note, { breaks: true })               → every newline is a <br>, as a chat writes it
 */

import { glow } from '../glow/glow.js'

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c])

// In TEXT an entity may stand: `&lt;` decodes to a character, never to a tag.
// Everything else that starts with `&` is escaped.
const ENTITY = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/
const escText = (s) => {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '&') {
      const m = ENTITY.exec(s.slice(i, i + 40))
      if (m) { out += m[0]; i += m[0].length - 1; continue }
    }
    out += ESC[c] ?? c
  }
  return out
}

/*
 * The scheme is read off the URL with every control character and space
 * removed first, because a browser ignores them: `java\tscript:` runs.
 * Answers null for a URL that may not be a link.
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])
export function safeUrl(url) {
  if (typeof url !== 'string') return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what this pattern removes or refuses
  const bare = url.replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(bare)
  if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null
  // `//host` is another site with no scheme stated; it inherits http(s).
  return url.trim()
}

// A fence's language becomes an attribute glow writes; keep it a word.
const fenceLang = (info) => (/^[\w+#.-]{1,32}/.exec(info) ?? [''])[0].toLowerCase()

const PUNCT = /[!-/:-@[-`{-~¡-¿‐-‧‰-⁞]/
const SPACE = /\s/

/* ── Inline ─────────────────────────────────────────────────────────── */

/*
 * One pass over the text builds a flat list of tokens — finished HTML, or a
 * run of `*`, `_` or `~` that might open or close emphasis — and a second pass
 * pairs the runs (CommonMark's "process emphasis", with its flanking rules and
 * the rule of three). Links and code spans are finished in the first pass, so
 * no delimiter inside one can pair with one outside it.
 */
function inline(src, opts, inLink = false) {
  const toks = []
  let text = ''
  const flush = () => { if (text) { toks.push({ html: escText(text) }); text = '' } }
  const push = (html) => { flush(); toks.push({ html }) }

  for (let i = 0; i < src.length; ) {
    const c = src[i]

    if (c === '\\') {
      const n = src[i + 1]
      if (n === '\n') { push('<br>\n'); i += 2; continue }
      if (n && PUNCT.test(n)) { text += n; i += 2; continue }
      text += c; i++; continue
    }

    if (c === '`') {
      let run = 1
      while (src[i + run] === '`') run++
      const fence = '`'.repeat(run)
      let j = i + run
      let close = -1
      while ((j = src.indexOf(fence, j)) !== -1) {
        if (src[j + run] !== '`' && src[j - 1] !== '`') { close = j; break }
        while (src[j] === '`') j++
      }
      if (close === -1) { text += fence; i += run; continue }
      let code = src.slice(i + run, close).replace(/\n/g, ' ')
      if (code.length > 2 && code[0] === ' ' && code.at(-1) === ' ' && code.trim()) code = code.slice(1, -1)
      push(`<code>${esc(code)}</code>`)
      i = close + run
      continue
    }

    if (c === '\n') {
      // Two spaces before a newline are a hard break; `breaks` makes them all one.
      const hard = opts.breaks || / {2,}$/.test(text)
      text = text.replace(/ +$/, '')
      if (hard) push('<br>\n')
      else text += '\n'
      i++
      continue
    }

    if (c === '<' && !inLink) {
      const m = /^<((?:https?|mailto):[^\s<>]*|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/i.exec(src.slice(i))
      if (m) {
        const href = m[1].includes(':') ? m[1] : `mailto:${m[1]}`
        push(`<a href="${esc(href)}">${esc(m[1])}</a>`)
        i += m[0].length
        continue
      }
    }

    if ((c === '[' || (c === '!' && src[i + 1] === '[')) && !inLink) {
      const link = readLink(src, c === '!' ? i + 1 : i)
      if (link) {
        const label = c === '!' ? escText(link.text) || esc(link.url) : inline(link.text, opts, true)
        const href = safeUrl(link.url)
        const title = link.title ? ` title="${esc(link.title)}"` : ''
        push(href == null ? label : `<a href="${esc(href)}"${title}>${label}</a>`)
        i = link.end
        continue
      }
    }

    if (!inLink && (c === 'h' || c === 'w') && (i === 0 || /[\s*_~(]/.test(src[i - 1]))) {
      const m = /^(?:https?:\/\/|www\.)[^\s<]+/i.exec(src.slice(i))
      if (m) {
        let url = m[0].replace(/[?!.,:*_~'"]+$/, '')
        // A closing paren the URL did not open belongs to the sentence.
        while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1)
        if (url.length > 4 && !/^www\.$/i.test(url)) {
          const href = /^www\./i.test(url) ? `https://${url}` : url
          push(`<a href="${esc(href)}">${esc(url)}</a>`)
          i += url.length
          continue
        }
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      let run = 1
      while (src[i + run] === c) run++
      const before = i === 0 ? ' ' : src[i - 1]
      const after = src[i + run] ?? ' '
      const left = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before))
      const right = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after))
      const open = c === '_' ? left && (!right || PUNCT.test(before)) : left
      const close = c === '_' ? right && (!left || PUNCT.test(after)) : right
      if (c === '~' && run !== 2) { text += c.repeat(run); i += run; continue }
      flush()
      toks.push({ ch: c, n: run, orig: run, open, close, pre: [], post: [] })
      i += run
      continue
    }

    text += c
    i++
  }
  flush()
  pairEmphasis(toks)

  return toks.map((t) => t.ch
    ? t.post.join('') + t.ch.repeat(t.n) + t.pre.join('')
    : t.html).join('')
}

function pairEmphasis(toks) {
  for (let ci = 0; ci < toks.length; ci++) {
    const closer = toks[ci]
    if (!closer.ch || !closer.close) continue
    for (let oi = ci - 1; oi >= 0 && closer.n > 0; oi--) {
      const opener = toks[oi]
      if (!opener.ch || opener.ch !== closer.ch || !opener.open || opener.n === 0) continue
      if (closer.ch !== '~' && (opener.close || closer.open) &&
          (opener.orig + closer.orig) % 3 === 0 && !(opener.orig % 3 === 0 && closer.orig % 3 === 0)) continue
      if (closer.ch === '~' && opener.n !== 2) continue
      const use = closer.ch === '~' ? 2 : opener.n >= 2 && closer.n >= 2 ? 2 : 1
      const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em'
      opener.n -= use
      closer.n -= use
      // A later match on the same opener is an OUTER one, so its tag goes first.
      opener.pre.unshift(`<${tag}>`)
      closer.post.push(`</${tag}>`)
      // A delimiter between the two can no longer pair across them.
      for (let k = oi + 1; k < ci; k++) if (toks[k].ch) { toks[k].open = false; toks[k].close = false }
      if (opener.n > 0) oi++ // the same opener may still close more of this closer
    }
  }
}

/*
 * `[text](url "title")` starting at the `[`. The text may hold brackets that
 * balance and code spans; the destination may be `<…>` with spaces in it.
 */
function readLink(src, at) {
  let depth = 0
  let i = at
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (c === '`') {
      let run = 1
      while (src[i + run] === '`') run++
      const close = src.indexOf('`'.repeat(run), i + run)
      if (close !== -1) { i = close + run - 1; continue }
    }
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) break
  }
  if (depth !== 0 || src[i + 1] !== '(') return null
  const text = src.slice(at + 1, i)
  const rest = src.slice(i + 2)
  const m = /^[ \t\n]*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))(?:[ \t\n]+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'))?[ \t\n]*\)/.exec(rest)
  if (!m) return null
  const unescapeMd = (s) => s?.replace(/\\([!-/:-@[-`{-~])/g, '$1')
  return {
    text,
    url: unescapeMd(m[1] ?? m[2] ?? ''),
    title: unescapeMd(m[3] ?? m[4] ?? ''),
    end: i + 2 + m[0].length,
  }
}

/* ── Blocks ─────────────────────────────────────────────────────────── */

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*)$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/
const DELIM_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

const blank = (l) => !l.trim()
const tabs = (l) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, '    '))
const indentOf = (l) => /^ */.exec(l)[0].length

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells = []
  let cell = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cell += '|'; i++; continue }
    if (s[i] === '|') { cells.push(cell.trim()); cell = ''; continue }
    cell += s[i]
  }
  cells.push(cell.trim())
  return cells
}

const isTable = (lines, i) =>
  lines[i]?.includes('|') && lines[i + 1] != null && DELIM_ROW.test(lines[i + 1]) && lines[i + 1].includes('|') &&
  splitRow(lines[i]).length === splitRow(lines[i + 1]).length

// Whether a line starts a block that ends the paragraph before it.
function interrupts(lines, i) {
  const l = lines[i]
  if (FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || isTable(lines, i)) return true
  const item = ITEM.exec(l)
  // An ordered list breaks a paragraph only from 1, and an empty item never
  // does: a sentence that wraps onto `2024. was a year` is not a list.
  return !!item && item[4]?.trim() && (/^\d/.test(item[2]) ? parseInt(item[2], 10) === 1 : true)
}

function blocks(lines, opts) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (blank(line)) { i++; continue }

    let m
    // A backtick fence's info string may not hold a backtick: ```a``` is code inline.
    if ((m = FENCE.exec(line)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      const [, indent, fence, info] = m
      const close = new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}[ \\t]*$`)
      const dedent = new RegExp(`^ {0,${indent.length}}`)
      const body = []
      i++
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++].replace(dedent, ''))
      i++
      out.push(code(body.join('\n'), fenceLang(info.trim())))
      continue
    }

    if ((m = HEADING.exec(line))) {
      // A base read off an attribute is a string, and '3' + 1 is '31'.
      const base  = Math.min(6, Math.max(1, Math.trunc(Number(opts.headingBase ?? 1)) || 1))
      const level = Math.min(6, m[1].length + base - 1)
      out.push(`<h${level}>${inline(m[2], opts)}</h${level}>`)
      i++
      continue
    }

    if (RULE.test(line)) { out.push('<hr>'); i++; continue }

    if (QUOTE.test(line)) {
      const body = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''))
      out.push(`<blockquote>\n${blocks(body, opts)}\n</blockquote>`)
      continue
    }

    if (ITEM.test(line)) { i = list(lines, i, opts, out); continue }

    if (isTable(lines, i)) { i = table(lines, i, opts, out); continue }

    const para = [line.replace(/^[ \t]+/, '')]
    i++
    while (i < lines.length && !blank(lines[i]) && !interrupts(lines, i)) para.push(lines[i++].replace(/^[ \t]+/, ''))
    out.push(`<p>${inline(para.join('\n').replace(/[ \t]+$/, ''), opts)}</p>`)
  }
  return out.join('\n')
}

function code(text, lang) {
  // glow escapes every slice it emits; a fence with no language is escaped here.
  const painted = lang && text ? glow(text, { language: lang, prefix: false, mark: false }) : ''
  return painted ? `<pre>${painted}</pre>` : `<pre><code>${esc(text)}</code></pre>`
}

function list(lines, i, opts, out) {
  const first = ITEM.exec(lines[i])
  const ordered = /^\d/.test(first[2])
  const mark = first[2].at(-1)
  const items = []
  let loose = false
  let gapBefore = false

  while (i < lines.length) {
    const m = ITEM.exec(lines[i])
    if (!m || /^\d/.test(m[2]) !== ordered || m[2].at(-1) !== mark) break
    if (gapBefore) loose = true
    // Where the item's content starts: past the marker and its spaces, unless
    // those spaces are five or more, which is code that starts one space in.
    const pad = m[3] == null ? 1 : m[3].length > 4 ? 1 : tabs(m[3]).length
    const width = m[1].length + m[2].length + pad
    const body = [m[4] == null ? '' : (m[3]?.length > 4 ? m[3].slice(1) : '') + m[4]]
    i++
    gapBefore = false
    let gapInside = false
    while (i < lines.length) {
      const l = tabs(lines[i])
      if (blank(l)) {
        // A blank line is inside the item only when indented content follows.
        let j = i
        while (j < lines.length && blank(lines[j])) j++
        if (j < lines.length && indentOf(tabs(lines[j])) >= width) { body.push(...lines.slice(i, j).map(() => '')); gapInside = true; i = j; continue }
        gapBefore = j < lines.length && ITEM.test(lines[j]) && indentOf(lines[j]) < width
        i = j
        break
      }
      if (indentOf(l) >= width) { body.push(l.slice(width)); i++; continue }
      // A line that is not indented and starts nothing else continues the
      // item's last paragraph — a model wraps a long bullet that way.
      if (!blank(body.at(-1) ?? '') && !ITEM.test(l) && !interrupts(lines, i)) { body.push(l.trim()); i++; continue }
      break
    }
    if (gapInside) loose = true
    items.push(body)
  }

  const start = ordered ? parseInt(first[2], 10) : 1
  const tag = ordered ? 'ol' : 'ul'
  const html = items.map((body) => {
    let task = ''
    const box = /^\[([ xX])\][ \t]+/.exec(body[0])
    if (box) {
      task = `<input type="checkbox" disabled${box[1] === ' ' ? '' : ' checked'}> `
      body = [body[0].slice(box[0].length), ...body.slice(1)]
    }
    let inner = blocks(body, opts)
    // A tight list's paragraphs are drawn as their text.
    if (!loose) inner = inner.replace(/<p>([\s\S]*?)<\/p>/g, '$1')
    return `<li>${task}${inner}</li>`
  }).join('\n')
  out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>\n${html}\n</${tag}>`)
  return i
}

function table(lines, i, opts, out) {
  const head = splitRow(lines[i])
  const align = splitRow(lines[i + 1]).map((d) => d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : '')
  const cell = (tag, text, k) => `<${tag}${align[k] ? ` style="text-align: ${align[k]}"` : ''}>${inline(text ?? '', opts)}</${tag}>`
  const rows = []
  i += 2
  while (i < lines.length && !blank(lines[i]) && lines[i].includes('|') && !(FENCE.test(lines[i]) || HEADING.test(lines[i]) || QUOTE.test(lines[i]))) {
    const cells = splitRow(lines[i++])
    rows.push(`<tr>${head.map((_, k) => cell('td', cells[k], k)).join('')}</tr>`)
  }
  const cls = opts.classes?.table ? ` class="${esc(opts.classes.table)}"` : ''
  out.push(`<table${cls}>\n<thead>\n<tr>${head.map((h, k) => cell('th', h, k)).join('')}</tr>\n</thead>` +
    (rows.length ? `\n<tbody>\n${rows.join('\n')}\n</tbody>` : '') + '\n</table>')
  return i
}

/* ── Entry ──────────────────────────────────────────────────────────── */

/*
 * `opts.headingBase` is the level a `#` is drawn at — 3 inside a card whose
 * page already has an <h1> and <h2>. Deeper headings shift with it and stop
 * at <h6>. `opts.breaks` draws every newline in a paragraph as a <br>.
 * `opts.classes.table` is the class a <table> carries — the caller's
 * stylesheet's word for a table, which this file does not know.
 */
export function markdown(src, opts = {}) {
  if (src == null || src === '') return ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what this pattern removes or refuses
  const lines = String(src).replace(/\r\n?/g, '\n').replace(/\u0000/g, '\ufffd').split('\n')
  return blocks(lines, opts)
}

/* The same text with its markup dropped — a preview line, a title, a toast. */
export function markdownText(src) {
  return markdown(src)
    .replace(/<br>\n?/g, ' ')
    .replace(/<\/(p|h\d|li|tr|blockquote|pre)>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
