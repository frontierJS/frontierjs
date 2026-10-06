/*
 * frontmatter.js — what a `---` block at the top of a file MEANS.
 *
 * One reader for sierra's scanner (the route table) and mesa's `.md` compiler
 * (the page module). Two readers read ksite's menus two ways — one as a list of
 * maps, the other as a stray top-level key — and neither said so (`FJS-1541`).
 *
 * A declared subset of YAML (`FJS-D533`, widened by `FJS-D549`):
 *
 *   key: value              block maps, nested up to 100 deep
 *   - item                  block lists, indented or at their key's own column
 *   text: |   /   text: >   literal and folded scalars, with - / + and a digit
 *   tags: [a, b]   at: {x: 1}   flow collections, over several lines if need be
 *   'single'   "double \n"  quoted scalars
 *
 * Scalars resolve by YAML 1.2's core schema, so a date stays the string written:
 * `2024-01-05` is a timestamp only in YAML 1.1, and the value is JSON on every
 * path out of here anyway.
 *
 * REFUSED BY NAME rather than misread: anchors, aliases, tags, merge keys,
 * complex keys, directives, a tab in the indentation. Aliases are the part that
 * let six lines expand to 9^8 values in a generated routes file (`FJS-821`) —
 * without them a block's output is linear in its text, so no expansion bound is
 * needed downstream.
 */

const MAX_DEPTH = 100

const FENCE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/**
 * Where the fences are. A caller reporting a refused block still has the body
 * to show, so the split is its own answer.
 *
 * @param {string} source
 * @returns {{ block: string|null, body: string }} `block` is null with no fence
 */
export function splitFrontmatter(source) {
  const m = FENCE.exec(source)
  return m ? { block: m[1] ?? '', body: source.slice(m[0].length) } : { block: null, body: source }
}

/**
 * Split a file into its frontmatter and the rest.
 *
 * @param {string} source
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 * @throws {Error} on a block outside the subset; the message and `.line` name
 *   the line, counted from the top of the FILE
 */
export function parseFrontmatter(source) {
  const { block, body } = splitFrontmatter(source)
  return { frontmatter: block === null ? {} : read(block, 1), body }
}

/**
 * Read the text between the fences.
 *
 * @param {string} text
 * @returns {Record<string, unknown>}
 * @throws {Error} as `parseFrontmatter`, lines counted from the top of `text`
 */
export function parseFrontmatterBlock(text) {
  return read(text, 0)
}

/**
 * The text to write after `key: ` so this reader reads back exactly `value`.
 * A scaffold interpolating a person's words into a block wrote `description:
 * Fix: the login` and got a refusal, or `alias: a # b` and got `a`.
 *
 * Plain where plain reads back as itself, otherwise double-quoted — a JSON
 * string is a valid YAML double-quoted scalar, escapes included.
 *
 * @param {unknown} value written as `String(value)`
 * @returns {string}
 */
export function frontmatterValue(value) {
  const s = String(value)
  if (!/[\r\n]/.test(s)) {
    try { if (read('k: ' + s, 0).k === s) return s } catch {}
  }
  return JSON.stringify(s)
}

// ─── scalars ─────────────────────────────────────────────────────────────────

const NULL = /^(?:~|null|Null|NULL)?$/
const TRUE = /^(?:true|True|TRUE)$/
const FALSE = /^(?:false|False|FALSE)$/
const INT = /^[-+]?[0-9]+$/
const OCT = /^0o[0-7]+$/
const HEX = /^0x[0-9a-fA-F]+$/
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/
const INF = /^[-+]?\.(?:inf|Inf|INF)$/
const NAN = /^\.(?:nan|NaN|NAN)$/

function resolve(s) {
  if (NULL.test(s)) return null
  if (TRUE.test(s)) return true
  if (FALSE.test(s)) return false
  if (INT.test(s) || FLOAT.test(s)) return Number(s)
  if (OCT.test(s)) return parseInt(s.slice(2), 8)
  if (HEX.test(s)) return parseInt(s.slice(2), 16)
  if (INF.test(s)) return s[0] === '-' ? -Infinity : Infinity
  if (NAN.test(s)) return NaN
  return s
}

const ESCAPES = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f',
  r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\x85', _: '\xa0', L: ' ', P: ' ',
}
const HEX_ESCAPE = { x: 2, u: 4, U: 8 }

// `__proto__` is a legal key, and assignment would reach the prototype's setter
// instead of making one (`FJS-996`).
function put(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true })
}

// ─── the reader ──────────────────────────────────────────────────────────────

function read(text, offset) {
  const lines = text.split(/\r?\n/)
  let i = 0
  let depth = 0

  const fail = (message, at = i) => {
    const err = new Error(`line ${at + 1 + offset}: ${message}`)
    err.line = at + 1 + offset
    throw err
  }

  const refusals = {
    '&': 'an anchor (&name) is not read in frontmatter — write the value out where it is used',
    '*': 'an alias (*name) is not read in frontmatter — write the value out where it is used',
    '!': 'a tag (!name) is not read in frontmatter — a value is what it reads as; quote it to make it text',
    '@': 'a value cannot start with @ — quote it',
    '`': 'a value cannot start with a backtick — quote it',
    '%': 'a value cannot start with % — quote it',
  }

  const indentOf = (s) => {
    let n = 0
    while (s[n] === ' ') n++
    return n
  }
  const isBlank = (s) => /^\s*(?:#.*)?$/.test(s)
  const isItem = (s, n) => s[n] === '-' && (s.length === n + 1 || s[n + 1] === ' ')

  // The indent of the next line that carries structure, with `i` moved onto it;
  // -1 at the end.
  function next() {
    while (i < lines.length && isBlank(lines[i])) i++
    if (i >= lines.length) return -1
    const s = lines[i]
    const n = indentOf(s)
    if (s[n] === '\t') fail('this line is indented with a tab — YAML indents with spaces')
    if (n === 0 && s[0] === '%') fail('a directive (%) is not read in frontmatter')
    if (n === 0 && /^\.\.\.(?:\s|$)/.test(s)) fail('a document end (...) is not read in frontmatter')
    return n
  }

  // `{ key, rest }` when `s` (a line from its first character) is a map entry,
  // otherwise null.
  function entryOf(s, at = i) {
    if (s[0] === '"' || s[0] === "'") {
      const close = closingQuote(s, 1, s[0])
      if (close === -1) return null
      const after = s.slice(close + 1).trimStart()
      if (after[0] !== ':' || (after.length > 1 && after[1] !== ' ')) return null
      return { key: unquote(s.slice(1, close), s[0], at), rest: after.slice(1).trimStart() }
    }
    if (s[0] === '?' && (s.length === 1 || s[1] === ' ')) fail('a complex key (?) is not read in frontmatter', at)
    if (/^<<\s*:(?:\s|$)/.test(s)) fail('a merge key (<<) is not read in frontmatter — write the keys out', at)
    if (refusals[s[0]] && s[0] !== '%') fail(refusals[s[0]], at)
    if (s[0] === '[' || s[0] === '{' || s[0] === '#') return null
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '#' && k > 0 && (s[k - 1] === ' ' || s[k - 1] === '\t')) return null
      if (s[k] === ':' && (k + 1 === s.length || s[k + 1] === ' ' || s[k + 1] === '\t')) {
        const raw = s.slice(0, k).trimEnd()
        if (raw === '') fail('a line cannot start with `:` — this needs a key', at)
        const r = resolve(raw)
        return { key: r === null ? 'null' : String(r), rest: s.slice(k + 1).trimStart() }
      }
    }
    return null
  }

  // A block node whose first line is the current one, at indent `n`. Depth is
  // bounded so a hostile block is refused by name rather than by a stack
  // overflow that names nothing.
  function node(n) {
    if (++depth > MAX_DEPTH) fail(`nested more than ${MAX_DEPTH} deep`)
    const v = nodeAt(n)
    depth--
    return v
  }

  function nodeAt(n) {
    const s = lines[i]
    if (isItem(s, n)) return sequence(n)
    if (entryOf(s.slice(n))) return mapping(n)
    const line = i++
    return value(s.slice(n), n - 1, line, false)
  }

  function mapping(n) {
    const out = {}
    for (;;) {
      const at = next()
      if (at === -1 || at < n) return out
      if (at > n) fail('this line is indented deeper than the key above it, which already has a value')
      const s = lines[i]
      if (isItem(s, n)) return out
      const entry = entryOf(s.slice(n))
      if (!entry) fail('expected `key: value`')
      if (Object.hasOwn(out, entry.key)) fail(`\`${entry.key}\` is declared twice`)
      const line = i++
      put(out, entry.key, value(entry.rest, n, line, false))
    }
  }

  function sequence(n) {
    const out = []
    for (;;) {
      const at = next()
      if (at === -1 || at < n) return out
      if (at > n) fail('this line is indented deeper than the list item above it')
      const s = lines[i]
      // A key at the list's own column ends a list written under that key.
      if (!isItem(s, n)) return out
      let col = n + 1
      while (s[col] === ' ') col++
      const rest = s.slice(col)
      if (rest === '' || rest[0] === '#') {
        i++
        out.push(nested(n, true))
      } else if (isItem(rest, 0) || entryOf(rest)) {
        // A collection opening on the dash's own line: read it as though the
        // dash were a space, so its later lines line up under its first.
        lines[i] = ' '.repeat(col) + rest
        out.push(node(col))
      } else {
        const line = i++
        out.push(value(rest, n, line, true))
      }
    }
  }

  // What follows `key:` or `-` when the line itself holds nothing more.
  function nested(n, inList) {
    const at = next()
    if (at === -1) return null
    if (at > n) return node(at)
    if (at === n && !inList && isItem(lines[i], n)) return sequence(n)
    return null
  }

  // The value written after `key: ` or `- ` on line `line`, its parent at `n`.
  function value(rest, n, line, inList) {
    if (rest === '' || rest[0] === '#') return nested(n, inList)
    const c = rest[0]
    if (refusals[c]) fail(refusals[c], line)
    if (isItem(rest, 0)) fail('a list starts on the line after its key', line)
    if (c === '|' || c === '>') return blockScalar(rest, n, line)
    if (c === '[' || c === '{') return flow(rest, line)
    if (c === '"' || c === "'") return quoted(rest, line)
    return plain(rest, n, line)
  }

  // ─── plain ───

  function cutComment(s) {
    const m = /[ \t]#/.exec(s)
    return m ? { text: s.slice(0, m.index).trimEnd(), cut: true } : { text: s.trimEnd(), cut: false }
  }

  function plain(rest, n, line) {
    let { text, cut } = cutComment(rest)
    if (/:(?:\s|$)/.test(text)) fail("quote this value — it holds `: `, which reads as a second key", line)
    let blanks = 0
    while (!cut && i < lines.length) {
      const s = lines[i]
      if (s.trim() === '') { blanks++; i++; continue }
      const ind = indentOf(s)
      if (ind <= n || s[ind] === '#') break
      const more = cutComment(s.slice(ind))
      if (/:(?:\s|$)/.test(more.text)) fail('this line is indented deeper than the key above it, which already has a value')
      text += blanks ? '\n'.repeat(blanks) + more.text : ' ' + more.text
      blanks = 0
      cut = more.cut
      i++
    }
    return resolve(text)
  }

  // ─── quoted ───

  function closingQuote(s, from, q) {
    for (let k = from; k < s.length; k++) {
      if (q === '"' && s[k] === '\\') { k++; continue }
      if (s[k] === q) {
        if (q === "'" && s[k + 1] === "'") { k++; continue }
        return k
      }
    }
    return -1
  }

  function unquote(raw, q, line) {
    if (q === "'") return raw.replace(/''/g, "'")
    let out = ''
    for (let k = 0; k < raw.length; k++) {
      if (raw[k] !== '\\') { out += raw[k]; continue }
      const e = raw[++k]
      if (e in ESCAPES) { out += ESCAPES[e]; continue }
      const width = HEX_ESCAPE[e]
      const digits = width && raw.slice(k + 1, k + 1 + width)
      if (!width || !/^[0-9a-fA-F]+$/.test(digits) || digits.length !== width) {
        fail(`\`\\${e ?? ''}\` is not an escape in a double-quoted value`, line)
      }
      out += String.fromCodePoint(parseInt(digits, 16))
      k += width
    }
    return out
  }

  // Scanned a line at a time: neither an escape nor a doubled '' spans a line
  // break, and growing one string and rescanning it made an unclosed quote over
  // 100k lines take most of a minute.
  function quoted(rest, line) {
    const q = rest[0]
    const parts = []
    let cur = rest
    let start = 1
    let close = closingQuote(cur, start, q)
    while (close === -1) {
      parts.push(cur.slice(start))
      if (i >= lines.length) fail('this quoted value never closes', line)
      cur = lines[i++]
      start = 0
      close = closingQuote(cur, 0, q)
    }
    parts.push(cur.slice(start, close))
    if (!/^\s*(?:#.*)?$/.test(cur.slice(close + 1))) fail('text after the closing quote', i - 1)
    return unquote(fold(parts.join('\n'), q), q, line)
  }

  // A line break inside quotes is a space, and an empty line is a newline.
  function fold(raw, q) {
    if (!raw.includes('\n')) return raw
    const ls = raw.split('\n')
    let out = ''
    let blanks = 0
    let glue = false
    for (let k = 0; k < ls.length; k++) {
      const last = k === ls.length - 1
      let seg = k > 0 ? ls[k].trimStart() : ls[k]
      if (!last) seg = seg.trimEnd()
      if (k > 0 && seg === '' && !last) { blanks++; continue }
      if (k > 0) out += glue ? '' : blanks ? '\n'.repeat(blanks) : ' '
      blanks = 0
      glue = false
      // An escaped line break joins the lines with nothing between them.
      if (q === '"' && !last && /(?:^|[^\\])(?:\\\\)*\\$/.test(seg)) {
        seg = seg.slice(0, -1)
        glue = true
      }
      out += seg
    }
    return out
  }

  // ─── block scalars ───

  function blockScalar(rest, n, line) {
    const m = /^([|>])([-+]?)([1-9]?)([-+]?)\s*(?:#.*)?$/.exec(rest)
    if (!m || (m[2] && m[4])) fail('a block scalar opens with | or >, then optionally - or + and one indent digit', line)
    const folding = m[1] === '>'
    const chomp = m[2] || m[4]
    let indent = m[3] ? n + Number(m[3]) : 0
    let out = ''
    let empty = 0
    let did = false
    let moreIndented = false
    while (i < lines.length) {
      const s = lines[i]
      const ind = indentOf(s)
      if (!indent) {
        if (s.trim() === '') { empty++; i++; continue }
        if (ind <= n) break
        indent = ind
      }
      if (ind < indent && s.trim() !== '') break
      const c = s.slice(indent)
      if (ind < indent || c === '') { empty++; i++; continue }
      if (folding) {
        if (c[0] === ' ' || c[0] === '\t') {
          moreIndented = true
          out += '\n'.repeat(did ? 1 + empty : empty)
        } else if (moreIndented) {
          moreIndented = false
          out += '\n'.repeat(empty + 1)
        } else if (empty === 0) {
          if (did) out += ' '
        } else {
          out += '\n'.repeat(empty)
        }
      } else {
        out += '\n'.repeat(did ? 1 + empty : empty)
      }
      out += c
      did = true
      empty = 0
      i++
    }
    if (chomp === '+') out += '\n'.repeat(did ? 1 + empty : empty)
    else if (chomp !== '-' && did) out += '\n'
    return out
  }

  // ─── flow collections ───

  function flow(rest, line) {
    // Gather lines until the brackets balance, dropping comments as they go.
    let src = ''
    let depth = 0
    let q = null
    let s = rest
    let end = -1
    for (;;) {
      for (let k = 0; k < s.length; k++) {
        const c = s[k]
        if (q) {
          if (q === '"' && c === '\\') { k++; continue }
          if (c === q) {
            if (q === "'" && s[k + 1] === "'") { k++; continue }
            q = null
          }
          continue
        }
        if (c === '"' || c === "'") q = c
        else if (c === '#' && (k === 0 || s[k - 1] === ' ' || s[k - 1] === '\t')) { s = s.slice(0, k); break }
        else if (c === '[' || c === '{') {
          if (++depth > MAX_DEPTH) fail(`nested more than ${MAX_DEPTH} deep`, line)
        } else if (c === ']' || c === '}') {
          if (--depth === 0) { end = src.length + k + 1; break }
        }
      }
      src += s
      if (end !== -1) break
      if (i >= lines.length) fail('this [ ] or { } never closes', line)
      s = lines[i++].trim()
      src += ' '
    }
    if (src.slice(end).trim() !== '') fail('text after the closing bracket', i - 1)

    let p = 0
    const ws = () => { while (src[p] === ' ' || src[p] === '\t') p++ }
    const stops = (k) => {
      const c = src[k]
      if (c === undefined || c === ',' || c === '[' || c === ']' || c === '{' || c === '}') return true
      if (c === ':') { const d = src[k + 1]; return d === undefined || d === ' ' || d === ',' || d === ']' || d === '}' }
      return false
    }

    function scalar() {
      const c = src[p]
      if (c === '"' || c === "'") {
        const close = closingQuote(src, p + 1, c)
        const raw = src.slice(p + 1, close)
        p = close + 1
        return unquote(raw, c, line)
      }
      if (refusals[c]) fail(refusals[c], line)
      if (c === '|' || c === '>') fail('a block scalar cannot open inside [ ] or { }', line)
      const start = p
      while (!stops(p)) p++
      const raw = src.slice(start, p).trim()
      if (raw === '') fail('an empty entry inside [ ] or { }', line)
      return resolve(raw)
    }

    function item() {
      ws()
      const c = src[p]
      if (c === '[') {
        p++
        const out = []
        for (;;) {
          ws()
          if (src[p] === ']') { p++; return out }
          const v = item()
          ws()
          if (src[p] === ':') fail('a `key: value` inside [ ] — write it inside { }', line)
          out.push(v)
          if (src[p] === ',') p++
          else if (src[p] !== ']') fail('expected `,` or `]`', line)
        }
      }
      if (c === '{') {
        p++
        const out = {}
        for (;;) {
          ws()
          if (src[p] === '}') { p++; return out }
          if (src[p] === '[' || src[p] === '{') fail('a key inside { } is a word or a quoted string', line)
          const r = scalar()
          const key = r === null ? 'null' : String(r)
          ws()
          let v = null
          if (src[p] === ':') {
            p++
            ws()
            if (src[p] !== ',' && src[p] !== '}') v = item()
            ws()
          }
          if (Object.hasOwn(out, key)) fail(`\`${key}\` is declared twice`, line)
          put(out, key, v)
          if (src[p] === ',') p++
          else if (src[p] !== '}') fail('expected `,` or `}`', line)
        }
      }
      return scalar()
    }

    return item()
  }

  // ─── the document ───

  const n = next()
  if (n === -1) return {}
  const first = lines[i].slice(n)
  let root
  if (first[0] === '{') {
    const line = i++
    root = flow(first, line)
  } else if (isItem(lines[i], n) || !entryOf(first)) {
    fail('frontmatter is `key: value` lines, and this one is not')
  } else {
    root = mapping(n)
  }
  if (next() !== -1) {
    fail(isItem(lines[i], n) ? 'a list item where a key was expected' : 'this line is indented less than the keys above it')
  }
  return root
}
