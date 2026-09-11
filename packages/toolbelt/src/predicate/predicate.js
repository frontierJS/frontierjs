/*
 * predicate.js — does this record satisfy a declared expression?
 *
 * The `.lite` policy expression language, evaluated against one record in
 * JavaScript, in SQLite's three-valued logic and with SQLite's comparison
 * rules. `@@allow`/`@@deny` on a create, `$readAs` grading a broadcast, and a
 * `@required(where: …)` deciding whether a form must ask for a value are all
 * this one question.
 *
 * ── Why it is here and not in litestone ──────────────────────────────────────
 *
 * It was litestone's, and litestone is where the language lives — but a
 * condition cannot cross to a browser as a VALUE. `@required(where: status ==
 * 'shipped')` has to be answered against the record currently on screen, which
 * changes as somebody types, so either the browser gets an evaluator or it asks
 * the server on every keystroke.
 *
 * The dependency direction forbids the obvious route: sierra cannot import
 * litestone's internals and `@frontierjs/ui` cannot import sierra. Below the
 * graph is what both may have (`FJS-D26`), which is the same argument that put
 * `/jsonschema`, `/hooks`, `/directives` and `/inflect` here.
 *
 * **This is a MOVE and not a third compilation, and the distinction is the whole
 * safety argument.** A row policy is compiled twice — into SQL by `compileSql`
 * and into JavaScript here — and the two are held together by a real oracle
 * (`verifyRowPolicies`, and `test/policy-interpreters.test.ts` asking both
 * halves the same predicate over the same rows). `FJS-195` is what happens when
 * a form lands in one compiler and not the other. A second CALLER of one
 * compiler is not that: litestone's `evalJs` is this function with litestone's
 * environment passed in, so the browser runs the same bytes and there is
 * nothing new to drift against.
 *
 * ── Three answers, not two ───────────────────────────────────────────────────
 *
 * `true` · `false` · `null` — SQL's UNKNOWN, which is not *false*. An `@@allow`
 * holds only on TRUE and an `@@deny` fires on TRUE and UNKNOWN alike, which is
 * `(allows) AND NOT (denies)` on both sides (`FJS-668`). `x == null` is the one
 * comparison that answers a boolean over an absent value, because that is how
 * this language spells `IS NULL`.
 *
 * ── What the caller injects ──────────────────────────────────────────────────
 *
 * Two node types read ANOTHER MODEL — `check(field)` and a relation path — and
 * neither can be answered from a record: on the server each opens a database.
 * They are resolvers rather than branches for that reason, and their defaults
 * are the answers litestone gives when the hop cannot be made: a path yields
 * `null` (a scalar subquery over no row IS NULL, so an allow fails closed and a
 * deny fires) and a `check()` answers `true` (it is a predicate, and the SQL
 * half allows when the target has no policy).
 *
 * `affinityOf` is the third and it is not decoration — see `compare` below.
 */

// ─── three-valued logic ───────────────────────────────────────────────────────
//
// Both sides of AND/OR are evaluated. A short circuit would be right one way
// (`FALSE AND NULL` is FALSE) and wrong the other (`NULL AND FALSE` is FALSE
// too, but only if the right side is looked at). The language has no side
// effects, which is what makes evaluating both free.
export const truth = (v) => (v === null || v === undefined ? null : Boolean(v))
export const and3  = (l, r) => (l === false || r === false ? false : l === null || r === null ? null : true)
export const or3   = (l, r) => (l === true  || r === true  ? true  : l === null || r === null ? null : false)
export const not3  = (v)    => (v === null ? null : !v)

// ─── SQLite's comparison, in the interpreter that has JavaScript's ────────────
//
// SQLite applies the COLUMN's affinity to the other operand and then orders by
// storage class; JS `===` does neither. So `ownerId == auth().id` over an `Int`
// column and a caller whose id is the string `'5'` — which is every junction
// principal, since a session carries `userId` as text — is TRUE through a query
// and FALSE here unless this is done. Measured across column type × operator ×
// operand, 54 of 594 cells disagreed, in both directions and on every operator
// (`FJS-713`). Coercing one claim closes four of those cells and leaves fifty,
// which is why the fix is here rather than at the principal.

// A JS value as SQLite would STORE it — the binder's own conversions, since
// that is what the SQL half is comparing against.
const toStorage = (v) => {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date)      return v.toISOString()
  return v
}

// NUMERIC affinity converts TEXT only when it is a well-formed number, and
// leaves it TEXT otherwise — which is what makes `qty < 'abc'` TRUE rather than
// unknown. `Number` is wider than SQLite here (hex, `Infinity`), so the shapes
// SQLite refuses are excluded rather than inherited.
const toNumeric = (v) => {
  if (typeof v !== 'string') return v
  if (!/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v)) return v
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}
const toText = (v) => (typeof v === 'number' ? String(v) : v)

export function compare(L, op, R, affL = null, affR = null) {
  // Every comparison with an absent operand is UNKNOWN, `IS NULL` included —
  // the presence test is a branch of its own above, and this is a comparison.
  if (L === null || L === undefined || R === null || R === undefined) return null

  L = toStorage(L)
  R = toStorage(R)

  // SQLite's own rules, in its own order (§4.2 Affinity Of Comparison
  // Operands): numeric affinity on one side pulls the other to a number, text
  // affinity pushes an unaffinitied operand to text, and nothing else applies.
  if      (affL === 'NUMERIC' && affR !== 'NUMERIC') R = toNumeric(R)
  else if (affR === 'NUMERIC' && affL !== 'NUMERIC') L = toNumeric(L)
  else if (affL === 'TEXT'    && affR === null)      R = toText(R)
  else if (affR === 'TEXT'    && affL === null)      L = toText(L)

  // Anything that is not a number or a string after that is a value this
  // comparison has no storage class for — a Bytes column, a Json document.
  // Those keep JavaScript's answer rather than being given a wrong one: two
  // distinct Buffers rank equal under a class comparison, which would make
  // `==` TRUE for them.
  const rank = (v) => (typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 0)
  const rl = rank(L), rr = rank(R)
  if (!rl || !rr) {
    switch (op) {
      case '==': return L === R
      case '!=': return L !== R
      case '<':  return L < R
      case '>':  return L > R
      case '<=': return L <= R
      case '>=': return L >= R
      default:   throw new Error(`Unknown policy comparison operator: ${op}`)
    }
  }

  // NULL < INTEGER/REAL < TEXT < BLOB, and within a class by value. Text is
  // compared with JS `<`, which is UTF-16 code-unit order where SQLite's BINARY
  // collation is UTF-8 byte order — the two agree below U+10000 and not above.
  const c = rl !== rr ? (rl < rr ? -1 : 1) : L < R ? -1 : L > R ? 1 : 0
  switch (op) {
    case '==': return c === 0
    case '!=': return c !== 0
    case '<':  return c < 0
    case '>':  return c > 0
    case '<=': return c <= 0
    case '>=': return c >= 0
    default:   throw new Error(`Unknown policy comparison operator: ${op}`)
  }
}

/**
 * Evaluate a parsed policy expression against one record.
 *
 * @param {object} node  the AST a `.lite` predicate parsed to
 * @param {object} env
 *   `record`        the row, keyed by COLUMN (see `columnOf`)
 *   `auth`          the principal, or null
 *   `now`           the instant, as ISO text — ONE per evaluation, never per node
 *   `columnOf`      field name → the key to read on the record. Litestone passes
 *                   the relation map's foreign key here, because `ownerId ==
 *                   auth().id` on a `belongsTo` names the relation and reads the
 *                   column. Identity is the right answer where there is no map.
 *   `affinityOf`    (node) → 'NUMERIC' | 'TEXT' | 'BLOB' | null
 *   `resolvePath`   (node) → value, for a one-hop read. Default null.
 *   `resolveCheck`  (node) → boolean, for `check(field)`. Default true.
 *
 * @returns the EXPRESSION's value, which is a three-valued truth for every node
 *   that compares or combines — and the column's own value for a bare `field`,
 *   because a field node is also an operand and `compare` needs what is stored.
 *   So a predicate that IS a column (`where: active`) answers 1 or 0 out of
 *   SQLite, not true or false.
 *
 *   **Wrap the top-level answer in `truth()`.** `=== true` on a raw column is
 *   the two compilers disagreeing: the SQL half emits `"active"` and SQLite
 *   reads 1 as true, so a JS caller testing identity calls the row exempt while
 *   the CHECK refuses it. Litestone's policy layer has always done this —
 *   `allowHolds` / `denyFires` in `core/policy.js` — and sierra's `requiredFor`
 *   had not, which is how a `@required(where: active)` form offered an optional
 *   box for a column the boundary would refuse.
 */
export function evaluate(node, env = {}) {
  const {
    record = null,
    auth   = null,
    now    = null,
    columnOf     = (n) => n,
    affinityOf   = () => null,
    resolvePath  = () => null,
    resolveCheck = () => true,
  } = env

  const ev = (n) => evaluate(n, env)
  const read = (name) => record?.[columnOf(name)] ?? null

  switch (node?.type) {
    case 'or':      return or3(truth(ev(node.left)), truth(ev(node.right)))
    case 'and':     return and3(truth(ev(node.left)), truth(ev(node.right)))
    case 'not':     return not3(truth(ev(node.expr)))

    case 'literal': return node.value
    case 'field':   return record?.[node.name] ?? null
    case 'path':    return resolvePath(node)
    case 'check':   return resolveCheck(node)
    case 'now':     return now

    case 'auth':
      return node.field ? (auth?.[node.field] ?? null) : auth

    // The other half of the same sentence. `create` has no WHERE to put a CASE
    // in, so a ternary landing only in the SQL compiler would be decided one
    // way by the reader and another by the writer — `FJS-195` exactly.
    case 'ternary': return ev(node.cond) ? ev(node.then) : ev(node.else)

    case 'compare': {
      const { left, right, op } = node

      if (op === 'in') {
        const listOf = (n) => {
          if (n.type === 'list') return n.items
          const v = n.type === 'auth'  ? (n.field ? auth?.[n.field] : auth?.id)
                  : n.type === 'field' ? read(n.name)
                  : ev(n)
          // A create may carry the array as written; a row read back has been
          // deserialized. A column absent from the payload is not an empty
          // list — it is a column that was not set, and nothing is in it.
          if (Array.isArray(v)) return v
          if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] } }
          return v == null ? [] : [v]
        }
        const needle = left.type === 'field' ? read(left.name) : ev(left)
        // `NULL IN (…)` is NULL in SQL, never false — the value is unknown, so
        // whether it is in the list is unknown.
        if (needle === null || needle === undefined) return null
        // Membership is equality repeated, so it takes the same affinity — the
        // left operand's, applied to each element. A NULL in the list is
        // UNKNOWN rather than a miss, for the same reason an absent operand is.
        const affNeedle = affinityOf(left)
        let unknown = false
        for (const item of listOf(right)) {
          const hit = compare(needle, '==', item, affNeedle, null)
          if (hit === true) return true
          if (hit === null) unknown = true
        }
        return unknown ? null : false
      }

      // `x == null` is how this language spells `IS NULL`, and it is the one
      // comparison that answers a BOOLEAN over an absent value rather than
      // UNKNOWN — in SQL too, which is why SQL has a second spelling for it.
      // Without this branch the presence test propagates its own subject and
      // there is no way to write "the caller carries no such claim" at all.
      // It reads a FIELD as well as a claim: `ownerId == null` compiles to
      // `ownerId IS NULL`, and the two halves have to agree about that.
      const nullTest = (probe, other) =>
        other.type === 'literal' && other.value === null ? probe : null
      const probe = nullTest(left, right) ?? nullTest(right, left)
      if (probe) {
        const v = probe.type === 'auth'
          ? (probe.field ? (auth?.[probe.field] ?? null) : auth)
          : ev(probe)
        const absent = v === null || v === undefined
        return op === '==' ? absent : !absent
      }

      // field == auth() — the bare principal is its id, and on a `belongsTo`
      // the field names the relation while the value is on the foreign key.
      if (left.type === 'field' && right.type === 'auth' && right.field === null)
        return compare(read(left.name), op, auth?.id ?? null, affinityOf(left), null)
      if (right.type === 'field' && left.type === 'auth' && left.field === null)
        return compare(auth?.id ?? null, op, read(right.name), null, affinityOf(right))

      return compare(ev(left), op, ev(right), affinityOf(left), affinityOf(right))
    }

    // The SQL compiler throws on a node it does not know; answering `true` here
    // and calling it conservative is the opposite of conservative. The two
    // halves compile ONE language and the ops they cover are disjoint, so a node
    // added to the grammar and to the SQL half alone would not fail — it would
    // make every create policy holding it a silent no-op. That is what `check()`
    // cost once already: a cross-tenant create permitted in silence (`FJS-282`).
    // Refuse, so the gap arrives as the same error from either half (`FJS-635`).
    default:
      throw new Error(`Unknown policy AST node type: ${node?.type}`)
  }
}
