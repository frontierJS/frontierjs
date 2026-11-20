// ─── a flow expression, written back out as text ──────────────────────────────
//
// The other direction of `text.ts`. `compileExpression` parses
// `$.trigger.body.amount > 100` into the node the resolver runs; this turns
// that node back into the line somebody wrote, so an editor can show a stored
// expression as the language rather than as its tree.
//
// ── Every form has syntax; some VALUES do not ────────────────────────────────
//
// `template` and `object` (`FJS-D513`) and `array`, `pipe` and `let`
// (`FJS-D1429`) are in the shared grammar, `@frontierjs/toolbelt/predicate`, in
// its flow dialect only, and a `.lite` policy refuses each by name. What still
// answers `{ text: null, reason }` is a document no text re-parses to: an
// object or an exponent as a literal, an array whose members are all literals
// (the text reads back as a list), a pipeline of fewer than two steps.
//
// ── Precedence, which is the only way this can be quietly wrong ──────────────
//
// An emitter that drops a bracket produces text that PARSES and means
// something else, and neither side can see it alone. So every emission states
// the tightness it is being read at and wraps itself when it is looser, the
// levels being the parser's own ladder — ternary, `||`, `&&`, `!`, a
// comparison, a sum, a product, a value. A comparison's operands sit at SUM,
// because the grammar gives it `sum`.
//
// `test/engine/expression/emit.test.ts` is what holds it: text → Expression →
// text → Expression, asserting the two trees are equal. STRUCTURE rather than
// string, because a lost bracket changes the tree and may not change the
// spelling of anything else.

import type { Expression, PipeStep, PredicateNode } from "../types"

/** A line of the language, or the reason there is none. */
export interface TextForm {
  text:    string | null
  reason?: string
}

// The parser's ladder. A child emitted below the tightness its position
// demands is wrapped. A let and a pipeline are looser than a ternary, and are
// read wherever an expression starts — the whole line, a call argument, a
// lambda body, a hole, an object value, an array member.
const LET     = -2
const PIPE    = -1
const TERNARY = 0
const OR      = 1
const AND     = 2
const NOT     = 3
const COMPARE = 4
const SUM     = 5
const TERM    = 6
const VALUE   = 7

const IDENT = /^[_a-zA-Z]\w*$/

// The three names the parser intercepts BEFORE the generic call, plus the
// three it reads as iteration. A `fn` carrying one of these has no text form:
// re-parsed, `now()` is not a call at all and `map(x)` is an iterator missing
// its lambda, so the round trip would refuse text this file had just written.
const RESERVED_CALLS = new Set(["auth", "check", "now", "round", "map", "filter", "reduce"])

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
    return { text: emit(expr, LET) }
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
      return wrap(`${expr.name}(${expr.args.map(a => emit(a, LET)).join(", ")})`, VALUE, min)
    }

    // The condition is an `or` and both branches are full ternaries, which is
    // what makes `a ? b : c ? d : e` nest into the else with no brackets.
    case "cond":
      return wrap(`${emit(expr.if, OR)} ? ${emit(expr.then, TERNARY)} : ${emit(expr.else, TERNARY)}`, TERNARY, min)

    case "map":
    case "filter":
    case "reduce":   return wrap(iterator(expr), VALUE, min)

    case "predicate": return predicate(expr.ast, min)

    case "template": return wrap(template(expr.parts), VALUE, min)
    case "object":   return wrap(object(expr.properties), VALUE, min)

    case "array":    return wrap(array(expr.items), VALUE, min)
    case "pipe":     return wrap(pipe(expr.steps), PIPE, min)
    case "let":      return wrap(letForm(expr.bindings, expr.body), LET, min)
  }

  return refuse(`there is no text form for a '${(expr as { type: string }).type}' expression`)
}

// `map(over, i => …)`, or with no `over` as a pipeline step, where the flowing
// value is the collection.
function iterator(expr: { type: "map" | "filter" | "reduce"; over?: Expression; as: string }): string {
  const over = expr.over ? `${emit(expr.over, LET)}, ` : ""
  if (expr.type === "map") {
    const { body } = expr as Extract<Expression, { type: "map" }>
    return `map(${over}${param(expr.as)} => ${emit(body, LET)})`
  }
  if (expr.type === "filter") {
    const { where } = expr as Extract<Expression, { type: "filter" }>
    return `filter(${over}${param(expr.as)} => ${emit(where, LET)})`
  }
  const { acc, init, body } = expr as Extract<Expression, { type: "reduce" }>
  return `reduce(${over}${emit(init, LET)}, (${param(acc)}, ${param(expr.as)}) => ${emit(body, LET)})`
}

// A member list that is all strings, numbers and booleans reads back as a
// `list`, which compiles to a literal — so such an array is a document the text
// cannot return to, and is refused rather than written as something else.
function array(items: Expression[]): string {
  if (!items.length) return refuse("an empty array has no text form — the grammar refuses [] as a list that matches nothing")
  const listLike = (e: Expression) =>
    e.type === "literal" && ["string", "number", "boolean"].includes(typeof e.value)
  if (items.every(listLike)) {
    return refuse("an array whose members are all literals reads back as a list, so it is edited as a document")
  }
  return `[${items.map(i => emit(i, LET)).join(", ")}]`
}

// `head |> step |> step`. The head is a ternary at loosest, and a step a
// ternary too, so a pipeline or a let in either is grouped.
function pipe(steps: PipeStep[]): string {
  if (steps.length < 2) {
    return refuse("a pipeline of fewer than two steps has no text form — written out, it is its one step")
  }
  const [head, ...rest] = steps
  return [emit(head as Expression, TERNARY), ...rest.map(step)].join(" |> ")
}

// A `fn` after the first step is handed the flowing value, so its text omits
// that operand: no args is the bare name, `args: []` is `name()`. A name the
// grammar reads as something else has no step form either.
function step(s: PipeStep): string {
  if (s.type === "fn") {
    if (!IDENT.test(s.name) || ["null", "true", "false"].includes(s.name)) {
      return refuse(`${JSON.stringify(s.name)} is not a name a pipeline step can be written with`)
    }
    if (!s.args) return s.name
    if (RESERVED_CALLS.has(s.name)) {
      return refuse(`'${s.name}' is a word the grammar reads as something else, so a call to it has no text form`)
    }
    return `${s.name}(${s.args.map(a => emit(a, LET)).join(", ")})`
  }
  if (s.type === "map" || s.type === "filter" || s.type === "reduce") return iterator(s)
  return emit(s, TERNARY)
}

// `let a = e, b = e; body`. A binding's value is a pipeline at loosest, so a let
// there is grouped; the body is a whole expression.
function letForm(bindings: Record<string, Expression>, body: Expression): string {
  const entries = Object.entries(bindings)
  if (!entries.length) return refuse("a let with no bindings has no text form — written out, it is its body")
  const written = entries.map(([name, value]) => {
    if (!IDENT.test(name) || ["null", "true", "false"].includes(name)) {
      refuse(`${JSON.stringify(name)} is not a name a let can bind`)
    }
    return `${name} = ${emit(value, PIPE)}`
  })
  return `let ${written.join(", ")}; ${emit(body, LET)}`
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
      out += `\${${emit(part, LET)}}`
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
    return `${name}: ${emit(value, LET)}`
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

    // A comparison takes a sum on each side — never another comparison.
    case "compare": {
      if (typeof node.op !== "string") return refuse("a comparison with no operator")
      return wrap(`${predicate(node.left, SUM)} ${node.op} ${predicate(node.right, SUM)}`, COMPARE, min)
    }

    // Left-associative like `&&`, so the right child sits one level tighter.
    case "arith": {
      if (node.op === "*") return wrap(`${predicate(node.left, TERM)} * ${predicate(node.right, VALUE)}`, TERM, min)
      if (node.op === "+" || node.op === "-")
        return wrap(`${predicate(node.left, SUM)} ${node.op} ${predicate(node.right, TERM)}`, SUM, min)
      return refuse(`there is no text form for the operator '${node.op}'`)
    }
    case "round":   return wrap(`round(${predicate(node.expr, TERNARY)})`, VALUE, min)
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
