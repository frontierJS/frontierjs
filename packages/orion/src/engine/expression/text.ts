// ─── a flow expression, written as text ───────────────────────────────────────
//
// `$.trigger.body.amount > 100 && $.lead.data.tier == 'gold'` is one language
// with `@@allow(status == 'paid')`, and it is parsed by one parser
// (`FJS-D271`) — `@frontierjs/toolbelt/predicate`, which the engine may import
// because it is substrate rather than a framework package (`FJS-D26`).
//
// ── The halves are split where the rulings split them ────────────────────────
//
// VALUES are the engine's: a path, a call, a lambda over a collection
// (`FJS-D284`–`FJS-D286`) compile to the `Expression` the resolver already
// runs, with its own function table.
//
// A CONDITION is the predicate kit's, and it answers in SQLite's three-valued
// logic — `null > 1` is unknown, not false, and `!unknown` is unknown. That is
// what a policy answers, which is the point of sharing the language: an edge
// condition and a row policy written the same way behave the same way. So a
// comparison, `&&`, `||` and `!` compile to one `predicate` node holding the
// parsed tree, with every value inside it marked as a hole; at resolve time the
// holes are filled by the engine and `evaluate` answers the rest.
//
// A `null` answer is falsy, so an edge whose condition is unknown does not fire.

import { tokenize, TK, ParseError, parseFlowExpression, evaluate } from '@frontierjs/toolbelt/predicate'
import type { Expression, PredicateNode } from "../types"

// ─── the cursor the grammar walks ─────────────────────────────────────────────

interface Token { type: string; value: unknown; line: number; col: number }

function cursor(tokens: Token[]) {
  let pos = 0
  const p = {
    peek:     (n = 0) => tokens[pos + n],
    advance:  () => tokens[pos++],
    check:    (type: string) => tokens[pos]?.type === type,
    eat(type: string) {
      const t = tokens[pos]
      if (!t || t.type !== type) throw p.fail(`Expected ${type}, got '${t?.value ?? 'end of expression'}'`, t)
      return tokens[pos++]!
    },
    maybeEat: (type: string) => (tokens[pos]?.type === type ? tokens[pos++] : undefined),
    fail:     (msg: string, at?: Token) => new ParseError(msg, at),
    done:     () => tokens[pos]?.type === TK.EOF,
    rest:     () => tokens[pos],
  }
  return p
}

/** Parse one flow expression and compile it to what the resolver runs. */
export function compileExpression(src: string): Expression {
  const p = cursor(tokenize(src) as Token[])
  const ast = parseFlowExpression(p)
  // Trailing tokens mean the expression ended earlier than the author thought —
  // `$.a $.b` parses as `$.a` and would otherwise run, silently, as half of it.
  if (!p.done()) throw p.fail(`Unexpected '${p.rest()?.value}' after the expression`, p.rest())
  return compile(ast)
}

// ─── the parsed tree → an Expression ──────────────────────────────────────────

const CONDITIONS = new Set(['and', 'or', 'not', 'compare'])

// The iteration calls. Each takes its collection first and a lambda last, and
// what it compiles to is the node the resolver already has for it.
const ITERATORS = new Set(['map', 'filter', 'reduce'])

type Ast = { type: string; [k: string]: any }

function compile(ast: Ast): Expression {
  if (CONDITIONS.has(ast.type)) return { type: 'predicate', ast: withHoles(ast) }

  switch (ast.type) {
    case 'literal':  return { type: 'literal', value: ast.value }
    // A list is only ever the right side of `in`, where the predicate kit reads
    // the members as values.
    case 'list':     return { type: 'literal', value: ast.items }
    case 'ref':      return { type: 'ref', path: ast.path }
    case 'ternary':  return { type: 'cond', if: compile(ast.cond), then: compile(ast.then), else: compile(ast.else) }
    case 'call':     return call(ast)
    case 'template': return { type: 'template', parts: ast.parts.map(compile) }
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(ast.properties.map((e: Ast) => [e.key, compile(e.value)])),
      }
    default:
      throw new Error(`orion: cannot compile expression node "${ast.type}"`)
  }
}

function call(ast: Ast): Expression {
  if (ITERATORS.has(ast.name)) return iterator(ast)
  if (ast.args.some((a: Ast) => a.type === 'lambda'))
    throw new Error(`orion: '${ast.name}' does not take a lambda — map, filter and reduce do`)
  return { type: 'fn', name: ast.name, args: ast.args.map(compile) }
}

function iterator(ast: Ast): Expression {
  const lambda = ast.args[ast.args.length - 1]
  if (!lambda || lambda.type !== 'lambda')
    throw new Error(`orion: ${ast.name}(…) takes a lambda as its last argument — ${ast.name}($.items, i => …)`)
  const over = compile(ast.args[0])

  if (ast.name === 'reduce') {
    if (lambda.params.length !== 2)
      throw new Error(`orion: reduce's lambda takes the accumulator and the item — reduce($.items, 0, (acc, i) => …)`)
    if (ast.args.length !== 3)
      throw new Error(`orion: reduce takes the collection, the starting value and a lambda`)
    const [acc, as] = lambda.params
    return { type: 'reduce', over, as, acc, init: compile(ast.args[1]), body: compile(lambda.body) }
  }

  if (lambda.params.length !== 1)
    throw new Error(`orion: ${ast.name}'s lambda takes one parameter — ${ast.name}($.items, i => …)`)
  if (ast.args.length !== 2)
    throw new Error(`orion: ${ast.name} takes the collection and a lambda`)
  const as = lambda.params[0]
  return ast.name === 'map'
    ? { type: 'map',    over, as, body:  compile(lambda.body) }
    : { type: 'filter', over, as, where: compile(lambda.body) }
}

// Everything in a value position inside a condition becomes a hole the resolver
// fills; the shape around it stays as parsed, because that shape is what the
// predicate kit reads.
function withHoles(ast: Ast): PredicateNode {
  switch (ast.type) {
    case 'and':
    case 'or':      return { type: ast.type, left: withHoles(ast.left), right: withHoles(ast.right) } as PredicateNode
    case 'not':     return { type: 'not', expr: withHoles(ast.expr) } as PredicateNode
    case 'compare': return { type: 'compare', op: ast.op, left: operandHole(ast.left), right: operandHole(ast.right) } as PredicateNode
    default:        return operandHole(ast)
  }
}

function operandHole(ast: Ast): PredicateNode {
  if (CONDITIONS.has(ast.type)) return withHoles(ast)
  // A literal and a list are values already, and `evaluate` reads both — no
  // round trip through the resolver for them.
  if (ast.type === 'literal') return { type: 'literal', value: ast.value } as PredicateNode
  if (ast.type === 'list')    return { type: 'list', items: ast.items } as PredicateNode
  return { type: 'hole', expr: compile(ast) } as PredicateNode
}

// ─── answering one ────────────────────────────────────────────────────────────

/**
 * Fill the holes with the resolver's answers, then let the predicate kit judge.
 * Answers `true`, `false`, or `null` for unknown.
 *
 * A filled hole becomes a FIELD over a record built here, never a literal. The
 * language spells `IS NULL` as `x == null`, so the kit reads a literal null as
 * the author having written one — and a resolved value that happens to be null
 * would then turn `$.a > 1` into a presence test answering true. A field is what
 * a run value is standing in for anyway: the thing whose value is not known
 * until the expression runs.
 */
export function answerPredicate(
  node: PredicateNode,
  resolveValue: (expr: Expression) => unknown,
): boolean | null {
  const record: Record<string, unknown> = {}
  const filled = fill(node, (expr) => {
    const name = `h${Object.keys(record).length}`
    record[name] = resolveValue(expr)
    return name
  })
  return evaluate(filled, { record }) as boolean | null
}

function fill(node: PredicateNode, bind: (expr: Expression) => string): Ast {
  const n = node as Ast
  switch (n.type) {
    case 'hole':    return { type: 'field', name: bind(n.expr) }
    case 'and':
    case 'or':      return { type: n.type, left: fill(n.left, bind), right: fill(n.right, bind) }
    case 'not':     return { type: 'not', expr: fill(n.expr, bind) }
    case 'compare': return { type: 'compare', op: n.op, left: fill(n.left, bind), right: fill(n.right, bind) }
    default:        return n
  }
}
