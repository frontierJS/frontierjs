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
  // ── Offset operators ────────────────────────────────────────────────────
  // `@@commitment(abandon, on: createdAt + 14d)` — a time moved by a duration.
  // No expression grammar reads them, so arithmetic in a predicate is still
  // `Expected …, got '+'` from the parser rather than a value.
  PLUS:  'PLUS',  // +
  MINUS: 'MINUS', // -  (a `-` before a digit is a negative NUMBER instead)
}

export function tokenize(src) {
  // Strip leading UTF-8 BOM if present — editors sometimes write \uFEFF at the
  // start of files and the rest of the parser treats it as garbage.
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1)

  const tokens = []
  let i = 0
  let line = 1
  let col  = 1

  function mark() { return { line, col } }
  function advance(n = 1) {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1 } else col++
      i++
    }
  }

  while (i < src.length) {
    const pos = mark()

    // Whitespace — includes ASCII \s plus common Unicode invisibles that get
    // pasted in from rich-text editors (NBSP, zero-width, BOM mid-file, etc.)
    if (/\s/.test(src[i])) { advance(); continue }
    const code = src.charCodeAt(i)
    if (
      code === 0x00A0 ||  // NO-BREAK SPACE
      code === 0x2007 ||  // FIGURE SPACE
      code === 0x202F ||  // NARROW NO-BREAK SPACE
      code === 0x200B ||  // ZERO WIDTH SPACE
      code === 0x200C ||  // ZERO WIDTH NON-JOINER
      code === 0x200D ||  // ZERO WIDTH JOINER
      code === 0xFEFF     // BOM appearing mid-stream (concat'd files etc.)
    ) { advance(); continue }

    // Triple-slash doc comment
    if (src.slice(i, i + 3) === '///') {
      const start = i + 3
      while (i < src.length && src[i] !== '\n') advance()
      tokens.push({ type: TK.COMMENT, value: src.slice(start, i).trim(), ...pos })
      continue
    }

    // Regular line comment — skip
    if (src.slice(i, i + 2) === '//') {
      while (i < src.length && src[i] !== '\n') advance()
      continue
    }

    // Block comment — skip
    if (src.slice(i, i + 2) === '/*') {
      advance(2)
      while (i < src.length && src.slice(i, i + 2) !== '*/') advance()
      advance(2)
      continue
    }

    // @@ before @
    if (src.slice(i, i + 2) === '@@') {
      tokens.push({ type: TK.ATAT, value: '@@', ...pos })
      advance(2); continue
    }

    // Multi-char operators — must check before single chars
    if (src.slice(i, i+2) === '->') { tokens.push({ type: TK.ARROW, value: '->', ...pos }); advance(2); continue }
    // `=>` and `$` are a flow expression's (`FJS-D284`, `FJS-D286`). They lex in a
    // schema too and no schema grammar accepts one, so `$` there is now `Expected
    // …, got '$'` from whoever was parsing rather than an unknown character.
    if (src.slice(i, i+2) === '=>') { tokens.push({ type: TK.FATARROW, value: '=>', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '||') { tokens.push({ type: TK.OR,  value: '||', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '&&') { tokens.push({ type: TK.AND, value: '&&', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '==') { tokens.push({ type: TK.EQ,  value: '==', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '!=') { tokens.push({ type: TK.NEQ, value: '!=', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '<=') { tokens.push({ type: TK.LTE, value: '<=', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '>=') { tokens.push({ type: TK.GTE, value: '>=', ...pos }); advance(2); continue }
    if (src[i] === '<') { tokens.push({ type: TK.LT,   value: '<',  ...pos }); advance(); continue }
    if (src[i] === '>') { tokens.push({ type: TK.GT,   value: '>',  ...pos }); advance(); continue }
    if (src[i] === '!') { tokens.push({ type: TK.BANG, value: '!',  ...pos }); advance(); continue }
    if (src[i] === '+') { tokens.push({ type: TK.PLUS, value: '+',  ...pos }); advance(); continue }
    if (src[i] === '-' && !/[0-9]/.test(src[i + 1])) { tokens.push({ type: TK.MINUS, value: '-', ...pos }); advance(); continue }

    // Semicolon — field separator in compact inline schemas, treated as whitespace
    if (src[i] === ';') { advance(); continue }

    // Single-char tokens
    const single = { '{': TK.LBRACE, '}': TK.RBRACE, '[': TK.LBRACKET, ']': TK.RBRACKET,
                     '(': TK.LPAREN, ')': TK.RPAREN, ',': TK.COMMA,    ':': TK.COLON,
                     '?': TK.QUESTION, '.': TK.DOT,  '@': TK.AT,
                     '$': TK.DOLLAR }
    if (single[src[i]]) {
      tokens.push({ type: single[src[i]], value: src[i], ...pos })
      advance(); continue
    }

    // Template literal — backticks. A separate token kind from a quoted string
    // because the two are different LANGUAGES at the one place that takes both:
    // `@generated("…")` is SQL and `@generated(`…`)` is a template. Accepting a
    // backtick as an ordinary string would make every other attribute take one
    // and mean nothing by it.
    if (src[i] === '`') {
      advance()
      let str = ''
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { advance(); str += src[i] } else { str += src[i] }
        advance()
      }
      if (i >= src.length) throw new ParseError('Unterminated template literal — no closing `', { ...pos })
      advance() // closing backtick
      tokens.push({ type: TK.TEMPLATE, value: str, ...pos })
      continue
    }

    // String literal
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i]
      advance()
      let str = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') { advance(); str += src[i] } else { str += src[i] }
        advance()
      }
      advance() // closing quote
      tokens.push({ type: TK.STRING, value: str, ...pos })
      continue
    }

    // Number
    if (/[0-9]/.test(src[i]) || (src[i] === '-' && /[0-9]/.test(src[i + 1]))) {
      let num = ''
      if (src[i] === '-') { num += '-'; advance() }
      while (i < src.length && /[0-9.]/.test(src[i])) { num += src[i]; advance() }
      tokens.push({ type: TK.NUMBER, value: Number(num), ...pos })
      continue
    }

    // Identifier or keyword or boolean
    if (/[_a-zA-Z]/.test(src[i])) {
      let id = ''
      while (i < src.length && /[\w]/.test(src[i])) { id += src[i]; advance() }
      if (id === 'true' || id === 'false')
        tokens.push({ type: TK.BOOL, value: id === 'true', ...pos })
      else
        tokens.push({ type: TK.IDENT, value: id, ...pos })
      continue
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

// Map common gotcha codepoints to actionable hints. Returns null if nothing
// useful to say — caller falls back to the raw codepoint display.
function pickCharHint(code) {
  switch (code) {
    case 0x2018: case 0x2019: return "Looks like a smart single-quote (' or '). Use a plain ASCII '."
    case 0x201C: case 0x201D: return 'Looks like a smart double-quote (" or "). Use a plain ASCII ".'
    case 0x2013: case 0x2014: return 'Looks like an en/em dash (– or —). Did you mean - ?'
    case 0x00A0:              return 'Looks like a non-breaking space. Replace with a regular space.'
    case 0x200B: case 0x200C:
    case 0x200D: case 0xFEFF: return 'Looks like an invisible Unicode character. Re-type the line.'
    default:                  return null
  }
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(msg, pos) {
    super(pos ? `${msg} (line ${pos.line}, col ${pos.col})` : msg)
    this.name = 'ParseError'
    this.pos  = pos
  }
}
