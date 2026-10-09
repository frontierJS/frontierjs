/*
 * values.js — the predicate language read as TEXT that produces VALUES.
 *
 * A stored template (`Hi {{contact.name ? contact.name : 'there'}}`) is the
 * expression language handed to a stranger's keyboard and answered against an
 * object the app holds. The grammar needs a token cursor and nothing made one
 * from text, and `evaluate`'s defaults answer for a POLICY: `check()` is true,
 * `auth()` is the principal, `now()` is the clock. A caller producing text must
 * refuse those, and one that forgot rendered a stranger's `auth().id`.
 *
 * Parse with `parseText`, grade at save with `assertValues(ast, names)`, answer
 * with `evaluateValues(ast, data)` -- which grades again, so a row that was
 * written around the save check still cannot reach what a policy reaches.
 */

import { TK, tokenize, ParseError } from './tokenize.js'
import { parseExpression } from './parse.js'
import { evaluate } from './predicate.js'

function cursor(tokens) {
  let pos = 0
  const p = {
    peek:     (n = 0) => tokens[pos + n],
    advance:  () => tokens[pos++],
    check:    (type) => tokens[pos]?.type === type,
    maybeEat: (type) => (tokens[pos]?.type === type ? tokens[pos++] : undefined),
    eat(type) {
      const t = tokens[pos]
      if (!t || t.type !== type) throw p.fail(`Expected ${type}, got '${t?.value ?? 'end of expression'}'`, t)
      return tokens[pos++]
    },
    fail: (msg, at) => new ParseError(msg, at),
  }
  return p
}

/**
 * One policy-dialect expression from source text. Tokens left over mean the
 * expression ended earlier than the author thought, and `a b` would otherwise
 * run as `a`.
 */
export function parseText(src) {
  const p = cursor(tokenize(src))
  const ast = parseExpression(p)
  if (!p.check(TK.EOF)) {
    const t = p.peek()
    throw p.fail(`Unexpected '${t?.value}' after the expression`, t)
  }
  return ast
}

// What a value can be made of: a name, a literal, and choosing or comparing
// between them. Everything else reads something other than what was handed in.
const CHILDREN = {
  literal: [], list: [], path: [],
  ternary: ['cond', 'then', 'else'],
  compare: ['left', 'right'],
  and: ['left', 'right'], or: ['left', 'right'],
  not: ['expr'],
}

const REFUSED = {
  auth:  'auth() reads the caller, and a value is only what it was handed',
  now:   'now() reads the clock, and a value is only what it was handed',
  shift: 'now() reads the clock, and a value is only what it was handed',
  check: 'check() asks another model\'s policy',
  some:  '.some() reads rows of another model',
  field: 'a bare name has no record to read -- write it as owner.name',
}

/**
 * Throw a ParseError unless `ast` holds only values over `names`, the closed
 * list `{ owner: ['field', …] }` of what it may read. Own keys only, because
 * `constructor.constructor` is an own property of nothing the caller listed.
 */
export function assertValues(ast, names) {
  const walk = (n) => {
    const type = n?.type
    if (type === 'path') {
      if (!Object.hasOwn(names, n.rel) || !names[n.rel].includes(n.name)) {
        const known = Object.entries(names).flatMap(([rel, fields]) => fields.map(f => `${rel}.${f}`))
        throw new ParseError(`${n.rel}.${n.name} is not a name it may use. It may use ${known.join(', ')}`)
      }
      return
    }
    if (!Object.hasOwn(CHILDREN, type)) throw new ParseError(`${REFUSED[type] ?? `${type} is not a value`}`)
    for (const k of CHILDREN[type]) walk(n[k])
  }
  walk(ast)
}

/**
 * The expression's value over `data` (`{ owner: { field: value } }`), read by
 * own key and never writable through. A name the data lacks answers null.
 */
export function evaluateValues(ast, data) {
  assertValues(ast, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Object.keys(v)])))
  return evaluate(ast, {
    record: null,
    auth: null,
    resolvePath: (n) => (Object.hasOwn(data, n.rel) && Object.hasOwn(data[n.rel], n.name) ? data[n.rel][n.name] ?? null : null),
  })
}
