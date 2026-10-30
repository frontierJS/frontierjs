/*
 * tokenize.js — `.lite` source text → tokens.
 *
 * Litestone's, MOVED (`FJS-D287`): a schema and a flow expression are the same
 * language lexically, and two lexers is how a string, a number or an operator
 * comes to lex one way in a schema and another in an expression. Litestone
 * tokenizes a whole `.lite` file with it; orion tokenizes one expression.
 *
 * `parse.js` beside this reads what it emits. `ParseError` is here because the
 * lexer is the first thing that throws one, and both halves carry a position.
 */

export const TK = {
  IDENT:    'IDENT',
  STRING:   'STRING',
  TEMPLATE: 'TEMPLATE', // `…` — a template, never raw SQL
  NUMBER:   'NUMBER',
  DOTTED:   'DOTTED',   // 3.8.3.8 — a gate's levels, one per operation
  BOOL:     'BOOL',
  AT:       'AT',       // @
  ATAT:     'ATAT',     // @@
  ARROW:    'ARROW',    // ->
  FATARROW: 'FATARROW', // => — a lambda, in a flow expression
  DOLLAR:   'DOLLAR',   // $  — the run, in a flow expression
  LBRACE:   'LBRACE',   // {
  RBRACE:   'RBRACE',   // }
  LBRACKET: 'LBRACKET', // [
  RBRACKET: 'RBRACKET', // ]
  LPAREN:   'LPAREN',   // (
  RPAREN:   'RPAREN',   // )
  COMMA:    'COMMA',    // ,
  COLON:    'COLON',    // :
  QUESTION: 'QUESTION', // ?
  DOT:      'DOT',      // .
  COMMENT:  'COMMENT',  // /// doc comment
  EOF:      'EOF',
  // ── Policy expression operators ─────────────────────────────────────────
  OR:   'OR',   // ||
  AND:  'AND',  // &&
  BANG: 'BANG', // !
  EQ:   'EQ',   // ==
  NEQ:  'NEQ',  // !=
  LT:   'LT',   // <
  GT:   'GT',   // >
  LTE:  'LTE',  // <=
  GTE:  'GTE',  // >=
  // ── Arithmetic, and a time moved by a duration ──────────────────────────
  // `a * b + c` in an expression (`FJS-D1107`); `+`/`-` also move a time,
  // `now() + 2d` and `@@commitment(abandon, on: createdAt + 14d)`. There is no
  // `/`, so a `/` is still only the start of a comment.
  PLUS:  'PLUS',  // +
  MINUS: 'MINUS', // -  (a `-` before a digit is a negative NUMBER instead)
  STAR:  'STAR',  // *
  // `@unit(%)` — the one unit symbol that is not an identifier. No expression
  // grammar reads it, so `%` in a predicate is still `got '%'` from the parser.
  PERCENT: 'PERCENT', // %
}

// Any other escaped character stands for itself. Without these three a
// multi-line `@default("a\nb")` stored `anb` and no migration warned. A
// template takes the same table, and so does a flow's reading of its raw text.
export const STRING_ESCAPES ={ n: '\n', t: '\t', r: '\r' }

// Dispatch is on the char code, and a run of identifier or space characters
// moves `col` by its length rather than one step at a time. The lexer is a
// third of a schema's parse time, so a per-character closure call or an object
// literal built per token shows in `bench/cases.mjs`.
export function tokenize(src) {
  // Strip leading UTF-8 BOM if present — editors sometimes write ﻿ at the
  // start of files and the rest of the parser treats it as garbage.
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1)

  const tokens = []
  const n = src.length
  let i = 0
  let line = 1
  let col  = 1

  function advance(k = 1) {
    for (let m = 0; m < k; m++) {
      if (src.charCodeAt(i) === 10) { line++; col = 1 } else col++
      i++
    }
  }
  function moveTo(j) {
    for (; i < j; i++) {
      if (src.charCodeAt(i) === 10) { line++; col = 1 } else col++
    }
  }
  const isDigit = c => c >= 48 && c <= 57

  while (i < n) {
    const code = src.charCodeAt(i)
    const next = src.charCodeAt(i + 1)   // NaN past the end; compares false to every code

    // Whitespace — includes ASCII \s plus common Unicode invisibles that get
    // pasted in from rich-text editors (NBSP, zero-width, BOM mid-file, etc.)
    if (code === 32 || code === 9 || code === 13 || code === 11 || code === 12) { i++; col++; continue }
    if (code === 10) { i++; line++; col = 1; continue }
    if (code > 127 && (
      /\s/.test(src[i]) ||
      code === 0x00A0 ||  // NO-BREAK SPACE
      code === 0x2007 ||  // FIGURE SPACE
      code === 0x202F ||  // NARROW NO-BREAK SPACE
      code === 0x200B ||  // ZERO WIDTH SPACE
      code === 0x200C ||  // ZERO WIDTH NON-JOINER
      code === 0x200D ||  // ZERO WIDTH JOINER
      code === 0xFEFF     // BOM appearing mid-stream (concat'd files etc.)
    )) { i++; col++; continue }

    const pos = { line, col }

    // Identifier or keyword or boolean
    if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95) {
      let j = i + 1
      for (; j < n; j++) {
        const c = src.charCodeAt(j)
        if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || isDigit(c))) break
      }
      const id = src.slice(i, j)
      col += j - i
      i = j
      if (id === 'true' || id === 'false') tokens.push({ type: TK.BOOL, value: id === 'true', ...pos })
      else                                 tokens.push({ type: TK.IDENT, value: id, ...pos })
      continue
    }

    // Number
    if (isDigit(code) || (code === 45 && isDigit(next))) {
      let j = i + (code === 45 ? 1 : 0)
      for (; j < n; j++) {
        const c = src.charCodeAt(j)
        if (!(isDigit(c) || c === 46)) break
      }
      const num = src.slice(i, j)
      col += j - i
      i = j
      // `3.8.3.8` is a gate's level per operation (`FJS-D1081`), never a number.
      if (/^\d+(\.\d+){2,}$/.test(num)) {
        tokens.push({ type: TK.DOTTED, value: num, ...pos })
        continue
      }
      // `1.000.000` is NaN, and a NaN literal in a policy compared equal to
      // every number on the JS side while SQL hid the row (FJS-2185).
      const value = Number(num)
      if (Number.isNaN(value)) throw new ParseError(`Malformed number '${num}'`, pos)
      // `text` is the literal as written: `@@gate(2.0)` is two positions and
      // its value, 2, is one.
      tokens.push({ type: TK.NUMBER, value, text: num, ...pos })
      continue
    }

    // String literal
    if (code === 34 || code === 39) {
      let j = i + 1
      let seg = j
      let str = ''
      while (j < n) {
        const c = src.charCodeAt(j)
        if (c === code) break
        if (c === 92) {
          str += src.slice(seg, j)
          j++
          if (j >= n) { seg = j; break }
          str += STRING_ESCAPES[src[j]] ?? src[j]
          seg = ++j
          continue
        }
        j++
      }
      if (j >= n) throw new ParseError(`Unterminated string — no closing ${src[i]}`, pos)
      str += src.slice(seg, j)
      moveTo(j + 1)
      tokens.push({ type: TK.STRING, value: str, ...pos })
      continue
    }

    switch (code) {
      case 47: // '/'
        if (next === 47) {
          // Triple-slash doc comment, or a regular line comment that is skipped
          const eol = src.indexOf('\n', i)
          const end = eol < 0 ? n : eol
          if (src.charCodeAt(i + 2) === 47) tokens.push({ type: TK.COMMENT, value: src.slice(i + 3, end).trim(), ...pos })
          col += end - i
          i = end
          continue
        }
        if (next === 42) {
          // Block comment — skip
          const close = src.indexOf('*/', i + 2)
          if (close < 0) throw new ParseError('Unterminated block comment — no closing */', pos)
          moveTo(close + 2)
          continue
        }
        break
      case 64: // '@' — `@@` before `@`
        if (next === 64) { tokens.push({ type: TK.ATAT, value: '@@', ...pos }); i += 2; col += 2 }
        else             { tokens.push({ type: TK.AT,   value: '@',  ...pos }); i++;   col++ }
        continue
      case 45: // '-' — `->` is an arrow; a digit after it is a number, taken above
        if (next === 62) { tokens.push({ type: TK.ARROW, value: '->', ...pos }); i += 2; col += 2 }
        else             { tokens.push({ type: TK.MINUS, value: '-',  ...pos }); i++;   col++ }
        continue
      // `=>` and `$` are a flow expression's (`FJS-D284`, `FJS-D286`). They lex in a
      // schema too and no schema grammar accepts one, so `$` there is now `Expected
      // …, got '$'` from whoever was parsing rather than an unknown character.
      case 61: // '='
        if (next === 62)      { tokens.push({ type: TK.FATARROW, value: '=>', ...pos }); i += 2; col += 2; continue }
        if (next === 61)      { tokens.push({ type: TK.EQ,       value: '==', ...pos }); i += 2; col += 2; continue }
        break
      case 124: // '|'
        if (next === 124) { tokens.push({ type: TK.OR,  value: '||', ...pos }); i += 2; col += 2; continue }
        break
      case 38: // '&'
        if (next === 38)  { tokens.push({ type: TK.AND, value: '&&', ...pos }); i += 2; col += 2; continue }
        break
      case 33: // '!'
        if (next === 61) { tokens.push({ type: TK.NEQ,  value: '!=', ...pos }); i += 2; col += 2 }
        else             { tokens.push({ type: TK.BANG, value: '!',  ...pos }); i++;   col++ }
        continue
      case 60: // '<'
        if (next === 61) { tokens.push({ type: TK.LTE, value: '<=', ...pos }); i += 2; col += 2 }
        else             { tokens.push({ type: TK.LT,  value: '<',  ...pos }); i++;   col++ }
        continue
      case 62: // '>'
        if (next === 61) { tokens.push({ type: TK.GTE, value: '>=', ...pos }); i += 2; col += 2 }
        else             { tokens.push({ type: TK.GT,  value: '>',  ...pos }); i++;   col++ }
        continue
      // Semicolon — field separator in compact inline schemas, treated as whitespace
      case 59: i++; col++; continue
      case 96: { // '`'
        // Template literal — backticks. A separate token kind from a quoted string
        // because the two are different LANGUAGES at the one place that takes both:
        // `@generated("…")` is SQL and `@generated(`…`)` is a template. Accepting a
        // backtick as an ordinary string would make every other attribute take one
        // and mean nothing by it.
        // `value` is the text with escapes taken; `raw` is the source between the
        // backticks, which is what a flow reads `${…}` holes out of (`FJS-D513`) —
        // after the escapes are taken, `\${` and `${` are the same characters.
        const start = i + 1
        const end   = templateEnd(src, start)
        if (end < 0) throw new ParseError('Unterminated template literal — no closing `', { ...pos })
        advance()
        let str = ''
        while (i < end) {
          if (src[i] === '\\') { advance(); str += STRING_ESCAPES[src[i]] ?? src[i] } else { str += src[i] }
          advance()
        }
        advance() // closing backtick
        tokens.push({ type: TK.TEMPLATE, value: str, raw: src.slice(start, end), ...pos })
        continue
      }
      default: {
        const type = SINGLE[code]
        if (type) { tokens.push({ type, value: src[i], ...pos }); i++; col++; continue }
      }
    }

    // Unknown character — surface code point + line context so smart quotes,
    // NBSPs, and similar invisibles are easy to spot.
    const ch       = src[i]
    const ccode    = src.charCodeAt(i)
    const lineStart = src.lastIndexOf('\n', i - 1) + 1
    const lineEndN  = src.indexOf('\n', i)
    const lineText  = src.slice(lineStart, lineEndN === -1 ? src.length : lineEndN)
    // Only show the literal character for printable ASCII. Anything outside
    // ASCII is shown as its codepoint (U+XXXX) so users can identify smart
    // quotes, NBSP, em-dashes, etc. by code rather than by ambiguous glyph.
    const isAsciiPrintable = ccode >= 0x20 && ccode <= 0x7E
    const display = isAsciiPrintable ? `'${ch}'` : `U+${ccode.toString(16).toUpperCase().padStart(4, '0')}`
    const hint    = pickCharHint(ccode)
    throw new ParseError(
      `Unexpected character ${display} (line ${pos.line}, col ${pos.col})\n` +
      `  ${lineText}\n` +
      `  ${' '.repeat(pos.col - 1)}^` +
      (hint ? `\n  ${hint}` : ''),
      pos,
    )
  }

  tokens.push({ type: TK.EOF, value: null, line, col })
  return tokens
}

// One-character tokens by char code. `+ * %` and the brackets never combine.
const SINGLE = {
  123: TK.LBRACE, 125: TK.RBRACE, 91: TK.LBRACKET, 93: TK.RBRACKET,
  40: TK.LPAREN,  41: TK.RPAREN,  44: TK.COMMA,    58: TK.COLON,
  63: TK.QUESTION, 46: TK.DOT,    36: TK.DOLLAR,
  43: TK.PLUS,    42: TK.STAR,    37: TK.PERCENT,
}

// Map common gotcha codepoints to actionable hints. Returns null if nothing
// useful to say — caller falls back to the raw codepoint display.
function pickCharHint(code) {
  switch (code) {
    case 0x2018: case 0x2019: return "Looks like a smart single-quote (' or '). Use a plain ASCII '."
    case 0x201C: case 0x201D: return 'Looks like a smart double-quote (" or "). Use a plain ASCII ".'
    case 0x2013: case 0x2014: return 'Looks like an en/em dash (– or —). Did you mean - ?'
    case 0x00A0:              return 'Looks like a non-breaking space. Replace with a regular space.'
    case 0x2F:                return 'There is no division. A constant divisor is a decimal multiplier: round(price * 0.01).'
    case 0x200B: case 0x200C:
    case 0x200D: case 0xFEFF: return 'Looks like an invisible Unicode character. Re-type the line.'
    default:                  return null
  }
}

// ─── Template extent ────────────────────────────────────────────────────────────
//
// A template's closing backtick is the first one OUTSIDE a `${…}` hole, because
// a hole holds an expression and an expression may hold a template. Stopping at
// the first backtick would end `a ${`b`} c` inside its own hole. Both answer the
// index of what closes them, or -1 when the source runs out first.

function templateEnd(src, i) {
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue }
    if (src[i] === '`') return i
    if (src[i] === '$' && src[i + 1] === '{') {
      i = holeEnd(src, i + 2)
      if (i < 0) return -1
    }
    i++
  }
  return -1
}

// Quoted strings are skipped whole, so a `}` inside one does not close the hole.
export function holeEnd(src, i) {
  let depth = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"') {
      i++
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1
    } else if (c === '`') {
      i = templateEnd(src, i + 1)
      if (i < 0) return -1
    } else if (c === '{') {
      depth++
    } else if (c === '}') {
      if (!depth) return i
      depth--
    }
    i++
  }
  return -1
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(msg, pos) {
    super(pos ? `${msg} (line ${pos.line}, col ${pos.col})` : msg)
    this.name = 'ParseError'
    this.pos  = pos
  }
}
