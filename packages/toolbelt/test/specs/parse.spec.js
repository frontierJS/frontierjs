/*
 * parse.spec.js
 *
 * `parseExpression` — the `.lite` expression grammar, walked over a cursor.
 *
 * What is graded here is the CONTRACT a caller relies on: the grammar reads
 * tokens through the six cursor methods and nothing else, builds the AST
 * `evaluate` answers, and throws whatever the caller's `fail` returns with the
 * token it failed at. Litestone is the real caller and every schema in its suite
 * parses through this function, so the policy rows below are hand-built tokens —
 * the shape litestone hands in. The flow rows tokenize their own text, because
 * that is how orion arrives (`FJS-D287`).
 */

import { parseExpression, parseFlowExpression, tokenize, TOKEN, OPERATORS, evaluate, ParseError } from '../../src/predicate/predicate.js'

const T = TOKEN
const tok = (type, value = null) => ({ type, value, line: 1, col: 0 })

// The smallest cursor the grammar can walk — the shape litestone's parser has.
function cursor(tokens) {
  const all = [...tokens, tok('EOF')].map((t, i) => ({ ...t, col: i + 1 }))
  let pos = 0
  const p = {
    peek:     (n = 0) => all[pos + n],
    advance:  () => all[pos++],
    check:    (type) => all[pos].type === type,
    eat(type) {
      if (all[pos].type !== type) throw p.fail(`Expected ${type}, got '${all[pos].value}'`, all[pos])
      return all[pos++]
    },
    maybeEat: (type) => (all[pos].type === type ? all[pos++] : undefined),
    fail:     (msg, at) => Object.assign(new Error(msg), { at }),
    rest:     () => all.slice(pos),
  }
  return p
}

test('parse: a comparison between a column and a literal', function () {
  const ast = parseExpression(cursor([tok(T.IDENT, 'status'), tok(T.EQ, '=='), tok(T.STRING, 'paid')]))
  assert.equal(JSON.stringify(ast), JSON.stringify({
    type: 'compare', op: '==', left: { type: 'field', name: 'status' }, right: { type: 'literal', value: 'paid' },
  }))
})

test('parse: && binds tighter than ||, and the ternary looser than both', function () {
  // a || b && c ? 1 : 2
  const ast = parseExpression(cursor([
    tok(T.IDENT, 'a'), tok(T.OR, '||'), tok(T.IDENT, 'b'), tok(T.AND, '&&'), tok(T.IDENT, 'c'),
    tok(T.QUESTION, '?'), tok(T.NUMBER, 1), tok(T.COLON, ':'), tok(T.NUMBER, 2),
  ]))
  assert.equal(ast.type, 'ternary')
  assert.equal(ast.cond.type, 'or')
  assert.equal(ast.cond.right.type, 'and')
})

test('parse: what it builds is what evaluate answers', function () {
  // qty > 3 && status in ['paid', 'shipped']
  const ast = parseExpression(cursor([
    tok(T.IDENT, 'qty'), tok(T.GT, '>'), tok(T.NUMBER, 3), tok(T.AND, '&&'),
    tok(T.IDENT, 'status'), tok(T.IDENT, 'in'), tok(T.LBRACKET, '['),
    tok(T.STRING, 'paid'), tok(T.COMMA, ','), tok(T.STRING, 'shipped'), tok(T.RBRACKET, ']'),
  ]))
  assert.equal(evaluate(ast, { record: { qty: 5, status: 'shipped' } }), true)
  assert.equal(evaluate(ast, { record: { qty: 5, status: 'draft' } }), false)
})

test('parse: stops at the first token that is not part of the expression', function () {
  const p = cursor([tok(T.IDENT, 'a'), tok(T.EQ, '=='), tok(T.NUMBER, 1), tok(T.RPAREN, ')')])
  parseExpression(p)
  assert.equal(p.peek().type, T.RPAREN)
})

test('parse: a refusal is the caller\'s error, at the token it failed on', function () {
  const p = cursor([tok(T.IDENT, 'order'), tok(T.DOT, '.'), tok(T.IDENT, 'user'), tok(T.DOT, '.'), tok(T.IDENT, 'id')])
  let threw = null
  try { parseExpression(p) } catch (e) { threw = e }
  assert.ok(threw, 'expected a refusal')
  assert.match(threw.message, /crosses two relations/)
  assert.equal(threw.at.col, 4)
})

// `members.some(…)` (`FJS-D566`). The condition is a full expression, and the
// relation has spent the one hop — so a dot or a check() inside is refused at
// the token that makes it, and so is a to-many test two relations away.
const SOME = (inner) => [
  tok(T.IDENT, 'members'), tok(T.DOT, '.'), tok(T.IDENT, 'some'), tok(T.LPAREN, '('),
  ...inner, tok(T.RPAREN, ')'),
]

test('parse: rel.some(expr) is its own node, the condition parsed whole', function () {
  const ast = parseExpression(cursor(SOME([
    tok(T.IDENT, 'userId'), tok(T.EQ, '=='), tok(T.IDENT, 'auth'), tok(T.LPAREN, '('), tok(T.RPAREN, ')'),
    tok(T.DOT, '.'), tok(T.IDENT, 'id'), tok(T.AND, '&&'), tok(T.IDENT, 'status'), tok(T.EQ, '=='), tok(T.STRING, 'active'),
  ])))
  assert.equal(ast.type, 'some')
  assert.equal(ast.rel, 'members')
  assert.equal(ast.where.type, 'and')
})

test('parse: a field NAMED some is still a path — only a call is the test', function () {
  const ast = parseExpression(cursor([tok(T.IDENT, 'owner'), tok(T.DOT, '.'), tok(T.IDENT, 'some'), tok(T.EQ, '=='), tok(T.NUMBER, 1)]))
  assert.equal(JSON.stringify(ast.left), JSON.stringify({ type: 'path', rel: 'owner', name: 'some' }))
})

test('parse: inside rel.some(…) a dot is a second hop, and so is check()', function () {
  assert.throws(() => parseExpression(cursor(SOME([
    tok(T.IDENT, 'team'), tok(T.DOT, '.'), tok(T.IDENT, 'private'), tok(T.EQ, '=='), tok(T.BOOL, false),
  ]))), /inside 'members.some\(…\)' crosses a second relation/)
  assert.throws(() => parseExpression(cursor(SOME([
    tok(T.IDENT, 'check'), tok(T.LPAREN, '('), tok(T.IDENT, 'team'), tok(T.RPAREN, ')'),
  ]))), /second hop/)
})

test('parse: a to-many test two relations away names the test, not the hops', function () {
  assert.throws(() => parseExpression(cursor([
    tok(T.IDENT, 'interview'), tok(T.DOT, '.'), ...SOME([tok(T.IDENT, 'done'), tok(T.EQ, '=='), tok(T.BOOL, true)]),
  ])), /two relations away.*'members\.some\(…\)'/)
})

test('parse: rel.some() with no condition is refused', function () {
  assert.throws(() => parseExpression(cursor(SOME([]))), /needs a condition/)
})

test('parse: a word where an operator belongs names the operators', function () {
  assert.throws(
    () => parseExpression(cursor([tok(T.IDENT, 'status'), tok(T.IDENT, 'like'), tok(T.STRING, 'a%')])),
    new RegExp(`'like' is not a policy operator. Available: ${OPERATORS.join(', ')}`),
  )
})

// ── the offset operators ─────────────────────────────────────────────────────
//
// `+` and `-` lex so `@@commitment(abandon, on: createdAt + 14d)` can be read;
// no expression grammar accepts one. A `-` before a digit stays a negative
// NUMBER, so `createdAt -14d` and `createdAt - 14d` reach the reader as two
// different token runs and it has to take both.

test('lex: + and - are tokens, and -digit is still a number', function () {
  const types = (src) => tokenize(src).map((t) => t.type + (t.value == null ? '' : ':' + t.value))
  assert.equal(types('createdAt + 14d').join(' '), 'IDENT:createdAt PLUS:+ NUMBER:14 IDENT:d EOF')
  assert.equal(types('dueOn - graceDays').join(' '), 'IDENT:dueOn MINUS:- IDENT:graceDays EOF')
  assert.equal(types('createdAt -14d').join(' '), 'IDENT:createdAt NUMBER:-14 IDENT:d EOF')
  assert.equal(types('a -> b').join(' '), 'IDENT:a ARROW:-> IDENT:b EOF')
})

test('parse: the expression stops at +, leaving it for the caller', function () {
  const p   = cursor(tokenize('qty + 1').slice(0, -1))
  const ast = parseExpression(p)
  assert.equal(ast.type, 'field')
  assert.equal(p.peek().type, T.PLUS)
})

// ── the flow dialect ─────────────────────────────────────────────────────────
//
// Same grammar, same tokens, and the lexer is now in this kit too — so a spec
// can write the text a flow author writes.

function flow(src) {
  const all = tokenize(src)
  let pos = 0
  const p = {
    peek:     (n = 0) => all[pos + n],
    advance:  () => all[pos++],
    check:    (t) => all[pos].type === t,
    eat(t) { if (all[pos].type !== t) throw p.fail(`Expected ${t}, got '${all[pos].value}'`, all[pos]); return all[pos++] },
    maybeEat: (t) => (all[pos].type === t ? all[pos++] : undefined),
    fail:     (m, at) => new ParseError(m, at),
  }
  return parseFlowExpression(p)
}

test('parse: a flow reads the run with $ at any depth', function () {
  assert.equal(JSON.stringify(flow('$.trigger.body.email')), JSON.stringify({ type: 'ref', path: '$.trigger.body.email' }))
  assert.equal(JSON.stringify(flow('$')), JSON.stringify({ type: 'ref', path: '$' }))
})

test('parse: a flow call, and a lambda binding a name over its body', function () {
  const ast = flow('map($.items, i => upper(i.name))')
  assert.equal(ast.type, 'call')
  assert.equal(ast.name, 'map')
  assert.equal(ast.args[1].type, 'lambda')
  assert.equal(JSON.stringify(ast.args[1].params), '["i"]')
  assert.equal(ast.args[1].body.args[0].path, '$.i.name')
})

test('parse: reduce binds two names', function () {
  const ast = flow('reduce($.items, 0, (acc, i) => add(acc, i.price))')
  assert.equal(JSON.stringify(ast.args[2].params), '["acc","i"]')
})

test('parse: a bare name is refused in a flow, and a column is not', function () {
  assert.throws(() => flow("status == 'paid'"), /'status' is not defined here/)
  // The same text in the policy dialect is a column, which is the whole reason
  // the dialect exists rather than a second grammar.
  const policy = parseExpression(cursor([tok(TOKEN.IDENT, 'status'), tok(TOKEN.EQ, '=='), tok(TOKEN.STRING, 'paid')]))
  assert.equal(policy.left.type, 'field')
})

test("parse: a policy's own words are refused in a flow", function () {
  assert.throws(() => flow('auth().id == 1'), /belongs to a policy/)
  assert.throws(() => flow("check(owner, 'read')"), /belongs to a policy/)
})

test('parse: a lambda parameter is out of scope outside its body', function () {
  assert.throws(() => flow('add(i, map($.items, i => i))'), /'i' is not defined here/)
})

test('parse: an ordering against a literal null is refused, == and != are not', function () {
  // SQL answers UNKNOWN for `qty > NULL` and the JS half answered `!absent`, so
  // the two interpreters disagreed on every ordering (`FJS-1152`).
  const q = (op) => cursor([tok(T.IDENT, 'qty'), tok(op, ''), tok(T.IDENT, 'null')])
  for (const op of [T.LT, T.GT, T.LTE, T.GTE]) assert.throws(() => parseExpression(q(op)), /null/)
  const r = (op) => cursor([tok(T.IDENT, 'null'), tok(op, ''), tok(T.IDENT, 'qty')])
  assert.throws(() => parseExpression(r(T.GT)), /null/)
  assert.equal(parseExpression(q(T.EQ)).op, '==')
  assert.equal(parseExpression(q(T.NEQ)).op, '!=')
})

test('parse: a malformed number literal is refused rather than lexed as NaN', function () {
  // A NaN literal compared equal to every number on the JS side, so
  // @@allow('create', qty <= 1.000.000) admitted any qty while SQL hid the row.
  for (const src of ['1.000.000', '1.5.0', '1..', '-1.2.3']) assert.throws(() => tokenize(src), /Malformed number/)
  assert.equal(tokenize('1.5')[0].value, 1.5)
  assert.equal(tokenize('-2')[0].value, -2)
})
