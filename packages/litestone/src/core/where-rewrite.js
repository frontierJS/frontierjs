// where-rewrite.js — the rewrites a caller's where takes before buildWhere
// compiles it, in the order a write takes: a `$scope` desugars to `$raw`, an
// @@extensible field name becomes its pooled slot, an equality operand goes
// through the field's write transforms, and a matchable protected field's
// operand is encoded the way its column was. Each rewrite is a function of the
// where alone; the ORDER is the correctness, because a transform applied after
// encryption encodes the wrong bytes and a scope expanded after the extensible
// rewrite names a column that no longer exists.
//
// Built once per table by `makeTable`, which hands it the table-local facts
// that live in that closure — the `@from` expression maps, the typed-JSON and
// point maps, the edge-or-relation filter, the @@extensible helpers — and takes
// back the entry points its verbs call.

import { buildWhere, rawClause, blobKeyClauses, sqlFragment, quoteIdent } from './query.js'
import { transformValue, ValidationError } from './validate.js'
import { compileScope } from './policy.js'
import { comparisonEncoderFor, legacyForm } from './encryption.js'

const JSON_WHOLE_OPS = new Set(['equals', 'not', 'in', 'notIn', 'isNull', 'isNotNull'])

export function makeWhereRewrite(shape, ctx, deps) {
  const { modelName, fieldKinds, fieldPolicy, columnMap } = shape
  const {
    edgeOrRelFilter, col, _hasScopes, _extensible, _extTenantCol, extTenant, extScope,
    _extDeclarations, _transformed, _fromExprMap, _fromExprMapAliased, _typedJsonMap, _pointMap,
  } = deps

  // A `$scope` becomes a `$raw` before anything else looks at the where.
  // Desugaring rather than adding a case to buildWhere is what makes it compose
  // for free: `{ $scope: 'overdue', status: 'open' }` conjoins, a scope nested
  // under AND/OR/NOT nests, and the parameters land in the position `$raw`'s
  // already do — one owner of each, instead of a second implementation.
  function expandScopes(where) {
    if (!where || typeof where !== 'object') return where
    if (Array.isArray(where)) return where.map(expandScopes)
    if (!('$scope' in where)) {
      let changed = false
      const out = {}
      for (const [k, v] of Object.entries(where)) {
        out[k] = (k === 'AND' || k === 'OR' || k === 'NOT') ? expandScopes(v) : v
        if (out[k] !== v) changed = true
      }
      return changed ? out : where
    }
    const { $scope, ...rest } = where
    const names = Array.isArray($scope) ? $scope : [$scope]
    if (!names.length)
      throw new ValidationError([{ path: ['where', '$scope'], message:
        `$scope was given an empty list — omit it, or name a scope` }])
    for (const n of names)
      if (typeof n !== 'string')
        throw new ValidationError([{ path: ['where', '$scope'], message:
          `$scope names a declared @@scope, so it is a string — got ${n === null ? 'null' : typeof n}` }])
    const clauses = names.map(n =>
      compileScope(modelName, n, ctx))
    // Several scopes AND, and they AND with the rest of the where. A disjunction
    // is written as its own scope, where the OR is in the expression language
    // and both compilers can see it.
    const merged = clauses.length === 1
      ? clauses[0]
      : rawClause(clauses.map(c => `(${c.sql})`).join(' AND '), clauses.flatMap(c => c.params))
    const out = expandScopes(rest)
    // `$raw` is a single slot, so a caller using both needs them conjoined.
    return out.$raw
      ? { ...out, $raw: rawClause(`(${merged.sql}) AND (${out.$raw.sql})`, [...merged.params, ...out.$raw.params]) }
      : { ...out, $raw: merged }
  }

  function buildWhereWithEncryption(where, params, tableAlias = null, outerIsAliased = tableAlias === 't') {
    const fromMap = outerIsAliased ? _fromExprMapAliased : _fromExprMap
    if (!where) return buildWhere(where, params, fromMap, tableAlias, _typedJsonMap, edgeOrRelFilter, fieldKinds, columnMap, _pointMap)
    where = _hasScopes ? expandScopes(where) : where
    where = _extensible ? rewriteExtensibleWhere(where, _extTenantCol ? () => extTenant(null, where) : null,
                                                  _extensible.scope ? () => extScope(null, where) : null, tableAlias) : where
    where = _transformed ? rewriteTransformedWhere(where) : where
    let rewritten = where
    if (ctx.enc.key) {
      rewritten = rewriteEncryptedWhere(where)
      if (rewritten?.__impossible) {
        const prefix = tableAlias ? `${tableAlias}.` : ''
        return `${prefix}"id" IS NULL AND ${prefix}"id" IS NOT NULL`
      }
    }
    return buildWhere(rewritten, params, fromMap, tableAlias, _typedJsonMap, edgeOrRelFilter, fieldKinds, columnMap, _pointMap)
  }

  // The same where as a fragment: its text and its binds leave together, so a
  // verb assembling it beside the policy and the seal cannot push one half
  // before the other (`FJS-262`). `null` when the where said nothing.
  function whereFragment(where, tableAlias = null, outerIsAliased = tableAlias === 't') {
    const params = []
    const text   = buildWhereWithEncryption(where, params, tableAlias, outerIsAliased)
    return text ? sqlFragment(text, params) : null
  }

  /**
   * `where: { fields: { tier: 'gold' } }` → `where: { t1: 'gold' }`.
   *
   * The tenant's own key is what crosses the wire and the slot never leaves the
   * Data boundary — a caller cannot know which pooled column their field landed
   * in, and should not have to.
   *
   * Nested under the blob column rather than spelled bare, because a bare
   * `{ tier: … }` cannot be told from a real column of that name: the
   * declarations are DATA, so a tenant could declare `name` tomorrow and shadow
   * or be shadowed by a column, silently, depending on which won. Under the
   * column there is no collision to resolve.
   *
   * A key that is not declared is REFUSED by name rather than dropped.
   * Dropping widens the result set in silence, which is the failure this whole
   * feature exists to prevent — the request succeeds, the count looks
   * plausible, and the answer is about more rows than were asked for. A
   * declared key that holds no slot is SCANNED instead (`FJS-D922`):
   * `json_extract` over the blob, ANDed in as a `$raw`, slower and never wrong.
   */
  function rewriteExtensibleWhere(where, tenantOf, scopeOf, tableAlias = null) {
    if (!where || typeof where !== 'object') return where
    if (Array.isArray(where)) return where.map(w => rewriteExtensibleWhere(w, tenantOf, scopeOf, tableAlias))

    const out     = {}
    const scanned = []
    for (const [key, val] of Object.entries(where)) {
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        out[key] = rewriteExtensibleWhere(val, tenantOf, scopeOf, tableAlias)
        continue
      }
      // Only the blob, and only when handed an object of keys. An operator
      // object (`{ equals: … }`) is the column being compared whole, which is
      // what a Json column has always meant and still does.
      if (key !== _extensible.column || !val || typeof val !== 'object' || Array.isArray(val)
          || Object.keys(val).some(k => JSON_WHOLE_OPS.has(k))) {
        out[key] = val
        continue
      }

      const declared = _extDeclarations(tenantOf?.(), scopeOf?.())
      const byKey    = new Map(declared.map(d => [d.key, d]))
      for (const [k, v] of Object.entries(val)) {
        const d = byKey.get(k)
        if (!d) throw new ValidationError([{ path: [_extensible.column, k], message:
          `'${k}' is not a field this ${modelName} declares` +
          (declared.length ? `. Declared: ${declared.map(x => x.key).join(', ')}` : ' — nothing is declared yet') }])
        if (d.slot) { out[d.slot] = v; continue }
        scanned.push([k, v])
      }
    }
    if (!scanned.length) return out

    // `$raw` is a single slot, so a caller using it needs the scan conjoined.
    const params = []
    const blob   = `${tableAlias ? `${tableAlias}.` : ''}${quoteIdent(col(_extensible.column))}`
    const sql    = scanned.flatMap(([k, v]) => blobKeyClauses(blob, k, v, params)).join(' AND ')
    const mine   = rawClause(sql, params)
    return out.$raw
      ? { ...out, $raw: rawClause(`(${mine.sql}) AND (${out.$raw.sql})`, [...mine.params, ...out.$raw.params]) }
      : { ...out, $raw: mine }
  }

  // An equality operand goes through the field's write transforms. A value the
  // write would have changed can never be stored, so compared raw it matched
  // nothing and said nothing: `Mixed.Case@Example.test` stored lowercased and
  // was never found by the login that typed it back (`FJS-1456`). Runs before
  // the encryption rewrite, the order a write takes. Only equality — trimming
  // a `contains` operand or upper-casing a range bound changes the question.
  function rewriteTransformedWhere(where, transformed = _transformed) {
    if (!where || typeof where !== 'object') return where
    if (Array.isArray(where)) return where.map(w => rewriteTransformedWhere(w, transformed))

    const out = {}
    for (const [key, val] of Object.entries(where)) {
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        out[key] = rewriteTransformedWhere(val, transformed)
        continue
      }
      const field = transformed.get(key)
      const one   = (v) => v === null || typeof v === 'object' ? v : transformValue(field, v)
      if (!field || val === null) out[key] = val
      else if (Array.isArray(val)) out[key] = val.map(one)
      else if (typeof val !== 'object') out[key] = one(val)
      else {
        const ops = { ...val }
        for (const op of ['equals', 'not']) if (op in ops) ops[op] = one(ops[op])
        for (const op of ['in', 'notIn']) if (Array.isArray(ops[op])) ops[op] = ops[op].map(one)
        out[key] = ops
      }
    }
    return out
  }

  function rewriteEncryptedWhere(where) {
    if (!where || typeof where !== 'object') return where
    if (Array.isArray(where)) return where.map(rewriteEncryptedWhere)

    const out = {}
    for (const [key, val] of Object.entries(where)) {
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        out[key] = rewriteEncryptedWhere(val)
        continue
      }
      const policy = fieldPolicy[key]

      // Both matchable modes take the SAME rewrite — encode the operand the way the
      // column was encoded, then compare bytes to bytes. Only the encoder differs,
      // and only equality survives either encoding. `comparisonEncoderFor` is the
      // one owner of that choice; policy.js asks it too.
      const encoder = comparisonEncoderFor(policy)
      const encode  = encoder?.encode ? (v) => encoder.encode(v, ctx.enc.key) : null

      // ── One value, every key on the ring ──────────────────────────────────
      //
      // Deterministic encoding is a function of the KEY, so an operand encoded
      // under the current key does not equal the same value stored under a
      // previous one — and a schema mid-rotation holds both. Encoding under one
      // key made every equality filter over a not-yet-rotated row answer
      // NOTHING, silently, which is the failure `previousEncryptionKeys` would
      // otherwise have created by making that state supported (`FJS-714`).
      //
      // Widened to a set rather than left to the caller: there is no request a
      // caller could make that would find the row, and no error would have been
      // raised to tell them so. With one key on the ring `encodeSet` answers one
      // element and the scalar path is kept, so the common query's SQL is
      // unchanged.
      // The set is ALWAYS widened, not only for a ring of two, and the second
      // reason is the one no test here could see: the payload is byte-identical
      // across envelope versions, so a value stored before the key id existed
      // reads `v1d.<p>` where this encodes `v2d.<kid>.<p>`. Equality compares
      // the whole string, so every deterministic and `@hashed` lookup in every
      // EXISTING database would have answered nothing, silently — and every
      // suite in this repo builds a fresh one.
      const ring      = ctx.enc.ring?.all ?? (ctx.enc.key ? [ctx.enc.key] : [])
      const multiKey  = !!encode
      const encodeSet = (v) => [...new Set(ring.flatMap(k => {
        const now = encoder.encode(v, k)
        const was = legacyForm(now)
        return was ? [now, was] : [now]
      }))]

      if (encode && val !== null && typeof val !== 'object') {
        out[key] = multiKey ? { in: encodeSet(val) } : encode(val)
      } else if (encode && Array.isArray(val)) {
        // The bare-array shorthand is `in`, so it encodes like `in`.
        out[key] = multiKey
          ? { in: val.flatMap(v => v === null ? [null] : encodeSet(v)) }
          : val.map(v => v === null ? null : encode(v))
      } else if (encode && val !== null && typeof val === 'object') {
        // An OPERATOR object. Each spelling of equality has to be encoded on its
        // own — the scalar branch above covers `{ email: x }` and nothing else, so
        // `{ in: [x] }` compared plaintext against stored bytes and answered
        // nothing, and `{ not: x }` answered EVERY row, the excluded one included,
        // because plaintext never equals ciphertext.
        const rewritten = {}
        for (const [op, operand] of Object.entries(val)) {
          const enc = (v) => v === null ? null : encode(v)
          const many = (v) => v === null ? [null] : encodeSet(v)
          if (op === 'equals' || op === 'not') {
            // `equals` widens to `in` and `not` to `notIn` — the same question
            // asked of every key the ring holds.
            if (multiKey) { rewritten[op === 'equals' ? 'in' : 'notIn'] = many(operand) }
            else          { rewritten[op] = enc(operand) }
          } else if (op === 'in' || op === 'notIn') {
            rewritten[op] = Array.isArray(operand)
              ? (multiKey ? operand.flatMap(many) : operand.map(enc))
              : operand
          } else {
            // Deterministic encryption and an HMAC preserve equality and nothing
            // else — no ordering, no substrings. Refuse rather than compare
            // against the stored bytes and answer something plausible.
            throw new ValidationError([{ path: ['where', key], message:
              `'${key}' is ${encoder.label} — it can answer equality (equals, not, in, notIn) and cannot answer '${op}', ` +
              `because neither preserves ordering or substrings` }])
          }
        }
        out[key] = rewritten
      } else if (policy?.encrypted && !policy.encrypted.deterministic && val !== null) {
        // Plain @encrypted field in WHERE — stored ciphertext never equals
        // the plaintext query value, so this WHERE can never match. Return a
        // condition on the id field that can never match.
        return { __impossible: true }
      } else {
        out[key] = val
      }
    }
    return out
  }

  return { expandScopes, buildWhereWithEncryption, whereFragment, rewriteExtensibleWhere, rewriteTransformedWhere, rewriteEncryptedWhere }
}
