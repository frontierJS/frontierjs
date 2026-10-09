// ─── a flow expression, written back out as text ──────────────────────────────
//
// The other direction of `text.ts`. `compileExpression` parses
// `$.trigger.body.amount > 100` into the node the resolver runs; this turns
// that node back into the line somebody wrote, so an editor can show a stored
// expression as the language rather than as its tree.
//
// ── The grammar is a SUBSET of the Expression union, and that is the design ───
//
// `array`, `pipe`, `let` and `match` are shapes the engine runs and the shared
// text grammar has no syntax for, so this answers `{ text: null, reason }` for
// them rather than inventing syntax. Widening the grammar is not this file's
// to do: it is `@frontierjs/toolbelt/predicate`, which litestone parses `.lite`
// policies with, and one language is the whole of `FJS-D271`. `template` and
// `object` are in it (`FJS-D513`), and a policy refuses both by name.
//
// ── Precedence, which is the only way this can be quietly wrong ──────────────
//
// An emitter that drops a bracket produces text that PARSES and means
// something else, and neither side can see it alone. So every emission states
// the tightness it is being read at and wraps itself when it is looser, the
// levels being the parser's own ladder — ternary, `||`, `&&`, `!`, a
// comparison, a value. A comparison's operands sit at VALUE, because the
// grammar gives it `operand` and an operand is a value or a group.
//
// `test/engine/expression/emit.test.ts` is what holds it: text → Expression →
// text → Expression, asserting the two trees are equal. STRUCTURE rather than
// string, because a lost bracket changes the tree and may not change the
// spelling of anything else.

import type { Expression, PredicateNode } from "../types"

/** A line of the language, or the reason there is none. */
export interface TextForm {
  text:    string | null
  reason?: string
}

// The parser's ladder. A child emitted below the tightness its position
// demands is wrapped, and `operand` — what a comparison takes — is VALUE.
const TERNARY = 0
const OR      = 1
const AND     = 2
const NOT     = 3
const COMPARE = 4
const VALUE   = 5

const IDENT = /^[_a-zA-Z]\w*$/

// The three names the parser intercepts BEFORE the generic call, plus the
// three it reads as iteration. A `fn` carrying one of these has no text form:
// re-parsed, `now()` is not a call at all and `map(x)` is an iterator missing
// its lambda, so the round trip would refuse text this file had just written.
const RESERVED_CALLS = new Set(["auth", "check", "now", "map", "filter", "reduce"])

class NoText extends Error {}

const refuse = (reason: string): never => { throw new NoText(reason) }

/**
 * One expression as the line that parses back to it.
 *
 *   expressionToText({ type: 'ref', path: '$.trigger.record.id' })
 *   // → { text: '$.trigger.record.id' }
 *
 * `text: null` is an answer and not a failure — most of what a flow stores is
 * expressible and some of it is not, and a caller shows the document instead.
 */
export function expressionToText(expr: Expression): TextForm {
  try {
    return { text: emit(expr, TERNARY) }
  } catch (err) {
    if (err instanceof NoText) return { text: null, reason: err.message }
    throw err
  }
}

// ─── expressions ──────────────────────────────────────────────────────────────

function emit(expr: Expression, min: number): string {
  if (!expr || typeof expr !== "object" || typeof (expr as { type?: unknown }).type !== "string") {
    return refuse("this is not an expression — it has no `type`")
  }

  switch (expr.type) {
    case "literal": return wrap(literal(expr.value), VALUE, min)

    case "ref": {
      const path = expr.path
      if (path === "$") return wrap("$", VALUE, min)
      if (!/^\$(\.[_a-zA-Z]\w*)+$/.test(path)) {
        return refuse(`the path ${JSON.stringify(path)} cannot be written as text — a path is '$' and dotted names`)
      }
      return wrap(path, VALUE, min)
    }

    case "fn": {
      if (!IDENT.test(expr.name)) return refuse(`${JSON.stringify(expr.name)} is not a name a call can be written with`)
      if (RESERVED_CALLS.has(expr.name)) {
        return refuse(`'${expr.name}' is a word the grammar reads as something else, so a call to it has no text form`)
      }
      return wrap(`${expr.name}(${expr.args.map(a => emit(a, TERNARY)).join(", ")})`, VALUE, min)
    }

    // The condition is an `or` and both branches are full ternaries, which is
    // what makes `a ? b : c ? d : e` nest into the else with no brackets.
    case "cond":
      return wrap(`${emit(expr.if, OR)} ? ${emit(expr.then, TERNARY)} : ${emit(expr.else, TERNARY)}`, TERNARY, min)

    case "map":
      return wrap(`map(${emit(expr.over, TERNARY)}, ${param(expr.as)} => ${emit(expr.body, TERNARY)})`, VALUE, min)

    case "filter":
      return wrap(`filter(${emit(expr.over, TERNARY)}, ${param(expr.as)} => ${emit(expr.where, TERNARY)})`, VALUE, min)

    case "reduce":
      return wrap(
        `reduce(${emit(expr.over, TERNARY)}, ${emit(expr.init, TERNARY)}, ` +
        `(${param(expr.acc)}, ${param(expr.as)}) => ${emit(expr.body, TERNARY)})`, VALUE, min)

    case "predicate": return predicate(expr.ast, min)

    case "template": return wrap(template(expr.parts), VALUE, min)
    case "object":   return wrap(object(expr.properties), VALUE, min)

    // The four the grammar has no syntax for. Named one at a time rather than
    // as a default, so a form ADDED to the union arrives here as a TypeScript
    // error instead of as a sentence about a shape nobody has considered.
    case "array":    return refuse("an array of expressions has no text form yet — a list in the grammar holds literals")
    case "pipe":    return refuse("a pipeline has no text form yet — it is edited as a document")
    case "let":      return refuse("a let has no text form yet — it is edited as a document")
    case "match":    return refuse("a match has no text form yet — it is edited as a document")
  }

  return refuse(`there is no text form for a '${(expr as { type: string }).type}' expression`)
}

// The text between holes is a string literal part; anything else is a hole. A
// string part directly after another would re-parse as ONE part, so it is
// written as a hole too and the tree comes back as it went in.
function template(parts: Expression[]): string {
  let out = ""
  let afterText = false
  for (const part of parts) {
    if (part.type === "literal" && typeof part.value === "string" && part.value !== "" && !afterText) {
      out += part.value.replace(/[\\`]|\$(?=\{)/g, m => `\\${m}`)
      afterText = true
    } else {
      out += `\${${emit(part, TERNARY)}}`
      afterText = false
    }
  }
  return `\`${out}\``
}

// A key is bare when the grammar would read it back as a name. `true` and
// `false` tokenize as booleans, so they are quoted.
function object(properties: Record<string, Expression>): string {
  const entries = Object.entries(properties).map(([key, value]) => {
    const name = IDENT.test(key) && key !== "true" && key !== "false" ? key : quote(key)
    return `${name}: ${emit(value, TERNARY)}`
  })
  return entries.length ? `{ ${entries.join(", ")} }` : "{}"
}

// A lambda's parameter, and the one place the emitter is deliberately less
// idiomatic than a person: inside the body, `i.name` and `$.i.name` compile to
// the SAME ref, and this writes the second. Tracking which names are in scope
// would buy the nicer spelling and a class of bug with it — a name emitted
// bare that is not actually bound reads as a column and is refused.
function param(name: string): string {
  if (!IDENT.test(name)) refuse(`${JSON.stringify(name)} is not a name a lambda parameter can be written with`)
  return name
}

// ─── conditions ───────────────────────────────────────────────────────────────

function predicate(node: PredicateNode, min: number): string {
  if (!node || typeof node !== "object") return refuse("this is not a condition")

  switch (node.type) {
    // The value positions the resolver fills. A hole is whatever it holds.
    case "hole":    return emit(node.expr, min)
    case "literal": return wrap(literal(node.value), VALUE, min)
    case "list":    return wrap(list(node.items), VALUE, min)

    // `!` takes another `!` or a comparison, so its operand is at NOT.
    case "not":     return wrap(`!${predicate(node.expr, NOT)}`, NOT, min)

    // Both are left-associative, so the LEFT child may be another of the same
    // and the right may not: `a && b && c` is `(a && b) && c`, and emitting the
    // right at the same tightness would re-parse `a && (b && c)` as a different
    // tree with the same answer today and not for an operator that is not
    // associative.
    case "and":     return wrap(`${predicate(node.left, AND)} && ${predicate(node.right, NOT)}`, AND, min)
    case "or":      return wrap(`${predicate(node.left, OR)} || ${predicate(node.right, AND)}`, OR, min)

    // A comparison takes an `operand` on each side, which is a value or a
    // bracketed group — never another comparison — so both sides are at VALUE.
    case "compare": {
      if (typeof node.op !== "string") return refuse("a comparison with no operator")
      return wrap(`${predicate(node.left, VALUE)} ${node.op} ${predicate(node.right, VALUE)}`, COMPARE, min)
    }
  }

  return refuse(`there is no text form for a '${(node as { type: string }).type}' condition`)
}

// ─── values ───────────────────────────────────────────────────────────────────

function wrap(text: string, prec: number, min: number): string {
  return prec < min ? `(${text})` : text
}

function literal(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string")  return quote(value)
  if (typeof value === "number")  return num(value)
  if (Array.isArray(value))       return list(value)
  return refuse(`a ${value === undefined ? "missing" : typeof value} value has no text form — it is edited as a document`)
}

// The tokenizer reads a number as an optional `-` and then digits and dots
// alone, so anything JavaScript spells with an exponent is a value it would
// read back as a different number — or as a parse error, which is worse,
// because the text came from here.
function num(value: number): string {
  const text = String(value)
  if (!Number.isFinite(value) || !/^-?[0-9]+(\.[0-9]+)?$/.test(text)) {
    return refuse(`${text} cannot be written as a number here — the grammar reads digits and one point`)
  }
  return text
}

// A list is the only place an expression holds more than one value, its members
// are literals, and an empty one is refused by the parser as matching nothing.
function list(items: unknown[]): string {
  if (!Array.isArray(items) || !items.length) {
    return refuse("an empty list has no text form — the grammar refuses one as matching nothing")
  }
  return `[${items.map(v => {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return literal(v)
    return refuse("a list holds strings, numbers and booleans — this one holds something else")
  }).join(", ")}]`
}

// The tokenizer takes the character after a backslash verbatim, so `\` and the
// quote are the whole escape set: `\n` in the text would come back as the
// letter n. A real newline needs no escape — the scan runs to the closing
// quote whatever is in between.
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}
