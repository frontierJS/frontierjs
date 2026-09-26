// ─────────────────────────────────────────────────────────────────────────────
//  format.ts — the `.lite` formatter.
//
//  A formatter may change whitespace and nothing else. Two layers hold that:
//
//    1. Alignment only touches a line it can prove OPENS a field — starting at
//       the model body's own depth, outside any string, comment or bracket,
//       shaped `name type rest`. A continuation line, a nested
//       `@@transitions(field) { … }` body, a wrapped attribute message: all are
//       kept byte for byte, because reading them as a field is what cut
//       `pay: pending -> paid,` to `pay: pending` (FJS-1341).
//    2. `formatLite` compares the source and its output with every whitespace
//       character removed, and token for token through litestone's own lexer
//       when one is given. Any difference returns the source unchanged, so a
//       shape the first layer misreads costs an unformatted file, not a
//       rewritten one.
// ─────────────────────────────────────────────────────────────────────────────

export type Tokenize = (src: string) => { type: string; value: unknown }[]

interface Line {
  raw:        string
  startsIn:   boolean   // begins inside a string, template or block comment
  startDepth: Depth
}

interface Depth { brace: number; paren: number; bracket: number }

interface Field { name: string; type: string; rest: string; text: string }

const FIELD = /^(\w+)\s+([^\s@/]+)(?:\s+(@.*|\/\/.*))?$/

// ─── Scanner ──────────────────────────────────────────────────────────────────

// One pass over the text, recording lexical state at every line boundary. The
// lexer below is litestone's shape: `"…"` and `'…'` with `\` escapes, `` `…` ``,
// `//` to end of line, `/* … */`.
function scan(src: string): Line[] {
  const out: Line[] = []
  const depth = { brace: 0, paren: 0, bracket: 0 }
  let mode: '' | '"' | "'" | '`' | '/*' = ''

  for (const raw of src.split('\n')) {
    const startsIn   = mode !== ''
    const startDepth = { ...depth }
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (mode === '/*') {
        if (c === '*' && raw[i + 1] === '/') { mode = ''; i++ }
        continue
      }
      if (mode) {
        if (c === '\\') { i++; continue }
        if (c === mode) mode = ''
        continue
      }
      if (c === '/' && raw[i + 1] === '/') break
      if (c === '/' && raw[i + 1] === '*') { mode = '/*'; i++; continue }
      if (c === '"' || c === "'" || c === '`') { mode = c; continue }
      if (c === '{') depth.brace++
      else if (c === '}') depth.brace--
      else if (c === '(') depth.paren++
      else if (c === ')') depth.paren--
      else if (c === '[') depth.bracket++
      else if (c === ']') depth.bracket--
    }
    // A quote left open at end of line stays open: the lines after it are left
    // alone, which is the conservative reading whatever the lexer would do.
    out.push({ raw, startsIn, startDepth })
  }
  return out
}

const atBody = (d: Depth) => d.brace === 1 && d.paren === 0 && d.bracket === 0

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Does `line` open a field declaration directly inside a model body? Only where
 * the line STARTS is asked: a field whose attribute wraps onto the next line is
 * still aligned, and the continuation is refused by its own start state.
 */
function fieldOf(line: Line, inModel: boolean) {
  if (!inModel || line.startsIn || !atBody(line.startDepth)) return null
  const m = line.raw.trim().match(FIELD)
  return m ? { name: m[1], type: m[2], rest: m[3] ?? '' } : null
}

/** The aligner alone, with no guard — exported so the suite can grade it. */
export function layout(src: string): string {
  const lines = scan(src)
  const out: (string | Field)[] = []

  // Every field line of one model shares one column set — the house aligns a
  // model as a whole, across its blank lines and comments.
  let model: Field[] = []
  const settle = () => {
    const n = Math.max(0, ...model.map(f => f.name.length))
    const t = Math.max(0, ...model.map(f => f.type.length))
    for (const f of model) {
      f.text = `  ${f.name.padEnd(n)} ${f.rest ? f.type.padEnd(t) + ' ' + f.rest : f.type}`.trimEnd()
    }
    model = []
  }

  let inModel = false
  for (const line of lines) {
    // A top-level line opening a block decides what the block is; the body
    // lasts until brace depth returns to zero, so a nested `{ … }` inside it
    // stays inside it.
    if (line.startDepth.brace === 0 && !line.startsIn) {
      settle()
      inModel = /^(extend\s+)?model\s/.test(line.raw.trim())
    }

    const f = fieldOf(line, inModel)
    if (f) { const field = { ...f, text: '' }; model.push(field); out.push(field); continue }

    if (line.startsIn) { out.push(line.raw); continue }
    const trimmed = line.raw.trimEnd()
    if (trimmed === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(trimmed)
  }
  settle()

  const text = out.map(l => typeof l === 'string' ? l : l.text)
  while (text.length && text[text.length - 1] === '') text.pop()
  return text.join('\n') + '\n'
}

/** Only whitespace differs between `a` and `b`. */
export function sameContent(a: string, b: string, tokenize?: Tokenize | null): boolean {
  if (a.replace(/\s+/g, '') !== b.replace(/\s+/g, '')) return false
  if (!tokenize) return true
  let ta, tb
  try { ta = tokenize(a) } catch { return true }   // the source does not lex; the strip check is all there is
  try { tb = tokenize(b) } catch { return false }
  if (ta.length !== tb.length) return false
  return ta.every((t, i) => t.type === tb[i].type && t.value === tb[i].value)
}

/** The formatted text, or `src` itself when formatting would change more than whitespace. */
export function formatLite(src: string, tokenize?: Tokenize | null): string {
  const formatted = layout(src)
  return sameContent(src, formatted, tokenize) ? formatted : src
}
