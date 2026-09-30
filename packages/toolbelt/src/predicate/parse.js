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

import { TK } from './tokenize.js'

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
    case 'literal': return typeof node.value === 'string' ? `'${node.value}'` : String(node.value)
    case 'compare': return `${sourceHint(node.left)} ${node.op} ${sourceHint(node.right)}`
    default:        return '…'
  }
}

// ─── grammar ──────────────────────────────────────────────────────────────────
//
//   expr     ::= ternary
//   ternary  ::= or ['?' ternary ':' ternary]
//   or       ::= and  ('||' and)*
//   and      ::= not  ('&&' not)*
//   not      ::= '!' not | primary
//   primary  ::= operand [compOp operand]
//   operand  ::= '(' expr ')' | value
//   value    ::= auth() [.field] | now() | check(field [,op]) | null | bool | string | number
//              | '[' literal (',' literal)* ']'
//              | ident | ident '.' ident   (one relation hop — FJS-D221)
//              | ident '.' 'some' '(' expr ')'   (any row of a to-many — FJS-D566)
//   compOp   ::= '==' | '!=' | '<' | '>' | '<=' | '>=' | 'in'

// The policy dialect: a condition over one record, which is what a schema takes.
const POLICY = Object.freeze({ flow: false, scope: null })

export function parseExpression(p, ctx = POLICY) {
  return ternary(p, ctx)
}

// The flow dialect (`FJS-D271`). Everything above, plus what a run needs: `$.a.b`
// at any depth (`FJS-D284`), a call to any function (`FJS-D285`), and a lambda
// as a call argument (`FJS-D286`). A bare name is refused rather than read as a
// column, because a flow has no record — the only names in scope are a lambda's
// own parameters.
export function parseFlowExpression(p) {
  return ternary(p, { flow: true, scope: new Set() })
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
  const cond = or(p, ctx)
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
  if (p.check(TK.BANG)) { p.eat(TK.BANG); return { type: 'not', expr: not(p, ctx) } }
  return primary(p, ctx)
}

function primary(p, ctx) {
  // A parenthesized group is an OPERAND like any other, so the comparison below
  // applies to it too — `(a ? 1 : 2) == 1` compares the group.
  const left = operand(p, ctx)
  const op   = compOp(p)
  if (op) {
    const opTok = p.advance()
    // BOTH sides take a group: `ownerId == (open ? auth().id : auth().adminId)`
    // is a ternary choosing which value to compare against, which is most of
    // what a ternary is for here.
    const right = operand(p, ctx)
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
    return { type: 'now' }
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
          `Write ['draft', 'review'], not a column or an expression.`, v)
      p.advance()
      items.push(v.value)
      if (!p.maybeEat(TK.COMMA)) break
    }
    p.eat(TK.RBRACKET)
    if (!items.length)
      throw p.fail(`An empty list in a policy expression matches nothing — say so with a literal instead`, t)
    return { type: 'list', items }
  }

  // A field reference (any other identifier), or one hop across a relation.
  //
  // `order.userId` is a column on the model this one belongs to, and the
  // compiler owns the join (`FJS-D221`). One hop, because transitive is N joins
  // the author cannot see, per policy, per query — so `a.b.c` is refused HERE
  // rather than compiled into something slow, which makes the bound
  // discoverable from the mistake instead of from a decision record.
  //
  // Inside `rel.some(…)` a name is a column of the rows being tested, and the
  // relation has already spent the one hop — so a dot there is refused the way
  // `a.b.c` is, and for the same reason.
  if (t.type === TK.IDENT) {
    p.eat(TK.IDENT)
    if (!p.check(TK.DOT)) return { type: 'field', name: t.value }
    if (ctx.within)
      throw p.fail(
        `'${t.value}.…' inside '${ctx.within}.some(…)' crosses a second relation. A name there is ` +
        `a column on the rows '${ctx.within}' holds — one hop is the bound, and '${ctx.within}' spent it.`, p.peek())
    p.eat(TK.DOT)
    const field = p.eat(TK.IDENT).value
    if (field === 'some' && p.check(TK.LPAREN)) return some(p, ctx, t.value)
    if (p.check(TK.DOT)) {
      // `interview.scorecards.some(…)` is a to-many test two relations away,
      // and saying *crosses two relations* names the hops where the author was
      // reaching for the test.
      if (p.peek(1)?.value === 'some' && p.peek(2)?.type === TK.LPAREN)
        throw p.fail(
          `'${t.value}.${field}.some(…)' tests rows two relations away. '.some()' asks about a relation ` +
          `on THIS model — put the rule on the model '${t.value}' points at, where it reads '${field}.some(…)'.`, p.peek())
      throw p.fail(
        `'${t.value}.${field}.…' crosses two relations. A policy may name a column ONE hop away — ` +
        `put the rule on the model '${t.value}' points at, or carry the value on this model.`, p.peek())
    }
    return { type: 'path', rel: t.value, name: field }
  }

  throw p.fail(`Expected a value in policy expression, got '${t.value ?? t.type}'`, t)
}

// `members.some(userId == auth().id)` — does ANY row of a to-many relation
// satisfy the condition (`FJS-D566`). The same question the query `where` asks
// as `{ members: { some: … } }`, under the same word. The condition is read
// against the related model, which is why it is a node of its own rather than
// a path: its names belong to another model, and a walker that descended into
// it as though they were this model's would check them against the wrong
// field list.
function some(p, ctx, rel) {
  p.eat(TK.LPAREN)
  if (p.check(TK.RPAREN))
    throw p.fail(`'${rel}.some()' needs a condition — the columns it tests are the rows '${rel}' holds`, p.peek())
  const where = parseExpression(p, { ...ctx, within: rel })
  p.eat(TK.RPAREN)
  return { type: 'some', rel, where }
}
