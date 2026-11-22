/*
 * parse.js — the `.lite` expression grammar.
 *
 * `@@allow`, `@@deny`, `@required(where: …)`, `@@transitions`' guards and every
 * other attribute that takes a condition parse it here, and `evaluate` beside it
 * is what answers one. It was litestone's parser's, and it is MOVED rather than
 * copied: orion's edge conditions are written in the same syntax (`FJS-D271`),
 * and two grammars for one language is how a form comes to parse in one place
 * and not the other.
 *
 * ── It reads tokens, not text ────────────────────────────────────────────────
 *
 * An expression inside a schema is part of a file litestone tokenizes once, so
 * the grammar walks a CURSOR over whatever token stream its caller already has:
 *
 *   peek()          the current token — { type, value, line, col }
 *   advance()       consume it and return it
 *   check(type)     is the current token of this type
 *   eat(type)       consume a token of this type, or throw
 *   maybeEat(type)  consume it if it is there
 *   fail(msg, pos)  the caller's error, so a message carries its file position
 *
 * Token types are the strings in `TOKEN`, which are litestone's own `TK` values.
 *
 * ── The AST is the contract ──────────────────────────────────────────────────
 *
 * `compileSql` in litestone and `evaluate` here both read what this returns,
 * held together by an oracle (`test/policy-interpreters.test.ts`). A node shape
 * changed here changes both, which is the point, and neither may be edited
 * without the other.
 */

import { TK, STRING_ESCAPES, tokenize, holeEnd, ParseError } from './tokenize.js'
import { unitInfo, MEASURE_UNITS } from '../units/units.js'

// The token names this grammar reads. The table is the lexer's.
export const TOKEN = TK


// Every operator an expression accepts, in one place so the parse error can
// list them. `in` is the only word among them; the rest are symbols the lexer
// already produces.
export const OPERATORS = Object.freeze(['==', '!=', '<', '>', '<=', '>=', 'in'])

// Enough of an expression to point at in a parse error. The full printer lives
// in litestone's core/policy.js, which reads what this produces.
function sourceHint(node) {
  if (!node || typeof node !== 'object') return '…'
  switch (node.type) {
    case 'field':   return node.name
    case 'auth':    return node.field ? `auth().${node.field}` : 'auth()'
    case 'now':     return 'now()'
    case 'shift':   return `now() ${node.sign > 0 ? '+' : '-'} ${node.value}${node.unit}`
    case 'literal': return typeof node.value === 'string' ? `'${node.value}'` : String(node.value)
    case 'compare': return `${sourceHint(node.left)} ${node.op} ${sourceHint(node.right)}`
    case 'arith':   return [node.left, node.right].map(n => n.type === 'compare' ? `(${sourceHint(n)})` : sourceHint(n)).join(` ${node.op} `)
    case 'round':   return `round(${sourceHint(node.expr)})`
    default:        return '…'
  }
}

// `now() + 2d`, `now() - 1wk`: the instant moved by a whole number of a duration
// unit, the literal `@@commitment(on: createdAt + 14d)` reads. Only `now()` takes
// one — a column plus a duration is a type question the schema validator owns —
// and the node is its own type, so an interpreter that does not know it throws
// where one that read `now` and dropped the offset would answer the wrong rows.
// `-` against a digit arrives as a negative NUMBER, so `now() -2d` is read too.
export function durationOffset(p, base) {
  let sign = 0
  if (p.maybeEat(TK.PLUS))       sign = 1
  else if (p.maybeEat(TK.MINUS)) sign = -1
  else if (p.check(TK.NUMBER) && p.peek().value < 0) sign = -1
  if (!sign) return base

  const numAt = p.peek()
  if (!p.check(TK.NUMBER)) throw p.fail(
    `'${sign > 0 ? '+' : '-'}' after now() takes a duration — 2d, 90min, 1wk`, numAt)
  const value = Math.abs(p.eat(TK.NUMBER).value)
  if (!Number.isInteger(value)) throw p.fail(
    `an offset is a whole number of a unit — write 90min, not 1.5h`, numAt)
  const unitAt = p.peek()
  const unit   = p.check(TK.IDENT) ? p.eat(TK.IDENT).value : null
  if (!unit || unitInfo(unit)?.dimension !== 'duration') throw p.fail(
    `'${value}${unit ?? ''}' is not a duration. ` +
    `Write the number and a unit together: ${MEASURE_UNITS.duration.map(u => `${value}${u}`).join(', ')}`, unitAt)
  return { type: 'shift', expr: base, sign, value, unit }
}

// ─── grammar ──────────────────────────────────────────────────────────────────
//
//   expr     ::= ternary
//   ternary  ::= or ['?' ternary ':' ternary]
//   or       ::= and  ('||' and)*
//   and      ::= not  ('&&' not)*
//   not      ::= '!' not | primary
//   primary  ::= sum [compOp sum]
//   sum      ::= term (('+' | '-') term)*     (FJS-D1107)
//   term     ::= operand ('*' operand)*
//   operand  ::= '(' expr ')' | value
//   value    ::= auth() [.field] | now() [('+' | '-') duration] | check(field [,op]) | null | bool | string | number
//              | round '(' expr ')'
//              | '[' literal (',' literal)* ']'
//              | ident | ident '.' ident   (one relation hop — FJS-D221)
//              | ident '.' ('some' | 'every' | 'none') '(' expr ')'   (a to-many — FJS-D566, FJS-D2291)
//              | 'this' '.' ident   (inside some(…) only: the declaring row's column — FJS-D2239)
//              | template | '{' [key ':' expr (',' key ':' expr)*] '}'   (a flow only — FJS-D513)
//              | '[' expr (',' expr)* ']'   (a flow only: an array when any member is not a literal — FJS-D1429)
//   compOp   ::= '==' | '!=' | '<' | '>' | '<=' | '>=' | 'in'
//
// A flow reads two more forms, looser than everything above (`FJS-D1429`):
//
//   flow     ::= let | pipeline
//   let      ::= 'let' ident '=' pipeline (',' ident '=' pipeline)* ';' flow
//   pipeline ::= ternary ('|>' step)*
//   step     ::= ident                     (a function given the flowing value: `lower` is lower($))
//              | ternary                   (a call there omits its first operand; anything else reads $)

// Every way back into the grammar (a group, a list, a call, a negation, a
// ternary branch) passes through `ternary` or `not`, so counting those bounds
// the stack. `!` x 50k or `(` x 20k otherwise escaped as RangeError, which no
// caller catches as a ParseError. The parse is synchronous, so one counter does.
const MAX_NESTING = 100
let nesting = 0

function nested(p, fn) {
  if (nesting >= MAX_NESTING) throw p.fail(`nested more than ${MAX_NESTING} deep`, p.peek())
  nesting++
  try { return fn() } finally { nesting-- }
}

// The policy dialect: a condition over one record, which is what a schema takes.
const POLICY = Object.freeze({ flow: false, scope: null })

export function parseExpression(p, ctx = POLICY) {
  return ctx.flow ? flow(p, ctx) : ternary(p, ctx)
}

// The flow dialect (`FJS-D271`). Everything above, plus what a run needs: `$.a.b`
// at any depth (`FJS-D284`), a call to any function (`FJS-D285`), and a lambda
// as a call argument (`FJS-D286`). A bare name is refused rather than read as a
// column, because a flow has no record — the only names in scope are a lambda's
// own parameters.
export function parseFlowExpression(p) {
  return parseExpression(p, { flow: true, scope: new Set() })
}

// ─── let and the pipeline (a flow only — FJS-D1429) ──────────────────────────
//
// Both bind looser than a ternary, so they sit where an expression starts — the
// whole flow, a group, a call argument, a lambda body, a hole, an object value,
// an array member — and a ternary's branch holds neither without a group.

function flow(p, ctx) {
  return isLet(p) ? letForm(p, ctx) : pipeline(p, ctx)
}

// `let` is not reserved: a name `let` is still a lambda parameter. The form is
// `let`, a name and `=`, which nothing else spells.
const isLet = (p) =>
  p.check(TK.IDENT) && p.peek().value === 'let' && p.peek(1)?.type === TK.IDENT && p.peek(2)?.type === TK.ASSIGN

// `let a = $.x, b = a * 2; b + 1`. Each name is in scope for the bindings after
// it and for the body, as a lambda's parameter is — written bare, it reads as
// `$.a`, which is where the resolver puts a binding. A binding's value is a
// pipeline and not a let, so the `,` and `;` that close it are never a nested
// let's. `in` is not the separator because `in` is already membership.
function letForm(p, ctx) {
  const at = p.eat(TK.IDENT)
  const scope = new Set(ctx.scope)
  const bindings = []
  do {
    const name = p.eat(TK.IDENT)
    if (bindings.some(b => b.name === name.value))
      throw p.fail(`'${name.value}' is bound twice in one let — the second would replace the first`, name)
    p.eat(TK.ASSIGN)
    bindings.push({ name: name.value, value: pipeline(p, { ...ctx, scope: new Set(scope) }) })
    scope.add(name.value)
  } while (p.maybeEat(TK.COMMA))
  if (!p.check(TK.SEMI))
    throw p.fail(`a let ends its bindings with ';' and then the body — let n = $.items.length; n * 2`, p.peek() ?? at)
  p.eat(TK.SEMI)
  return { type: 'let', bindings, body: nested(p, () => flow(p, { ...ctx, scope })) }
}

// `$.name |> lower |> split(',')`. A step after the first is handed the value
// flowing in, so it omits the operand that value fills: a bare name is a
// function called on it, and a call — `split(',')`, `map(x => …)` — is missing
// its first argument. A step that is neither is an expression reading the
// flowing value as `$`.
function pipeline(p, ctx) {
  const head = ternary(p, ctx)
  if (!p.check(TK.PIPE)) return head
  const steps = [head]
  while (p.maybeEat(TK.PIPE)) steps.push(step(p, ctx))
  return { type: 'pipe', steps }
}

// A name followed by `(` is a call and by `.` a path under a bound name, so only
// a name standing alone is a function. `null` is the literal.
function step(p, ctx) {
  const t = p.peek()
  const next = p.peek(1)?.type
  if (t.type === TK.IDENT && t.value !== 'null' && next !== TK.LPAREN && next !== TK.DOT) {
    p.advance()
    return { type: 'function', name: t.value }
  }
  return ternary(p, ctx)
}

// `cond ? a : b`, binding looser than `||` and RIGHT-associative, so
// `a ? x : b ? y : z` nests into the else — which is how a four-value urgency
// is written without a CASE keyword. Both branches parse as a full ternary:
// `a ? b ? c : d : e` is unambiguous because `?` and `:` bracket the middle.
//
// This is where the language stops being predicate-only and starts producing
// VALUES, so it lands in BOTH interpreters — `CASE WHEN … THEN … ELSE … END` in
// compileSql, `?:` in evaluate. A form in one and not the other is FJS-195
// repeating.
function ternary(p, ctx) {
  return nested(p, () => ternaryAt(p, ctx))
}

function ternaryAt(p, ctx) {
  const cond = or(p, ctx)
  if (!ctx.flow && p.check(TK.PIPE))
    throw p.fail(`A pipeline builds a value, and a policy asks a question — '|>' is written in a flow expression only.`, p.peek())
  if (!p.check(TK.QUESTION)) return cond
  p.eat(TK.QUESTION)
  const then = ternary(p, ctx)
  if (!p.check(TK.COLON))
    throw p.fail(`a ternary needs both branches — '${sourceHint(cond)} ? …' is missing its ':'`, p.peek())
  p.eat(TK.COLON)
  const alt = ternary(p, ctx)
  return { type: 'ternary', cond, then, else: alt }
}

function or(p, ctx) {
  let left = and(p, ctx)
  while (p.check(TK.OR))  { p.eat(TK.OR);  left = { type: 'or',  left, right: and(p, ctx) } }
  return left
}

function and(p, ctx) {
  let left = not(p, ctx)
  while (p.check(TK.AND)) { p.eat(TK.AND); left = { type: 'and', left, right: not(p, ctx) } }
  return left
}

function not(p, ctx) {
  if (!p.check(TK.BANG)) return primary(p, ctx)
  return nested(p, () => { p.eat(TK.BANG); return { type: 'not', expr: not(p, ctx) } })
}

function primary(p, ctx) {
  // A parenthesized group is an OPERAND like any other, so the comparison below
  // applies to it too — `(a ? 1 : 2) == 1` compares the group.
  const left = sum(p, ctx)
  const op   = compOp(p)
  if (op) {
    const opTok = p.advance()
    // BOTH sides take a group: `ownerId == (open ? auth().id : auth().adminId)`
    // is a ternary choosing which value to compare against, which is most of
    // what a ternary is for here.
    const right = sum(p, ctx)
    // SQL answers UNKNOWN for `qty > NULL` where the JS half would answer a
    // presence test, so the two interpreters disagree (`FJS-1152`).
    const isNull = (n) => n.type === 'literal' && n.value === null
    if (op !== '==' && op !== '!=' && op !== 'in' && (isNull(left) || isNull(right)))
      throw p.fail(`'${sourceHint(left)} ${op} ${sourceHint(right)}' orders against null, which is never true — use == null or != null`, opTok ?? p.peek())
    return { type: 'compare', op, left, right }
  }
  // A bare word where an operator belongs. Left alone it unwinds into
  // `Expected RPAREN, got 'in'` from whoever closes the attribute — a line and
  // column, and no statement about what was wrong or what is available.
  const next = p.peek()
  if (next.type === TK.IDENT)
    throw p.fail(
      `'${next.value}' is not a policy operator. Available: ${OPERATORS.join(', ')}. ` +
      `Membership is 'in' with the list on the right — 'auth().id in memberIds'.`, next)
  return left
}

// ─── arithmetic ───────────────────────────────────────────────────────────────
//
// `+ - *` over numbers, `*` tighter than `+ -` and both tighter than a
// comparison (`FJS-D1107`), in a flow as in a policy (`FJS-D1365`). No `/`:
// SQLite divides two integers to an integer and by zero to NULL, and the JS
// half would have to copy both.
//
// `a -1` lexes as `a` and the NUMBER -1, so a negative number straight after an
// operand is a subtraction, the reading `now() -2d` already gets.
function sum(p, ctx) {
  let left = term(p, ctx)
  for (;;) {
    const t = p.peek()
    let op = null, right
    if (t.type === TK.PLUS || t.type === TK.MINUS) {
      p.advance()
      op = t.value
      right = term(p, ctx)
    } else if (t.type === TK.NUMBER && String(t.text ?? '').startsWith('-')) {
      p.advance()
      op = '-'
      right = term(p, ctx, { type: 'literal', value: Math.abs(t.value) })
    } else return left
    // `dueAt + 2d` reads as a sum and then a stray `d`. A column moved by a
    // duration is the type question `durationOffset` leaves to the schema.
    const unit = p.peek()
    if (unit.type === TK.IDENT && right.type === 'literal' && unitInfo(unit.value)?.dimension === 'duration')
      throw p.fail(`'${sourceHint(left)} ${op} ${right.value}${unit.value}' moves a column by a duration, ` +
        `and only now() takes one — compare the column with now() ${op} ${right.value}${unit.value}`, unit)
    left = arith(p, op, left, right, t)
  }
}

function term(p, ctx, first = null) {
  let left = first ?? operand(p, ctx)
  while (p.check(TK.STAR)) {
    const t = p.advance()
    left = arith(p, '*', left, operand(p, ctx), t)
  }
  return left
}

// What can never be a number is refused here, where the position is known. A
// column's type is the schema's, so litestone grades a field operand itself.
const NEVER_NUMERIC = {
  now:     'now() is an instant',
  shift:   'now() moved by a duration is an instant',
  list:    'a list is not a number',
  array:   'an array is not a number',
  compare: 'a comparison is a truth value',
  and:     'a && is a truth value',
  or:      'a || is a truth value',
  not:     'a ! is a truth value',
  check:   'check() is a truth value',
  some:    '.some() is a truth value',
}

function arith(p, op, left, right, at) {
  const node = { type: 'arith', op, left, right }
  numeric(p, left, op, node, at)
  numeric(p, right, op, node, at)
  return node
}

function numeric(p, n, op, whole, at) {
  const v = n.type === 'literal' ? n.value : undefined
  const why = NEVER_NUMERIC[n.type]
    ?? (n.type === 'auth' && !n.field ? 'auth() is the principal'
      : n.type === 'literal' && typeof v !== 'number' ? `${typeof v === 'string' ? `'${v}'` : v} is not a number`
      : null)
  if (why) throw p.fail(`${why}, and ${op} takes numbers — in ${sourceHint(whole)}`, at)
}

// `round(x)` — the whole number nearest x, half away from zero, which is
// SQLite's. A constant divisor is a decimal multiplier, `qty * price * 0.01`,
// and an Int column wants the whole result back.
function round(p, ctx, t) {
  p.eat(TK.IDENT)
  p.eat(TK.LPAREN)
  if (p.check(TK.RPAREN)) throw p.fail(`round() takes the number to round — round(price * 0.9)`, p.peek())
  const expr = parseExpression(p, ctx)
  if (p.check(TK.COMMA))
    throw p.fail(`round() takes one argument and rounds to a whole number — scale the operand for decimal places`, p.peek())
  p.eat(TK.RPAREN)
  const node = { type: 'round', expr }
  numeric(p, expr, 'round()', node, t)
  return node
}

// A comparison operand: a parenthesized expression, or a plain value.
function operand(p, ctx) {
  if (!p.check(TK.LPAREN)) return value(p, ctx)
  p.eat(TK.LPAREN)
  const expr = parseExpression(p, ctx)
  p.eat(TK.RPAREN)
  return expr
}

function compOp(p) {
  const t = p.peek()
  if (t.type === TK.EQ)  return '=='
  if (t.type === TK.NEQ) return '!='
  if (t.type === TK.LT)  return '<'
  if (t.type === TK.GT)  return '>'
  if (t.type === TK.LTE) return '<='
  if (t.type === TK.GTE) return '>='
  // `in` is a word rather than a symbol, so it arrives as an IDENT. Membership
  // reads in both directions with the list always on the RIGHT —
  // `auth().id in memberIds` and `teamId in auth().teamIds` — which is what
  // makes one operator enough.
  if (t.type === TK.IDENT && t.value === 'in') return 'in'
  return null
}

// `.a.b.c` after a `$` or a bound name — the rest of a path, at any depth.
function dotted(p) {
  let path = ''
  while (p.check(TK.DOT)) {
    p.eat(TK.DOT)
    path += '.' + p.eat(TK.IDENT).value
  }
  return path
}

// A call argument: an expression, or a lambda binding one or more names over it.
// `i => …` and `(acc, i) => …`; the names are in scope for the body alone, so a
// second lambda in the same call cannot see the first one's.
function argument(p, ctx) {
  const lambda = lambdaParams(p)
  if (!lambda) return parseExpression(p, ctx)
  const inner = { flow: true, scope: new Set([...ctx.scope, ...lambda]) }
  return { type: 'lambda', params: lambda, body: parseExpression(p, inner) }
}

// The parameter list of a lambda, consumed, or null when this argument is not
// one. Both shapes are decided by LOOKAHEAD rather than by backtracking, since
// `(a, b)` is also the start of an ordinary parenthesized expression.
function lambdaParams(p) {
  if (p.check(TK.IDENT) && p.peek(1)?.type === TK.FATARROW) {
    const one = p.eat(TK.IDENT).value
    p.eat(TK.FATARROW)
    return [one]
  }
  if (!p.check(TK.LPAREN)) return null
  let n = 1
  const names = []
  while (p.peek(n)?.type === TK.IDENT) {
    names.push(p.peek(n).value)
    if (p.peek(n + 1)?.type === TK.COMMA) { n += 2; continue }
    n += 1
    break
  }
  if (!names.length || p.peek(n)?.type !== TK.RPAREN || p.peek(n + 1)?.type !== TK.FATARROW) return null
  for (let k = 0; k <= n; k++) p.advance()
  p.eat(TK.FATARROW)
  return names
}

function value(p, ctx) {
  const t = p.peek()

  // Ahead of a flow's generic call, so `round` is one function in both dialects.
  if (t.type === TK.IDENT && t.value === 'round' && p.peek(1)?.type === TK.LPAREN)
    return round(p, ctx, t)

  if (ctx.flow) {
    // `$.a.b.c` — a value from the run, at any depth (`FJS-D284`). Bare `$` is
    // the run itself.
    if (t.type === TK.DOLLAR) {
      p.eat(TK.DOLLAR)
      return { type: 'ref', path: '$' + dotted(p) }
    }

    // `name(…)` — a call to whatever function table the caller runs with
    // (`FJS-D285`). `map`, `filter` and `reduce` are calls too; what makes them
    // iteration is the lambda they are handed (`FJS-D286`).
    if (t.type === TK.IDENT && p.peek(1)?.type === TK.LPAREN) {
      if (t.value === 'auth' || t.value === 'check')
        throw p.fail(
          `'${t.value}()' belongs to a policy, which is answered against a record. ` +
          `A flow runs as its owner and reads the run with '$.…'.`, t)
      p.eat(TK.IDENT)
      p.eat(TK.LPAREN)
      const args = []
      while (!p.check(TK.RPAREN)) {
        args.push(argument(p, ctx))
        if (!p.maybeEat(TK.COMMA)) break
      }
      p.eat(TK.RPAREN)
      return { type: 'call', name: t.value, args }
    }

    if (t.type === TK.TEMPLATE) { p.eat(TK.TEMPLATE); return template(p, ctx, t) }
    if (t.type === TK.LBRACE)   return object(p, ctx)
    if (t.type === TK.LBRACKET) return bracket(p, ctx)

    // A lambda's own parameter, and anything under it.
    if (t.type === TK.IDENT && ctx.scope.has(t.value)) {
      p.eat(TK.IDENT)
      return { type: 'ref', path: '$.' + t.value + dotted(p) }
    }

    if (t.type === TK.IDENT && t.value !== 'null')
      throw p.fail(
        `'${t.value}' is not defined here. A value from the run is written '$.${t.value}', ` +
        `and a lambda's parameter is in scope only inside its body.`, t)
  }

  // auth() or auth().field
  if (t.type === TK.IDENT && t.value === 'auth') {
    p.eat(TK.IDENT)
    p.eat(TK.LPAREN); p.eat(TK.RPAREN)
    if (p.check(TK.DOT)) {
      p.eat(TK.DOT)
      const field = p.eat(TK.IDENT).value
      return { type: 'auth', field }
    }
    return { type: 'auth', field: null }
  }

  // now()
  if (t.type === TK.IDENT && t.value === 'now') {
    p.eat(TK.IDENT)
    p.eat(TK.LPAREN); p.eat(TK.RPAREN)
    return durationOffset(p, { type: 'now' })
  }

  // check(field) or check(field, 'operation')
  if (t.type === TK.IDENT && t.value === 'check') {
    if (ctx.within) throw p.fail(
      `check() inside '${ctx.within}.some(…)' delegates from rows one relation away, which is a ` +
      `second hop. Put the condition on the model '${ctx.within}' holds, or test its columns here.`, t)
    p.eat(TK.IDENT)
    p.eat(TK.LPAREN)
    const field = p.eat(TK.IDENT).value
    let operation = null
    if (p.maybeEat(TK.COMMA)) operation = p.eat(TK.STRING).value
    p.eat(TK.RPAREN)
    return { type: 'check', field, operation }
  }

  if (t.type === TK.IDENT && t.value === 'null') {
    p.eat(TK.IDENT)
    return { type: 'literal', value: null }
  }

  // A column may be named `let`; `let`, a name and `=` is the flow's binding form.
  if (t.type === TK.IDENT && t.value === 'let' && p.peek(1)?.type === TK.IDENT && p.peek(2)?.type === TK.ASSIGN)
    throw p.fail(`A let binds names to build a value, and a policy asks a question — it is written in a flow expression only.`, t)

  if (t.type === TK.BOOL) {
    p.eat(TK.BOOL)
    return { type: 'literal', value: t.value }
  }

  if (t.type === TK.STRING) {
    p.eat(TK.STRING)
    return { type: 'literal', value: t.value }
  }

  if (t.type === TK.NUMBER) {
    p.eat(TK.NUMBER)
    return { type: 'literal', value: t.value }
  }

  // list literal — the right operand of `in`, and the only place an expression
  // holds more than one value. Members are literals: a list of COLUMN names
  // would be a different question (does any of these columns equal it), and
  // one worth refusing rather than guessing at.
  if (t.type === TK.LBRACKET) {
    p.eat(TK.LBRACKET)
    const items = []
    while (!p.check(TK.RBRACKET)) {
      const v = p.peek()
      if (v.type !== TK.STRING && v.type !== TK.NUMBER && v.type !== TK.BOOL)
        throw p.fail(
          `A list in a policy expression holds literals — got '${v.value ?? v.type}'. ` +
          `Write ['draft', 'review'], not a column or an expression; an array of expressions builds a ` +
          `value, and is written in a flow expression only.`, v)
      p.advance()
      items.push(v.value)
      if (!p.maybeEat(TK.COMMA)) break
    }
    p.eat(TK.RBRACKET)
    if (!items.length)
      throw p.fail(`An empty list in a policy expression matches nothing — say so with a literal instead`, t)
    return { type: 'list', items }
  }

  // A field reference (any other identifier), or a column across to-one relations.
  //
  // `order.customer.userId` is a column on a model this one reaches by
  // belongsTo, and the compiler owns the joins (`FJS-D221`). Two hops is the
  // bound (`FJS-D1027`), because each is a join the author cannot see, per
  // policy, per query — so a third is refused HERE rather than compiled into
  // something slow, which makes the bound discoverable from the mistake instead
  // of from a decision record. The last name may instead be a to-many tested
  // with `.some(…)`, which ends the chain.
  //
  // Inside `rel.some(…)` a name is a column of the rows being tested — the far
  // end of the chain — so a dot there is refused. `this.col` is the one dot it
  // takes: a column of the row the rule is declared on, which the EXISTS
  // correlates on and so crosses nothing (`FJS-D2239`).
  if (t.type === TK.IDENT) {
    p.eat(TK.IDENT)
    if (!p.check(TK.DOT)) return { type: 'field', name: t.value }
    if (ctx.within && t.value === 'this') {
      p.eat(TK.DOT)
      const name = p.eat(TK.IDENT).value
      if (p.check(TK.DOT))
        throw p.fail(
          `'this.${name}.…' crosses a relation from inside '${ctx.within}.some(…)'. The bound is two ` +
          `to-one hops then one '.some(…)', and '.some(…)' ends the chain.`, p.peek())
      return { type: 'this', name }
    }
    if (ctx.within) {
      if (QUANTIFIERS.has(p.peek(1)?.value) && p.peek(2)?.type === TK.LPAREN)
        throw p.fail(
          `'${t.value}.${p.peek(1).value}(…)' inside '${ctx.within}.some(…)' nests one to-many test in another. The bound ` +
          `is two to-one hops then ONE '.some(…)'.`, p.peek())
      throw p.fail(
        `'${t.value}.…' inside '${ctx.within}.some(…)' crosses a relation from the rows it tests. ` +
        `A name there is a column of those rows — the bound is two to-one hops then one '.some(…)', and ` +
        `'.some(…)' ends the chain.`, p.peek())
    }
    const hops = [t.value]
    for (;;) {
      p.eat(TK.DOT)
      const name = p.eat(TK.IDENT).value
      if (QUANTIFIERS.has(name) && p.check(TK.LPAREN)) return some(p, ctx, hops, name)
      if (!p.check(TK.DOT)) return chained({ type: 'path', rel: hops.at(-1), name }, hops)
      hops.push(name)
      if (hops.length === 3 && !(QUANTIFIERS.has(p.peek(1)?.value) && p.peek(2)?.type === TK.LPAREN))
        throw p.fail(
          `'${hops.join('.')}.…' crosses three relations. A policy may cross TWO to-one relations, then ` +
          `name a column or run one '.some(…)' — put the rule on a model nearer the column, or carry the ` +
          `value on this model.`, p.peek())
    }
  }

  // The forms a flow assembles a value with (`FJS-D513`, `FJS-D1429`). A policy
  // asks a question of a record, so any of them there would parse and have no
  // meaning in the SQL half.
  if (t.type === TK.TEMPLATE || t.type === TK.LBRACE)
    throw p.fail(
      `${t.type === TK.TEMPLATE ? 'A template literal' : 'An object'} builds a value, and a policy ` +
      `asks a question — it is written in a flow expression only.`, t)

  throw p.fail(`Expected a value in policy expression, got '${t.value ?? t.type}'`, t)
}

// `` `Hello ${$.lead.name}!` `` — the text between the holes is literal and each
// hole is a full expression in the dialect it sits in, so a lambda's parameter is
// in scope inside one. The tokenizer finds where each hole ends (a `}` inside a
// string or a nested template does not close it) and `raw` keeps `\${` apart
// from `${`, which the unescaped value cannot.
function template(p, ctx, t) {
  const raw   = t.raw
  const parts = []
  let text = ''
  const flush = () => { if (text) parts.push({ type: 'literal', value: text }); text = '' }

  for (let i = 0; i < raw.length;) {
    if (raw[i] === '\\') { text += STRING_ESCAPES[raw[i + 1]] ?? raw[i + 1] ?? ''; i += 2; continue }
    if (raw[i] === '$' && raw[i + 1] === '{') {
      const end = holeEnd(raw, i + 2)
      flush()
      parts.push(hole(p, ctx, raw.slice(i + 2, end), t))
      i = end + 1
      continue
    }
    text += raw[i++]
  }
  flush()
  return { type: 'template', parts }
}

// One `${…}`: its source parsed on a cursor of its own, whose positions would be
// relative to the hole, so a failure is re-raised at the template's token.
function hole(p, ctx, src, at) {
  const fail = (msg) => p.fail(`${msg.replace(/ \(line \d+, col \d+\)$/, '')} (inside \${…} of a template)`, at)
  let tokens
  try { tokens = tokenize(src, { flow: true }) } catch (err) { throw fail(err.message) }
  let pos = 0
  const sub = {
    peek:     (n = 0) => tokens[pos + n],
    advance:  () => tokens[pos++],
    check:    (type) => tokens[pos]?.type === type,
    maybeEat: (type) => (tokens[pos]?.type === type ? tokens[pos++] : undefined),
    eat(type) {
      const tok = tokens[pos]
      if (!tok || tok.type !== type) throw sub.fail(`Expected ${type}, got '${tok?.value ?? 'end of expression'}'`, tok)
      return tokens[pos++]
    },
    fail: (msg, tok) => new ParseError(msg, tok),
  }
  if (sub.check(TK.EOF)) throw fail('a hole holds an expression — it is empty')
  try {
    const node = parseExpression(sub, ctx)
    if (!sub.check(TK.EOF)) throw sub.fail(`Unexpected '${sub.peek().value}' after the expression`, sub.peek())
    return node
  } catch (err) {
    if (err instanceof ParseError) throw fail(err.message)
    throw err
  }
}

// `[$.a, $.b + 1]` in a flow. A bracket whose members are all strings, numbers
// and booleans is a `list` exactly as a policy reads one — the right side of
// `in` means the same thing in both dialects — and any other member makes it
// an `array` of expressions. An empty bracket is refused either way, as a list
// always was.
function bracket(p, ctx) {
  const t = p.eat(TK.LBRACKET)
  const items = []
  while (!p.check(TK.RBRACKET)) {
    items.push(parseExpression(p, ctx))
    if (!p.maybeEat(TK.COMMA)) break
  }
  p.eat(TK.RBRACKET)
  if (!items.length)
    throw p.fail(`An empty list in a policy expression matches nothing — say so with a literal instead`, t)
  const literal = (n) => n.type === 'literal' && ['string', 'number', 'boolean'].includes(typeof n.value)
  return items.every(literal)
    ? { type: 'list', items: items.map(n => n.value) }
    : { type: 'array', items }
}

// `{ title: `Lead ${$.name}`, n: $.count }` — keys are names or quoted strings,
// values are full expressions. A repeated key is refused, because the second
// would silently replace the first.
function object(p, ctx) {
  p.eat(TK.LBRACE)
  const properties = []
  const seen = new Set()
  while (!p.check(TK.RBRACE)) {
    const k = p.peek()
    if (k.type !== TK.IDENT && k.type !== TK.STRING)
      throw p.fail(`An object key is a name or a quoted string — got '${k.value ?? k.type}'`, k)
    p.advance()
    if (!p.check(TK.COLON))
      throw p.fail(`The key '${k.value}' needs a value — { ${k.value}: … }`, p.peek())
    p.eat(TK.COLON)
    if (seen.has(k.value))
      throw p.fail(`The key '${k.value}' is written twice in one object`, k)
    seen.add(k.value)
    properties.push({ key: k.value, value: parseExpression(p, ctx) })
    if (!p.maybeEat(TK.COMMA)) break
  }
  p.eat(TK.RBRACE)
  return { type: 'object', properties }
}

// `members.some(userId == auth().id)` — does ANY row of a to-many relation
// satisfy the condition (`FJS-D566`). The same question the query `where` asks
// as `{ members: { some: … } }`, under the same word. The condition is read
// against the related model, which is why it is a node of its own rather than
// a path: its names belong to another model, and a walker that descended into
// it as though they were this model's would check them against the wrong
// field list.
//
// `every` and `none` are the same node with a `quantifier` (`FJS-D2291`), the
// three words the `where` names: every walker that asks which model a
// condition is read against treats them alike, and only a compiler reads the
// word. `some` carries none, so a walker that forgets the field compiles a
// `some` rather than missing a node it has never seen.
const QUANTIFIERS = new Set(['some', 'every', 'none'])

function some(p, ctx, hops, word) {
  const rel = hops.at(-1)
  const at  = hops.join('.')
  p.eat(TK.LPAREN)
  if (p.check(TK.RPAREN))
    throw p.fail(`'${at}.${word}()' needs a condition — the columns it tests are the rows '${rel}' holds`, p.peek())
  const where = parseExpression(p, { ...ctx, within: at })
  p.eat(TK.RPAREN)
  return chained(word === 'some' ? { type: 'some', rel, where } : { type: 'some', rel, where, quantifier: word }, hops)
}

// `via` is the to-one hops before `rel`, absent for a relation on this model —
// so a walker that does not follow it looks `rel` up on the wrong model and
// finds nothing, rather than reading a column off the wrong table.
function chained(node, hops) {
  return hops.length > 1 ? { ...node, via: hops.slice(0, -1) } : node
}
