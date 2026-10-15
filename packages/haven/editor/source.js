// editor/source.js — a scene FILE (`src/scenes/<Name>.mesa`) read and written
// back as text.
//
// The editor's document is the file's markup: the `<Scene>` tag and the
// `<Piece>`, `<Row>`, `<Door>`, `<Pacer>` and `<Carousel>` tags inside it, one per line,
// each placed by its `x` and `y`. An export splices only what changed into
// the file's own text — an attribute's value, a removed tag's line, a tag
// added before `</Scene>`, the spawn, a palette entry's hexes, and the import
// of a shared piece the scene did not list yet. Everything else — comments,
// the scene's own piece blocks, the palette's shape — is the file's and is
// never regenerated, so a file opened and saved with no edit is the same
// bytes, and an edit moves only its own characters.
//
// One shape of file is read; another is refused by name rather than guessed
// at: a block (`{#each}`) in the markup, a tag the stage does not know, or a
// `<Scene>` with no `slug` and `spawn`.
//
// Pure: no DOM and no file system, so the round trip is a bun test.

const TAGS = ['Piece', 'Row', 'Door', 'Pacer', 'Carousel']
const TAG  = /<(Piece|Row|Door|Pacer|Carousel)\b((?:[^>]|>(?!\s*$))*?)\/>/g
const ATTR = /(\w+)=(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)")/g
const NUMBER = /^-?\d+$/

/** The markup half: everything after the last `</script>`. */
function markupOf(source) {
  const at = source.lastIndexOf('</script>')
  if (at === -1) throw new Error('no `</script>` — a scene file is a <script> and a <Scene> tree after it')
  return { start: at + '</script>'.length, text: source.slice(at + '</script>'.length) }
}

function attrsOf(text) {
  const out = {}
  for (const m of text.matchAll(ATTR)) {
    const [, name, expr, str] = m
    out[name] = str !== undefined ? str : NUMBER.test(expr.trim()) ? Number(expr.trim()) : expr.trim()
  }
  return out
}

/**
 * The scene the file draws: `{ slug, spawn, elements }`, each element
 * `{ id, kind, attrs, start, end }` in document order, `id` its index. An
 * attribute written `x={12}` is the number, `to="/"` the string, and any
 * other `{expr}` its text (`of={table}` is `'table'`).
 */
export function readScene(source) {
  const { start, text } = markupOf(source)
  if (/\{#/.test(text)) throw new Error('a block in the markup — the editor reads a flat list of placed tags')
  const scene = /<Scene\b([^>]*)>/.exec(text)
  if (!scene) throw new Error('no `<Scene …>` tag in the markup')
  const sa = attrsOf(scene[1])
  const spawn = /\{\s*\{\s*x:\s*(-?\d+),\s*y:\s*(-?\d+)\s*\}\s*\}/.exec(scene[1])
  if (!sa.slug || !spawn) throw new Error('`<Scene>` needs `slug="…"` and `spawn={{ x: N, y: N }}`')
  const elements = []
  for (const m of text.matchAll(TAG)) {
    elements.push({ id: elements.length, kind: m[1], attrs: attrsOf(m[2]), start: start + m.index, end: start + m.index + m[0].length })
  }
  const other = /<([A-Z]\w*)\b/g
  for (const m of text.matchAll(other)) {
    if (m[1] !== 'Scene' && !TAGS.includes(m[1])) throw new Error(`<${m[1]}> is not a tag the stage knows (${TAGS.join(', ')})`)
  }
  return { slug: sa.slug, spawn: { x: Number(spawn[1]), y: Number(spawn[2]) }, elements }
}

const splice = (s, start, end, text) => s.slice(0, start) + text + s.slice(end)

// A string is a quoted attribute, a number a braced one, and `{ expr }` is
// written as the expression itself — `of={table}` names a piece block.
const literal = (v) => (typeof v === 'string' ? `"${v}"` : v && typeof v === 'object' && 'expr' in v ? `{${v.expr}}` : `{${v}}`)

/** A tag's text with `values` written over its attributes, or added before `/>`. */
function withAttrs(tag, values) {
  let out = tag
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue
    const re = new RegExp(`\\b${name}=(?:\\{(?:[^{}]|\\{[^{}]*\\})*\\}|"[^"]*")`)
    out = re.test(out) ? out.replace(re, `${name}=${literal(value)}`) : out.replace(/\s*\/>$/, ` ${name}=${literal(value)} />`)
  }
  return out
}

/** The whole line of a tag that stands alone on it, newline included; else the tag. */
function lineOf(source, { start, end }) {
  const from = source.lastIndexOf('\n', start - 1) + 1
  const to   = source.indexOf('\n', end)
  const alone = source.slice(from, start).trim() === '' && source.slice(end, to === -1 ? undefined : to).trim() === ''
  return alone ? { start: from, end: to === -1 ? source.length : to + 1 } : { start, end }
}

function tagOf(add) {
  const attrs = Object.entries(add.attrs ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${literal(v)}`)
  return `<${add.kind} ${attrs.join(' ')} />`
}

function addTags(source, adds) {
  const { start, text } = markupOf(source)
  const close = text.lastIndexOf('</Scene>')
  if (close === -1) throw new Error('no `</Scene>` in the markup')
  const last = [...text.matchAll(TAG)].pop()
  const indent = last ? /\n([ \t]*)$/.exec(text.slice(0, last.index))?.[1] ?? '  ' : '  '
  const lines = adds.map((a) => `${indent}${tagOf(a)}\n`).join('')
  return splice(source, start + close, start + close, lines)
}

function addImport(source, ident, file) {
  if (new RegExp(`import \\{[^}]*\\b${ident}\\b[^}]*\\}\\s+from`).test(source)) return source
  const script = source.indexOf('</script>')
  const head = source.slice(0, script)
  const imports = [...head.matchAll(/^[ \t]*import .* from '[^']+'\n/gm)]
  const last = imports[imports.length - 1]
  const at = last ? last.index + last[0].length : 0
  const indent = last ? /^[ \t]*/.exec(last[0])[0] : '  '
  return splice(source, at, at, `${indent}import { ${ident} } from '@/pieces/${file}'\n`)
}

function writeSpawn(source, { x, y }) {
  const { start, text } = markupOf(source)
  const scene = /<Scene\b[^>]*>/.exec(text)
  const tag = scene[0].replace(/spawn=\{\{[^}]*\}\}/, `spawn={{ x: ${x}, y: ${y} }}`)
  return splice(source, start + scene.index, start + scene.index + scene[0].length, tag)
}

// The text of the object literal opening at `open` (a `{`), braces counted.
function objectAt(source, open) {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return { start: open, end: i + 1 }
  }
  throw new Error('an object literal in the scene file never closes')
}

function paletteBlock(source) {
  const i = source.indexOf('const PALETTE = {')
  if (i === -1) throw new Error('no `const PALETTE = {` in the scene file')
  return objectAt(source, source.indexOf('{', i))
}

function writePaletteEntry(source, key, hexes) {
  const block = paletteBlock(source)
  const text = source.slice(block.start, block.end)
  const line = new RegExp(`\\n(\\s*)${key}:\\s*\\{[^\\n]*\\},?`).exec(text)
  if (!line) {
    const indent = /\n(\s*)\w:/.exec(text)?.[1] ?? '    '
    const fg = hexes.length === 1 ? `'${hexes[0]}'` : `[${hexes.map((h) => `'${h}'`).join(', ')}]`
    const at = block.end - 1
    return splice(source, at, at, `${indent}${key}: { fg: ${fg} },\n`)
  }
  let n = 0
  const was = line[0]
  const now = was.replace(/'#[0-9a-fA-F]{3,8}'/g, (h) => (n < hexes.length ? `'${hexes[n++]}'` : h))
  const start = block.start + line.index
  return splice(source, start, start + was.length, now)
}

/**
 * The file with `edits` spliced in, each present only when it changed:
 * `elements` `{ [id]: { x, y, to, from } }` — attribute values by element id;
 * `remove` `[id]`; `add` `[{ kind, attrs, import?: { ident, file } }]`;
 * `spawn` `{ x, y }`; `palette` `{ [key]: [hex, …] }`.
 */
export function writeScene(source, edits) {
  let out = source
  const { elements } = readScene(out)
  const removed = new Set(edits.remove ?? [])
  // Highest offset first, so an earlier splice never moves a later one.
  for (const el of [...elements].reverse()) {
    if (removed.has(el.id)) {
      const { start, end } = lineOf(out, el)
      out = splice(out, start, end, '')
    } else if (edits.elements?.[el.id]) {
      out = splice(out, el.start, el.end, withAttrs(out.slice(el.start, el.end), edits.elements[el.id]))
    }
  }
  if (edits.add?.length) out = addTags(out, edits.add)
  if (edits.spawn) out = writeSpawn(out, edits.spawn)
  for (const [key, hexes] of Object.entries(edits.palette ?? {})) out = writePaletteEntry(out, key, hexes)
  for (const a of edits.add ?? []) if (a.import) out = addImport(out, a.import.ident, a.import.file)
  return out
}
