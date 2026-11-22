/*
 * tokenize.js — a line at a time, with the state carried from one line to the next.
 *
 * For an editor or a viewer that draws a window of a long file: `tokenizeLine`
 * takes the state a line starts in and answers the state it ends in, so a block
 * comment or a template literal that spans lines is known without reading from
 * the top. `glow` paints through it wherever `grammarFor` finds a grammar.
 *
 * A STATE IS AN OPAQUE TOKEN. It is a small integer standing for a grammar plus
 * the stack of regions open at a line's end, interned so two states compare with
 * `===`; never do arithmetic on one, and never keep one across a reload of this
 * module. The intern table is a module-level memo, like `datetime`'s formatter
 * cache: it only ever answers what its key already determines.
 *
 * A grammar is a list of rules, tried as ONE regex: every rule is an
 * alternative, and the leftmost match wins, the earlier rule on a tie. A rule is
 *
 *   { match, type }                     one token
 *   { begin, end, type, escape? }       a region of one type that may span lines
 *                                       (a block comment, a string); `escape`
 *                                       is skipped while looking for `end`
 *   { begin, end, type, rules }         a region whose inside has rules of its own
 *   { begin, end, type, syntax }        a region whose inside is another grammar
 *                                       OBJECT (a <script> in HTML)
 *
 * `inside` on a region with rules or a syntax is the type of its untyped text
 * (a template literal's text is a string though its ${} is not).
 *
 * A grammar's `first` rules are tried on the document's first line only, ahead
 * of its rules: the initial state is a state of its own that no line ends in,
 * so a front-matter `---` opens a region there and is a thematic break below.
 *
 * The delimiters of a region take its `type`. Patterns are compiled with 'g'
 * alone and `^` means the line's start.
 */

/**
 * @typedef {{ match?: RegExp, begin?: RegExp, end?: RegExp, escape?: RegExp,
 *   type?: string, inside?: string, rules?: Rule[], syntax?: Grammar }} Rule
 * @typedef {{ name: string, rules: Rule[], first?: Rule[] }} Grammar
 * @typedef {(type: string | null, from: number, to: number) => void} Emit
 * @typedef {number} State an opaque token: compare with ===, do no arithmetic on it
 */

// A stack deeper than this stops opening regions: nesting is unbounded in
// broken input, and every distinct stack is an interned state kept for good.
const MAX_DEPTH = 24

// ─── compiling ───────────────────────────────────────────────────────────

let nextId = 0
const compiled = new WeakMap() // Rule | Grammar → { id, scanner? }

/** How many capture groups a pattern has, so each alternative's own group is found. */
function groupCount(re) {
  return new RegExp(`${re.source}|`).exec('').length - 1
}

function idOf(node) {
  let c = compiled.get(node)
  if (!c) {
    c = { id: nextId++, scanner: null }
    compiled.set(node, c)
  }
  return c
}

const ruleById = []

function ruleId(rule) {
  const c = idOf(rule)
  ruleById[c.id] = rule
  return c.id
}

/**
 * The scanner for a context: the inside of a region, or a grammar's top level.
 * `alts[g]` names what capture group g matched: 'end', 'escape' or a rule.
 */
function scannerFor(ctx) {
  const c = idOf(ctx)
  if (c.scanner) return c.scanner
  const parts = []
  const alts = []
  let group = 1
  const add = (re, what) => {
    parts.push(`(${re.source})`)
    alts[group] = what
    group += 1 + groupCount(re)
  }
  const isRegion = ctx.begin !== undefined
  const inner = isRegion ? (ctx.syntax ? ctx.syntax.rules : ctx.rules) : ctx.rules
  if (isRegion && !inner && ctx.escape) add(ctx.escape, 'escape')
  if (isRegion) add(ctx.end, 'end')
  for (const rule of inner ?? []) add(rule.match ?? rule.begin, rule)
  // No alternatives at all (a plain-text grammar) is no regex: an empty one
  // matches everywhere and would be tried once per code unit.
  c.scanner = { re: parts.length ? new RegExp(parts.join('|'), 'g') : null, alts, plain: isRegion && !inner }
  return c.scanner
}

// ─── states ──────────────────────────────────────────────────────────────

// A state is a grammar plus the stack of open region rules, interned by key.
// `top` is the context of an empty stack: the grammar, or on the first line
// its first-line context.
const stateKeys = new Map()
/** @type {{ grammar: Grammar, stack: Rule[], top: Grammar | { rules: Rule[] } }[]} */
const stateById = []

function intern(grammar, stack, first = false) {
  let key = String(idOf(grammar).id)
  if (first) key += '^'
  for (const r of stack) key += `,${ruleId(r)}`
  let id = stateKeys.get(key)
  if (id === undefined) {
    id = stateById.length
    const top = first ? { rules: [...grammar.first, ...grammar.rules] } : grammar
    stateById.push({ grammar, stack: stack.slice(), top })
    stateKeys.set(key, id)
  }
  return id
}

/**
 * The state a document in this grammar starts in. A state is an opaque token:
 * compare two with `===` and do nothing else with one.
 * @param {Grammar} grammar
 * @returns {State}
 */
export function initialState(grammar) {
  return intern(grammar, [], grammar.first !== undefined)
}

/**
 * The grammar a state belongs to.
 * @param {State} state
 * @returns {Grammar}
 */
export function stateGrammar(state) {
  return stateById[state].grammar
}

/**
 * Region rules open in a state, innermost last.
 * @param {State} state
 * @returns {Rule[]}
 */
export function stateStack(state) {
  return stateById[state].stack
}

// ─── tokenizing ──────────────────────────────────────────────────────────

/**
 * Tokenize one line. `emit` gets every run in order, the gaps between tokens
 * as type null; adjacent runs are not merged. Returns the state at the line's end,
 * `===` to `state` when the line opened and closed nothing.
 * @param {string} text the line, without its '\n'
 * @param {State} state the state the line starts in
 * @param {Emit} [emit]
 * @returns {State}
 */
export function tokenizeLine(text, state, emit = noop) {
  const { grammar, stack: start, top: base } = stateById[state]
  const stack = start.slice()
  const len = text.length
  let pos = 0
  while (pos < len) {
    const top = stack.length ? stack[stack.length - 1] : base
    const { re, alts, plain } = scannerFor(top)
    const fill = top.inside ?? (plain ? top.type : null)
    if (!re) {
      emit(fill, pos, len)
      break
    }
    re.lastIndex = pos
    let m = re.exec(text)
    // An empty match makes no progress: look again one code unit on.
    while (m && m[0] === '') {
      re.lastIndex = m.index + 1
      m = re.lastIndex <= len ? re.exec(text) : null
    }
    if (!m) {
      emit(fill, pos, len)
      break
    }
    if (m.index > pos) emit(fill, pos, m.index)
    const end = m.index + m[0].length
    let g = 1
    while (m[g] === undefined) g++
    const what = alts[g]
    if (what === 'escape') {
      emit(fill, m.index, end)
    } else if (what === 'end') {
      emit(top.type ?? null, m.index, end)
      stack.pop()
    } else if (what.match) {
      emit(what.type ?? null, m.index, end)
    } else {
      emit(what.type ?? null, m.index, end)
      if (stack.length < MAX_DEPTH) stack.push(what)
    }
    pos = end
  }
  const same = base === grammar && stack.length === start.length && stack.every((r, i) => r === start[i])
  return same ? state : intern(grammar, stack)
}

function noop() {}

// ─── painting ────────────────────────────────────────────────────────────

// The parser turns a bare CR into LF, a line break in a `pre` row, and drops
// NUL, which would move every column after it; a reference keeps one code unit.
// Quotes pass through: this is a row's text, never an attribute value, which is
// mesa's escapeHTML.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#13;', '\0': '&#xFFFD;' }
export const escapeLine = (s) => s.replace(/[&<>\r\0]/g, (c) => ESC[c])

// A token is marked with the element @frontierjs/css's code palette keys off
// (components/code.css, the shape glow() emits), so the editor takes the six
// roles every highlighted block does, retinted by the theme and clamped to
// read as text. A type with no color role is a span with a `t-` class, for
// weight or slant, never a color (Invariant 13). A STRUCTURE type with a role
// gets both: a heading is glow's markdown heading, `label`, and still bold.
export const ELEMENT = {
  heading: 'label',
  link: 'b',
  comment: 'sup',
  punctuation: 'i',
  type: 'b',
  function: 'b',
  property: 'b',
  attribute: 'b',
  string: 'em',
  number: 'em',
  constant: 'em',
  regexp: 'em',
  code: 'em',
  keyword: 'strong',
  tag: 'strong',
  special: 'label',
  escape: 'label',
}
export const STRUCTURE = new Set(['heading', 'emphasis', 'strong', 'link'])

/**
 * One line as markup: an element per run of one type (ELEMENT), and the
 * untyped text bare. Returns the markup; the end state is not needed to paint.
 * With `classes` false a run whose type has no element is bare text and a
 * STRUCTURE type drops its class: glow's output, which a theme styles by
 * element alone (FJS-D2304).
 * @param {string} text
 * @param {State} state
 * @param {boolean} [classes]
 */
export function lineHTML(text, state, classes = true) {
  let out = ''
  let runType = null
  let runFrom = 0
  let runTo = 0
  const flush = () => {
    if (runTo === runFrom) return
    const s = escapeLine(text.slice(runFrom, runTo))
    const el = runType && ELEMENT[runType]
    if (!runType || (!el && !classes)) out += s
    else {
      const cls = classes && STRUCTURE.has(runType) ? ` class="t-${runType}"` : ''
      out += el ? `<${el}${cls}>${s}</${el}>` : `<span class="t-${runType}">${s}</span>`
    }
  }
  tokenizeLine(text, state, (type, from, to) => {
    if (type === runType && from === runTo) {
      runTo = to
      return
    }
    flush()
    runType = type
    runFrom = from
    runTo = to
  })
  flush()
  return out
}
