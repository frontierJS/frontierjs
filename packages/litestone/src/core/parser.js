// schema.lite parser — recursive descent, zero dependencies
//
// `@frontierjs/toolbelt` is the one import, and it is the substrate rather than
// a dependency: it ships pure functions and depends on nothing, which is what
// lets litestone reach it without inverting the graph (`FJS-D26`).

import { isKnownCurrency, minorUnits, isKnownUnit, unitInfo, suggestUnit, MEASURE_UNITS }
  from '@frontierjs/toolbelt/units'
import { LEVELS }                       from '@frontierjs/toolbelt/gate'
import { parseExpression, tokenize, TK, ParseError } from '@frontierjs/toolbelt/predicate'
import { expandCapabilityType } from './capabilities.js'
// One owner for the range a value round-trips through a JS number in — the
// validator's, so a refusal here and a refusal at the boundary name one number.
import { EXACT_INT_MAX, validateJsonPatch } from './validate.js'
import { compileStatic, policyExprToString } from './policy.js'
import { sealedStates, sealFaults } from './seal.js'

// What a `@values` binding may say about a value the set does not contain.
// `required` refuses it, `open` accepts it AND adds it to the set, `suggested`
// accepts it and leaves the set alone. Unstated is `required`, fail-closed —
// the other default takes typos in silence (`FJS-D120`).
const VALUE_STRENGTHS = new Set(['required', 'open', 'suggested'])

const SCALAR_TYPES = new Set([
  'String', 'Int', 'Float', 'Bytes', 'Boolean', 'DateTime', 'Json', 'File'
])

const KEYWORDS = new Set([
  'model', 'enum', 'function', 'import', 'database', 'view', 'trait', 'type', 'true', 'false'
])

// ─── Gate level names ─────────────────────────────────────────────────────────
// What `@@sync` may say about a collision, and the set stays closed: a policy
// that parses and resolves nothing reads exactly like one that works
// (`IDEAS/homestead.md` § The `@@sync` vocabulary, `FJS-D304`). Each of these
// three does something different to a HELD write — an online write is untouched
// by all of them.
//
//   server  the operation replays against whatever the row holds by then, so the
//           revision the device read is DROPPED from the held write
//   append  rows are only ever added, so only a create may be held at all; a
//           held patch or remove is refused by name
//   refuse  the held write carries the revision it was made against and the Data
//           boundary refuses it if the row moved — which is why this one needs
//           an `@version` column and is refused below without one
//   field   the same carried revision, compared per COLUMN against the base row
//           the write travelled with: two people who touched different columns
//           both win, and only a column they both moved is a conflict
//           (`FJS-D334`). Needs `@version` for the same reason `refuse` does
export const SYNC_POLICIES = new Set(['server', 'append', 'refuse', 'field'])

// The policies that name a revision, and so cannot work without a column
// holding one. Kept as a set rather than two comparisons because the next value
// added is likelier to be a third member than a fourth policy.
export const SYNC_NEEDS_VERSION = new Set(['refuse', 'field'])

// The 0–9 scale, by name — `@@gate`'s named form and `@@transitions`' per-move
// `@gate()` both read it, so a level can never mean two things. It used to be a
// copy of the runtime's, described here as mirroring it; the mirror is what
// went wrong one file over (`FJS-D197`), so both come off the kit now and the
// parse and the enforcement cannot disagree about what a name is worth.
// (imported at the top of this file, beside the other toolbelt kit)

// ─── @generated template compiler ─────────────────────────────────────────────
//
// `"{firstName} {lastName}"` → SQL producing that string from this row.
// `{name}` is a column, everything else is literal text, and a NULL column
// takes the separator beside it rather than leaving a hole.
//
// Two shapes come out, because SQLite has an exact answer for the common one.
// Where every gap between fields is the SAME text and nothing sits outside the
// fields, that is `concat_ws(sep, …)`: it drops a NULL argument and the
// separator that would have followed it, which is precisely what the template
// means, and it is one function call rather than a chain.
//
// A template with mixed or outer literals has no single separator, so each
// field is paired with the text preceding it and the pair vanishes together —
// `coalesce('-' || "year", '')` is empty when `year` is NULL, taking the dash
// with it. The chain is wrapped in `trim()` because the leading literal has no
// field to disappear with.

function sqlText(s) { return `'${s.replace(/'/g, "''")}'` }

export function compileFormat(tpl) {
  // Segments: literal text and {field} references, in order.
  const segs = []
  const re   = /\{([^}]*)\}/g
  let last = 0, m
  while ((m = re.exec(tpl)) !== null) {
    if (m.index > last) segs.push({ lit: tpl.slice(last, m.index) })
    const name = m[1]
    if (!/^\w+$/.test(name))
      throw new Error(`'{${name}}' is not a field name — a template reference is {fieldName}, and everything outside the braces is literal text`)
    segs.push({ field: name })
    last = re.lastIndex
  }
  if (last < tpl.length) segs.push({ lit: tpl.slice(last) })

  const fields = segs.filter(s => s.field)
  if (!fields.length)
    throw new Error(`the template \`${tpl}\` names no field, so it is a constant — a column that is the same for every row belongs in @default`)

  // The exact shape: fields separated by one repeated literal, nothing outside.
  const inner = segs.slice(
    segs[0].field ? 0 : 1,
    segs[segs.length - 1].field ? segs.length : segs.length - 1,
  )
  const outerLit = !segs[0].field || !segs[segs.length - 1].field
  const gaps     = inner.filter(s => s.lit).map(s => s.lit)
  const uniform  = gaps.length === fields.length - 1 && new Set(gaps).size <= 1
  if (!outerLit && uniform)
    return `concat_ws(${sqlText(gaps[0] ?? ' ')}, ${fields.map(f => `"${f.field}"`).join(', ')})`

  // The general shape: every field carries the literal in front of it.
  const parts = []
  let pending = ''
  for (const seg of segs) {
    if (seg.lit) { pending += seg.lit; continue }
    parts.push(pending
      ? `coalesce(${sqlText(pending)} || "${seg.field}", '')`
      : `coalesce("${seg.field}", '')`)
    pending = ''
  }
  if (pending) parts.push(sqlText(pending))
  return `trim(${parts.join(' || ')})`
}

// ─── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  constructor(tokens) {
    this.tokens = tokens
    this.pos    = 0
  }

  // ── Primitives ──────────────────────────────────────────────────────────────

  peek(n = 0) { return this.tokens[this.pos + n] }
  advance()   { return this.tokens[this.pos++] }
  isEOF()     { return this.peek().type === TK.EOF }

  check(type, value) {
    const t = this.peek()
    return t.type === type && (value === undefined || t.value === value)
  }

  eat(type, value) {
    const t = this.peek()
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      const expected = value !== undefined ? `'${value}'` : type
      throw new ParseError(`Expected ${expected}, got '${t.value}'`, { line: t.line, col: t.col })
    }
    return this.advance()
  }

  eatIdent(value) { return this.eat(TK.IDENT, value) }
  maybeEat(type, value) { if (this.check(type, value)) return this.advance() }
  // The grammar in toolbelt throws what this returns, so its messages carry a position here.
  fail(msg, pos) { return new ParseError(msg, pos) }

  // Collect leading /// doc comments
  docComments() {
    const comments = []
    while (this.check(TK.COMMENT)) comments.push(this.advance().value)
    return comments
  }

  // ── Top level ───────────────────────────────────────────────────────────────

  parseSchema() {
    const schema = { imports: [], databases: [], models: [], views: [], enums: [], functions: [], traits: [], types: [], valuesets: [], extends: [], claims: [], claimSources: {}, tenancy: null }

    while (!this.isEOF()) {
      const comments = this.docComments()
      const t = this.peek()

      if (t.type === TK.IDENT && t.value === 'import') {
        schema.imports.push(this.parseImport())
      } else if (t.type === TK.IDENT && t.value === 'database') {
        schema.databases.push(this.parseDatabase())
      } else if (t.type === TK.IDENT && t.value === 'tenancy') {
        // One block per schema. A second is refused here rather than merged:
        // two answers to "what is a tenant" is the shape the block exists to
        // remove.
        if (schema.tenancy)
          throw new ParseError(`tenancy is declared twice — a schema has one tenancy block`, t)
        schema.tenancy = this.parseTenancy()
      } else if (t.type === TK.IDENT && t.value === 'claim') {
        // A claim that is not a column of the @@auth model. `@@auth User` names
        // every claim that IS one; this names the rest, so a tool holding only
        // the schema can grade `auth().x` the same way the app does. Bare, the
        // app supplies the VALUE per request. With `from`, the value is read off
        // a row that points at the caller — `claim employeeId from
        // Employee(userId)` — and the app supplies nothing.
        const c = this.parseClaim()
        if (schema.claims.includes(c.name))
          throw new ParseError(`claim '${c.name}' is declared twice`, t)
        schema.claims.push(c.name)
        if (c.source) schema.claimSources[c.name] = c.source
      } else if (t.type === TK.IDENT && t.value === 'extend') {
        schema.extends.push(this.parseExtend(comments))
      } else if (t.type === TK.IDENT && t.value === 'model') {
        schema.models.push(this.parseModel(comments))
      } else if (t.type === TK.IDENT && t.value === 'view') {
        schema.views.push(this.parseView(comments))
      } else if (t.type === TK.IDENT && t.value === 'enum') {
        schema.enums.push(this.parseEnum(comments))
      } else if (t.type === TK.IDENT && t.value === 'function') {
        schema.functions.push(this.parseFunction(comments))
      } else if (t.type === TK.IDENT && t.value === 'trait') {
        schema.traits.push(this.parseTrait(comments))
      } else if (t.type === TK.IDENT && t.value === 'type') {
        schema.types.push(this.parseType(comments))
      } else if (t.type === TK.IDENT && t.value === 'valueset') {
        schema.valuesets.push(this.parseValueSet(comments))
      } else {
        throw new ParseError(`Unexpected token '${t.value}' — expected database, tenancy, claim, model, extend, view, enum, function, trait, type, valueset, or import`, t)
      }
    }

    return schema
  }

  // ── Database block ───────────────────────────────────────────────────────────
  //
  // database logs {
  //   path        env("LOGS_PATH", "./logs.db")
  //   driver      jsonl
  //   replication true
  //   retention   30d
  //   maxSize     500mb
  // }
  //
  // 'path' accepts:  env("VAR", "./default")  or  "./literal/path"
  // 'driver':        sqlite (default) | jsonl
  // 'replication':   true | false (default false)
  // 'retention':     duration string e.g. 30d, 90d, 1y  (optional)
  // 'maxSize':       size string e.g. 500mb, 1gb         (optional, jsonl only)

  parseDatabase() {
    this.eatIdent('database')
    const name = this.eat(TK.IDENT).value
    this.eat(TK.LBRACE)

    let path        = null
    let driver      = 'sqlite'
    let replication = false
    let retention   = null
    let maxSize     = null
    let logModel    = null   // 'auto' (implicit) or a model name (user-defined)
    let announce    = 'inProcess'

    while (!this.check(TK.RBRACE)) {
      const key = this.eat(TK.IDENT).value
      switch (key) {
        case 'path':
          path = this.parseEnvOrString()
          break
        case 'driver': {
          const val = this.eat(TK.IDENT).value
          if (!DATABASE_DRIVERS.has(val))
            throw new ParseError(`database '${name}': driver must be 'sqlite', 'jsonl', or 'logger', got '${val}'`, this.peek())
          driver = val
          break
        }
        case 'replication': {
          const val = this.eat(TK.BOOL).value
          replication = val === 'true' || val === true
          break
        }
        case 'retention':
          retention = this.parseDurationOrSize()
          break
        case 'maxSize':
          maxSize = this.parseDurationOrSize()
          break
        case 'model': {
          // model <name> — user-defined log model
          // Absence of this key = auto mode (Litestone generates <dbName>Logs)
          const val = this.eat(TK.IDENT).value
          logModel = val
          break
        }
        // How far a write announcement travels. `inProcess` is a callback list
        // on this client and reaches nobody else, which is right for one
        // process and silently wrong for two: a worker's writes reached a
        // serving process's subscribers never (`FJS-642`). `crossProcess`
        // records each announcement in the database so every process on this
        // MACHINE sharing the file sees it.
        //
        // The word is `announce` because that is what this package calls the
        // thing everywhere — `announceDataWrites`, `announceBulk`, the
        // announcement point. The per-call `announce` option is the other axis,
        // what SHAPE to announce; this is how far it reaches.
        case 'announce': {
          const val = this.eat(TK.IDENT).value
          if (val !== 'inProcess' && val !== 'crossProcess')
            throw new ParseError(
              `database '${name}': announce must be 'inProcess' or 'crossProcess', got '${val}'`, this.peek())
          announce = val
          break
        }
        default:
          throw new ParseError(`database '${name}': unknown property '${key}'`, this.peek())
      }
      this.maybeEat(TK.COMMA)
    }

    this.eat(TK.RBRACE)

    if (!path)
      throw new ParseError(`database '${name}' must declare a 'path'`, this.peek())

    // The mechanism is a table in this database read by another process's
    // client. A jsonl or logger database is a FILE with no reader and no
    // transaction, so the declaration could be written and would do nothing.
    if (announce === 'crossProcess' && driver !== 'sqlite')
      throw new ParseError(
        `database '${name}': announce crossProcess needs driver 'sqlite' — a '${driver}' database is a log file, ` +
        `so there is no table to record an announcement in and no transaction to record it with`, this.peek())

    return { name, path, driver, replication, retention, maxSize, logModel, announce }
  }

  // ── Tenancy block ────────────────────────────────────────────────────────────
  //
  // tenancy {
  //   strategy database
  //   dir      env("TENANT_DIR", "./tenants")
  //   registry "./tenants-registry.db"
  //   maxOpen  100
  //   key      env("TENANT_KEY")
  //   resolve  subdomain
  // }
  //
  // tenancy {
  //   strategy row
  //   column   workspaceId
  //   claim    workspaceId        // default: the column's own name
  // }
  //
  // Two strategies, one declaration. `database` is a SQLite file per tenant and
  // the registry that indexes them; `row` is one database with a tenant column
  // on the rows. Which one an app runs is a fact about the app, so it lives in
  // the seed — every reader (the registry factory, the CLI, Studio, Junction's
  // per-request resolution) asks the parse rather than being told again.
  //
  // `resolve` is the only line about the API realm: how a REQUEST names its
  // tenant. It is here because the answer has to agree with the strategy, and
  // an app that spells it twice is an app that can spell it two ways.

  parseTenancy() {
    const start = this.peek()
    this.eatIdent('tenancy')
    this.eat(TK.LBRACE)

    let strategy = null
    let dir      = null
    let registry = null
    let maxOpen  = null
    let key      = null
    let column   = null
    let claim    = null
    let resolve  = null

    while (!this.check(TK.RBRACE)) {
      const keyTok = this.eat(TK.IDENT)
      switch (keyTok.value) {
        case 'strategy': {
          const val = this.eat(TK.IDENT).value
          if (val !== 'database' && val !== 'row')
            throw new ParseError(`tenancy: strategy must be 'database' or 'row', got '${val}'`, this.peek())
          strategy = val
          break
        }
        case 'dir':      dir      = this.parseEnvOrString(); break
        case 'registry': registry = this.parseEnvOrString(); break
        case 'key':      key      = this.parseEnvOrString(); break
        case 'maxOpen': {
          const val = Number(this.eat(TK.NUMBER).value)
          if (!Number.isInteger(val) || val < 1)
            throw new ParseError(`tenancy: maxOpen must be a positive integer, got '${val}'`, this.peek())
          maxOpen = val
          break
        }
        case 'column':   column = this.eat(TK.IDENT).value; break
        case 'claim':    claim  = this.eat(TK.IDENT).value; break
        case 'resolve':  resolve = this.parseTenantResolve(); break
        default:
          throw new ParseError(
            `tenancy: unknown property '${keyTok.value}' — expected strategy, dir, registry, key, maxOpen, column, claim or resolve`,
            this.peek(),
          )
      }
      this.maybeEat(TK.COMMA)
    }

    this.eat(TK.RBRACE)

    if (!strategy)
      throw new ParseError(`tenancy must declare a 'strategy' — 'database' (a file per tenant) or 'row' (a tenant column)`, start)

    // Nothing under strategy row reads `resolve` — the tenant registry is the
    // one reader and exists only under strategy database — so a declared one
    // would be a transport rule that looks enforced and routes nothing. Where a
    // request names its tenant is the resolver's `tenantFrom`, a function.
    if (strategy === 'row' && resolve)
      throw new ParseError(
        `tenancy: 'resolve' is not a property of strategy row. Under row tenancy the tenant is a claim on the ` +
        `principal, and where a request names it is the resolver's to say — createApp({ principal: ` +
        `membershipClaim({ tenantFrom, … }) })`, start,
      )

    // Refused rather than ignored: a `column` under strategy database reads as
    // row tenancy that is quietly doing nothing, which is the failure this
    // block exists to make impossible.
    const wrong = strategy === 'database'
      ? [['column', column], ['claim', claim]]
      : [['dir', dir], ['registry', registry], ['key', key], ['maxOpen', maxOpen]]
    for (const [name, value] of wrong) {
      if (value != null)
        throw new ParseError(
          `tenancy: '${name}' is not a property of strategy ${strategy}`, start,
        )
    }

    if (strategy === 'row' && !column)
      throw new ParseError(`tenancy: strategy row must declare the 'column' that holds the tenant`, start)

    return {
      strategy,
      dir, registry, key, maxOpen,
      column,
      claim: claim ?? column,
      resolve,
    }
  }

  // resolve subdomain | header("X-Tenant-Id") | claim(workspaceId)
  parseTenantResolve() {
    const t    = this.eat(TK.IDENT)
    const kind = t.value
    if (kind === 'subdomain') return { kind, name: null }
    if (kind === 'header' || kind === 'claim') {
      this.eat(TK.LPAREN)
      const name = this.check(TK.STRING) ? this.eat(TK.STRING).value : this.eat(TK.IDENT).value
      this.eat(TK.RPAREN)
      return { kind, name }
    }
    throw new ParseError(
      `tenancy: resolve must be subdomain, header("X-Name") or claim(fieldName), got '${kind}'`, t,
    )
  }

  // Parse env("VAR", "./default") or a plain string literal.
  // Returns: { kind: 'env', var: string, default: string }
  //       or { kind: 'literal', value: string }
  parseEnvOrString() {
    if (this.check(TK.IDENT, 'env')) {
      this.eat(TK.IDENT)   // consume 'env'
      this.eat(TK.LPAREN)
      const varName     = this.eat(TK.STRING).value
      this.maybeEat(TK.COMMA)
      const defaultVal  = this.check(TK.STRING) ? this.eat(TK.STRING).value : null
      this.eat(TK.RPAREN)
      return { kind: 'env', var: varName, default: defaultVal }
    }
    const value = this.eat(TK.STRING).value
    return { kind: 'literal', value }
  }

  // Parse a bare duration/size token like 30d, 90d, 1y, 500mb.
  // These come through as NUMBER followed by an IDENT unit, or as a single IDENT.
  parseDurationOrSize() {
    if (this.check(TK.NUMBER)) {
      const num  = this.eat(TK.NUMBER).value
      const unit = this.eat(TK.IDENT).value
      return `${num}${unit}`
    }
    return this.eat(TK.IDENT).value
  }

  // ── View block ───────────────────────────────────────────────────────────────
  //
  // view userSummary {
  //   id          Int
  //   name        String
  //   accountName String
  //
  //   @@sql("SELECT u.id, u.name, a.name AS accountName FROM users u ...")
  //   @@db(logs)
  // }
  //
  // view accountStats {
  //   accountId Int
  //   total     Int
  //
  //   @@materialized
  //   @@sql("SELECT accountId, COUNT(*) AS total FROM events GROUP BY accountId")
  //   @@refreshOn([events])
  //   @@db(analytics)
  // }

  parseView(comments = []) {
    this.eatIdent('view')
    const name = this.eat(TK.IDENT).value
    this.eat(TK.LBRACE)

    const fields      = []
    const attributes  = []
    let   sql         = null
    let   materialized = false
    let   refreshOn   = []
    let   db          = null

    // A view is a read path onto rows that models guard, so it carries the same
    // access attributes they do, compiled against the columns IT declares —
    // never inferred from `@@sql`, which would mean parsing SQL to find out who
    // is allowed to read it.
    const ACCESS_ATTRS = new Set(['gate', 'allow', 'deny', 'tenant', 'export'])

    while (!this.check(TK.RBRACE)) {
      // A doc comment may precede either an attribute or a field, exactly as it
      // may in a model. Read it here so the attribute branch below is reachable
      // when one does — otherwise a commented `@@export` falls into the field
      // branch and fails on the `@@`.
      const pending = this.docComments()

      if (this.check(TK.ATAT)) {
        // Model-level attribute
        this.eat(TK.ATAT)
        const attr = this.eat(TK.IDENT).value
        if (ACCESS_ATTRS.has(attr)) {
          attributes.push(this.parseModelAttributeBody(attr))
          continue
        }
        switch (attr) {
          case 'sql':
            sql = this.parseParenString()
            break
          case 'materialized':
            materialized = true
            break
          case 'refreshOn':
            refreshOn = this.parseFieldListParen()
            break
          case 'db': {
            this.eat(TK.LPAREN)
            db = this.eat(TK.IDENT).value
            this.eat(TK.RPAREN)
            break
          }
          default:
            throw new ParseError(
              `Unknown view attribute '@@${attr}' — a view takes @@sql, @@materialized, ` +
              `@@refreshOn, @@db, @@export, and the access attributes @@gate, @@allow, @@deny and @@tenant`,
              this.peek())
        }
      } else {
        // Field declaration: name Type[?]
        const fieldComments = pending.length ? pending : this.docComments()
        const fieldName = this.eat(TK.IDENT).value
        const type      = this.parseFieldType()
        fields.push({ name: fieldName, type, comments: fieldComments })
        this.maybeEat(TK.COMMA)
      }
    }

    this.eat(TK.RBRACE)

    return { name, fields, attributes, sql, materialized, refreshOn, db, comments }
  }


  // ── Function ─────────────────────────────────────────────────────────────────
  // Defines a named SQL expression usable as a @generated field shorthand.
  //
  // function discount(price: Int, pct: Float): Int {
  //   @@expr("CAST({price} * (1.0 - {pct}) AS INTEGER)")
  // }

  parseFunction(comments = []) {
    this.eatIdent('function')
    const name = this.eat(TK.IDENT).value

    // Parameter list: (param: Type, ...)
    this.eat(TK.LPAREN)
    const params = []
    while (!this.check(TK.RPAREN)) {
      const pName = this.eat(TK.IDENT).value
      this.eat(TK.COLON)
      const pType = this.eat(TK.IDENT).value
      params.push({ name: pName, type: pType })
      this.maybeEat(TK.COMMA)
    }
    this.eat(TK.RPAREN)

    // Return type: : Type
    this.eat(TK.COLON)
    const returnType = this.eat(TK.IDENT).value

    // Body: { @@expr("...") }
    this.eat(TK.LBRACE)
    let expr = null
    while (!this.check(TK.RBRACE)) {
      this.eat(TK.ATAT)
      const attr = this.eat(TK.IDENT).value
      if (attr === 'expr') {
        expr = this.parseParenString()
      } else {
        throw new ParseError(`Unknown function attribute '@@${attr}'. Expected @@expr(...)`, this.peek())
      }
    }
    this.eat(TK.RBRACE)

    if (!expr) throw new ParseError(`Function '${name}' must have @@expr(...)`, this.peek())

    return { name, params, returnType, expr, comments }
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  // `import "./auth.lite"` or `import "@frontierjs/auth/schema.lite" into auth`.
  //
  // `into` names the database everything that import brings in lands in, and it
  // BEATS a `@@db` written in the imported file — a package shipping a fragment
  // has to spell some database, and only the importing app knows what its own
  // are called. See parseFile for how it composes with a nested import.
  // claim <name>
  // claim <name> from <Model>(<subject>)            — the row's primary key
  // claim <name> from <Model>(<subject>).<column>   — another column of it
  parseClaim() {
    this.eatIdent('claim')
    const name = this.eat(TK.IDENT).value
    if (!this.check(TK.IDENT, 'from')) return { name, source: null }
    this.advance()
    const model = this.eat(TK.IDENT).value
    this.eat(TK.LPAREN)
    const subject = this.eat(TK.IDENT).value
    this.eat(TK.RPAREN)
    let column = null
    if (this.check(TK.DOT)) { this.advance(); column = this.eat(TK.IDENT).value }
    return { name, source: { model, subject, column } }
  }

  parseImport() {
    this.eatIdent('import')
    const path = this.eat(TK.STRING).value
    const into = this.check(TK.IDENT, 'into')
      ? (this.advance(), this.eat(TK.IDENT).value)
      : null
    this.maybeEat(TK.IDENT, ';')
    return { path, into }
  }

  // ── Model ───────────────────────────────────────────────────────────────────

  parseModel(comments = []) {
    this.eatIdent('model')
    const name = this.eat(TK.IDENT).value
    this.eat(TK.LBRACE)

    const fields     = []
    const attributes = []

    while (!this.check(TK.RBRACE)) {
      const fieldComments = this.docComments()

      if (this.check(TK.ATAT)) {
        attributes.push(this.parseModelAttribute())
      } else if (this.check(TK.IDENT)) {
        fields.push(this.parseField(fieldComments))
      } else {
        const t = this.peek()
        throw new ParseError(`Unexpected token '${t.value}' inside model '${name}'`, t)
      }
    }

    this.eat(TK.RBRACE)
    return { name, comments, fields, attributes }
  }

  // ── Extend ──────────────────────────────────────────────────────────────────
  //
  // `extend model Credential { ... }` — what an app has to say about a model it
  // did not write.
  //
  // The case is a package that ships `.lite` (`@frontierjs/auth`, junction's
  // outbox). The package owns the columns; the APP owns where those rows sit in
  // its own schema — the relation back to its User, whether they are audited,
  // and, under row tenancy, that they span tenants. None of that can go in the
  // shipped file, because a package cannot know it.
  //
  // Without this the only way to say it was to paste the models in and edit
  // them, which is what basecamp did for four models. A copy stops being the
  // package's the first time either side moves and nothing fails: the copy had
  // `@guarded` where the package says `@secret`, so basecamp stored every
  // OAuth token in plain text, and its own 137 tests were green throughout.
  //
  // The opposite direction of `@@trait`, and both exist: a trait is opted INTO
  // by the model, which requires the model's author to have known about it.
  parseExtend(comments = []) {
    this.eatIdent('extend')
    this.eatIdent('model')
    const name = this.eat(TK.IDENT).value
    this.eat(TK.LBRACE)

    const fields     = []
    const attributes = []

    while (!this.check(TK.RBRACE)) {
      const fieldComments = this.docComments()

      if (this.check(TK.ATAT)) {
        attributes.push(this.parseModelAttribute())
      } else if (this.check(TK.IDENT)) {
        fields.push(this.parseField(fieldComments))
      } else {
        const t = this.peek()
        throw new ParseError(`Unexpected token '${t.value}' inside extend model '${name}'`, t)
      }
    }

    this.eat(TK.RBRACE)
    return { name, comments, fields, attributes }
  }

  // ── Trait ───────────────────────────────────────────────────────────────────
  //
  // A trait is a reusable model fragment — fields and model-level attributes
  // that get spliced into a model via @@trait(T). Traits are erased at parse
  // time; nothing in the rest of the codebase needs to know they existed.
  //
  // What's allowed in a trait is validated at splice time, not declaration
  // time, so a trait with relations is fine to declare even if a future use
  // wouldn't make sense.
  //
  // Forbidden in trait declarations: @id, @@id, @@map, @@db, @@fts.
  // Validated at splice time: collisions, cycle detection.
  parseTrait(comments = []) {
    this.eatIdent('trait')
    const name = this.eat(TK.IDENT).value
    this.eat(TK.LBRACE)

    const fields     = []
    const attributes = []

    while (!this.check(TK.RBRACE)) {
      const fieldComments = this.docComments()

      if (this.check(TK.ATAT)) {
        attributes.push(this.parseModelAttribute())
      } else if (this.check(TK.IDENT)) {
        fields.push(this.parseField(fieldComments))
      } else {
        const t = this.peek()
        throw new ParseError(`Unexpected token '${t.value}' inside trait '${name}'`, t)
      }
    }

    this.eat(TK.RBRACE)
    return { name, comments, fields, attributes }
  }

  // ── Type ────────────────────────────────────────────────────────────────────
  //
  // type Address {
  //   street     String
  //   city       String
  //   state      String?
  //   postalCode String
  //   country    String @default("US")
  // }
  //
  // A type declares the shape of a JSON value. Used as `Json @type(Address)`
  // on a field, the type's structure is validated on write.
  //
  // Types can contain: scalar fields, optional fields, array fields, enum
  // fields, validators (@email, @regex, @length, @gte, ...), transforms
  // (@trim, @lower, @upper), other types via Json @type(Other) (recursive).
  //
  // Types CANNOT contain: relations, model-level attributes, primary keys,
  // unique constraints, encryption, guarded fields, file/blob fields, most
  // defaults. Validation happens at parse time after all types are known.
  parseType(comments = []) {
    this.eatIdent('type')
    const name = this.eat(TK.IDENT).value
    this.eat(TK.LBRACE)

    const fields     = []
    const attributes = []

    while (!this.check(TK.RBRACE)) {
      const fieldComments = this.docComments()

      if (this.check(TK.ATAT)) {
        attributes.push(this.parseModelAttribute())
      } else if (this.check(TK.IDENT)) {
        fields.push(this.parseField(fieldComments))
      } else {
        const t = this.peek()
        throw new ParseError(`Unexpected token '${t.value}' inside type '${name}'`, t)
      }
    }

    this.eat(TK.RBRACE)
    return { name, comments, fields, attributes }
  }

  parseField(comments = []) {
    const name = this.eat(TK.IDENT).value
    const type = this.parseFieldType()
    const attributes = []

    while (this.check(TK.AT)) {
      attributes.push(this.parseFieldAttribute())
    }

    return { name, type, attributes, comments }
  }

  parseFieldType() {
    const t = this.eat(TK.IDENT)
    const isScalar = SCALAR_TYPES.has(t.value)
    const array    = !!this.maybeEat(TK.LBRACKET) && !!this.eat(TK.RBRACKET)
    const optional = !!this.maybeEat(TK.QUESTION)

    // Unknown non-scalar, non-array: only allowed if it's an enum or relation reference
    // (validated in second pass once all models/enums are known)
    return { kind: isScalar ? 'scalar' : 'enum', name: t.value, array, optional }
  }

  // Lazy enum check — will be validated in a second pass once all enums are known
  isEnumRef(_name) { return true }

  // ── Field attributes ────────────────────────────────────────────────────────

  parseFieldAttribute() {
    this.eat(TK.AT)
    const name = this.eat(TK.IDENT).value

    switch (name) {
      case 'id':       return { kind: 'id' }
      // `@unique` takes no argument but one: `global`, which says the value is
      // unique across the whole installation and not per tenant. It exists so
      // the tenancy warning below can be answered rather than lived with — a
      // token or a public subdomain is legitimately global, and a permanent
      // warning on a correct schema is what teaches people to stop reading
      // them. Silent outside `tenancy { strategy row }`, where it is simply
      // what every unique already is.
      case 'unique':   return { kind: 'unique', global: this.maybeEatGlobalArg() }
      case 'map':      return { kind: 'map',       name: this.parseParenString() }
      case 'default':  return { kind: 'default',   value: this.parseDefault() }
      case 'relation': return { kind: 'relation',  ...this.parseRelation() }
      case 'generated':return { kind: 'generated', ...this.parseGenerated() }
      case 'from': return { kind: 'from', ...this.parseFrom() }
      case 'edge':   return { kind: 'edge',   ...this.parseEdge() }
      case 'scoped': return { kind: 'scoped', ...this.parseScoped() }

      case 'computed':   return { kind: 'computed' }
      // @values(TaskTag)             — required, the default
      // @values(TaskTag, open)       — a value outside the set is accepted AND joins it
      // @values(LeadSource, suggested) — accepted, the set is offered and not enforced
      //
      // Beside @relation rather than instead of it: storage (a foreign key with
      // referential integrity) and resolution (where the offered values come
      // from, and what is legal) are two facts about one column.
      // @values(State, dependsOn: countryId) — the list is that country's states
      //
      // The dependency is a JOIN and it goes on the BINDING, for the reason the
      // strength does: a set is reusable and a controlling column is
      // model-local (`FJS-D122`). Which column of the SOURCE matches is derived
      // from the relation path and never written here — `on <column>` is the
      // escape for a source that reaches the same model twice.
      case 'values': {
        this.eat(TK.LPAREN)
        const set = this.eat(TK.IDENT).value
        let strength = null
        let dependsOn = null, dependsOnSource = null
        while (this.maybeEat(TK.COMMA)) {
          const tok  = this.peek()
          const word = this.eat(TK.IDENT).value
          // A named argument, told from the positional strength by the colon.
          if (this.maybeEat(TK.COLON)) {
            if (word !== 'dependsOn') throw new ParseError(
              `@values(${set}, ${word}: …): unknown argument. The only named one is 'dependsOn', ` +
              `which takes the column on THIS model whose value narrows the list.`, tok)
            if (dependsOn) throw new ParseError(`@values(${set}): 'dependsOn' is declared twice`, tok)
            dependsOn = this.eat(TK.IDENT).value
            // `dependsOn: countryId on regionCountryId` — the source side, for
            // the case the relation walk cannot decide.
            if (this.check(TK.IDENT) && this.peek().value === 'on') {
              this.advance()
              dependsOnSource = this.eat(TK.IDENT).value
            }
            continue
          }
          if (strength) throw new ParseError(`@values(${set}): a strength is declared twice`, tok)
          if (!VALUE_STRENGTHS.has(word)) throw new ParseError(
            `@values(${set}, ${word}): unknown strength. One of ${[...VALUE_STRENGTHS].join(', ')}. ` +
            `Unstated is 'required'.`, tok)
          strength = word
        }
        this.eat(TK.RPAREN)
        return { kind: 'values', set, strength: strength ?? 'required', dependsOn, dependsOnSource }
      }

      // @transient → a field the caller WRITES that is never stored.
      //
      // The mirror of @computed, which is a field the caller READS that is
      // never stored. Both are values with no column; they differ in which
      // direction the value travels:
      //
      //              column   caller writes   caller reads
      //   @computed   no       no              yes
      //   @transient  no       yes             no
      //   @system     yes      no              yes
      //   @guarded    yes      no              no
      //
      // For a payload key that is about a write rather than part of one — a
      // plaintext credential on its way into an @encrypted row somewhere else,
      // a confirmation token, a "notify the owner" flag. Junction validates it
      // like any other field and then lifts it off the payload onto
      // ctx.transients, so nothing below the API boundary ever sees it; a value
      // that reaches this client anyway is refused by name rather than dropped.
      case 'transient': {
        if (this.check(TK.LPAREN))
          throw new ParseError('@transient takes no arguments — a field is stored or it is not', this.peek())
        return { kind: 'transient' }
      }

      // @derived(dueAt < now() && completedAt == null)
      //
      // A value computed in SQL from this row's own columns, so unlike
      // @computed it can be filtered and sorted by. The body is the declarative
      // expression language, NOT a SQL string — which is what lets the schema
      // say what the field DEPENDS on rather than only what it is.
      //
      // Not @generated: that creates a real column and must stay deterministic,
      // and the whole point here is a value that changes on its own because the
      // clock moved.
      case 'derived': {
        this.eat(TK.LPAREN)
        const expr = this.parsePolicyExpr()
        this.eat(TK.RPAREN)
        return { kind: 'derived', expr }
      }
      case 'hardDelete': return { kind: 'hardDelete' }

      // On a hasMany field of a @@softDelete parent: these children stay LIVE
      // when the parent is soft-deleted. The third fate a child can have, and
      // the two that already had a spelling are cascade (@@softDelete(cascade))
      // and destruction (@hardDelete) — so *the child outlives the parent* was
      // the one shape that could only be written by leaving the warning about
      // it in place. A financial record outliving the person it belongs to is
      // that shape, and it is not rare.
      case 'keep': return { kind: 'keep' }

      // On a hasMany field of a model that declares a @seals move: these
      // children are part of the DOCUMENT, so once the parent seals they may
      // not be created, changed or removed. It goes on the LIST side because
      // sealing is the parent's event — the child has no way to know when its
      // parent's machine moved, and a marker on the child would have to name a
      // state, which is the second source of truth @seals exists to avoid.
      //
      // Explicit, never inferred: every child relation on a sealing model looks
      // sealable and they are not. `payments` on an issued invoice is exactly
      // the row that must keep arriving.
      case 'sealed': return { kind: 'sealed' }

      // ── Field visibility + access control ─────────────────────────────────
      case 'omit': {
        // @omit        → skip lists, include on findUnique
        // @omit(all)   → skip everything unless explicitly selected
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const arg = this.eat(TK.IDENT).value
          this.eat(TK.RPAREN)
          // `(lists)` is the one wrong spelling worth naming: it is what the bare
          // form already means, and a second way to write one thing is what
          // `@@strict` was deleted for (`FJS-D203`).
          if (arg === 'lists') throw new ParseError(
            `@omit(lists) is not a spelling — bare @omit already means "out of lists, present on a findUnique". ` +
            `@omit(all) is the stronger one: out of every read unless a select names the column`, this.peek())
          if (arg !== 'all') throw new ParseError(`@omit only accepts (all) as an argument, got (${arg})`, this.peek())
          return { kind: 'omit', level: 'all' }
        }
        return { kind: 'omit', level: 'lists' }
      }
      case 'guarded': {
        // @guarded → absent unless system context, in both directions.
        //
        // It took an argument for a while and the argument did nothing: `(all)`
        // and the bare form compiled to two branches with one body, and the
        // write half never read the level at all (`FJS-D205`, `FJS-827`). What
        // `(select)` was reaching for — a caller unlocking the column by naming
        // it — is what `@omit(all)` means, and a lock a caller picks by asking
        // more specifically is not a lock.
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const arg = this.eat(TK.IDENT).value
          this.eat(TK.RPAREN)
          throw new ParseError(
            `@guarded takes no argument, got (${arg}). It is a system-context lock on read and write, ` +
            `and (all) was its only accepted spelling — drop it. For a column a caller may read by naming ` +
            `it in a select, the word is @omit(all)`, this.peek())
        }
        return { kind: 'guarded' }
      }
      case 'system': {
        // @system → anyone may READ it, only the system may write it.
        //
        // The orthogonal sibling of @guarded, which locks both directions:
        //
        //             read          write
        //   @guarded   system only   system only
        //   @system    anyone        system only
        //
        // For a column an application fills and a person must not — a tracking
        // code a courier job books, an API key's hint, a workspace stamped from
        // a header. Nothing in the schema could say that before, so every form
        // generator offered a text box whose value a worker would overwrite.
        if (this.check(TK.LPAREN))
          throw new ParseError('@system takes no arguments — it is a lock, not a level', this.peek())
        return { kind: 'system' }
      }

      // @immutable → written once, at create, and never again by anybody.
      //
      // What a DOCUMENT is (`FJS-D162`): an invoice's number, the instant it
      // was issued and the total it was issued for are a statement about a
      // moment, and a correction is a credit note rather than an edit.
      //
      // It refuses the KEY rather than comparing the value, which is what makes
      // it cheap and is also the only thing it could do — nothing in this
      // language can see the stored row beside the incoming one. An update
      // payload naming the column is refused whether or not the value differs;
      // *I sent the same number back* is not a defense a rule this shape can
      // hear, and a form that round-trips a frozen column is a form that would
      // have overwritten it the day somebody changed the box.
      //
      // It is the CONSTRAINT tier: asSystem() does not drop it, where the gate,
      // the row policies and @guarded all fall away there. A renewal job and a
      // payment settler both run as system, so a rule they may drop is a rule
      // absent from every caller that actually writes an invoice.
      case 'immutable': {
        if (this.check(TK.LPAREN))
          throw new ParseError(
            '@immutable takes no arguments — a column is written once or it is not. ' +
            'For a row that freezes when it reaches a state, freeze the columns and let ' +
            '@@transitions own the state column.', this.peek())
        return { kind: 'immutable' }
      }
      case 'capability': {
        // @capability — writing THIS column is its own capability.
        //
        // Opt-in per column and never derived wholesale: every writable column
        // on basecamp is 461 of them, which is not a list anybody picks from
        // (`FJS-D147`). The model's own @@capabilities switch has to be on for
        // this to mean anything — validate() says so.
        if (this.check(TK.LPAREN))
          throw new ParseError(
            '@capability takes no arguments — it says this column\'s write is its own ' +
            'capability, and which callers hold it is a Role row rather than a schema fact',
            this.peek())
        return { kind: 'capability' }
      }
      case 'encrypted': {
        // @encrypted                       → AES-256-GCM under a random IV. Implies
        //                                    @guarded. Not filterable.
        // @encrypted(deterministic: true)  → AES-256-GCM under an IV derived from the
        //                                    plaintext. Same value encrypts the same
        //                                    way, so equality filters work — and it is
        //                                    still ciphertext, so it reads back.
        //
        // `searchable: true` was the old spelling and it did something else entirely:
        // it stored an HMAC and no ciphertext, destroying the plaintext on write. It is
        // refused by name rather than translated, because the two candidate meanings —
        // "I can look this up AND read it" and "I can only ever match it" — are the
        // whole decision, and guessing either one silently is how the value was lost.
        let deterministic = false
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const key = this.eat(TK.IDENT).value
          this.eat(TK.COLON)
          const val = this.eat(TK.BOOL).value
          this.eat(TK.RPAREN)
          if (key === 'searchable')
            throw new ParseError(
              `@encrypted(searchable: true) no longer exists — it stored a one-way HMAC and destroyed the plaintext. ` +
              `Use @encrypted(deterministic: true) for a value you need to look up AND read back, ` +
              `or @hashed for one you only ever need to match. Existing v1s. columns cannot be recovered by either.`,
              this.peek())
          if (key !== 'deterministic')
            throw new ParseError(`@encrypted only accepts (deterministic: true/false), got (${key})`, this.peek())
          deterministic = val === true || val === 'true'
        }
        return { kind: 'encrypted', deterministic }
      }

      // ── @hashed — one-way, matchable, never readable ────────────────────────
      // HMAC-SHA256, no ciphertext, no key that recovers it. Equality filters work;
      // a read strips it, and asking for it by name throws. Not an option on
      // @encrypted, because an option inherits the parent's promise and the parent
      // promises the value comes back.
      case 'hashed': return { kind: 'hashed' }

      case 'check':    return { kind: 'check',     ...this.parseCheckArgs() }

      // ── @secret — composite encrypted+guarded+logged field ─────────────────
      // @secret                        — rotatable (default)
      // @secret(rotate: false)         — excluded from $rotateKey, and therefore
      //                                  UNREADABLE after one: the key swap is global,
      //                                  so a column rotation skips is not left on the
      //                                  old key, it is lost. $rotateKey refuses while
      //                                  one exists unless it is orphaned by name.
      // @secret(deterministic: true)   — the same value stores the same bytes, so
      //                                  the secret can be looked up by equality
      //                                  and still rotated. An API key is both.
      //
      // Expands at parse time (expandSecretAttributes) to:
      //   @encrypted @guarded @log(<first logger db>)   (log only if logger db declared)
      // The { kind: 'secret', rotate } attr is kept for key rotation tracking.
      case 'secret': {
        let rotate        = true
        let deterministic = false
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          while (!this.check(TK.RPAREN)) {
            const key = this.eat(TK.IDENT).value
            this.eat(TK.COLON)
            const val  = this.eat(TK.BOOL).value
            const bool = val === true || val === 'true'
            if      (key === 'rotate')        rotate = bool
            else if (key === 'deterministic') deterministic = bool
            else throw new ParseError(`@secret only accepts (rotate: true/false) and (deterministic: true/false), got (${key})`, this.peek())
            this.maybeEat(TK.COMMA)
          }
          this.eat(TK.RPAREN)
        }
        return { kind: 'secret', rotate, deterministic }
      }

      // ── Field-level access policy ─────────────────────────────────────────
      // @allow('read',  expr)  — field stripped from results if condition false
      // @allow('write', expr)  — field silently dropped from write data if condition false
      // @allow('all',   expr)  — both read + write
      // Multiple @allow on same field/op → OR semantics (any passing = allowed)
      // asSystem() bypasses all field @allow checks
      case 'allow': {
        this.eat(TK.LPAREN)
        const opStr = this.eat(TK.STRING).value
        if (opStr !== 'read' && opStr !== 'write' && opStr !== 'all')
          throw new ParseError(`@allow on a field only accepts 'read', 'write', or 'all', got '${opStr}'`, this.peek())
        const operations = opStr === 'all' ? ['read', 'write'] : [opStr]
        this.eat(TK.COMMA)
        const expr = this.parsePolicyExpr()
        this.eat(TK.RPAREN)
        return { kind: 'fieldAllow', operations, expr }
      }

      // ── File storage ───────────────────────────────────────────────────────
      // File is a first-class type — @keepVersions is an optional modifier.
      // @keepVersions  — skip old object cleanup on update (keep all versions)
      case 'keepVersions': return { kind: 'keepVersions' }

      // ── Field-level logging ────────────────────────────────────────────────
      // @log(audit)                   — log reads + writes (default)
      // @log(audit, reads: false)     — writes only
      // @log(audit, writes: false)    — reads only
      case 'log': {
        const args = this.parseLogArgs()
        delete args.readsExplicit
        return { kind: 'log', ...args }
      }

      // ── Transforms (applied before validation + write) ─────────────────────
      case 'trim':      return { kind: 'trim' }
      case 'lower':     return { kind: 'lower' }
      case 'upper':     return { kind: 'upper' }
      case 'slug': {
        // @slug (no args) — transformer
        // @slug(field) — funcCall (function defined in schema)
        if (!this.check(TK.LPAREN)) return { kind: 'slug' }
        this.eat(TK.LPAREN)
        const slugArgs = []
        while (!this.check(TK.RPAREN)) {
          slugArgs.push(this.eat(TK.IDENT).value)
          this.maybeEat(TK.COMMA)
        }
        this.eat(TK.RPAREN)
        return { kind: 'funcCall', fn: 'slug', args: slugArgs }
      }
      case 'updatedAt': return { kind: 'updatedAt' }   // auto-set on every update
      case 'version':   return { kind: 'version' }     // optimistic concurrency — see client.js

      // ── Exact numbers ──────────────────────────────────────────────────────
      // `@scale(n)` — the column is an integer and the point sits n places in.
      // `@money(USD)` — the same thing with the scale DERIVED from the currency,
      // because scale is not a free parameter for money: JPY has none, KWD has
      // three, and an author who has to know the ISO table by heart will get it
      // wrong (`FJS-D142`).
      case 'scale':     return { kind: 'scale', places: this.parseParenNumber() }
      case 'money':     return this.parseMoney()

      // `@unit(ms)` — what the number COUNTS. Not a scale and not a currency:
      // the value stored is the value sent, exactly as `@money`'s minor units
      // are. What it buys is that the fact stops living in the identifier,
      // where nothing parses it.
      case 'unit':      return this.parseUnit()

      // `@big` — the column holds 64 bits and the VALUE is allowed to use them.
      // The storage was always 64-bit; what was not was the crossing, which goes
      // through a JS number and rounds past 2^53 in both directions (`FJS-643`).
      // So a wide column hands its value over as a decimal STRING, which is what
      // node-postgres does with int8 and what mysql2's `bigNumberStrings` is
      // for: a BigInt would be exact and `JSON.stringify` throws on one, which
      // is every response, every frame and every audit snapshot.
      case 'big':       return { kind: 'big' }
      case 'updatedBy': {
        // @updatedBy              → stamps ctx.auth.id on every update
        // @updatedBy(auth().field) → stamps ctx.auth[field] on every update
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          this.eatIdent('auth')
          this.eat(TK.LPAREN); this.eat(TK.RPAREN)
          this.eat(TK.DOT)
          const authField = this.eat(TK.IDENT).value
          this.eat(TK.RPAREN)
          return { kind: 'updatedBy', authField }
        }
        return { kind: 'updatedBy', authField: 'id' }
      }
      case 'createdBy': {
        // @createdBy               → stamps ctx.auth.id on create
        // @createdBy(auth().field) → stamps ctx.auth[field] on create
        //
        // A stamp, not a default: an authenticated caller cannot forge
        // authorship by putting the column in the payload. With no ctx.auth
        // (asSystem(), a seeder, an anonymous write) an explicit value is
        // honored — that is how backfills and imports carry authorship in.
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          this.eatIdent('auth')
          this.eat(TK.LPAREN); this.eat(TK.RPAREN)
          this.eat(TK.DOT)
          const authField = this.eat(TK.IDENT).value
          this.eat(TK.RPAREN)
          return { kind: 'createdBy', authField }
        }
        return { kind: 'createdBy', authField: 'id' }
      }

      // ── Per-scope sequence ─────────────────────────────────────────────────
      // @sequence(scope: fieldName)
      // Auto-increments a counter scoped to the value of another field.
      // Classic use case: per-tenant document numbers (invoice #0001 per account).
      // Litestone manages a _litestone_sequences table internally.
      case 'sequence': {
        this.eat(TK.LPAREN)
        const key = this.eat(TK.IDENT).value
        if (key !== 'scope')
          throw new ParseError(`@sequence only accepts (scope: fieldName), got (${key})`, this.peek())
        this.eat(TK.COLON)
        const scopeField = this.eat(TK.IDENT).value
        this.eat(TK.RPAREN)
        return { kind: 'sequence', scope: scopeField }
      }

      // ── Presentation ───────────────────────────────────────────────────────
      // @label("Customer") — what a human calls this field.
      //
      // Emitted as JSON Schema `title`, which is the standard slot for exactly
      // this, and read by every generated message so an error never says
      // `customerId` under a form label that says "customer". Doc comments
      // already become `description`; a label is the short form, not the prose.
      case 'label':      return { kind: 'label', text: this.parseParenString() }

      // @required("Please select a customer from the list")
      //
      // Carries the WORDING only — it does not make the field required. The
      // absence of `?` already did that, and this attribute on a nullable field
      // is a no-op message nothing will ever emit (validated below).
      //
      // Required-ness is the one rule with no natural home for a message: every
      // other validator is an attribute that can take one as its last argument,
      // but "required" is the absence of a `?`. ZenStack reaches for model-level
      // @@validate(expr, msg) here; this follows Remult's field-level
      // Validators.required(msg) instead, so the wording sits beside the rule
      // it belongs to like every other message in this file.
      // @required                          — wording only; the absence of `?` is the rule
      // @required("msg")                   — …with the sentence to say
      // @required(where: expr)             — required in the rows the predicate admits
      // @required(where: expr, "msg")      — …with the sentence to say
      //
      // One attribute rather than two, which is `@@unique([a], where: …)`'s
      // shape: a rule that is unconditional bare and conditional with a
      // predicate in a named argument. Splitting it would put the WORDING on
      // one attribute and the RULE on another, and `@required("msg")` on an
      // optional field is a parse error — so the pair could not even be
      // written without relaxing that, leaving two attributes carrying the
      // message for one rule.
      case 'required':   return { kind: 'required', ...this.parseRequiredArgs() }

      // ── String validators ──────────────────────────────────────────────────
      case 'email':      return { kind: 'email',      ...this.parseOptMessage() }
      case 'url':        return { kind: 'url',        ...this.parseOptMessage() }
      case 'phone':      return { kind: 'phone',      ...this.parseOptMessage() }
      case 'markdown':   return { kind: 'markdown' }   // semantic annotation — no validation
      case 'accept':     return { kind: 'accept', types: this.parseParenString() }   // e.g. @accept("image/*")
      case 'date':       return { kind: 'date',       ...this.parseOptMessage() }
      case 'datetime':   return { kind: 'datetime',   ...this.parseOptMessage() }
      case 'time': {
        // @time                       — HH:MM, 24-hour, leading zeros required
        // @time(seconds: true)        — also accepts HH:MM:SS
        // @time(message: "...")       — optional custom error message
        // @time(seconds: true, message: "...")
        let seconds = false
        let message = null
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          // Comma-separated named args. Both `seconds: <bool>` and `message: <string>`.
          // No positional form — keeps the surface tiny and unambiguous.
          while (!this.check(TK.RPAREN)) {
            const name = this.eat(TK.IDENT).value
            this.eat(TK.COLON)
            if (name === 'seconds') {
              const t = this.peek()
              if (t.type !== TK.BOOL)
                throw new ParseError(`@time(seconds: ...) expects true/false, got ${t.value}`, t)
              seconds = this.eat(TK.BOOL).value
            } else if (name === 'message') {
              if (!this.check(TK.STRING))
                throw new ParseError(`@time(message: ...) expects a string`, this.peek())
              message = this.eat(TK.STRING).value
            } else {
              throw new ParseError(`Unknown @time argument '${name}' — expected 'seconds' or 'message'`, this.peek())
            }
            if (this.check(TK.COMMA)) this.eat(TK.COMMA)
          }
          this.eat(TK.RPAREN)
        }
        return { kind: 'time', seconds, ...(message ? { message } : {}) }
      }
      case 'regex':      return { kind: 'regex',      ...this.parseRegex() }
      case 'length':     return { kind: 'length',     ...this.parseLength() }
      case 'startsWith': return { kind: 'startsWith', ...this.parseTextMessage('startsWith') }
      case 'endsWith':   return { kind: 'endsWith',   ...this.parseTextMessage('endsWith') }
      case 'contains':   return { kind: 'contains',   ...this.parseTextMessage('contains') }

      // ── Number validators ──────────────────────────────────────────────────
      case 'lt':   return { kind: 'lt',  ...this.parseNumMessage() }
      case 'lte':  return { kind: 'lte', ...this.parseNumMessage() }
      case 'gt':   return { kind: 'gt',  ...this.parseNumMessage() }
      case 'gte':  return { kind: 'gte', ...this.parseNumMessage() }

      // ── Array validators ──────────────────────────────────────────────────
      case 'minItems':    return { kind: 'minItems',   ...this.parseNumMessage() }
      case 'maxItems':    return { kind: 'maxItems',   ...this.parseNumMessage() }
      case 'uniqueItems': return { kind: 'uniqueItems', ...this.parseOptMessage() }

      // ── @point — where a row IS ───────────────────────────────────────────
      //
      // `@point(lat, lng)` on a Json field: the two keys of that value carry a
      // coordinate. It is the whole declaration of one — an object, two numeric
      // keys, ±90 / ±180, both or neither — because that floor is the same in
      // every application, which is why it belongs to the attribute rather than
      // to a shape each schema declares for itself (`FJS-D317`). `@money` is
      // the same shape: nobody declares a Money type to use it.
      //
      // The keys are NAMED rather than assumed, because the value is the app's:
      // `@point(lat, lng)` and `@point(latitude, longitude)` are both ordinary,
      // and inferring them from the shape would be silently wrong for the model
      // whose `lat` is a lathe setting.
      case 'point':   return { kind: 'point', ...this.parsePoint() }

      // ── @vector — what a row MEANS ────────────────────────────────────────
      //
      // `@vector(1536)` on a `Bytes` field: the column holds that many float32
      // dimensions and can be ordered by similarity. A marker on storage that
      // already exists rather than a ninth scalar (`FJS-D332`) — `Embedding(n)`
      // would be this grammar's first PARAMETERIZED type, and the parameter
      // would then have to travel into the DDL, the differ, the JSON Schema,
      // `select`, `orderBy`, patch semantics and the audit trail. `String @date`
      // (`FJS-D288`) and `@point` above are the same decision twice already.
      //
      // The dimension is the column's, stated once. Two vectors of different
      // lengths have no comparison, so everything downstream reads it from here
      // rather than from the bytes in hand.
      case 'vector':  return { kind: 'vector', dim: this.parseParenNumber() }

      // ── Typed JSON ────────────────────────────────────────────────────────
      // @type(Address)            — strict by default: extra keys reject
      // @type(Address, strict: false)  — loose: extra keys silently kept
      case 'type': {
        this.eat(TK.LPAREN)
        const typeName = this.eat(TK.IDENT).value
        let strict = true
        if (this.check(TK.COMMA)) {
          this.eat(TK.COMMA)
          const key = this.eat(TK.IDENT).value
          this.eat(TK.COLON)
          const val = this.eat(TK.BOOL).value
          if (key !== 'strict') throw new ParseError(`@type only accepts (strict: true/false) as a second argument, got (${key})`, this.peek())
          strict = val === true || val === 'true'
        }
        this.eat(TK.RPAREN)
        return { kind: 'type', name: typeName, strict }
      }

      default:
        // Unknown name — check if it's a function call: @fnName(arg1, arg2)
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const args = []
          while (!this.check(TK.RPAREN)) {
            args.push(this.eat(TK.IDENT).value)
            this.maybeEat(TK.COMMA)
          }
          this.eat(TK.RPAREN)
          return { kind: 'funcCall', fn: name, args }
        }
        throw new ParseError(`Unknown field attribute '@${name}'`, this.peek())
    }
  }

  parseDefault() {
    this.eat(TK.LPAREN)
    const value = this.parseDefaultValue()
    this.eat(TK.RPAREN)
    return value
  }

  parseDefaultValue() {
    const t = this.peek()
    if (t.type === TK.STRING)  return { kind: 'string',   value: this.advance().value }
    if (t.type === TK.NUMBER)  return { kind: 'number',   value: this.advance().value }
    if (t.type === TK.BOOL)    return { kind: 'boolean',  value: this.advance().value }
    if (t.type === TK.IDENT) {
      const name = this.advance().value
      if (this.check(TK.LPAREN)) {
        this.eat(TK.LPAREN)
        this.eat(TK.RPAREN)
        // auth().field — read a field from the auth context at write time
        if (name === 'auth' && this.check(TK.DOT)) {
          this.advance()  // consume '.'
          const field = this.eat(TK.IDENT).value
          return { kind: 'call', fn: 'auth', field }
        }
        // now(), uuid(), cuid(), ulid()
        return { kind: 'call', fn: name }
      }
      // Bare IDENT — could be an enum value OR a field reference.
      // Stored as 'fieldRef' and resolved at client build time:
      // if it matches a sibling field name → fieldRef default
      // if it matches an enum value → enum default (handled by DDL/SQL DEFAULT)
      return { kind: 'fieldRef', field: name }
    }
    if (t.type === TK.LBRACKET) return this.parseDefaultArray()
    throw new ParseError(`Invalid default value`, t)
  }

  // @default([]) · @default(["a", "b"]) · @default([Active, Pending])
  //
  // An array column already has a zero — `columnDefaultExpr` gives every one of
  // them `DEFAULT '[]'`, because an empty array is the null state of a list — so
  // `@default([])` restates what the column already does. It parses anyway: it
  // is what a Prisma schema writes (11 occurrences across three real ones), and
  // a language that refuses the redundant spelling of its own behavior makes a
  // port fail on a line that means what the tree already does.
  //
  // A NON-empty one is the case with no other spelling at all.
  //
  // Elements are literals and enum members. A call is refused by name rather
  // than parsed: `[now()]` is a list holding one timestamp frozen at DDL time,
  // which nobody means, and there is no runtime stamp for an element. Nested
  // arrays are refused for the plainer reason that a column holds one dimension.
  parseDefaultArray() {
    const open = this.eat(TK.LBRACKET)
    const values = []

    while (!this.check(TK.RBRACKET)) {
      const t = this.peek()
      if      (t.type === TK.STRING) values.push({ kind: 'string',   value: this.advance().value })
      else if (t.type === TK.NUMBER) values.push({ kind: 'number',   value: this.advance().value })
      else if (t.type === TK.BOOL)   values.push({ kind: 'boolean',  value: this.advance().value })
      else if (t.type === TK.IDENT) {
        const name = this.advance().value
        if (this.check(TK.LPAREN)) throw new ParseError(
          `@default([… ${name}() …]) — a generated value cannot be an array element. ` +
          `Every element is written into the column DEFAULT, so it would be one value frozen at migrate time.`, t)
        // Resolved against the field's enum in validate(), like a bare scalar one.
        values.push({ kind: 'fieldRef', field: name })
      }
      else if (t.type === TK.LBRACKET) throw new ParseError(
        `@default([[…]]) — a column holds one dimension`, t)
      else throw new ParseError(`Invalid default value`, t)

      if (!this.maybeEat(TK.COMMA)) break
    }

    this.eat(TK.RBRACKET)
    return { kind: 'array', values, token: open }
  }

  parseRelation() {
    this.eat(TK.LPAREN)
    const rel = {}

    // Prisma-style positional relation name: @relation("members", fields: ...)
    if (this.check(TK.STRING)) {
      rel.name = this.eat(TK.STRING).value
      this.maybeEat(TK.COMMA)
    }

    while (!this.check(TK.RPAREN)) {
      const key = this.eat(TK.IDENT).value
      this.eat(TK.COLON)

      if (key === 'fields' || key === 'references') {
        rel[key] = this.parseFieldList()
      } else if (key === 'onDelete') {
        rel.onDelete = this.eat(TK.IDENT).value
      } else if (key === 'onUpdate') {
        rel.onUpdate = this.eat(TK.IDENT).value
      } else if (key === 'name') {
        rel.name = this.eat(TK.STRING).value
      } else {
        throw new ParseError(`Unknown @relation argument '${key}'`, this.peek())
      }

      this.maybeEat(TK.COMMA)
    }

    this.eat(TK.RPAREN)
    return rel
  }

  // ── @edge / @scoped parsers ───────────────────────────────────────────────────
  // @edge(ref: Model [, key: name] [, as: namespace] [, onMissing: error|skip])
  //   → a field whose value lives on a relationship (join/side table), not the row.
  // @scoped [ (as: namespace, onMissing: ...) ]
  //   → shorthand for @edge bound to the @@auth model (per-viewer). Resolved in
  //     expandEdgeAttributes once the @@auth model is known.
  parseEdge() {
    this.eat(TK.LPAREN)
    const e = {}
    while (!this.check(TK.RPAREN)) {
      const key = this.eat(TK.IDENT).value
      this.eat(TK.COLON)
      if      (key === 'ref')       e.ref       = this.eat(TK.IDENT).value
      else if (key === 'key')       e.key       = this.eat(TK.IDENT).value
      else if (key === 'as')        e.as        = this.eat(TK.IDENT).value
      else if (key === 'onMissing') e.onMissing = this.eat(TK.IDENT).value
      else throw new ParseError(`Unknown @edge argument '${key}'`, this.peek())
      this.maybeEat(TK.COMMA)
    }
    this.eat(TK.RPAREN)
    return e
  }

  parseScoped() {
    const s = {}
    if (this.check(TK.LPAREN)) {
      this.eat(TK.LPAREN)
      while (!this.check(TK.RPAREN)) {
        const key = this.eat(TK.IDENT).value
        this.eat(TK.COLON)
        if      (key === 'as')        s.as        = this.eat(TK.IDENT).value
        else if (key === 'onMissing') s.onMissing = this.eat(TK.IDENT).value
        else throw new ParseError(`Unknown @scoped argument '${key}'`, this.peek())
        this.maybeEat(TK.COMMA)
      }
      this.eat(TK.RPAREN)
    }
    return s
  }

  // @generated takes two languages and the QUOTE says which.
  //
  //   @generated("{qty} * {price}")        SQL, with {field} → "field"
  //   @generated(`{firstName} {lastName}`) a template: the string it produces
  //
  // `{field}` means the same thing in both — this row's column — so the only
  // thing the delimiter changes is what the text AROUND the braces is. In SQL
  // it is an expression; in a template it is literal text, and a NULL column
  // takes the separator beside it (compileFormat).
  parseGenerated() {
    this.eat(TK.LPAREN)
    const tok      = this.peek()
    const template = this.check(TK.TEMPLATE)
    const raw      = template ? this.eat(TK.TEMPLATE).value : this.eat(TK.STRING).value
    const stored   = this.check(TK.COMMA) && (this.advance(), this.eat(TK.IDENT).value === 'stored')
    this.eat(TK.RPAREN)
    if (!template) {
      // Expand {fieldName} → "fieldName" so no quote-escaping is needed in the schema.
      // @generated("{price} * 1.08") becomes "price" * 1.08 in SQL.
      return { expr: raw.replace(/\{(\w+)\}/g, '"$1"'), stored }
    }
    let expr
    try { expr = compileFormat(raw) }
    catch (e) { throw new ParseError(e.message, tok) }
    return { expr, stored, template: raw }
  }

  // ── @from parser ────────────────────────────────────────────────────────────
  // @from(targetModel, op: value, [where: "sql", orderBy: field])
  //
  // Operations (exactly one required):
  //   last: true     — last row as full object  (ORDER BY {orderBy|id} DESC LIMIT 1)
  //   first: true    — first row as full object (ORDER BY {orderBy|id} ASC  LIMIT 1)
  //   count: true    — COUNT(*) as Int
  //   sum: fieldName — COALESCE(SUM(field), 0) as Float/Int
  //   max: fieldName — MAX(field) as DateTime/Float/Int
  //   min: fieldName — MIN(field) as DateTime/Float/Int
  //   exists: true   — EXISTS(...) as Boolean
  parseFrom() {
    this.eat(TK.LPAREN)
    const target = this.eat(TK.IDENT).value
    this.eat(TK.COMMA)

    // Parse key: value pairs
    let op = null, opValue = null, where = null, orderBy = null, via = null
    let withDeleted = false, withTemplates = false

    while (!this.check(TK.RPAREN)) {
      const key = this.eat(TK.IDENT).value
      this.eat(TK.COLON)

      switch (key) {
        case 'last':
        case 'first':
        case 'count': {
          const val = this.eat(TK.BOOL).value
          if (val !== true && val !== 'true')
            throw new ParseError(`@from(${key}: ...) only accepts true`, this.peek())
          op = key; opValue = true
          break
        }
        case 'exists': {
          // Outer loop ate the COLON — consume the bool value (always true)
          this.eat(TK.BOOL)
          op = 'exists'; opValue = true
          break
        }
        case 'sum':
        case 'max':
        case 'min': {
          opValue = this.eat(TK.IDENT).value
          op = key
          break
        }
        case 'where': {
          where = this.eat(TK.STRING).value
          break
        }
        case 'orderBy': {
          orderBy = this.eat(TK.IDENT).value
          break
        }
        // Which relation this reads, when more than one joins the two models.
        // Names either side — the field on this model or the one on the target.
        case 'via': {
          via = this.eat(TK.IDENT).value
          break
        }
        // A @from reads the target model through the target model's own
        // defaults — soft-deleted and template rows are out, exactly as they
        // are for a direct read or an include. These opt back in, and they are
        // named for the findMany args rather than inventing a second word.
        case 'withDeleted': {
          const val = this.eat(TK.BOOL).value
          withDeleted = val === true || val === 'true'
          break
        }
        case 'withTemplates': {
          const val = this.eat(TK.BOOL).value
          withTemplates = val === true || val === 'true'
          break
        }
        default:
          throw new ParseError(`@from: unknown option '${key}'`, this.peek())
      }
      this.maybeEat(TK.COMMA)
    }

    this.eat(TK.RPAREN)
    if (!op) throw new ParseError(`@from requires an operation (last, first, count, sum, max, min, exists)`, this.peek())
    return { target, op, opValue, where: where ?? null, orderBy: orderBy ?? null, via, withDeleted, withTemplates }
  }

  parseParenString() {
    this.eat(TK.LPAREN)
    const val = this.eat(TK.STRING).value
    this.eat(TK.RPAREN)
    return val
  }

  // `@unique` and `@unique(global)`. The bare form is by far the common one, so
  // the parens are optional and their absence is not an error — which is why
  // this peeks rather than eats. Anything else inside them is refused by name,
  // because a mis-spelled modifier that parsed as nothing would be a schema
  // that says less than its author wrote.
  maybeEatGlobalArg() {
    if (!this.check(TK.LPAREN)) return false
    this.eat(TK.LPAREN)
    const word = this.eat(TK.IDENT).value
    if (word !== 'global')
      throw new ParseError(`@unique: unknown argument '${word}' — the only one is 'global'`, this.peek())
    this.eat(TK.RPAREN)
    return true
  }

  // ── @@gate argument parser ──────────────────────────────────────────────────
  // Supports two forms:
  //   "2.4.4.6"                                — numeric dotted string (existing)
  //   (read: READER, write: USER)              — named shorthand (write = C+U+D)
  //   (read: READER, create: USER, update: USER, delete: OWNER) — fully named
  //
  // Named keys: read, create, update, delete, write (shorthand for create+update+delete)
  // Level names: STRANGER VISITOR READER CREATOR USER ADMINISTRATOR OWNER SYSTEM LOCKED
  // Returns a normalized dotted string "R.C.U.D" so gate.js stays unchanged.

  parseGateArg() {
    this.eat(TK.LPAREN)

    // Peek — if first token is a STRING, use original parseParenString path
    if (this.check(TK.STRING)) {
      const val = this.eat(TK.STRING).value
      this.eat(TK.RPAREN)
      return val
    }

    // The named form is REFUSED, and the refusal computes the answer
    // (`FJS-D239`). `@@gate(read: READER, …)` was the canonical spelling for
    // five weeks and reached five declarations, all of them in this package's
    // own example, against 320 written as digits — so it was a second spelling
    // of one thing, which is what the vocabulary table exists to forbid, and it
    // had no test of its own at any point.
    //
    // Refused rather than quietly dropped because a schema carrying it parses
    // today: a caller who wrote it gets the digit string for what they meant,
    // in place, rather than a grammar error pointing at a colon.
    const VALID_KEYS = new Set(['read', 'create', 'update', 'delete', 'write'])
    const named = {}
    const spelled = []
    do {
      const key = this.eat(TK.IDENT).value
      if (!VALID_KEYS.has(key))
        throw new ParseError(`@@gate: unknown key "${key}". Valid keys: read, create, update, delete, write`, this.peek())
      this.eat(TK.COLON)
      const levelToken = this.eat(TK.IDENT)
      // `Object.hasOwn`, because the value is a caller-supplied identifier and
      // every candidate map carries `Object.prototype`: a plain index answers
      // `constructor`, `toString` and `__proto__` with something that is not
      // undefined, so the typo check below passes and the level becomes a
      // function (FJS-984).
      const level = Object.hasOwn(LEVELS, levelToken.value) ? LEVELS[levelToken.value] : undefined
      if (level === undefined)
        throw new ParseError(`@@gate: unknown level "${levelToken.value}". Valid: ${Object.keys(LEVELS).join(', ')}`, levelToken)
      named[key] = level
      spelled.push(`${key}: ${levelToken.value}`)
    } while (this.maybeEat(TK.COMMA))

    this.eat(TK.RPAREN)

    if ('write' in named) {
      if (!('create' in named)) named.create = named.write
      if (!('update' in named)) named.update = named.write
      if (!('delete' in named)) named.delete = named.write
      delete named.write
    }
    const r = named.read   ?? 0
    const c = named.create ?? r
    const u = named.update ?? c
    const d = named.delete ?? u
    throw new ParseError(
      `@@gate: the named form is not the gate syntax — write the levels. ` +
      `@@gate(${spelled.join(', ')}) is @@gate("${r}.${c}.${u}.${d}"), ` +
      `read.create.update.delete on the level ladder.`,
      this.peek())
  }

  // ─── Policy expression parser ──────────────────────────────────────────────
  // The condition argument of @@allow / @@deny and every attribute that takes
  // one. The grammar is `@frontierjs/toolbelt/predicate`'s, walked over this
  // parser's own token stream — orion parses the same language (`FJS-D271`), so
  // it has one owner and this is its caller.
  parsePolicyExpr() { return parseExpression(this) }

  // Parse @log(dbName) or @log(dbName, reads: false) or @log(dbName, writes: false)
  // Returns { db, reads, writes, readsExplicit } — readsExplicit tracks if user set reads
  parseLogArgs() {
    this.eat(TK.LPAREN)
    const db     = this.eat(TK.IDENT).value
    let reads    = true
    let writes   = true
    let readsExplicit = false

    if (this.maybeEat(TK.COMMA)) {
      while (!this.check(TK.RPAREN)) {
        const key = this.eat(TK.IDENT).value
        this.eat(TK.COLON)
        const val = this.eat(TK.BOOL).value
        const bool = val === true || val === 'true'
        if (key === 'reads')  { reads = bool; readsExplicit = true }
        else if (key === 'writes') writes = bool
        else throw new ParseError(`@log only accepts reads and writes options, got '${key}'`, this.peek())
        this.maybeEat(TK.COMMA)
      }
    }

    this.eat(TK.RPAREN)
    return { db, reads, writes, readsExplicit }
  }

  parseFieldList() {
    this.eat(TK.LBRACKET)
    const names = [this.eat(TK.IDENT).value]
    while (this.maybeEat(TK.COMMA)) names.push(this.eat(TK.IDENT).value)
    this.eat(TK.RBRACKET)
    return names
  }

  // An index's column list, where a column may carry a direction:
  //
  //   @@index([organizationId, type, createdAt(sort: Desc)])
  //
  // Prisma's spelling, and ZenStack v2 and v3 declare `@@index` byte-identically
  // and mark it `@@@prisma` — inherited unchanged — so one spelling covers all
  // three and an import carries it straight through. `fields` stays a plain
  // array of names, because the index NAME is derived from it and three other
  // readers walk it; the directions travel beside it, aligned by position.
  parseIndexFieldList() {
    this.eat(TK.LBRACKET)
    const fields = []
    const sorts  = []

    const one = () => {
      fields.push(this.eat(TK.IDENT).value)
      if (!this.maybeEat(TK.LPAREN)) { sorts.push(null); return }
      const at  = this.peek()
      const key = this.eat(TK.IDENT).value
      if (key !== 'sort') throw new ParseError(
        `@@index: unknown column argument '${key}' — a column takes 'sort: Asc' or 'sort: Desc'`, at)
      this.eat(TK.COLON)
      const dir = this.eat(TK.IDENT).value
      // Prisma's own casing. A lowercase `desc` is the client's `orderBy`
      // spelling and means the same thing, so it is accepted rather than made
      // into a second thing to remember.
      if (!/^(asc|desc)$/i.test(dir)) throw new ParseError(
        `@@index: sort must be Asc or Desc, got '${dir}'`, at)
      sorts.push(dir.toUpperCase())
      this.eat(TK.RPAREN)
    }

    one()
    while (this.maybeEat(TK.COMMA)) one()
    this.eat(TK.RBRACKET)
    return { fields, sorts: sorts.some(Boolean) ? sorts : null }
  }

  // ── Model attributes ────────────────────────────────────────────────────────

  parseModelAttribute() {
    this.eat(TK.ATAT)
    const name = this.eat(TK.IDENT).value
    return this.parseModelAttributeBody(name)
  }

  // The body alone, entered with `@@` and the name already eaten. `parseView`
  // is the second caller: a view may carry the access attributes and nothing
  // else, and reading them anywhere but here would be a second grammar for
  // `@@allow`.
  parseModelAttributeBody(name) {
    switch (name) {
      // @@index([kind])                             — over every row
      // @@index([kind], where: archivedAt == null)   — over the rows it admits
      //
      // A partial index. The predicate is the expression language @@scope and
      // @@allow use, and what it may CONTAIN is decided in validate() by asking
      // the compiler rather than by a grammar here — see § partial index there.
      case 'index': {
        this.eat(TK.LPAREN)
        const { fields, sorts } = this.parseIndexFieldList()
        let where = null
        if (this.maybeEat(TK.COMMA)) {
          const argName = this.eat(TK.IDENT).value
          if (argName !== 'where')
            throw new ParseError(`@@index: unknown argument '${argName}' — expected 'where'`, this.peek())
          this.eat(TK.COLON)
          where = this.parsePolicyExpr()
        }
        this.eat(TK.RPAREN)
        return { kind: 'index', fields, sorts, where }
      }
      // @@id([orgId, userId]) — the row's identity IS the tuple
      //
      // Sugar over marking each named field `@id`, and the desugar is what makes
      // it cheap: every reader downstream already handles several `@id` fields
      // (the composite PRIMARY KEY, `findUnique` over both columns, the
      // `UniqueConflictError` naming them together, the implicit m2m join table,
      // which has been one of these since it was written), so nothing had to
      // learn a new shape.
      //
      // What it adds over two `@id` fields is the ORDER. A primary key builds an
      // implicit index and an implicit index is prefix-matched, so
      // `PRIMARY KEY (orgId, userId)` answers `WHERE orgId = ?` and the swap does
      // not — and with field-level `@id` alone the key order is the field
      // DECLARATION order, which is a different thing from the key. That is not
      // theoretical: `litestone introspect` read `PRIMARY KEY ("userId","orgId")`
      // off a real table, emitted `@id` on each field in COLUMN order, and the
      // schema it wrote built the key the other way round with nothing said
      // (`FJS-561`).
      //
      // It is also the spelling every foreign schema uses, so `litestone import`
      // can carry the key instead of inventing a surrogate and grading the loss.
      case 'id': {
        this.eat(TK.LPAREN)
        const fields = this.parseFieldList()
        this.eat(TK.RPAREN)
        if (!fields.length)
          throw new ParseError(`@@id: expected at least one field`, this.peek())
        return { kind: 'id', fields }
      }
      // @@unique([a, b])                        — the tuple identifies a row
      // @@unique([a, b], nullsDistinct: true)   — and rows with a NULL member are
      //                                           deliberately not constrained
      //
      // SQL's own word for what SQLite does: two NULLs never compare equal, so a
      // UNIQUE index admits `(1, NULL)` twice. Declaring it is how a schema says
      // that is the shape it wants — validate() refuses a nullable member
      // otherwise, because the silent version is a constraint an app believes
      // it has.
      // @@unique([a, b], where: <expr>)         — …and only over the rows the
      //                                           predicate admits
      //
      // ONE WORD, TWO NODE KINDS, because they are two mechanisms. A plain
      // @@unique rides inside CREATE TABLE as `UNIQUE (a, b)`; no SQL dialect
      // takes a predicate on a table constraint, so the partial form is a
      // standalone `CREATE UNIQUE INDEX … WHERE` and migrates by one DROP and
      // one CREATE where the other rebuilds the table. Emitting one kind whose
      // migration cost silently varies with whether an argument is present is
      // the shape nobody can reason about while writing it — and the split is
      // what makes every reader below correct without being edited: the table
      // emitter cannot pick one up, and a one-to-one relation cannot be
      // satisfied by a constraint that holds over only some rows.
      //
      // Django makes the same split under the same word and documents it.
      case 'unique': {
        this.eat(TK.LPAREN)
        const fields = this.parseFieldList()
        let nullsDistinct = false
        let where = null
        let global_ = false
        if (this.maybeEat(TK.COMMA)) {
          const argName = this.eat(TK.IDENT).value
          if (argName !== 'nullsDistinct' && argName !== 'where' && argName !== 'global')
            throw new ParseError(`@@unique: unknown argument '${argName}' — expected 'nullsDistinct', 'where' or 'global'`, this.peek())
          this.eat(TK.COLON)
          if (argName === 'where') {
            where = this.parsePolicyExpr()
          } else if (argName === 'global') {
            if (!this.check(TK.BOOL))
              throw new ParseError(`@@unique(global: …): expected true or false`, this.peek())
            global_ = this.eat(TK.BOOL).value === true
          } else {
            if (!this.check(TK.BOOL))
              throw new ParseError(`@@unique(nullsDistinct: …): expected true or false`, this.peek())
            nullsDistinct = this.eat(TK.BOOL).value === true
          }
        }
        this.eat(TK.RPAREN)
        // Refused together rather than ranked. `nullsDistinct` says the rows
        // with a NULL member are deliberately unconstrained and a predicate
        // decides which rows are constrained at all: a predicate that already
        // excludes them makes the flag moot, and one that does not is asking
        // two questions of one declaration. Refuse until somebody produces the
        // case, which is cheaper than picking a precedence nobody can read off
        // the line.
        if (where && nullsDistinct)
          throw new ParseError(
            `@@unique: 'where' and 'nullsDistinct' cannot both be given — a predicate already says which rows are ` +
            `constrained. Put the NULL rows in or out of the predicate instead`, this.peek())
        return where
          ? { kind: 'partialUnique', fields, where, global: global_ }
          : { kind: 'uniqueIndex', fields, nullsDistinct, global: global_ }
      }
      // @@arc([orderId, productId])                  — exactly one is set
      // @@arc([orderId, productId], optional: true)  — at most one is set
      //
      // An exclusive arc: several optional foreign keys, of which one applies.
      // The answer to "this row points at an Order OR a Product" that keeps a
      // real FK, a real cascade and a real include — where a polymorphic
      // (typeName, id) pair keeps none of the three and the database cannot
      // refuse a dangling one.
      //
      // Emitted as a table CHECK counting the non-null members, so it holds for
      // a migration, a seed, an atomic operator and for asSystem(), which drops
      // the gate and every row policy and cannot drop a CHECK.
      case 'arc': {
        this.eat(TK.LPAREN)
        const fields = this.parseFieldList()
        let optional = false
        let message  = undefined
        while (this.maybeEat(TK.COMMA)) {
          const argName = this.eat(TK.IDENT).value
          this.eat(TK.COLON)
          if (argName === 'optional') {
            if (!this.check(TK.BOOL))
              throw new ParseError(`@@arc(optional: …): expected true or false`, this.peek())
            optional = this.eat(TK.BOOL).value === true
          } else if (argName === 'message') {
            if (!this.check(TK.STRING))
              throw new ParseError(`@@arc(message: …): expected a string`, this.peek())
            message = this.eat(TK.STRING).value
          } else {
            throw new ParseError(`@@arc: unknown argument '${argName}' — expected 'optional' or 'message'`, this.peek())
          }
        }
        this.eat(TK.RPAREN)
        return { kind: 'arc', fields, optional, message }
      }
      // @@relator([workspaceId, userId], once)            — the pair happens at most once
      // @@relator([appId, serverId], many: replicaIndex)  — many, told apart by a column
      // @@relator([recipeId, serverId], many)             — many, told apart by nothing
      //
      // A relationship that is a row, existentially dependent on the things it
      // relates. The argument that cannot be left off is REPEATABILITY, because
      // it is the half no reader can derive: `once` and a bare `many` differ by
      // an ABSENCE, so a default answers in silence the one question the word
      // exists to ask. A bare list is a parse error naming the three choices.
      case 'relator': {
        this.eat(TK.LPAREN)
        const fields = this.parseFieldList()
        if (!this.maybeEat(TK.COMMA)) throw new ParseError(
          `@@relator([${fields.join(', ')}]) does not say whether this relationship may happen twice. ` +
          `Write 'once' if the relata identify the row, 'many: <column>' if a column tells two of them ` +
          `apart, or 'many' if nothing does`, this.peek())
        const at     = this.peek()
        const repeat = this.eat(TK.IDENT).value
        if (repeat !== 'once' && repeat !== 'many') throw new ParseError(
          `@@relator: expected 'once' or 'many', got '${repeat}'`, at)
        let discriminator = null
        if (this.maybeEat(TK.COLON)) {
          // `once: col` is refused rather than read as `many: col`. The two
          // words are the whole declaration, and a form that accepts a column
          // beside the one that says there is nothing to tell apart is a line
          // whose meaning depends on which half the reader trusts.
          if (repeat === 'once') throw new ParseError(
            `@@relator(…, once: …) takes no column — 'once' says the relata identify the row on their ` +
            `own. A column that tells two apart is 'many: <column>'`, at)
          discriminator = this.eat(TK.IDENT).value
        }
        this.eat(TK.RPAREN)
        return { kind: 'relator', fields, repeat, discriminator }
      }
      case 'noStrict': return { kind: 'noStrict' }  // opt-out from default strict
      case 'fts': {
        // @@fts([field1, field2])                   — default tokenizer (unicode61)
        // @@fts([field1], tokenize: trigram)        — typo-tolerant char-level matching
        // @@fts([title], tokenize: porter)          — English stemming
        // @@fts([title], tokenize: ascii)           — ASCII-only folding
        //
        // The tokenizer choice affects what the FTS5 virtual table indexes and
        // therefore what `search()` matches. unicode61 is word-based; trigram
        // is character-overlap (fuzzy); porter applies English stemming;
        // ascii is lowercase-ASCII fold. The model picks one. Unknown values
        // throw at parse time.
        this.eat(TK.LPAREN)
        const fields = this.parseFieldList()
        let tokenize = 'unicode61'   // FTS5 default — same behavior as before this change
        if (this.maybeEat(TK.COMMA)) {
          // Named arg: tokenize: <ident>
          const argName = this.eat(TK.IDENT).value
          if (argName !== 'tokenize')
            throw new ParseError(`@@fts: unknown argument '${argName}' — expected 'tokenize'`, this.peek())
          this.eat(TK.COLON)
          tokenize = this.eat(TK.IDENT).value
          if (!ALLOWED_TOKENIZERS.has(tokenize))
            throw new ParseError(
              `@@fts(tokenize: ${tokenize}): unknown tokenizer. ` +
              `Allowed: ${[...ALLOWED_TOKENIZERS].join(', ')}`,
              this.peek(),
            )
        }
        this.eat(TK.RPAREN)
        return { kind: 'fts', fields, tokenize }
      }
      case 'map':    return { kind: 'map',          name: this.parseParenString() }
      // @@label(fullName) — which column a picker SHOWS for a row of this model.
      // A bare identifier because it names a field, like @@index and
      // @@transitions do; a quoted one is the shape that looks like a caption.
      case 'label': {
        this.eat(TK.LPAREN)
        if (this.check(TK.STRING)) throw new ParseError(
          `@@label takes a field NAME, not a string — @@label(${JSON.stringify(this.peek().value)}) ` +
          `should be @@label(${this.peek().value}). A caption for one field is @label("…") on that field.`,
          this.peek(),
        )
        const field = this.eat(TK.IDENT).value
        this.eat(TK.RPAREN)
        return { kind: 'labelField', field }
      }
      case 'external': return { kind: 'external' }  // table exists outside migrations
      // @@extensible(fields, declaredBy: CustomField)
      // @@extensible(fields, declaredBy: CustomField, max: { text: 8, number: 4 })
      //
      // A column whose KEYS a tenant declares at runtime, and a model whose rows
      // are those declarations. `max:` is the optional half and it is what costs
      // something: it generates a pool of promoted columns so a declared key can
      // be filtered on, and an unused slot is a tax on every write to this table
      // forever, paid by every tenant including the ones who declared nothing.
      //
      // The declaring model is named rather than described, and its columns are
      // found by convention with a refusal that names what is missing — see
      // § extensible in validate(). One spelling, and a loud failure, beats a
      // second set of names for columns the app has already written.
      case 'extensible': {
        this.eat(TK.LPAREN)
        const column = this.eat(TK.IDENT).value
        let declaredBy = null
        let max        = null

        while (this.maybeEat(TK.COMMA)) {
          const argName = this.eat(TK.IDENT).value
          if (argName !== 'declaredBy' && argName !== 'max')
            throw new ParseError(
              `@@extensible: unknown argument '${argName}' — expected 'declaredBy' or 'max'`, this.peek())
          this.eat(TK.COLON)
          if (argName === 'declaredBy') {
            declaredBy = this.eat(TK.IDENT).value
            continue
          }
          // `max: { text: 8, number: 4 }` — one entry per member of the
          // declaring model's own type enum, so the pool's SHAPE is stated in
          // the app's own vocabulary rather than in slot names.
          this.eat(TK.LBRACE)
          max = {}
          while (!this.check(TK.RBRACE)) {
            const kind = this.eat(TK.IDENT).value
            this.eat(TK.COLON)
            if (!this.check(TK.NUMBER))
              throw new ParseError(`@@extensible(max: { ${kind}: … }): expected a number`, this.peek())
            const n = this.eat(TK.NUMBER).value
            if (!Number.isInteger(n) || n < 1)
              throw new ParseError(`@@extensible(max: { ${kind}: ${n} }): expected a whole number of slots, 1 or more`, this.peek())
            if (kind in max)
              throw new ParseError(`@@extensible(max: …): '${kind}' is given twice`, this.peek())
            max[kind] = n
            if (!this.maybeEat(TK.COMMA)) break
          }
          this.eat(TK.RBRACE)
          if (!Object.keys(max).length)
            throw new ParseError(`@@extensible(max: {}): a pool with no slots is the declaration without max:`, this.peek())
        }
        this.eat(TK.RPAREN)

        if (!declaredBy)
          throw new ParseError(
            `@@extensible(${column}, …) needs declaredBy: — a blob with nobody declaring its keys is an ordinary Json column`,
            this.peek())

        return { kind: 'extensible', column, declaredBy, max }
      }
      case 'softDelete': {
        // @@softDelete          — soft delete, no cascade
        // @@softDelete(cascade) — soft delete, cascade to child tables
        let cascade = false
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const arg = this.eat(TK.IDENT).value
          if (arg !== 'cascade') throw new ParseError(`@@softDelete only accepts (cascade) as an argument, got (${arg})`, this.peek())
          cascade = true
          this.eat(TK.RPAREN)
        }
        return { kind: 'softDelete', cascade }
      }
      case 'capabilities': {
        // @@capabilities       — create, update, delete and every named move
        // @@capabilities(all)  — the same, plus read
        //
        // A SWITCH and not a list: `FJS-D139` rules that a capability is a
        // reference to something the seed already declares, so the names come
        // from this model's own surface and a second list would be a second
        // owner of them.
        //
        // `read` is opt-in because its refusal is the silent one (`FJS-D140`):
        // a capability refusal on a write throws and names itself, while a
        // missing read capability composes with the policy layer into an empty
        // list with a 200. `all` is the widening token this language already
        // uses — @omit(all), @allow('all', …).
        let read = false
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const arg = this.eat(TK.IDENT).value
          if (arg !== 'all')
            throw new ParseError(
              `@@capabilities only accepts (all), got (${arg}). Bare covers create, update, ` +
              `delete and every named move; (all) adds read.`, this.peek())
          read = true
          this.eat(TK.RPAREN)
        }
        return { kind: 'capabilities', read }
      }
      case 'hasTemplates': {
        // @@hasTemplates                       — adds isTemplate Boolean @default(false), filters it out by default
        // @@hasTemplates(field: "isPreset")    — same, but with a custom column name
        //
        // Categorical "definition vs instance" pattern. Templates and instances
        // share a table because they share a schema; default reads exclude
        // templates so reporting and operational queries see only real rows.
        // Opt in per call with { withTemplates: true } or { onlyTemplates: true }.
        let field = 'isTemplate'
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          // Accept (field: "name") OR ("name") for ergonomics
          if (this.peek().type === TK.IDENT && this.peek().value === 'field') {
            this.eat(TK.IDENT)
            this.eat(TK.COLON)
          }
          if (this.check(TK.STRING)) {
            field = this.eat(TK.STRING).value
          } else {
            throw new ParseError(`@@hasTemplates expects (field: "name") — got ${this.peek().value}`, this.peek())
          }
          this.eat(TK.RPAREN)
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field))
          throw new ParseError(`@@hasTemplates field name must be a valid identifier, got '${field}'`, this.peek())
        return { kind: 'hasTemplates', field }
      }
      case 'expires': {
        // @@expires(expiresAt) — the row is DEAD from this moment on.
        //
        // IMPOSED: every read and write filters to the rows not yet expired, at
        // the client's clock or a stated `asOf`, and `withExpired` /
        // `onlyExpired` are the ways out. Nothing points at an expired row —
        // a hold, a session, a reset token — so almost every read wants the
        // filter, and a read that forgot it would hand out a dead credential.
        //
        // The sibling of `@@effective`, and the two share a predicate and not
        // a default (`FJS-D352`). One column, because an expiry has no start.
        this.eat(TK.LPAREN)
        const column = this.eat(TK.IDENT).value
        this.eat(TK.RPAREN)
        return { kind: 'expires', column }
      }
      case 'effective': {
        // @@effective(from: effectiveFrom, to: effectiveTo) — a validity window.
        //
        // ASKED: a read that states `asOf` gets the rows in force then, and a
        // read that does not gets every row. A row out of its window is
        // HISTORY here — the price a subscriber still pays, the terms a payslip
        // was computed under — and it is pointed at and listed far more often
        // than it is filtered. Imposed, those reads fail silently: a pointer
        // answers null (`FJS-D352`).
        //
        // It does NOT imply the partial unique that makes *one open row*
        // (`@@unique([…], where: to == null)` says that), nor the `@@check` that
        // orders the pair, nor schedule anything — Caravan owns the clock.
        this.eat(TK.LPAREN)
        let from = null
        let to   = null
        while (!this.check(TK.RPAREN)) {
          const at   = this.peek()
          const name = this.eat(TK.IDENT).value
          if (name !== 'from' && name !== 'to')
            throw new ParseError(`@@effective takes 'from:' and 'to:' — got '${name}'`, at)
          this.eat(TK.COLON)
          const col = this.eat(TK.IDENT).value
          if (name === 'from') from = col
          else                 to   = col
          if (!this.maybeEat(TK.COMMA)) break
        }
        this.eat(TK.RPAREN)
        // `from:` is required. Without it the line reads as an expiry and
        // would behave as a window nobody asks, so an expired session would be
        // read back as live with nothing said — the one outcome worth a
        // refusal at parse.
        if (!from) throw new ParseError(
          to
            ? `@@effective(to: ${to}) has no 'from:'. A row that is dead after a moment is ` +
              `@@expires(${to}), which filters every read. @@effective is a validity window — ` +
              `'from: <column>' and an optional 'to: <column>' — and filters only a read that states asOf`
            : `@@effective() names no column. Write 'from: <column>' and an optional 'to: <column>', ` +
              `or @@expires(<column>) for a row that is dead after a moment`,
          this.peek())
        return { kind: 'effective', from, to }
      }
      case 'commitment': {
        // @@commitment(abandon, on: createdAt + 14d)
        // @@commitment(lapse,   on: dueOn + graceDays, while: status == issued)
        //
        // A transition the SYSTEM owes this row at a time (`FJS-D353`). The
        // first argument names a transition on this model's @@transitions, so
        // its from-state is the guard and the optimistic lock is the once-ness.
        // The clock passing makes a WRITE here, where `@@expires` and
        // `@@effective` change only what a read counts.
        //
        // `on:` is a time column of this row, optionally moved by a duration
        // literal or by an `@immutable @unit` column of the same row
        // (`FJS-D355`) — never a hop, so the read is one table. Nothing here
        // schedules anything: Caravan owns the clock (`FJS-D36`).
        //
        // `subscription.lapse` names a transition on the model a TO-ONE
        // relation of this row reaches (`FJS-D362`): the invoice owns the
        // deadline and the subscription owns the move. Only the target of the
        // move crosses the relation — `on:` and `while:` still read this row.
        this.eat(TK.LPAREN)
        const at   = this.peek()
        let via        = null
        let transition = this.eat(TK.IDENT).value
        if (this.maybeEat(TK.DOT)) {
          via        = transition
          transition = this.eat(TK.IDENT).value
        }
        const name = via ? `${via}.${transition}` : transition
        let on        = null
        let predicate = null
        while (this.maybeEat(TK.COMMA)) {
          if (this.check(TK.RPAREN)) break
          const argAt = this.peek()
          const key   = this.eat(TK.IDENT).value
          this.eat(TK.COLON)
          if (key === 'on') {
            if (on) throw new ParseError(`@@commitment(${name}): 'on:' stated twice`, argAt)
            on = this.parseCommitmentOn(name)
          } else if (key === 'while') {
            if (predicate) throw new ParseError(`@@commitment(${name}): 'while:' stated twice`, argAt)
            predicate = this.parsePolicyExpr()
          } else {
            throw new ParseError(`@@commitment takes 'on:' and 'while:' — got '${key}'`, argAt)
          }
        }
        this.eat(TK.RPAREN)
        if (!on) throw new ParseError(
          `@@commitment(${name}) has no 'on:'. Say when the transition is owed — ` +
          `on: createdAt + 14d, or on: dueOn + graceDays`, at)
        return { kind: 'commitment', name, via, transition, on, while: predicate }
      }
      // ── Authorship ───────────────────────────────────────────────────────────
      // @@createdBy         — adds `createdById` + a `createdBy` relation to the
      //                       @@auth model, stamped from ctx.auth on create.
      // @@updatedBy         — adds `updatedById` + `updatedBy`, restamped on every update.
      // @@createdBy(owner)  — same pair, named `ownerId` + `owner`.
      //
      // Sugar only: both expand at parse time into the fields you would have
      // written by hand (@default(auth().id) / @updatedBy), so nothing
      // downstream knows they exist. See expandAuthorshipAttributes().
      case 'createdBy':
      case 'updatedBy': {
        let base = name
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          // Accept (as: "owner") OR ("owner") OR (owner) for ergonomics
          if (this.peek().type === TK.IDENT && this.peek().value === 'as') {
            this.eat(TK.IDENT)
            this.eat(TK.COLON)
          }
          base = this.check(TK.STRING) ? this.eat(TK.STRING).value : this.eat(TK.IDENT).value
          this.eat(TK.RPAREN)
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(base))
          throw new ParseError(`@@${name} name must be a valid identifier, got '${base}'`, this.peek())
        return { kind: name, base }
      }
      // ── Access policies ──────────────────────────────────────────────────────
      // @@allow('read', published || owner == auth())
      // @@allow('create,update', auth() != null)
      // @@deny('delete', status == 'archived')
      case 'allow':
      case 'deny': {
        this.eat(TK.LPAREN)
        const opStr = this.eat(TK.STRING).value
        const operations = normalizePolicyOps(opStr, this.peek())
        this.eat(TK.COMMA)
        const expr = this.parsePolicyExpr()
        let message = null
        if (this.check(TK.COMMA)) {
          this.eat(TK.COMMA)
          message = this.eat(TK.STRING).value
        }
        this.eat(TK.RPAREN)
        return { kind: name === 'allow' ? 'allow' : 'deny', operations, expr, message }
      }
      // @@scope(overdue, dueAt < now() && completedAt == null)
      //
      // A named predicate, in the same expression language @@allow uses, asked
      // for as `where: { $scope: 'overdue' }`. It is the policy compiler made
      // explicit and opt-in rather than implicit and always-on, and it is the
      // one spelling of a query shape that a BROWSER can name: a client sends a
      // `where` OBJECT over HTTP and cannot invoke `db.task.overdue()`.
      //
      // Predicate-only, which is what makes it cheap — no value branch, no
      // declared type to check branches against, no property in the generated
      // schema or in a form built from it. If the UI ever RENDERS the thing,
      // it wants @derived instead; if it only ever appears in a WHERE, this.
      case 'scope': {
        this.eat(TK.LPAREN)
        const scopeName = this.eat(TK.IDENT).value
        this.eat(TK.COMMA)
        const expr = this.parsePolicyExpr()
        this.eat(TK.RPAREN)
        return { kind: 'scope', name: scopeName, expr }
      }
      // ── Tenancy, per model ───────────────────────────────────────────────────
      // @@tenant(none)                 — this model is not tenant data
      // @@tenant(column: "accountId")  — it is, under a column of its own
      //
      // Only meaningful under `tenancy { strategy row }`, which applies the
      // declared column to every model that HAS it. This is the answer to the
      // two models that block cannot judge: the one that deliberately spans
      // tenants (an identity table, a global audit trail) and the one whose
      // column is spelled differently.
      case 'tenant': {
        if (!this.check(TK.LPAREN))
          throw new ParseError(`@@tenant takes an argument: (none), (column: "name") or (via: relation)`, this.peek())
        this.eat(TK.LPAREN)
        if (this.peek().type === TK.IDENT && this.peek().value === 'none') {
          this.eat(TK.IDENT)
          this.eat(TK.RPAREN)
          return { kind: 'tenant', mode: 'none', column: null }
        }
        // `via` names the relation this model is scoped THROUGH — the answer for
        // a model that carries no tenant column of its own and has more than one
        // parent that could supply one.
        if (this.peek().type === TK.IDENT && this.peek().value === 'via') {
          this.eat(TK.IDENT)
          this.eat(TK.COLON)
          const via = this.check(TK.STRING) ? this.eat(TK.STRING).value : this.eat(TK.IDENT).value
          this.eat(TK.RPAREN)
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(via))
            throw new ParseError(`@@tenant via must name a relation field, got '${via}'`, this.peek())
          return { kind: 'tenant', mode: 'via', column: null, via }
        }
        if (this.peek().type === TK.IDENT && this.peek().value === 'column') {
          this.eat(TK.IDENT)
          this.eat(TK.COLON)
        }
        const column = this.check(TK.STRING) ? this.eat(TK.STRING).value : this.eat(TK.IDENT).value
        this.eat(TK.RPAREN)
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column))
          throw new ParseError(`@@tenant column must be a valid identifier, got '${column}'`, this.peek())
        return { kind: 'tenant', mode: 'column', column }
      }
      // ── @@check — a row invariant that spans more than one column ───────────
      //
      //   @@check("startsAt < endsAt")
      //   @@check("startsAt < endsAt", "an end must come after its start")
      //
      // The table-level half of `@check`. A field validator sees one field,
      // `@@unique` is about rows in a table rather than values in a row, and
      // `@@allow` is who rather than what is valid — so a two-column invariant
      // had nowhere to live but a service hook, which every other writer
      // bypasses: a job on `db.`, a migration, `asSystem()`, a seed.
      //
      // Repeatable, like `@@unique` and `@@index`: a model may hold several
      // invariants and they are not one answer to one question.
      case 'check':  return { kind: 'check',        ...this.parseCheckArgs() }

      // @@export(ndjson)                    — every column, graded per caller
      // @@export(ndjson, since: updatedAt)   — plus a cursor, for an incremental run
      //
      // An export is not a second read path: it is a paginated scoped read, so
      // this attribute says a dataset MAY leave and in what shape, and says
      // nothing about who may take it. That is the @@gate beside it, which
      // validate() requires.
      case 'export': {
        this.eat(TK.LPAREN)
        const format = this.eat(TK.IDENT).value
        let since = null
        if (this.check(TK.COMMA)) {
          this.eat(TK.COMMA)
          const key = this.eat(TK.IDENT).value
          if (key !== 'since')
            throw new ParseError(`@@export takes one option and it is 'since:' — got '${key}'`, this.peek())
          this.eat(TK.COLON)
          since = this.eat(TK.IDENT).value
        }
        this.eat(TK.RPAREN)
        return { kind: 'export', format, since }
      }
      case 'gate':   return { kind: 'gate',         value: this.parseGateArg() }
      case 'transitions': return { kind: 'transitions', ...this.parseTransitionsArg() }
      case 'auth':   return { kind: 'auth' }
      case 'log': {
        // @@log(audit)               — log create/update/delete (default)
        // @@log(audit, reads: true)  — also log findMany/findFirst (opt-in)
        // reads defaults to false at model level — collection reads can be high volume
        const args = this.parseLogArgs()
        if (!args.readsExplicit) args.reads = false
        delete args.readsExplicit
        return { kind: 'log', ...args }
      }
      case 'db': {
        this.eat(TK.LPAREN)
        const dbName = this.eat(TK.IDENT).value
        this.eat(TK.RPAREN)
        return { kind: 'db', name: dbName }
      }
      case 'trait': {
        // @@trait(TraitName)
        // Splices the named trait's fields and attributes into this model
        // at parse time. Validated and resolved after all top-level decls
        // are parsed (see resolveTraits).
        this.eat(TK.LPAREN)
        const traitName = this.eat(TK.IDENT).value
        this.eat(TK.RPAREN)
        return { kind: 'trait', name: traitName }
      }
      case 'sync': {
        // @@sync(server) — this model's rows may be written with no server
        // reachable, and the queue that holds such a write replays it when one
        // is (`FJS-D298`).
        //
        // The argument is the COLLISION policy and nothing else. Whether a
        // model leaves the device, and in which direction, is a second question
        // this attribute has not been asked (`IDEAS/homestead.md`).
        //
        // There is no default: a model that says nothing is not syncable and an
        // offline client refuses to queue a write against it. The refusal is
        // the point — a model nobody thought about loses a row otherwise, with
        // nothing said.
        this.eat(TK.LPAREN)
        const policyToken = this.eat(TK.IDENT)
        this.eat(TK.RPAREN)
        if (!SYNC_POLICIES.has(policyToken.value))
          throw new ParseError(
            `@@sync: unknown policy "${policyToken.value}". Valid: ${[...SYNC_POLICIES].join(', ')}`,
            policyToken)
        return { kind: 'sync', policy: policyToken.value }
      }
      // @@anonymous — no row of this model may be attributed (`FJS-D349`). A
      // fact validate() and the client reason from, because what re-attributes
      // a row is usually on a DIFFERENT model: a logged write in the same
      // transaction, whose trail clock lines up with this table's rowid order.
      case 'anonymous': return { kind: 'anonymous' }
      default:
        throw new ParseError(`Unknown model attribute '@@${name}'`, this.peek())
    }
  }


  // ── Validation attribute helpers ───────────────────────────────────────────

  // Parse optional message: @email or @email(msg)
  parseOptMessage() {
    if (!this.check(TK.LPAREN)) return {}
    this.eat(TK.LPAREN)
    const message = this.check(TK.STRING) ? this.eat(TK.STRING).value : null
    this.eat(TK.RPAREN)
    return message ? { message } : {}
  }

  // `where:` first when both are present, so the message stays where every
  // other validator puts it — last. Named argument for the predicate and
  // positional for the message, which is what @@check(expr, "msg") and
  // @@unique([a], where: …) already do between them.
  parseRequiredArgs() {
    if (!this.check(TK.LPAREN)) return {}
    this.eat(TK.LPAREN)

    let where = null
    if (this.check(TK.IDENT) && this.peek().value === 'where') {
      this.eat(TK.IDENT)
      this.eat(TK.COLON)
      where = this.parsePolicyExpr()
      this.maybeEat(TK.COMMA)
    }

    const message = this.check(TK.STRING) ? this.eat(TK.STRING).value : null
    this.eat(TK.RPAREN)
    return { ...(where ? { where } : {}), ...(message ? { message } : {}) }
  }

  // Parse @point(lat, lng) — two key names inside the Json value.
  parsePoint() {
    this.eat(TK.LPAREN)
    const lat = this.eat(TK.IDENT).value
    this.eat(TK.COMMA)
    const lng = this.eat(TK.IDENT).value
    this.eat(TK.RPAREN)
    return { lat, lng }
  }

  // Parse @regex(pattern) or @regex(pattern, msg)
  parseRegex() {
    this.eat(TK.LPAREN)
    const pattern = this.eat(TK.STRING).value
    const message = this.maybeEat(TK.COMMA) ? this.eat(TK.STRING).value : null
    this.eat(TK.RPAREN)
    return message ? { pattern, message } : { pattern }
  }

  // Parse @length(min, max) or @length(min, max, msg)
  parseLength() {
    this.eat(TK.LPAREN)
    const min = this.check(TK.NUMBER) ? this.eat(TK.NUMBER).value : null
    const max = this.maybeEat(TK.COMMA) && this.check(TK.NUMBER) ? this.eat(TK.NUMBER).value : null
    const message = this.maybeEat(TK.COMMA) && this.check(TK.STRING) ? this.eat(TK.STRING).value : null
    this.eat(TK.RPAREN)
    return Object.fromEntries(Object.entries({ min, max, message }).filter(([,v]) => v != null))
  }

  // Parse @startsWith(text) or @startsWith(text, msg)
  parseTextMessage(kind) {
    this.eat(TK.LPAREN)
    const text = this.eat(TK.STRING).value
    const message = this.maybeEat(TK.COMMA) ? this.eat(TK.STRING).value : null
    this.eat(TK.RPAREN)
    return message ? { text, message } : { text }
  }

  // Parse @gt(value) or @gt(value, msg)
  parseParenNumber() {
    this.eat(TK.LPAREN)
    const value = this.eat(TK.NUMBER).value
    this.eat(TK.RPAREN)
    return value
  }

  /**
   * `@money` · `@money(USD)` · `@money("USD")` · `@money(field: currency)`
   *
   * A bare code and a quoted one are the same thing; the schema reads better
   * unquoted and a string is what somebody pasting from JSON will write.
   * `field:` names a sibling column holding the code per row, which is the shape
   * a shop taking more than one currency needs — django-money's two columns and
   * one declaration.
   */
  parseMoney() {
    if (!this.check(TK.LPAREN)) return { kind: 'money', currency: null, field: null }

    this.eat(TK.LPAREN)

    // `field: currency` — an IDENT followed by a colon, which no currency is.
    if (this.check(TK.IDENT) && this.peek(1)?.type === TK.COLON) {
      const key = this.eat(TK.IDENT).value
      this.eat(TK.COLON)
      const field = this.eat(TK.IDENT).value
      this.eat(TK.RPAREN)
      if (key !== 'field') {
        const t = this.peek()
        throw new ParseError(`@money takes a currency or 'field:', got '${key}:'`, { line: t.line, col: t.col })
      }
      return { kind: 'money', currency: null, field }
    }

    const currency = this.check(TK.STRING) ? this.eat(TK.STRING).value : this.eat(TK.IDENT).value
    this.eat(TK.RPAREN)
    return { kind: 'money', currency: String(currency).toUpperCase(), field: null }
  }

  /**
   * `@unit(ms)` · `@unit("%")`
   *
   * Bare where the symbol is an identifier, quoted where it is not — `%` is a
   * token this lexer already spends on something else, and a unit that cannot
   * be written bare is better quoted than renamed. The symbol is NOT folded to
   * a case: `MB` is a megabyte and `Mb` a megabit everywhere a reader has seen
   * them, so a wrong case is a wrong unit and is refused as one.
   */
  parseUnit() {
    const t = this.peek()
    if (!this.check(TK.LPAREN))
      throw new ParseError('@unit takes a symbol — @unit(ms), @unit(kg), @unit("%")', { line: t.line, col: t.col })
    this.eat(TK.LPAREN)
    const symbol = this.check(TK.STRING) ? this.eat(TK.STRING).value : this.eat(TK.IDENT).value
    this.eat(TK.RPAREN)
    return { kind: 'unit', symbol: String(symbol) }
  }

  // ── @@commitment's `on:` ────────────────────────────────────────────────────
  //
  //   createdAt                 the column itself
  //   createdAt + 14d           moved by a literal
  //   dueOn + graceDays         moved by a column of the same row
  //
  // `+` and `-` are the lexer's; a `-` against a digit arrives as a negative
  // NUMBER, so `createdAt -14d` is read here too. Whether the unit fits the
  // column's kind, and whether the offset column is a frozen duration, needs
  // the whole model and is validate()'s.
  parseCommitmentOn(transition) {
    const field = this.eat(TK.IDENT).value
    let sign = 0
    if (this.maybeEat(TK.PLUS))       sign = 1
    else if (this.maybeEat(TK.MINUS)) sign = -1
    else if (this.check(TK.NUMBER) && this.peek().value < 0) sign = -1
    if (!sign) return { field, offset: null }

    if (this.check(TK.IDENT)) return { field, offset: { sign, field: this.eat(TK.IDENT).value } }

    const numAt = this.peek()
    if (!this.check(TK.NUMBER)) throw new ParseError(
      `@@commitment(${transition}): '${sign > 0 ? '+' : '-'}' takes a duration — 14d, 2h — or a column of this row`, numAt)
    const value = Math.abs(this.eat(TK.NUMBER).value)
    if (!Number.isInteger(value)) throw new ParseError(
      `@@commitment(${transition}): an offset is a whole number of a unit — write 90min, not 1.5h`, numAt)
    const unitAt = this.peek()
    const unit   = this.check(TK.IDENT) ? this.eat(TK.IDENT).value : null
    if (!unit || unitInfo(unit)?.dimension !== 'duration') throw new ParseError(
      `@@commitment(${transition}): '${value}${unit ?? ''}' is not a duration. ` +
      `Write the number and a unit together: ${MEASURE_UNITS.duration.map(u => `${value}${u}`).join(', ')}`,
      unitAt)
    return { field, offset: { sign, value, unit } }
  }

  // ── @check / @@check argument parser ────────────────────────────────────────
  //
  //   @check("qty > 0")
  //   @check("qty > 0", "must be at least one")
  //
  // The message is the LAST argument, which is where every other validator on a
  // field carries one. Without it the only sentence available is the expression,
  // and an expression under a form control is SQL leaking to a person who did
  // not write it.
  parseCheckArgs() {
    this.eat(TK.LPAREN)
    const expr    = this.eat(TK.STRING).value
    const message = this.maybeEat(TK.COMMA) ? this.eat(TK.STRING).value : null
    this.eat(TK.RPAREN)
    return message ? { expr, message } : { expr }
  }

  parseNumMessage() {
    this.eat(TK.LPAREN)
    const value = this.eat(TK.NUMBER).value
    const message = this.maybeEat(TK.COMMA) ? this.eat(TK.STRING).value : null
    this.eat(TK.RPAREN)
    return message ? { value, message } : { value }
  }

  parseFieldListParen() {
    this.eat(TK.LPAREN)
    const fields = this.parseFieldList()
    this.eat(TK.RPAREN)
    return fields
  }

  // ── @@transitions argument parser ───────────────────────────────────────────
  //
  //   @@transitions(status,
  //     pay:    pending         -> paid,
  //     ship:   paid            -> shipped,
  //     refund: paid            -> refunded @gate(5),
  //     cancel: [pending, paid] -> cancelled)
  //
  // The leading name is optional — `pending -> paid` names itself after the
  // target value. `@gate(N)` takes a number or a level name (ADMINISTRATOR).
  //
  // Values are checked against the field's enum in validate(), not here: the
  // enum may be declared after the model, or in another file.

  parseTransitionsArg() {
    this.eat(TK.LPAREN)
    const field = this.eat(TK.IDENT).value
    if (!this.maybeEat(TK.COMMA))
      throw new ParseError(`@@transitions(${field}): expected at least one transition after the field name`, this.peek())

    const transitions = {}
    do {
      if (this.check(TK.RPAREN)) break   // tolerate a trailing comma

      // Optional `name:` — an IDENT followed by COLON. Anything else starts `from`.
      let name = null
      if (this.check(TK.IDENT) && this.peek(1)?.type === TK.COLON) {
        name = this.eat(TK.IDENT).value
        this.eat(TK.COLON)
      }

      // A state is an enum member or a boolean literal. `true`/`false` are their
      // own token, so an enum-only reader stopped at the tokenizer and the
      // commonest two-state machine in any schema had no declaration at all.
      // A state is an enum member, and a member may be quoted — so a move onto
      // `"To Receive and Bill"` names it the way the enum declares it.
      const state = () =>
        this.check(TK.BOOL)   ? this.eat(TK.BOOL).value
      : this.check(TK.STRING) ? this.eat(TK.STRING).value
      :                         this.eat(TK.IDENT).value

      // from — a single value or [a, b, ...]
      let from
      if (this.check(TK.LBRACKET)) {
        this.eat(TK.LBRACKET)
        from = [state()]
        while (this.maybeEat(TK.COMMA)) from.push(state())
        this.eat(TK.RBRACKET)
      } else {
        from = [state()]
      }

      const arrow = this.advance()
      if (arrow.type !== TK.ARROW)
        throw new ParseError(`@@transitions(${field}): expected '->' after '${from.join(', ')}', got '${arrow.value}'`, arrow)

      const to = state()
      // Unnamed moves are named after the target state, which reads on an enum
      // (`-> refunded` is `refund`) and says nothing on a boolean: `true` is not
      // the name of anything a person does. So a boolean move states its own.
      if (name === null && typeof to === 'boolean')
        throw new ParseError(
          `@@transitions(${field}): a boolean move must be named — '-> ${to}' says which value it writes, ` +
          `not what it does. Write \`promote: false -> true\`.`, this.peek())
      // Same reasoning one step along: a QUOTED member is a display string, and
      // `transition(id, 'To Receive and Bill')` is the value wearing the name of
      // an action. A bare member reads as a verb (`-> refunded` is `refund`) and
      // a sentence does not.
      if (name === null && typeof to === 'string' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(to))
        throw new ParseError(
          `@@transitions(${field}): a move onto a quoted member must be named — '-> "${to}"' is the ` +
          `value it writes, not what it does. Write \`receive: … -> "${to}"\`.`, this.peek())
      if (name === null) name = to   // unnamed → named after the target state

      // Optional per-move attributes, in either order.
      //
      //   @gate(N)  the minimum level allowed to MAKE this move
      //   @system   the move is the APPLICATION's: a caller may ask for it and
      //             never make one, and the app states `{ system: true }` on the
      //             call. The move still runs on the caller's own client, so the
      //             gate, the row policies and the audit actor all survive —
      //             which is the whole difference from asSystem().
      //   @seals    the move is the moment this row becomes a DOCUMENT. After it
      //             the row's @sealed children may not be created, changed or
      //             removed, and its @immutable columns freeze. A seal is an
      //             event rather than a state, which is why it is declared on
      //             the move rather than as a predicate over the state column —
      //             a predicate is a second answer to a question @@transitions
      //             already answers, and the two can disagree.
      //
      // They compose: `@system @gate(5)` is a move the engine decides, on behalf
      // of a caller who must still be senior enough to ask for it.
      let gate   = null
      let system = false
      let seals  = false
      while (this.check(TK.AT)) {
        this.eat(TK.AT)
        const attr = this.eat(TK.IDENT)

        if (attr.value === 'gate') {
          if (gate !== null)
            throw new ParseError(`@@transitions(${field}) '${name}': @gate stated twice`, attr)
          gate = this.parseTransitionGate(field, name)
          continue
        }

        if (attr.value === 'system') {
          if (system)
            throw new ParseError(`@@transitions(${field}) '${name}': @system stated twice`, attr)
          // It takes no argument, and the shape somebody reaches for is the
          // column's — `@guarded`. Named rather than left to fail on the
          // paren, which reports a missing comma somewhere else entirely.
          if (this.check(TK.LPAREN))
            throw new ParseError(
              `@@transitions(${field}) '${name}': @system takes no argument — it says the application makes ` +
              `this move and states so on the call. Use @gate(N) beside it to say who may ask.`, attr)
          system = true
          continue
        }

        if (attr.value === 'seals') {
          if (seals)
            throw new ParseError(`@@transitions(${field}) '${name}': @seals stated twice`, attr)
          if (this.check(TK.LPAREN))
            throw new ParseError(
              `@@transitions(${field}) '${name}': @seals takes no argument — WHICH children seal is @sealed on ` +
              `the relation field, and WHEN is this move.`, attr)
          seals = true
          continue
        }

        throw new ParseError(
          `@@transitions(${field}): unknown transition attribute '@${attr.value}' — only @gate, @system and @seals are supported`, attr)
      }

      // 8 and 9 are sentinels meaning *no caller reaches this*, which is the
      // opposite of what @system says. A move declaring both has two answers to
      // one question and the reader cannot tell which was meant.
      if (system && gate !== null && gate >= 8)
        throw new ParseError(
          `@@transitions(${field}) '${name}': @system and @gate(${gate}) contradict each other — ` +
          `@gate(${gate}) admits no caller at all, where @system says the application makes the move ` +
          `THROUGH one. Drop the gate, or lower it to the level a caller must hold to ask.`, this.peek())

      if (name in transitions)
        throw new ParseError(`@@transitions(${field}): duplicate transition name '${name}'`, this.peek())
      transitions[name] = { from, to, gate, system, seals }
    } while (this.maybeEat(TK.COMMA))

    this.eat(TK.RPAREN)
    return { field, transitions }
  }

  // @gate(5) or @gate(ADMINISTRATOR) — a single level, unlike @@gate's R.C.U.D tuple
  parseTransitionGate(field, name) {
    this.eat(TK.LPAREN)
    const tok = this.advance()
    let level
    if (tok.type === TK.NUMBER) {
      level = tok.value
    } else if (tok.type === TK.IDENT) {
      // Guarded for FJS-984's reason — see the `@@gate` site above.
      level = Object.hasOwn(LEVELS, tok.value) ? LEVELS[tok.value] : undefined
      if (level === undefined)
        throw new ParseError(
          `@@transitions(${field}) '${name}': unknown level '${tok.value}'. Valid: ${Object.keys(LEVELS).join(', ')}`,
          tok,
        )
    } else {
      throw new ParseError(`@@transitions(${field}) '${name}': @gate expects a level 0–9 or a level name, got '${tok.value}'`, tok)
    }
    if (!Number.isInteger(level) || level < 0 || level > 9)
      throw new ParseError(`@@transitions(${field}) '${name}': @gate level must be an integer 0–9, got ${level}`, tok)
    this.eat(TK.RPAREN)
    return level
  }

  // ── Enum ────────────────────────────────────────────────────────────────────

  // ── Value set ───────────────────────────────────────────────────────────────
  // A NAME for a scoped list of rows, so a picker's options and a column's
  // legality come from one declaration instead of a hand-written service, a
  // hand-written control and a hand-written validator per list (`FJS-D120`).
  //
  //   valueset TaskTag {
  //     source Tag                  // the model the rows come from
  //     value  label                // the column a record STORES — default @id
  //     scope  mine                 // a @@scope declared on the source
  //     where  "archivedAt IS NULL"
  //     order  sortOrder, label      // what a picker offers first — default: the label column
  //   }
  //
  // There is no `binding` here: a strength is a property of the FIELD, not of
  // the list, because one list is legitimately enforced on one field and merely
  // offered on another. It goes on `@values(Name, strength)`.
  //
  // `order` is the opposite and sits HERE for the reason strength does not: one
  // list shown on two fields is the same list, and a per-call order is already
  // spellable as a directive. It is not membership — nothing here changes what
  // a column may hold (`FJS-D121`).
  parseValueSet(comments = []) {
    this.eatIdent('valueset')
    const nameTok = this.peek()
    const name    = this.eat(TK.IDENT).value
    this.eat(TK.LBRACE)

    let source = null, value = null, scope = null, where = null, order = null, recent = null
    const seen = new Set()

    while (!this.check(TK.RBRACE)) {
      const keyTok = this.peek()
      const key    = this.eat(TK.IDENT).value
      if (seen.has(key)) throw new ParseError(`valueset '${name}': '${key}' is declared twice`, keyTok)
      seen.add(key)

      switch (key) {
        case 'source': source = this.eat(TK.IDENT).value;  break
        case 'value':  value  = this.eat(TK.IDENT).value;  break
        case 'scope':  scope  = this.eat(TK.IDENT).value;  break
        case 'where':  where  = this.eat(TK.STRING).value; break
        // `order sortOrder, name desc` — a direction binds to the column before
        // it and defaults to asc, which is the shape `orderBy` already takes on
        // every read. No valueset key is named asc or desc, so a bare column
        // followed by the next key is unambiguous.
        case 'order': {
          order = []
          do {
            const colTok = this.peek()
            // `recent(Task.assigneeId, createdAt)` — the HEAD: the values this
            // caller reached for last, read off rows the app already writes.
            // It is not a sort key, which is why it cannot follow one: the head
            // is its own bounded query and the columns after it order the page
            // beneath it (`FJS-D121`).
            //
            // The clock is STATED rather than derived. A rank by the wrong
            // clock draws a plausible order and nothing about it looks wrong,
            // which is the one failure this whole axis has — so the schema
            // names the column that says WHEN, the same way @@label names the
            // column that says WHICH ROW.
            if (this.peek().value === 'recent' && this.peek(1)?.type === TK.LPAREN) {
              if (recent || order.length)
                throw new ParseError(
                  `valueset '${name}': recent(…) is the head of the list, so it comes first and only once`, colTok)
              this.advance(); this.eat(TK.LPAREN)
              const model = this.eat(TK.IDENT).value
              this.eat(TK.DOT)
              const field = this.eat(TK.IDENT).value
              this.eat(TK.COMMA)
              const clock = this.eat(TK.IDENT).value
              this.eat(TK.RPAREN)
              recent = { model, field, clock }
              continue
            }
            const col    = this.eat(TK.IDENT).value
            let   dir    = 'asc'
            if (this.check(TK.IDENT) && (this.peek().value === 'asc' || this.peek().value === 'desc'))
              dir = this.advance().value
            if (order.some(o => o.field === col))
              throw new ParseError(`valueset '${name}': order names '${col}' twice`, colTok)
            order.push({ field: col, dir })
          } while (this.maybeEat(TK.COMMA))
          break
        }
        default:
          throw new ParseError(
            `valueset '${name}': unknown key '${key}'. A value set takes source, value, scope, where and order. ` +
            `A strength is not one of them — it goes on the field, as @values(${name}, required|open|suggested), ` +
            `because one list can be enforced on one field and only offered on another.`,
            keyTok,
          )
      }
    }
    this.eat(TK.RBRACE)

    if (!source) throw new ParseError(`valueset '${name}': no 'source' — a value set is a named list of rows from one model`, nameTok)
    return { name, source, value, scope, where, order, recent, comments }
  }

  parseEnum(comments = []) {
    this.eatIdent('enum')
    const name   = this.eat(TK.IDENT).value
    this.eat(TK.LBRACE)
    const values = []
    let   transitions = null

    while (!this.check(TK.RBRACE)) {
      const enumComments = this.docComments()
      // Check for optional `transitions {` block
      if (this.peek().type === TK.IDENT && this.peek().value === 'transitions') {
        this.advance()   // consume 'transitions'
        this.eat(TK.LBRACE)
        transitions = {}
        while (!this.check(TK.RBRACE)) {
          // name: from -> to   OR   name: [a, b] -> to
          const tName = this.eat(TK.IDENT).value
          if (tName === 'transitions') throw new ParseError(`'transitions' is reserved and cannot be a transition name`, this.peek())
          this.eat(TK.COLON)
          // Parse from: single ident or [a, b, ...]
          let froms
          if (this.check(TK.LBRACKET)) {
            this.eat(TK.LBRACKET)
            froms = [this.eat(TK.IDENT).value]
            while (this.maybeEat(TK.COMMA)) froms.push(this.eat(TK.IDENT).value)
            this.eat(TK.RBRACKET)
          } else {
            froms = [this.eat(TK.IDENT).value]
          }
          // Parse -> (tokenized as TK.ARROW)
          const arrow = this.advance()
          if (arrow.type !== TK.ARROW)
            throw new ParseError(`Expected '->' in transition '${tName}', got '${arrow.value}'`, arrow)
          const to = this.eat(TK.IDENT).value
          // Both per-move attributes are a MODEL concern: one enum can drive
          // the same move on two models that answer to different authority, and
          // on one of them the move can be the engine's while on the other it is
          // a person's. This block is shared by both. Caught by name because the
          // generic parse failure here is `Expected IDENT, got '@'`, which says
          // neither why nor where it goes.
          if (this.check(TK.AT)) {
            const at   = this.peek()
            const next = this.peek(1)
            // `@gate` keeps its argument in the suggestion; `@system` has none.
            const attr = next && next.type === TK.IDENT
              ? (next.value === 'gate' ? '@gate(N)' : `@${next.value}`)
              : 'an attribute'
            throw new ParseError(
              `Enum '${name}', transition '${tName}': ${attr} cannot go on the enum's shared block — ` +
              `one enum can drive the same move on two models that answer to different authority, and ` +
              `the move can be the application's on one and a person's on the other. ` +
              `Declare @@transitions(<field>, ${tName}: ${froms.join(', ')} -> ${to} ${attr === 'an attribute' ? '@gate(N)' : attr}) ` +
              `on the model, which overrides this block for that field.`, at)
          }
          if (tName in transitions)
            throw new ParseError(`Enum '${name}': duplicate transition name '${tName}'`, this.peek())
          transitions[tName] = { from: froms, to }
        }
        this.eat(TK.RBRACE)
      } else {
        // A member may be a quoted STRING, because a closed set in the wild is
        // usually written for a person to read: `To Receive and Bill`,
        // `Grand Total`, `Per Week`. Measured over seven published schemas, 283
        // Frappe Select fields declare a set `.lite` could not express, and
        // almost every one of them is blocked by a space and nothing else.
        //
        // The stored value IS the string — there is no second name and nothing
        // translates. Postgres's own enums work this way; Prisma's `@map` is the
        // other answer and buys a separate code-name at the price of a
        // bidirectional layer on every read and write, which nothing in the
        // corpus asks for. `@label` is already the display override.
        //
        // A quoted member that IS a legal identifier normalizes to the bare
        // spelling, so `"Draft"` and `Draft` are one member rather than two —
        // the same reading `FJS-564` gave the redundant array default, and what
        // lets an importer quote everything and still emit a canonical schema.
        const vTok  = this.check(TK.STRING) ? this.eat(TK.STRING) : this.eat(TK.IDENT)
        const vName = vTok.value
        if (vTok.type === TK.STRING && vName === '') throw new ParseError(
          `Enum '${name}': a member may not be the empty string`, vTok)
        if (values.some(v => v.name === vName)) throw new ParseError(
          `Enum '${name}': duplicate member '${vName}' — a quoted member that is a legal ` +
          `identifier is the same member as the bare one`, vTok)

        // A member takes attributes through the SAME parser a field's do, so
        // there is one grammar for `@label("…")` rather than a second one that
        // accepts a slightly different string literal. What a member may carry
        // is narrower than what a field may, and the refusal names the member:
        // an attribute that parses and then does nothing is the shape a reader
        // assumes is working.
        let label
        while (this.check(TK.AT)) {
          const at   = this.peek()
          const attr = this.parseFieldAttribute()
          if (attr.kind !== 'label') throw new ParseError(
            `Enum '${name}', member '${vName}': @${attr.kind} is not allowed on an enum member. ` +
            `Only @label("…") is — a member is a symbol, not a column.`,
            at,
          )
          if (label !== undefined) throw new ParseError(
            `Enum '${name}', member '${vName}': duplicate @label`,
            at,
          )
          label = attr.text
        }

        values.push({ name: vName, comments: enumComments, ...(label === undefined ? {} : { label }) })
      }
    }

    this.eat(TK.RBRACE)
    return { name, comments, values, transitions: transitions ?? undefined }
  }
}

// ─── Policy operation normalizer ─────────────────────────────────────────────
// Accepts: 'read', 'create', 'update', 'post-update', 'delete',
//          'write' (= create+update+delete), 'all' (= all five),
//          or comma-separated combos: 'update,delete'
// Returns: array of canonical op names, deduplicated

const VALID_POLICY_OPS = new Set(['read', 'create', 'update', 'post-update', 'delete'])

function normalizePolicyOps(str, token) {
  if (str === 'all')   return ['read', 'create', 'update', 'post-update', 'delete']
  if (str === 'write') return ['create', 'update', 'delete']
  const parts = str.split(',').map(s => s.trim())
  for (const p of parts)
    if (!VALID_POLICY_OPS.has(p))
      throw new ParseError(
        `@@allow/@@deny: invalid operation '${p}'. Valid: read, create, update, post-update, delete, write, all`,
        token
      )
  return [...new Set(parts)]
}

// ─── Validator ────────────────────────────────────────────────────────────────
// Second pass — checks enum refs, duplicate names, relation integrity

// ─── @secret expansion ────────────────────────────────────────────────────────
// Runs between parseSchema() and validate().
// Synthesizes @encrypted, @guarded, and optionally @log(<loggerDb>) onto
// every field marked @secret, keeping the { kind: 'secret', rotate } attr for
// key rotation tracking via db.$rotateKey().
//
// Runs before validation so all downstream checks (@encrypted on jsonl, etc.)
// fire correctly on the synthesized attributes.

// ─── Trait resolution ────────────────────────────────────────────────────────
// `trait T { ... }` declarations are reusable model fragments. A model picks
// them up via `@@trait(T)`, which gets spliced at parse time:
//
//   - The trait's fields are added to the host's field list.
//   - The trait's model-level attributes are added to the host's attribute list.
//   - The @@trait reference itself is removed from the host's attributes.
//
// Validation rules applied here:
//   - Trait declarations cannot contain @id, @@id, @@map, @@db, @@fts —
//     these are host-model concerns.
//   - Two traits used by the same model cannot declare the same field name.
//   - A trait can use other traits (transitive splicing). Cycles are detected
//     and reported as errors.
//   - A reference to a non-existent trait is an error.
//   - Host model fields/attributes win over trait ones (override semantics).
//
// After resolution, schema.models contains the fully-spliced models and
// schema.traits is preserved (for introspection / typegen / docs) but
// not used by anything else downstream.

// Enumerated argument values, hoisted so they are readable as data rather than
// as a literal inside the arm that happens to check them — `catalog.js` restates
// them and `test/catalog.test.ts` binds the two.
export const ALLOWED_TOKENIZERS   = new Set(['unicode61', 'ascii', 'porter', 'trigram'])
export const ON_DELETE_ACTIONS    = new Set(['Cascade', 'SetNull', 'Restrict', 'NoAction'])
// Why a database named by `@@log` is not one a trail can be written to. Two
// different mistakes with two different fixes, and a single "must use driver
// logger" told half of them the wrong one.
function logTargetHint(schema, dbName) {
  const db = schema.databases.find(d => d.name === dbName)
  if (db?.driver === 'jsonl')
    return `'${dbName}' is 'driver jsonl', which is ordinary append-only storage. A trail is 'driver logger', or a SQLite database declaring 'model <Name>'`
  return `'${dbName}' is 'driver ${db?.driver ?? 'sqlite'}' and declares no log model. Either add 'model <Name>' to it, naming a model assigned to it with @@db(${dbName}), or write the trail to a 'driver logger' database`
}

export const DATABASE_DRIVERS     = new Set(['sqlite', 'jsonl', 'logger'])

export const TRAIT_FORBIDDEN_FIELD_ATTRS = new Set(['id'])
export const TRAIT_FORBIDDEN_MODEL_ATTRS = new Set(['id', 'map', 'db', 'fts'])

// Attributes a model may legitimately carry more than one of. Everything else
// is a single answer, so a second one is two answers and is refused rather than
// silently won by whichever the merge put last.
// How an attribute's ANSWER reads in a refusal. Single-valued attributes carry
// their argument under several key names, so this prefers whichever is there
// and falls back to naming the attribute alone where it takes no argument.
function attrAnswer(attr, at = '@@', ordinal = 'the first') {
  // A value arrives under whichever key its own parse arm chose, and `@default`
  // wraps its own in `{ kind, value }`. Anything still not a scalar after that
  // is an argument with no short spelling — a field list, a policy expression —
  // and naming its POSITION beats printing a structure into a sentence.
  //
  // The ordinal is a parameter and not a constant because both halves of the
  // sentence call this: with it fixed at "the first", an attribute whose
  // argument has no short spelling produced *the first @@relator is the one in
  // force; the first @@relator is ignored* — one name for two attributes, which
  // is the reading failure the caller exists to prevent.
  const raw = attr.value ?? attr.policy ?? attr.name ?? attr.text ?? attr.format ?? attr.field
  const v   = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
  const tag = `${at}${typedAttr(attr.kind)}`
  return v === undefined || v === null || typeof v === 'object'
    ? `${ordinal} ${tag}`
    : `${tag}(${JSON.stringify(v)})`
}

// These are PARSE KINDS and not the words a reader types, which is the trap
// this list has already fallen into twice: `@@unique` parses as `uniqueIndex`
// and field `@allow` as `fieldAllow`, so an entry spelled the readable way
// matches nothing and the rule silently stops applying. `repeatable-attrs`
// in the suite parses each of these twice and fails on a kind no parse emits.
export const REPEATABLE_MODEL_ATTRS = new Set([
  'allow', 'deny', 'index', 'uniqueIndex', 'check', 'scope', 'trait',
  // One per predicate, as `index` beside it — an entry row and a move row are
  // two constraints ([FJS-1306](ISSUES.md#fjs-1306)).
  'partialUnique',
  // One per MOVE owed, and a second for the same move is refused by name in
  // @@commitment's own check — an invoice owes both a lapse and a cancel.
  'commitment',
  // One per FIELD — an invoice's `status` and its `reminded` are two machines,
  // and the runtime keys moves by field. The same field twice, and one move
  // name on two machines, are @@transitions' own refusals.
  'transitions',
])

// Field attributes a field may legitimately carry more than one of. No field in
// this workspace or the imported corpus carries a repeated attribute at all, so
// this one is here on the argument and on the suite: `@allow('read', …)` beside
// `@allow('write', …)` is two operations, not two answers.
export const REPEATABLE_FIELD_ATTRS = new Set(['fieldAllow'])

// What a reader TYPED, where the parse kind is not the word. `@@unique` parses
// as `uniqueIndex`, and a refusal naming that spells a word nobody can write —
// which is how `REPEATABLE_MODEL_ATTRS` came to list 'unique', a kind that
// never occurs, and so refused a legitimate second `@@unique` on an extend
// while letting every real duplicate through ([FJS-1174](ISSUES.md#fjs-1174)).
const TYPED_AS = { uniqueIndex: 'unique', partialUnique: 'unique' }
// Columns a predicate's top-level AND chain pins as `col != null`.
const nonNullConjuncts = (node, out = new Set()) => {
  if (!node) return out
  if (node.type === 'and') { nonNullConjuncts(node.left, out); nonNullConjuncts(node.right, out) }
  else if (node.type === 'compare' && node.op === '!=') {
    const isNull = (n) => n?.type === 'literal' && n.value === null
    if (node.left?.type === 'field' && isNull(node.right)) out.add(node.left.name)
    else if (node.right?.type === 'field' && isNull(node.left)) out.add(node.right.name)
  }
  return out
}

export const typedAttr = (kind) => TYPED_AS[kind] ?? kind

/**
 * Splice every `extend model X` into the `model X` it names.
 *
 * Runs BEFORE traits, so an extend may bring a `@@trait(T)` with it.
 *
 * Three things are refused rather than resolved, and each is a real mistake
 * wearing the look of a working schema:
 *
 *   · an extend naming no model — a typo does nothing at all, forever
 *   · a field the base already declares — that is editing a package's column,
 *     which is the copy this feature exists to remove
 *   · a second answer to a single-valued attribute — `@@gate` twice is not a
 *     narrowing, it is two statements about who may read the table
 */
function resolveExtends(schema) {
  const errors  = []
  const extends_ = schema.extends ?? []
  if (!extends_.length) return errors

  const byName = new Map()
  for (const m of schema.models) byName.set(m.name, m)

  for (const ext of extends_) {
    const model = byName.get(ext.name)
    if (!model) {
      // Named, with what IS there: the common cause is a misspelling or an
      // import that did not resolve, and both read as "my extend did nothing".
      const known = schema.models.map(m => m.name).sort().join(', ')
      errors.push(
        `extend model '${ext.name}': no model '${ext.name}' is declared or imported. ` +
        `Declared: ${known || '(none)'}`
      )
      continue
    }

    const hostFields = new Set(model.fields.map(f => f.name))
    for (const f of ext.fields) {
      if (hostFields.has(f.name)) {
        errors.push(
          `extend model '${ext.name}': field '${f.name}' is already declared by the model. ` +
          `An extend adds; it cannot redefine a column its owner declared.`
        )
        continue
      }
      hostFields.add(f.name)
      model.fields.push(f)
    }

    const hostAttrs = new Set(model.attributes.map(a => a.kind))
    for (const attr of ext.attributes) {
      if (!REPEATABLE_MODEL_ATTRS.has(attr.kind) && hostAttrs.has(attr.kind)) {
        errors.push(
          `extend model '${ext.name}': @@${typedAttr(attr.kind)} is already declared by the model, ` +
          `and it takes one answer. Change it where the model is declared, or drop it here.`
        )
        continue
      }
      hostAttrs.add(attr.kind)
      model.attributes.push(attr)
    }
  }

  return errors
}

function resolveTraits(schema) {
  const errors = []
  const traits = schema.traits ?? []
  if (!traits.length && !schema.models.some(m => m.attributes.some(a => a.kind === 'trait'))) {
    return errors
  }

  // Index traits by name. Duplicate trait declarations are an error.
  const traitMap = new Map()
  for (const t of traits) {
    if (traitMap.has(t.name)) {
      errors.push(`Duplicate trait '${t.name}' — defined more than once`)
      continue
    }
    traitMap.set(t.name, t)
  }

  // Validate each trait's contents against the trait-declaration ruleset.
  for (const t of traits) {
    for (const f of t.fields) {
      for (const attr of f.attributes) {
        if (TRAIT_FORBIDDEN_FIELD_ATTRS.has(attr.kind)) {
          errors.push(`Trait '${t.name}' field '${f.name}': @${attr.kind} is not allowed in a trait (the host model owns its primary key)`)
        }
      }
    }
    for (const attr of t.attributes) {
      // @@trait is allowed (transitive); other forbidden ones are not.
      if (attr.kind === 'trait') continue
      if (TRAIT_FORBIDDEN_MODEL_ATTRS.has(attr.kind)) {
        errors.push(`Trait '${t.name}': @@${attr.kind === 'id' ? 'id' : attr.kind} is not allowed in a trait (host-model concern)`)
      }
    }
  }

  if (errors.length) return errors

  // Resolve a trait's full set of fields + attributes, recursively expanding
  // any nested @@trait references. Detects cycles via a visiting set carried
  // through the recursion. Returns null on error (errors pushed to outer array).
  function resolve(traitName, visiting, errorPath) {
    if (visiting.has(traitName)) {
      const cycle = [...visiting, traitName].join(' → ')
      errors.push(`Trait cycle detected: ${cycle}`)
      return null
    }
    const trait = traitMap.get(traitName)
    if (!trait) {
      errors.push(`${errorPath}: unknown trait '${traitName}'`)
      return null
    }
    visiting.add(traitName)

    const allFields = []
    const allAttrs  = []
    const seenFields = new Map()  // name → trait it came from (for collision diagnostics)

    // Process nested traits first (so their fields appear before this trait's own)
    for (const attr of trait.attributes) {
      if (attr.kind !== 'trait') continue
      const sub = resolve(attr.name, visiting, `Trait '${traitName}'`)
      if (!sub) continue
      for (const f of sub.fields) {
        if (seenFields.has(f.name)) {
          errors.push(`Trait '${traitName}': field '${f.name}' is declared by both '${seenFields.get(f.name)}' and '${attr.name}' — cannot splice both into the same trait`)
          continue
        }
        seenFields.set(f.name, attr.name)
        allFields.push(f)
      }
      allAttrs.push(...sub.attrs)
    }

    // Then this trait's own fields (override nested if name collides — but
    // since we error above on collision, this is unreachable in practice;
    // kept for safety).
    for (const f of trait.fields) {
      if (seenFields.has(f.name)) {
        errors.push(`Trait '${traitName}': field '${f.name}' collides with field of same name from nested trait '${seenFields.get(f.name)}'`)
        continue
      }
      seenFields.set(f.name, traitName)
      allFields.push(f)
    }

    // Then this trait's own model-level attributes (excluding @@trait, which
    // we've already expanded).
    for (const attr of trait.attributes) {
      if (attr.kind === 'trait') continue
      allAttrs.push(attr)
    }

    visiting.delete(traitName)
    return { fields: allFields, attrs: allAttrs }
  }

  // Splice traits into each model.
  for (const model of schema.models) {
    const traitRefs = model.attributes.filter(a => a.kind === 'trait')
    if (!traitRefs.length) continue

    const seenFromTraits = new Map()  // field name → originating trait
    const splicedFields = []
    const splicedAttrs  = []

    for (const ref of traitRefs) {
      const resolved = resolve(ref.name, new Set(), `Model '${model.name}' @@trait`)
      if (!resolved) continue

      for (const f of resolved.fields) {
        if (seenFromTraits.has(f.name)) {
          errors.push(`Model '${model.name}': field '${f.name}' provided by both @@trait(${seenFromTraits.get(f.name)}) and @@trait(${ref.name})`)
          continue
        }
        seenFromTraits.set(f.name, ref.name)
        splicedFields.push(f)
      }
      splicedAttrs.push(...resolved.attrs)
    }

    // Host wins: if the model itself already declares a field, drop the
    // trait-provided version. Same for attributes that take a single value.
    const hostFieldNames = new Set(model.fields.map(f => f.name))
    const finalTraitFields = splicedFields.filter(f => !hostFieldNames.has(f.name))

    // Trait fields go first, then host fields (host author's intent should
    // appear most prominently in any tooling that lists fields).
    model.fields = [...finalTraitFields, ...model.fields]

    // Trait attributes go first, host attributes after (so host's @@allow /
    // @@deny / @@gate take precedence in any "last write wins" evaluation).
    // Drop the @@trait references themselves.
    const hostAttrs = model.attributes.filter(a => a.kind !== 'trait')
    model.attributes = [...splicedAttrs, ...hostAttrs]
  }

  return errors
}

// ─── Type resolution & validation ─────────────────────────────────────────────
// `type T { ... }` declarations describe the shape of a JSON value.
// Used as `Json @type(T)` on a field, the type's structure is validated on
// write at runtime.
//
// What can appear in a type:
//   - Scalar fields (String, Int, Float, Boolean, DateTime)
//   - Optional fields (String?)
//   - Array fields (String[], Int[])
//   - Enum fields
//   - Nested types via Json @type(Other)
//   - Validators (@email, @regex, @length, @gte, @gt, @lte, @lt, @url,
//     @date, @datetime, @minItems, @maxItems, @uniqueItems)
//   - Transforms (@trim, @lower, @upper)
//   - Computed fields (@computed)
//   - Markdown semantic tag (@markdown)
//
// What CANNOT appear in a type:
//   - Relations (@relation) — JSON can't carry FK columns
//   - File / Bytes field types — bytes don't JSON-encode
//   - @id, @unique, @map — column-only concepts
//   - @encrypted, @guarded, @secret — column-only protections
//   - @default(now()) / @updatedAt / @default(auth().id) / cuid()/ulid() —
//     runtime-stamped on column write, doesn't apply per JSON write
//   - @from / @generated — column-only
//   - @allow / @deny field-level — JSON can't be policy-gated by sub-key
//   - Model-level attributes (@@anything)
//
// Validation runs in two passes:
//   1. Type declarations are validated against the rules above.
//   2. Every `Json @type(T)` reference is checked: T exists, target field
//      is a Json type, no nested cycles in `Json @type` chains.

export const TYPE_FORBIDDEN_FIELD_ATTRS = new Set([
  'id', 'unique', 'map', 'relation', 'generated', 'from',
  'encrypted', 'guarded', 'secret', 'updatedAt', 'version', 'allow', 'deny',
  // Storage facts about a COLUMN. A `type` describes a shape inside a Json
  // column or a custom method's input, where there is no column to scale — and
  // no int64 either, since a `type` is carried as JSON and JSON's number is the
  // double `@big` exists to get around.
  'scale', 'money', 'big',
  // Not because the SET has no table — it does — but because nothing on this
  // path runs the check. A `type` describes a shape inside a Json column or a
  // custom method's declared input; neither reaches litestone's write path,
  // where `enforceValueSets` lives, so a binding here would be a declaration
  // that silently enforces nothing.
  'values',
])

/**
 * The two columns a `@point` field derives, keyed by the JSON key each reads.
 *
 * ONE owner, because three readers have to agree on the spelling: the DDL that
 * emits them, the query compiler that names them in a WHERE, and the migration
 * differ that must not see a column it cannot account for. camelCase, like
 * every other identifier this schema language produces.
 */
export function pointColumnNames(fieldName, point) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
  return { [point.lat]: `${fieldName}${cap(point.lat)}`, [point.lng]: `${fieldName}${cap(point.lng)}` }
}

/** `[latColumn, lngColumn]` in that order — what an index and a box need. */
export function pointColumns(fieldName, point) {
  const names = pointColumnNames(fieldName, point)
  return [names[point.lat], names[point.lng]]
}

export const TYPE_FORBIDDEN_FIELD_TYPES = new Set(['File', 'Bytes'])
export const TYPE_DEFAULT_FORBIDDEN_KINDS = new Set(['now', 'cuid', 'ulid', 'uuid', 'nanoid', 'auth'])

function validateTypes(schema) {
  const errors = []
  const types = schema.types ?? []
  if (!types.length && !schema.models.some(m => m.fields.some(f => f.attributes.some(a => a.kind === 'type')))) {
    return errors
  }

  // Index types by name; duplicates are an error.
  const typeMap = new Map()
  for (const t of types) {
    if (typeMap.has(t.name)) {
      errors.push(`Duplicate type '${t.name}' — defined more than once`)
      continue
    }
    typeMap.set(t.name, t)
  }

  // Pass 1: validate type declaration contents.
  for (const t of types) {
    if (t.attributes.length) {
      for (const attr of t.attributes) {
        errors.push(`Type '${t.name}': @@${attr.kind} not allowed in a type — types describe value shapes, not models`)
      }
    }
    for (const f of t.fields) {
      // Forbidden underlying types
      if (TYPE_FORBIDDEN_FIELD_TYPES.has(f.type.name)) {
        errors.push(`Type '${t.name}' field '${f.name}': ${f.type.name} fields can't be stored as JSON`)
      }
      // Forbidden attributes
      for (const attr of f.attributes) {
        if (TYPE_FORBIDDEN_FIELD_ATTRS.has(attr.kind)) {
          errors.push(`Type '${t.name}' field '${f.name}': @${attr.kind} not allowed in a type`)
        }
        // @default(now()) / @default(cuid()) etc. — runtime-stamped values
        // make no sense per-JSON-write.
        if (attr.kind === 'default' && attr.value && attr.value.kind === 'call' && TYPE_DEFAULT_FORBIDDEN_KINDS.has(attr.value.fn)) {
          errors.push(`Type '${t.name}' field '${f.name}': @default(${attr.value.fn}()) not allowed in a type — runtime-stamped values apply to columns, not JSON values`)
        }
      }
    }
  }

  if (errors.length) return errors

  // Pass 2: validate every Json @type(T) reference on model fields.
  for (const model of schema.models) {
    for (const field of model.fields) {
      const typeAttr = field.attributes.find(a => a.kind === 'type')
      if (!typeAttr) continue
      // Field must be Json-typed.
      if (field.type.name !== 'Json') {
        errors.push(`Model '${model.name}' field '${field.name}': @type(${typeAttr.name}) requires the field to be Json (got ${field.type.name})`)
        continue
      }
      // Target type must exist.
      if (!typeMap.has(typeAttr.name)) {
        errors.push(`Model '${model.name}' field '${field.name}': @type(${typeAttr.name}) — unknown type '${typeAttr.name}'`)
        continue
      }
    }
  }

  // Pass 3: detect cycles in `type X { y Json @type(X) }` chains.
  const reportedCycles = new Set()
  for (const t of types) {
    const visited = new Set()
    function walk(typeName, path) {
      if (visited.has(typeName)) {
        const key = [...path, typeName].sort().join('|')
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key)
          errors.push(`Type cycle detected: ${[...path, typeName].join(' → ')}`)
        }
        return
      }
      visited.add(typeName)
      const target = typeMap.get(typeName)
      if (!target) return
      for (const f of target.fields) {
        if (f.type.name !== 'Json') continue
        const ta = f.attributes.find(a => a.kind === 'type')
        if (!ta) continue
        if (path.includes(ta.name)) {
          const cyclePath = [...path, typeName, ta.name]
          const key = cyclePath.sort().join('|')
          if (!reportedCycles.has(key)) {
            reportedCycles.add(key)
            errors.push(`Type cycle detected: ${cyclePath.join(' → ')}`)
          }
          continue
        }
        walk(ta.name, [...path, typeName])
      }
      visited.delete(typeName)
    }
    walk(t.name, [])
  }

  return errors
}

function expandSecretAttributes(schema) {
  const loggerDb = schema.databases.find(db => db.driver === 'logger')

  for (const model of schema.models) {
    for (const field of model.fields) {
      const secretAttr = field.attributes.find(a => a.kind === 'secret')
      if (!secretAttr) continue

      // Synthesize @encrypted + @guarded unconditionally.
      // If the field already had an explicit @encrypted or @guarded, this produces
      // duplicates — validate() catches those as conflict errors.
      field.attributes.push({ kind: 'encrypted', deterministic: !!secretAttr.deterministic })
      field.attributes.push({ kind: 'guarded' })

      // Synthesize @log(<loggerDb>) — audit writes only by default.
      // reads:false matches @@log model-level default — reads are high-volume and opt-in.
      // To audit reads, declare @log(audit, reads: true) explicitly on the field.
      if (loggerDb && !field.attributes.some(a => a.kind === 'log'))
        field.attributes.push({ kind: 'log', db: loggerDb.name, reads: false, writes: true })
    }
  }
}

// @@hasTemplates — auto-inject the marker field if the user hasn't declared
// it, so the directive is self-contained. Validation (type compatibility,
// collisions with @id, etc.) happens later in validate().
function expandHasTemplatesAttributes(schema) {
  for (const model of schema.models) {
    const ht = model.attributes.find(a => a.kind === 'hasTemplates')
    if (!ht) continue

    const existing = model.fields.find(f => f.name === ht.field)
    if (existing) continue   // user declared their own — validate() checks the type

    // Mirror the AST shape produced by the parser for `isTemplate Boolean @default(false)`.
    // type is a nested {kind, name, array, optional} object, and the @default
    // value uses {kind:'boolean'} (NOT 'literal') so DDL emits `DEFAULT 0`.
    model.fields.push({
      name: ht.field,
      type: { kind: 'scalar', name: 'Boolean', array: false, optional: false },
      attributes: [{ kind: 'default', value: { kind: 'boolean', value: false } }],
      comments: [],
    })
  }
}

// ── @@id expansion ────────────────────────────────────────────────────────────
// `@@id([orgId, userId])` → `@id` on each named field, in the order named.
//
// Pure desugaring, and that is the whole design: several `@id` fields is a shape
// every reader in this package already handles, so from here on nothing knows
// the attribute existed. The attribute itself STAYS on the model, read by one
// caller — `tableConstraints` in ddl.js — because the field list is the only
// place the key's column ORDER is written down, and field declaration order is
// a different fact.
//
// Refused rather than merged where the two spellings are both present: `@@id`
// and a field-level `@id` on the same model are two answers to *what identifies
// a row*, and the merge would silently pick one. That is the same rule
// REPEATABLE_MODEL_ATTRS applies to a second `@@id`.
function expandCompositeId(schema) {
  const errors    = []
  // A relation is still a `scalar` carrying a model name at this point —
  // `validate()` is what promotes it — so the type name is what can be asked,
  // not `type.kind`.
  const modelNames = new Set(schema.models.map(m => m.name))
  const enumNames  = new Set((schema.enums ?? []).map(e => e.name))
  const VIRTUAL    = ['computed', 'transient', 'from', 'derived']

  for (const model of schema.models) {
    const attrs = model.attributes.filter(a => a.kind === 'id')
    if (!attrs.length) continue
    if (attrs.length > 1) {
      errors.push(
        `Model '${model.name}': @@id declared ${attrs.length} times — a row has one identity. ` +
        `Name every column of the key in a single @@id([...]).`)
      continue
    }
    const attr = attrs[0]

    const declared = model.fields.filter(f => f.attributes.some(a => a.kind === 'id'))
    if (declared.length) {
      errors.push(
        `Model '${model.name}': @@id([${attr.fields.join(', ')}]) and @id on '${declared[0].name}' both say what identifies a row — ` +
        `use one. @@id is the spelling when the key is a tuple, because it states the key's column ORDER; ` +
        `@id on the field is the spelling for a single-column key.`)
      continue
    }

    const seen = new Set()
    let bad = false
    for (const name of attr.fields) {
      if (seen.has(name)) {
        errors.push(`Model '${model.name}': @@id names '${name}' twice`)
        bad = true
        continue
      }
      seen.add(name)

      const field = model.fields.find(f => f.name === name)
      // An unknown name is reported by the generic model-attribute check in
      // `validate()`, which already says it for every attribute carrying a field
      // list. Saying it again here would print the same fault twice.
      if (!field) { bad = true; continue }

      // A primary key is over COLUMNS. Everything below is a field that is not
      // one, and each fails differently if allowed through: a relation would put
      // `@id` on a field with no column and emit a key naming nothing; an array
      // is JSON TEXT, so the key would be over a serialization; a virtual field
      // is computed at read time and has nothing to be keyed by.
      const why =
        modelNames.has(field.type.name) && !enumNames.has(field.type.name)
          ? `the relation '${name}' — name the foreign key field instead`
        : field.type.array
          ? `the array '${name}' — an array is stored as JSON text, so a key over it is a key over a serialization`
        : VIRTUAL.find(k => field.attributes.some(a => a.kind === k))
          ? `'${name}', which is @${VIRTUAL.find(k => field.attributes.some(a => a.kind === k))} — it is not a stored column`
        : null
      if (why) {
        errors.push(`Model '${model.name}': @@id names ${why}. A primary key is over columns.`)
        bad = true
        continue
      }

      // SQLite lets a PRIMARY KEY column hold NULL on a rowid table, which is
      // the one place it departs from the standard — so a nullable member is a
      // key that does not identify anything, silently. Refused for the reason
      // `@@unique` refuses one (FJS-D130), and more sharply: there is no
      // `nullsDistinct` reading of a primary key.
      if (field.type.optional) {
        errors.push(
          `Model '${model.name}': @@id names the optional field '${name}' — a primary key member cannot be nullable. ` +
          `Make it required, or use @@unique([...], nullsDistinct: true) if the tuple is merely unique when present.`)
        bad = true
      }
    }
    if (bad) continue

    for (const name of attr.fields)
      model.fields.find(f => f.name === name).attributes.push({ kind: 'id' })
  }

  return errors
}

// ── @@createdBy / @@updatedBy expansion ────────────────────────────────────────
// Authorship sugar. Both are pure desugaring — each injects the exact pair of
// fields you would otherwise hand-write, so from here on nothing knows the
// attribute existed:
//
//   @@createdBy  →  createdById <authIdType>? @createdBy
//                   createdBy   <AuthModel>?  @relation("<Model>_createdBy",
//                                               fields: [createdById], references: [<authId>])
//   @@updatedBy  →  updatedById <authIdType>? @updatedBy
//                   updatedBy   <AuthModel>?  @relation("<Model>_updatedBy", …)
//
// The FK type is copied from the @@auth model's @id, so an Int id and a
// String uuid id both land right. Both columns are nullable: asSystem() writes
// and unauthenticated creates have no author, and a NOT NULL here would break
// every seeder and migration backfill.
//
// A field the host already declares under either name wins and is left alone —
// declare `createdById String?` yourself and you still get the relation for
// free. Runs before expandEdgeAttributes() so injected columns are visible to
// its collision checks, and before validate(), which is what resolves the
// injected relation field's type.kind.
function expandAuthorshipAttributes(schema) {
  const errors    = []
  const authModel = schema.models.find(m => m.attributes.some(a => a.kind === 'auth'))

  for (const model of schema.models) {
    for (const attr of model.attributes) {
      if (attr.kind !== 'createdBy' && attr.kind !== 'updatedBy') continue

      if (!authModel) {
        errors.push(`Model '${model.name}': @@${attr.kind} requires a model marked @@auth`)
        continue
      }
      const authId = authModel.fields.find(f => f.attributes.some(a => a.kind === 'id'))
      if (!authId) {
        errors.push(`Model '${model.name}': @@${attr.kind} requires an @id field on the @@auth model '${authModel.name}'`)
        continue
      }

      const base = attr.base
      const key  = `${base}Id`

      if (!model.fields.some(f => f.name === key)) {
        model.fields.push({
          name: key,
          type: { kind: 'scalar', name: authId.type.name, array: false, optional: true },
          attributes: [{ kind: attr.kind, authField: 'id' }],
          comments: [],
        })
      }

      // The relation is named explicitly: a model carrying both @@createdBy and
      // @@updatedBy has two relations to the same model, which is ambiguous
      // without one. A self-authoring @@auth model needs it for the same reason.
      if (!model.fields.some(f => f.name === base)) {
        model.fields.push({
          name: base,
          type: { kind: 'scalar', name: authModel.name, array: false, optional: true },
          attributes: [{
            kind:       'relation',
            name:       `${model.name}_${base}`,
            fields:     [key],
            references: [authId.name],
          }],
          comments: [],
        })
      }
    }
  }
  return errors
}

// ── tenancy { strategy row } expansion ─────────────────────────────────────────
// The tenant column becomes two @@deny rules and a stamp, per model, so from
// here on nothing downstream knows the block existed — the gate ladder, the
// access snapshot, `verifyRowPolicies` and the compiled WHERE all read ordinary
// policies.
//
// A deny rather than an @@allow, and that is the whole correctness argument:
// allows are OR'd within an operation, so adding one to a model that already
// has `@@allow('read', ownerId == auth().id)` WIDENS its read to every row in
// the tenant. Tenancy narrows. `@@deny` overrides every allow and applies to a
// model that declares no policy at all.
//
// Two rules rather than one, because create and read want opposite answers
// about an absent value:
//
//   read/update/delete   auth().<claim> == null || <col> != auth().<claim>
//   create               auth().<claim> == null || (<col> != null && <col> != auth().<claim>)
//
// checkCreatePolicy runs BEFORE the @default stamp is applied, so a create that
// legitimately omits the column has `<col> == null` in its data. Denying that
// would refuse every create the stamp exists to serve. On a read there is no
// stamp and a row holding no tenant belongs to nobody — `@@tenant(none)` is how
// a model says it spans tenants on purpose.
//
// The anonymous branch is stated rather than left to SQL: `"col" != NULL`
// answers NULL, which `NOT (…)` also answers NULL, which excludes the row — the
// right outcome reached by three-valued logic nobody should have to hold in
// their head. In the JS evaluator the same expression is what refuses an
// anonymous create.
function expandTenancy(schema) {
  const errors   = []
  const warnings = []
  const t        = schema.tenancy
  const tagged   = [...schema.models, ...(schema.views ?? [])].filter(m => (m.attributes ?? []).some(a => a.kind === 'tenant'))

  if (!t) {
    for (const m of tagged)
      errors.push(
        `Model '${m.name}': @@tenant with no 'tenancy' block — declare one at the top of the schema`
      )
    return { errors, warnings }
  }

  if (t.strategy !== 'row') {
    for (const m of tagged)
      errors.push(
        `Model '${m.name}': @@tenant is a strategy row attribute — under strategy database every ` +
        `tenant already has a database of its own, so there is nothing for a column to scope`
      )
    return { errors, warnings }
  }

  const claim   = t.claim
  const drivers = Object.fromEntries(schema.databases.map(d => [d.name, d.driver ?? 'sqlite']))
  const scoped  = []
  const missing = []

  // Models with no column of their own, kept for the delegation pass below.
  const undecided = []

  for (const model of schema.models) {
    const tag = model.attributes.find(a => a.kind === 'tenant')
    if (tag?.mode === 'none') continue

    // A log row is appended, never policied — jsonl and logger models have no
    // policy engine to deny with, so scoping one would be a rule that reads as
    // enforcement and is not.
    const dbName = model.attributes.find(a => a.kind === 'db')?.name
    const driver = dbName ? drivers[dbName] : 'sqlite'
    if (driver === 'jsonl' || driver === 'logger') continue
    if (model.attributes.some(a => a.kind === 'external')) continue

    if (tag?.mode === 'via') { undecided.push({ model, via: tag.via }); continue }

    const column = tag?.column ?? t.column
    const field  = model.fields.find(f => f.name === column)

    if (!field) {
      if (tag) errors.push(`Model '${model.name}': @@tenant(column: "${column}") names no field on this model`)
      else undecided.push({ model, via: null })
      continue
    }

    const col       = () => ({ type: 'field', name: column })
    const authClaim = () => ({ type: 'auth',  field: claim })
    const noPrincipal = { type: 'compare', op: '==', left: authClaim(), right: { type: 'literal', value: null } }
    const mismatch    = { type: 'compare', op: '!=', left: col(),       right: authClaim() }
    const message     = `Outside your ${column}`

    // `post-update` is in this list and it is the half a hand-written
    // `@@allow('all', col == auth().claim)` got for free: `all` expands to every
    // operation, so an allow was graded against the RESULTING row too. The
    // generated rules were read/update/delete + create, which asks *may you
    // touch this row* and never *may the row end up there* — so a caller could
    // `update({ where: { id: mine }, data: { workspaceId: theirs } })` and push
    // their own row into somebody else's tenant, with the WHERE matching
    // legitimately at the moment it ran. Evaluated in JS after the write, inside
    // the transaction, so a violation rolls back.
    // `claim` rides the attribute so a reader does not have to recover it from
    // the expression tree. buildPolicyMap carries it through, and a system
    // context needs it to answer *is a tenant in scope at all* (FJS-519).
    model.attributes.push({
      kind: 'deny', operations: ['read', 'update', 'delete', 'post-update'], generated: 'tenancy', claim, message,
      expr: { type: 'or', left: noPrincipal, right: mismatch },
    })
    model.attributes.push({
      kind: 'deny', operations: ['create'], generated: 'tenancy', claim, message,
      expr: {
        type: 'or',
        left: noPrincipal,
        right: {
          type: 'and',
          left:  { type: 'compare', op: '!=', left: col(), right: { type: 'literal', value: null } },
          right: mismatch,
        },
      },
    })

    // The stamp. A column the app already defaults is left alone — an app
    // stamping it from somewhere else has said so, and two defaults on one
    // field is not a merge.
    if (!field.attributes.some(a => a.kind === 'default'))
      field.attributes.push({ kind: 'default', value: { kind: 'call', fn: 'auth', field: claim }, generated: 'tenancy' })

    scoped.push(model.name)
  }

  // ── views ──────────────────────────────────────────────────────────────────
  //
  // A view gets the READ deny and nothing else: it has no create, update or
  // delete to guard, and no column to stamp. It also does not delegate through
  // a parent — a view declares no relations, so the fixpoint below has nothing
  // to walk, and validate() refuses `@@tenant(via:)` on one for that reason.
  //
  // The column is the view's OWN, which is the whole reason this is declarable:
  // the tenant predicate is applied to the projection rather than pushed into
  // `@@sql`, so nothing here has to read the author's SQL to know what it
  // selected.
  for (const view of (schema.views ?? [])) {
    const tag = (view.attributes ?? []).find(a => a.kind === 'tenant')
    if (!tag || tag.mode === 'none' || tag.mode === 'via') continue

    const dbName = view.db
    const driver = dbName ? drivers[dbName] : 'sqlite'
    if (driver === 'jsonl' || driver === 'logger') continue

    const column = tag.column ?? t.column
    if (!view.fields.some(f => f.name === column)) {
      errors.push(
        `View '${view.name}': @@tenant(column: "${column}") names no column this view declares — ` +
        `a view is scoped by its own projection, so the column has to be selected by @@sql and declared here`)
      continue
    }

    const col         = { type: 'field', name: column }
    const authClaim   = { type: 'auth',  field: claim }
    const noPrincipal = { type: 'compare', op: '==', left: authClaim, right: { type: 'literal', value: null } }
    const mismatch    = { type: 'compare', op: '!=', left: col,       right: authClaim }

    view.attributes.push({
      kind: 'deny', operations: ['read'], generated: 'tenancy', claim, message: `Outside your ${column}`,
      expr: { type: 'or', left: noPrincipal, right: mismatch },
    })
    scoped.push(view.name)
  }

  // ── scoped through a parent ────────────────────────────────────────────────
  //
  // A model that carries no tenant column but holds a foreign key to one that
  // does is not cross-tenant data — it is the same tenant's data, one hop away.
  // Denormalizing the column onto it is a schema change an app can make by
  // hand; delegating to the parent's own rule is the one that needs no column
  // at all, and `check()` is exactly that delegation (FJS-282).
  //
  // ONE DENY PER SCOPED PARENT, and that is why there is no choice to make.
  // Denies are AND'd, so a model with two scoped parents must satisfy both —
  // the narrowing answer, which is the direction tenancy always takes. Picking
  // one parent and ignoring the other would be the widening one, and would need
  // a rule nobody could predict. `@@tenant(via: rel)` narrows to a single
  // relation for an app that wants exactly that.
  //
  // `check(rel, 'read')` states the operation rather than inheriting the
  // containing one: the question is always *is that parent mine*, never *may I
  // create that parent*, and the default would ask the second for a create.
  //
  // And `tenancy: true` narrows it to the parent's GENERATED denies. The
  // parent's read rule is also every visibility rule it has — a private team
  // readable only by its members — and asked whole, each of them became a
  // tenancy rule of the child, refusing a workspace's own admin as `Outside
  // your workspaceId` (FJS-1319). Whether the caller may SEE the parent is the
  // child's own @@allow to say, as it is for a model carrying the column.
  //
  // Transitive by fixpoint — a grandchild is scoped once its parent is — and a
  // self-relation is skipped, since a model cannot delegate to itself (the SQL
  // cycle guard opens it, which would be a rule that enforces nothing).
  // `field.type.kind` is not 'relation' yet — validate() sets it, and that runs
  // after this. A belongsTo is decidable without it: a non-array field naming a
  // model, carrying the @relation(fields: [...]) half that holds the key.
  const modelNames  = new Set(schema.models.map(m => m.name))
  const belongsToOf = (model) => model.fields.flatMap(f => {
    if (f.type.array || !modelNames.has(f.type.name)) return []
    const rel = f.attributes.find(a => a.kind === 'relation' && a.fields)
    if (!rel) return []
    return [{ field: f.name, target: f.type.name }]
  })

  const scopedSet = new Set(scoped)
  const pending   = undecided.map(u => ({ ...u, rels: belongsToOf(u.model) }))

  for (const p of pending) {
    if (!p.via) continue
    const rel = p.rels.find(r => r.field === p.via)
    if (!rel) errors.push(
      `Model '${p.model.name}': @@tenant(via: ${p.via}) names no to-one relation on this model — ` +
      `it must be a field holding a @relation(fields: [...]) to the model that carries the tenant column`)
    else if (rel.target === p.model.name) errors.push(
      `Model '${p.model.name}': @@tenant(via: ${p.via}) points at itself — a model cannot be scoped through its own relation`)
  }

  const delegated = []
  for (let changed = true; changed;) {
    changed = false
    for (const p of pending) {
      if (p.done) continue
      const usable = p.rels.filter(r =>
        r.target !== p.model.name && scopedSet.has(r.target) && (!p.via || r.field === p.via))
      if (!usable.length) continue

      for (const r of usable)
        p.model.attributes.push({
          // Same four plus `post-update`, for the same reason the column rule
          // above takes it: without it a child could be re-pointed at a parent
          // in another tenant, which is the delegated spelling of the same
          // move. `claim` as the column rule carries it: without it a system
          // client with a tenant in scope dropped this deny and read every
          // tenant's children (FJS-1370).
          kind: 'deny', operations: ['read', 'update', 'delete', 'create', 'post-update'], generated: 'tenancy',
          claim, message: `Outside your ${t.column}`,
          expr: { type: 'not', expr: { type: 'check', field: r.field, operation: 'read', tenancy: true } },
        })

      p.done = true
      scopedSet.add(p.model.name)
      delegated.push(`${p.model.name} (via ${usable.map(r => r.field).join(' + ')})`)
      changed = true
    }
  }

  for (const p of pending)
    if (p.via && !p.done) errors.push(
      `Model '${p.model.name}': @@tenant(via: ${p.via}) delegates to '${p.rels.find(r => r.field === p.via)?.target ?? p.via}', ` +
      `which is not scoped to a tenant itself — give that model the '${t.column}' column, or scope it through one of its own relations`)

  if (delegated.length)
    warnings.push(
      `tenancy: ${delegated.length} model(s) carry no '${t.column}' and are scoped through a parent — ${delegated.join(', ')}.`
    )

  // Reported, never inferred. A model with no tenant column under row tenancy
  // and no scoped parent is cross-tenant data by construction, which is
  // sometimes exactly right (a plan table, a country list) and sometimes the
  // column somebody forgot. One line naming all of them beats N warnings nobody
  // reads, and `@@tenant(none)` is the way to say the first out loud.
  for (const p of pending) if (!p.done) missing.push(p.model.name)

  if (missing.length)
    warnings.push(
      `tenancy: ${missing.length} model(s) declare no '${t.column}', hold no relation to a model that does, ` +
      `and are NOT scoped to a tenant — ${missing.join(', ')}. Add the column, relate them to a scoped model, ` +
      `or mark each @@tenant(none) to say it spans tenants on purpose.`
    )

  // ── a unique that is not per tenant ──────────────────────────────────────
  //
  // The desugar above guards READS. A `@unique` guards WRITES, and nothing here
  // touched it — so on a scoped model an ordinary `slug String @unique` is
  // unique across the whole INSTALLATION: two tenants cannot both hold
  // "launch", and the second is refused by a message naming the value, which
  // tells them a row they may not read exists. That is the one thing
  // `docs/access-control.md` says a refusal must never do.
  //
  // The test is TRANSITIVE and has to be, or it fires on correct schemas. A
  // unique is per-tenant if its columns carry the tenant column OR a foreign
  // key reaching a model that is itself scoped — `[serverId, name]` is
  // per-tenant because a Server is. `scopedSet` is the fixpoint above, so a
  // grandchild resolves for free. Measured against `basecamp` before this was
  // written: 12 of its 23 name the column, 10 more reach a scoped parent, and
  // the last is a `@guarded` token that is global on purpose — so the naive
  // *must name the tenant column* rule would have reported ten correct
  // declarations and been switched off.
  //
  // **The constraint is SCOPED rather than reported, wherever that is
  // derivable** (`FJS-1159`). The tenant column is stated once, in this block,
  // and a schema FRAGMENT can never name it — `@frontierjs/orion` ships
  // `FlowCredential.name @unique`, the host adds the column with `extend model`,
  // and no edit either of them can make fixes the index. So the desugar takes
  // the uniques the way it already takes the denies and the `@default` stamp:
  // the tenant column is PREPENDED, which is also the prefix every read under
  // row tenancy filters on first.
  //
  // `@unique(global)` / `@@unique([…], global: true)` is the opt-out and it
  // already existed — the exception has had a word for longer than the default
  // has been right, which is what makes this cost no new vocabulary.
  //
  // **Only where the model carries the column itself.** `scopedSet` also holds
  // the models scoped THROUGH A PARENT, which declare no tenant column at all —
  // prepending it there emits DDL naming a column that does not exist. Those
  // keep the warning, and it is the same warning as before: which parent to
  // scope by is a choice this cannot make, since a model may have two.
  const fkColumnsOf = (model) => {
    const out = new Map()
    for (const f of model.fields) {
      if (f.type.array || !modelNames.has(f.type.name)) continue
      const rel = f.attributes.find(a => a.kind === 'relation' && a.fields)
      if (!rel) continue
      for (const col of rel.fields) out.set(col, f.type.name)
    }
    return out
  }

  const crossTenantUniques = []
  const scopedUniques      = []
  for (const model of schema.models) {
    if (!scopedSet.has(model.name)) continue
    const fks    = fkColumnsOf(model)
    const perTenant = (cols) =>
      cols.includes(t.column) || cols.some(c => scopedSet.has(fks.get(c)))
    // The model's OWN column, not the fixpoint: a delegated model is scoped and
    // has nothing to prepend.
    const carries = model.fields.some(f => f.name === t.column)

    // The table-level half first, in place. The field-level half PUSHES a table
    // constraint, and a `for…of` over an array being pushed to visits what it
    // pushed — harmless, since a rewritten one is `perTenant` and skipped, but
    // the order of `model.attributes` is what the DDL emits, so the two stay
    // separate rather than interleaved.
    for (const a of model.attributes) {
      if (a.kind !== 'uniqueIndex' && a.kind !== 'partialUnique') continue
      if (a.global || perTenant(a.fields)) continue
      if (!carries) { crossTenantUniques.push(`${model.name}([${a.fields.join(', ')}])`); continue }
      scopedUniques.push(`${model.name}([${a.fields.join(', ')}])`)
      a.fields    = [t.column, ...a.fields]
      a.generated = 'tenancy'
    }

    // The @@extensible slot index, which is the framework's own and so is
    // rewritten rather than warned about: every read under row tenancy filters
    // on the tenant first, and a composite that does not lead with it is one
    // SQLite cannot seek into on the column it always has.
    if (carries) for (const a of model.attributes) {
      if (a.kind === 'index' && a.generated === 'extensible' && a.fields[0] !== t.column)
        a.fields = [t.column, ...a.fields]
    }

    const lifted = []
    for (const f of model.fields) {
      const u = f.attributes.find(a => a.kind === 'unique')
      if (!u || u.global || perTenant([f.name])) continue
      if (!carries) { crossTenantUniques.push(`${model.name}.${f.name}`); continue }
      scopedUniques.push(`${model.name}.${f.name}`)
      f.attributes.splice(f.attributes.indexOf(u), 1)
      lifted.push({
        kind: 'uniqueIndex', fields: [t.column, f.name], global: false, generated: 'tenancy',
        // A single `@unique` over an optional column is legal and two NULLs are
        // distinct to it; a COMPOSITE naming one is a parse error unless the
        // schema says it meant that. The rewrite must not change what the
        // author declared, so it says it for them.
        nullsDistinct: f.type.optional === true,
      })
    }
    model.attributes.push(...lifted)
  }

  // Said out loud, because `name String @unique` in a fragment now builds an
  // index over two columns and the line itself cannot show it. `ddl.snapshot.sql`
  // is where the result is readable.
  if (scopedUniques.length)
    warnings.push(
      `tenancy: ${scopedUniques.length} unique constraint(s) are scoped per tenant — ${scopedUniques.join(', ')}. ` +
      `Each builds a UNIQUE over '${t.column}' and the columns declared, so two tenants may hold the same value ` +
      `and one tenant may not hold it twice. Mark one global (@unique(global) / @@unique([…], global: true)) to ` +
      `keep it unique across the whole installation.`
    )

  if (crossTenantUniques.length)
    warnings.push(
      `tenancy: ${crossTenantUniques.length} unique constraint(s) on models scoped through a PARENT are unique ` +
      `across ALL tenants — ${crossTenantUniques.join(', ')}. These carry no '${t.column}' of their own, and which ` +
      `parent to scope by is not decidable here — a model may have two. Two tenants cannot hold the same value, ` +
      `and the refusal names it to the second. Add a key reaching a scoped model to the constraint, give the model ` +
      `the '${t.column}' column, or mark it global (@unique(global) / @@unique([…], global: true)).`
    )

  if (!scoped.length)
    warnings.push(`tenancy: strategy row scopes nothing — no model declares a '${t.column}' field`)

  return { errors, warnings }
}

// ── @edge / @scoped normalization ──────────────────────────────────────────────
// Resolve every @edge / @scoped attribute into a single canonical descriptor:
//   { kind:'edge', ref, key, as, onMissing, auth }
// with defaults filled — key = <ref>Id, as = <ref>Edge (or 'mine' for @scoped),
// onMissing = 'error'. @scoped resolves ref to the @@auth model. The resolved
// descriptor replaces the raw attribute in place and is also stashed as field.edge
// for downstream (DDL / client) lookups. Returns an array of error strings.
// ─── @@extensible ─────────────────────────────────────────────────────────────
//
// `max:` expands into exactly what an app writes by hand today: a mirror column
// the application fills, one `@generated` column per slot reading it, and ONE
// composite index over the pool. Expansion rather than a new path through the
// DDL writer, so every downstream reader — migrations, `ddl.snapshot.sql`,
// introspect, the JSON Schema, the access snapshot — sees ordinary columns and
// has nothing to learn.
//
// It also removes the defect the hand-written version has by construction: the
// allocation order and the index column order were two lists that had to agree
// and did not, which costs a two-term segment its second column with nothing
// failing. Here they are one list, built once.
//
// ── The order is a BET, and it is the app's rather than this function's ──
//
// A composite is read left to right, so which slots sit at the front decides
// which segments reach the index. Measured at 20,000 rows over three orderings
// and six field mixes, the total index columns reached was **13 for all three**
// — the trade is conserved, there is no ordering that is better, only orderings
// that are better for different mixes. So the only honest input is the ratio the
// app itself declared: `max: { text: 8, number: 4 }` is 2:1, and the pool is
// laid down two text per number. An app that expects mostly text says so and
// gets a run of text at the front.
const SLOT_AFFINITY = { text: 'String', number: 'Float', boolean: 'Boolean' }

function expandExtensible(schema) {
  const errors = []

  for (const model of schema.models) {
    for (const ext of model.attributes.filter(a => a.kind === 'extensible')) {
      if (!ext.max) continue

      const decl     = schema.models.find(m => m.name === ext.declaredBy)
      const typeName = decl?.fields.find(f => f.name === 'type')?.type.name
      const members  = schema.enums.find(e => e.name === typeName)?.values.map(v => v.name) ?? []
      if (!members.length) continue   // already refused in validate()

      // The mirror. `@system` because the application derives it from the blob:
      // a caller naming it could put a value in a slot the declarations do not
      // point at, which every segment would then match on.
      const mirror = `${ext.column}Slots`
      if (!model.fields.some(f => f.name === mirror)) {
        model.fields.push({
          name: mirror,
          type: { kind: 'scalar', name: 'Json', array: false, optional: false },
          attributes: [
            { kind: 'default', value: { kind: 'string', value: '{}' }, generated: 'extensible' },
            { kind: 'system', generated: 'extensible' },
          ],
          comments: [], generated: 'extensible',
        })
      }

      // One queue per kind, in the order the enum declares them, then drained
      // by the declared ratio so the front of the index matches the mix the app
      // said it expects.
      const queues = {}
      for (const kind of members) {
        const n = ext.max[kind] ?? 0
        const p = kind.slice(0, 1)
        queues[kind] = Array.from({ length: n }, (_, i) => `${p}${i + 1}`)
      }
      const total = Object.values(queues).reduce((a, q) => a + q.length, 0)
      const unit  = Object.fromEntries(members.map(k =>
        [k, Math.max(1, Math.round((ext.max[k] ?? 0) / Math.min(...members.map(m2 => ext.max[m2] || Infinity))))]))

      const order = []
      while (order.length < total) {
        let moved = false
        for (const kind of members) {
          for (let i = 0; i < unit[kind]; i++) {
            const slot = queues[kind]?.shift()
            if (!slot) break
            order.push([slot, kind]); moved = true
          }
        }
        if (!moved) break
      }

      for (const [slot, kind] of order) {
        if (model.fields.some(f => f.name === slot)) {
          errors.push(`Model '${model.name}': @@extensible(max: …) needs the column '${slot}' and this model already declares one. Rename it — the pool's names are taken from the declaring model's own type enum`)
          continue
        }
        model.fields.push({
          name: slot,
          type: { kind: 'scalar', name: SLOT_AFFINITY[kind] ?? 'String', array: false, optional: true },
          attributes: [{ kind: 'generated', expr: `json_extract("${mirror}", '$.${slot}')`, stored: false, generated: 'extensible' }],
          // The kind is stamped rather than read back off the name. `n1` is a
          // number because the enum member `number` begins with an `n`, which
          // is a fact about the expansion and not about the column, so every
          // reader that re-derived it from the prefix was one rename away from
          // coercing a value into the wrong affinity in silence.
          comments: [], generated: 'extensible', extKind: kind,
        })
      }

      // ONE composite. Several single-column indexes measured 139 ms on a
      // three-term segment against the composite's 2.7 ms: SQLite picks one
      // index and filters the rest, which is the same sentence that sinks the
      // pivot-table designs this pool replaces.
      if (order.length)
        model.attributes.push({ kind: 'index', fields: order.map(([s]) => s), sorts: null, where: null, generated: 'extensible' })
    }
  }

  return errors
}

// ─── @@relator expansion ─────────────────────────────────────────────
//
// The declaration is the origin and every constraint derives from it here, so
// the DDL emitter, the migrator and `advise` are untouched by the word — they
// go on reading `uniqueIndex` and `index` nodes, which is what keeps this from
// being a label that drifts from what the table actually holds.
//
// TWO facts come out of the word and only one of them is the unique.
// `FJS-413` found ten unindexed foreign keys in basecamp, four on cascading
// join tables, and the workaround was identical every time: a composite that
// leads with the other side leaves this side with no index to use. @@unique
// cannot know that both ends of the pair are read from. A relator, by
// definition, does — so the reverse index is emitted rather than remembered.
//
// Which relata need one falls out of prefix matching: `once` and `many: col`
// both emit a unique LEADING with the first relatum, so only the trailing ones
// are uncovered. A bare `many` emits no unique at all, so every relatum is.
function expandRelator(schema) {
  const errors = []
  const same   = (x, y) => x.length === y.length && x.every((v, i) => v === y[i])

  for (const model of schema.models) {
    const declared = model.attributes.filter(a => a.kind === 'relator')
    if (!declared.length) continue

    // A second @@relator is reported by the generic non-repeatable-attribute
    // check, which owns that sentence for every attribute. The first is the one
    // in force there, so it is the one expanded here.
    const a    = declared[0]
    const shown = `@@relator([${a.fields.join(', ')}], ${a.repeat}${a.discriminator ? `: ${a.discriminator}` : ''})`
    const fieldNamed = (n) => model.fields.find(f => f.name === n)

    // The relation attribute that OWNS a column, which is what makes the column
    // a relatum rather than an ordinary Int beside one.
    const relationOf = (col) => {
      for (const f of model.fields) {
        const rel = f.attributes.find(at => at.kind === 'relation' && Array.isArray(at.fields) && at.fields.includes(col))
        if (rel) return { field: f, rel }
      }
      return null
    }

    if (a.fields.length < 2) {
      errors.push(
        `Model '${model.name}': ${shown} names ${a.fields.length === 1 ? 'one relatum' : 'none'} — a relator ` +
        `mediates at least two things. With one there is no relationship, only a foreign key`)
      continue
    }

    const seen  = new Set()
    const dupes = a.fields.filter(n => seen.size === seen.add(n).size)
    if (dupes.length) {
      errors.push(
        `Model '${model.name}': ${shown} names ${[...new Set(dupes)].map(n => `'${n}'`).join(', ')} more than once`)
      continue
    }

    // An unknown member is already reported by the generic model-attribute
    // field-ref check, which covers every @@attr carrying a `fields` array.
    // Skip rather than restate it — and skip so the tests below do not also
    // report a column that is not there.
    if (a.fields.some(n => !fieldNamed(n))) continue

    // Every relatum is a foreign key column, and they cover at least two
    // DISTINCT relations. The count is over relations and not over columns
    // because a composite foreign key is two columns naming ONE thing, and a
    // row that mediates one thing is not mediating.
    const notForeign = a.fields.filter(n => !relationOf(n))
    if (notForeign.length) {
      errors.push(
        `Model '${model.name}': ${shown} names ${notForeign.map(n => `'${n}'`).join(', ')}, which ` +
        `${notForeign.length > 1 ? 'are not foreign key columns' : 'is not a foreign key column'} — a relatum is ` +
        `something this row relates, so it is named by a @relation. A column that tells two of these apart is ` +
        `'many: <column>'`)
      continue
    }

    const relata = new Set(a.fields.map(n => relationOf(n).field.name))
    if (relata.size < 2) {
      errors.push(
        `Model '${model.name}': ${shown} names ${a.fields.length} columns but they all belong to one relation ` +
        `('${[...relata][0]}') — a composite foreign key is two columns naming one thing. A relator mediates two`)
      continue
    }

    // A relator is existentially dependent on its relata, so a missing one
    // makes the row incoherent rather than partial. Cascade and Restrict both
    // pass: they honor the dependence and differ only on who wins when a
    // relatum leaves. SetNull denies it outright.
    for (const n of a.fields) {
      const { field, rel } = relationOf(n)
      // SetNull REQUIRES a nullable column, so the two tests are one mistake
      // seen from two sides. Report the cause and stay quiet about the symptom.
      if (rel.onDelete === 'SetNull') {
        errors.push(
          `Model '${model.name}': ${shown} names '${n}', whose relation '${field.name}' is onDelete: SetNull — ` +
          `that says the row outlives the thing it relates, which a relator cannot. Cascade ends it with the ` +
          `relatum; Restrict keeps the relatum while it lives`)
        continue
      }
      if (fieldNamed(n).type.optional)
        errors.push(
          `Model '${model.name}': ${shown} names '${n}', which is optional — a relator with a missing relatum ` +
          `is not a relationship that lost a participant, it is a row that never meant anything. Make it required, ` +
          `or this model is a reference wearing the silhouette`)
    }

    if (a.discriminator) {
      const d = fieldNamed(a.discriminator)
      if (!d)
        errors.push(
          `Model '${model.name}': ${shown} — '${a.discriminator}' is not a column on this model`)
      else if (a.fields.includes(a.discriminator))
        errors.push(
          `Model '${model.name}': ${shown} — '${a.discriminator}' is already a relatum, so it cannot also be ` +
          `what tells two of these apart`)
      else if (d.type.optional)
        errors.push(
          `Model '${model.name}': ${shown} — '${a.discriminator}' is optional, and two NULLs never compare ` +
          `equal, so the rows that leave it unset would be unconstrained. Make it required`)
      else if (d.attributes.some(at => ['computed', 'from', 'derived', 'transient', 'edge', 'relation'].includes(at.kind)))
        errors.push(
          `Model '${model.name}': ${shown} — '${a.discriminator}' has no column, so nothing can be told apart by it`)
    }

    if (errors.length && errors[errors.length - 1].startsWith(`Model '${model.name}': ${shown}`)) continue

    // ── emit ──
    const keyed = a.repeat === 'once' || Boolean(a.discriminator)
    const cols  = a.discriminator ? [...a.fields, a.discriminator] : a.fields

    // A composite primary key over exactly these columns already IS the key, and
    // it is the stronger statement. This is what `litestone edge eject` writes:
    // a side table keys its two dimensions with `@id` on each, which makes an
    // edge class-1 by construction. Emitting a UNIQUE beside it would be a
    // second b-tree over the primary key. The reverse index below still lands,
    // because a composite key is prefix-matched and an ejected model has never
    // had one on its trailing dimension.
    const pkCols = model.attributes.find(at => at.kind === 'id')?.fields
      ?? model.fields.filter(f => f.attributes.some(at => at.kind === 'id')).map(f => f.name)
    const keyIsPrimary = pkCols.length > 1 && same(pkCols, cols)

    if (keyed && !keyIsPrimary) {
      const clash = model.attributes.find(
        at => (at.kind === 'uniqueIndex' || at.kind === 'partialUnique') && same(at.fields, cols))
      if (clash)
        errors.push(
          `Model '${model.name}': ${shown} and @@unique([${cols.join(', ')}]) are the same constraint written ` +
          `twice — delete the @@unique, the relator emits it`)
      else
        model.attributes.push({ kind: 'uniqueIndex', fields: cols, nullsDistinct: false, global: false, generated: 'relator' })
    }

    const uncovered = keyed ? a.fields.slice(1) : a.fields
    for (const col of uncovered) {
      // An index this model declares that LEADS with the column is already the
      // reverse index and is doing more besides — `@@index([variantId,
      // expiresAt])` answers the availability sum AND the cascade walk, and an
      // index is prefix-matched. Emitting `([variantId])` beside it would be a
      // dead b-tree written on every row, which is the cost this word exists to
      // stop paying, arriving from the other direction.
      const covered = model.attributes.some(
        at => at.kind === 'index' && !at.where && at.generated !== 'relator' &&
              at.fields.length > 1 && at.fields[0] === col)
      if (covered) continue

      // An EXACT copy is different: it is the hand-written version of what the
      // declaration emits, and leaving both is the drift the word is here to
      // prevent.
      const clash = model.attributes.find(
        at => at.kind === 'index' && !at.where && !at.sorts && same(at.fields, [col]))
      if (clash)
        errors.push(
          `Model '${model.name}': ${shown} already indexes '${col}' — both ends of a relator are entrances, so ` +
          `the reverse index is emitted rather than written by hand (\`FJS-413\`). Delete the @@index([${col}])`)
      else
        model.attributes.push({ kind: 'index', fields: [col], sorts: null, where: null, generated: 'relator' })
    }

    // An @@index that a generated unique already answers. SQLite prefix-matches
    // an index, so @@index([workspaceId, userId]) beside UNIQUE(workspaceId,
    // userId) is a second b-tree maintained on every write and read by nothing.
    if (keyed) {
      for (const at of model.attributes) {
        if (at.kind !== 'index' || at.where || at.sorts || at.generated === 'relator') continue
        if (at.fields.length > cols.length) continue
        if (!at.fields.every((f, i) => f === cols[i])) continue
        errors.push(
          `Model '${model.name}': ${shown} emits UNIQUE(${cols.join(', ')}), and an index is prefix-matched, so ` +
          `@@index([${at.fields.join(', ')}]) is a second b-tree written on every row and read by nothing. Delete it`)
      }
    }
  }

  return errors
}

function expandEdgeAttributes(schema) {
  const errors = []
  const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1)
  const authModel  = schema.models.find(m => m.attributes.some(a => a.kind === 'auth'))
  const modelNames = new Set(schema.models.map(m => m.name))

  for (const model of schema.models) {
    // ── normalize every @edge / @scoped on this model ──
    const resolvedEdges = []
    for (const field of model.fields) {
      const raw = field.attributes.find(a => a.kind === 'edge' || a.kind === 'scoped')
      if (!raw) continue
      const isScoped = raw.kind === 'scoped'

      let ref = raw.ref
      if (isScoped) {
        if (!authModel) {
          errors.push(`Model '${model.name}', field '${field.name}': @scoped requires a model marked @@auth`)
          continue
        }
        ref = authModel.name
      }
      if (!ref || !modelNames.has(ref)) {
        errors.push(`Model '${model.name}', field '${field.name}': @edge(ref: …) references unknown model '${ref ?? ''}'`)
        continue
      }

      const key       = raw.key ?? `${lowerFirst(ref)}Id`
      const as        = raw.as  ?? (isScoped ? 'mine' : `${lowerFirst(ref)}Edge`)
      const onMissing = raw.onMissing ?? 'error'
      if (onMissing !== 'error' && onMissing !== 'skip')
        errors.push(`Model '${model.name}', field '${field.name}': @edge onMissing must be 'error' or 'skip', got '${onMissing}'`)

      const resolved = { kind: 'edge', ref, key, as, onMissing, auth: isScoped }
      field.attributes[field.attributes.indexOf(raw)] = resolved
      field.edge = resolved
      resolvedEdges.push({ field, ...resolved })
    }
    if (!resolvedEdges.length) continue

    // ── guardrails (D2 / D6 / D7 / D10 / D11) ──
    // Physical columns of the host (for key collisions).
    const colNames = new Set(model.fields.filter(f =>
      f.type.kind !== 'relation' && f.type.kind !== 'implicitM2M' &&
      !f.attributes.some(a => a.kind === 'edge' || a.kind === 'computed' || a.kind === 'from')
    ).map(f => f.name))
    // Ref models the host has a belongsTo (FK-owning @relation) to.
    const belongsToTargets = model.fields
      .filter(f => f.attributes.some(a => a.kind === 'relation' && a.fields))
      .map(f => f.type.name)
    const fieldNames = new Set(model.fields.map(f => f.name))
    const asToDim = new Map()   // as → "ref|key"
    const dimToAs = new Map()   // "ref|key" → as

    for (const e of resolvedEdges) {
      // D2 — a non-auth @edge pointed at a belongsTo ref is degenerate (single ref → just a column).
      if (!e.auth && belongsToTargets.includes(e.ref))
        errors.push(`Model '${model.name}', field '${e.field.name}': @edge(ref: ${e.ref}) points at a belongsTo relation — this row has a single ${e.ref}, so use a plain column, not an edge.`)
      // D6 — a non-auth derived/explicit key must not shadow an existing column.
      if (!e.auth && colNames.has(e.key))
        errors.push(`Model '${model.name}', field '${e.field.name}': @edge key '${e.key}' collides with an existing column — set an explicit key: on the edge.`)
      // D7 — the namespace must not collide with a field or relation name.
      if (fieldNames.has(e.as))
        errors.push(`Model '${model.name}', field '${e.field.name}': @edge namespace '${e.as}' collides with a field or relation — set an explicit as: on the edge.`)
      // D10 / D11 — namespace ⟺ (ref, key) must be a bijection among a model's edges.
      const dim = `${e.ref}|${e.key}`
      if (asToDim.has(e.as) && asToDim.get(e.as) !== dim)
        errors.push(`Model '${model.name}': edge namespace '${e.as}' maps to two dimensions — fields sharing an 'as' must share the same ref and key (D11).`)
      if (dimToAs.has(dim) && dimToAs.get(dim) !== e.as)
        errors.push(`Model '${model.name}': two edges to '${e.ref}' via key '${e.key}' use different namespaces — give the second a distinct key, or share one 'as' (D10).`)
      asToDim.set(e.as, dim)
      dimToAs.set(dim, e.as)
    }
  }
  return errors
}

// ─── Transition resolution ────────────────────────────────────────────────────
// `enum Status { transitions { ... } }` is the shorthand for "these rules apply
// wherever this enum is used". It desugars here into a @@transitions attribute
// on every model that has a field of that type, so from this point on the model
// attribute is the only representation — one enforcement path, one thing in the
// JSON Schema, and gates have a model-scoped place to hang.
//
// An explicit @@transitions on the same field wins outright rather than merging:
// a model narrowing the shared machine to two moves means two moves, not two
// plus whatever the enum declared.
//
// Runs before validate(), which is where field.type.kind is resolved to 'enum' —
// so match on the type *name* here, not the kind.

function resolveTransitions(schema) {
  const enumTransitions = new Map()
  for (const e of schema.enums ?? [])
    if (e.transitions) enumTransitions.set(e.name, e.transitions)
  if (!enumTransitions.size) return

  for (const model of schema.models) {
    const declared = new Set(
      model.attributes.filter(a => a.kind === 'transitions').map(a => a.field)
    )
    for (const field of model.fields) {
      if (field.type.kind === 'relation' || field.type.kind === 'implicitM2M') continue
      if (declared.has(field.name)) continue
      const shared = enumTransitions.get(field.type.name)
      if (!shared) continue

      model.attributes.push({
        kind:  'transitions',
        field: field.name,
        // The enum form carries no gates — a gate is a model concern.
        transitions: Object.fromEntries(
          Object.entries(shared).map(([name, { from, to }]) => [name, { from: [...from], to, gate: null }])
        ),
        fromEnum: field.type.name,   // provenance, for error messages
      })
      declared.add(field.name)
    }
  }
}

const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1)

/**
 * How a `@from(Target, …)` on `model` correlates its subquery to the outer row.
 *
 * The ONE owner of that rule: `validate()` rejects an `@from` this cannot
 * resolve, and `buildFromMap()` in client.js builds the subquery from what it
 * returns. They used to be one inline block in the SQL builder guarded by
 * `if (!fkCol) continue  // validation catches this` — validation did not, so a
 * derived field with no relation behind it was silently absent from every row.
 *
 * Returns `{ fkCols, refCols }` — the FK columns on the target table and the
 * columns they reference on `model`, index-aligned — or `null` when no relation
 * joins them. ARRAYS, because a composite key correlated on its first column
 * alone answers a count of every row sharing that column: plausible, real, and
 * an answer to a question nobody asked (`FJS-377`).
 */
export function inferFromFk(model, targetModel, via = null) {
  const idField = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'

  // Every field on the target whose type is this model and which owns the FK.
  // More than one is not exotic — sender/recipient both point at User, and a
  // self-relational model offers parent and children before an app writes
  // anything unusual. Picking the first silently is the failure this collects
  // for: the count that comes back is plausible and answers the other question.
  const candidates = []
  for (const f of targetModel.fields) {
    if (f.type.name !== model.name) continue
    const rel = f.attributes.find(a => a.kind === 'relation' && a.fields)
    if (!rel) continue
    const fkCols  = Array.isArray(rel.fields) ? rel.fields : [rel.fields]
    // Relations may reference a non-PK @unique column, so read it rather than
    // assuming the primary key.
    const refCols = rel.references
      ? (Array.isArray(rel.references) ? rel.references : [rel.references])
      : [idField]
    candidates.push({ field: f.name, name: rel.name ?? null, fkCols, refCols })
  }

  if (via) {
    // `via` may name the field on the target (`sender`), its FK column
    // (`senderId`), the @relation name, or the field on THIS model (`sent`) —
    // which reaches the target through the relation name they share.
    const own     = model.fields.find(f => f.name === via && f.type.name === targetModel.name)
    const ownName = own?.attributes.find(a => a.kind === 'relation')?.name ?? null
    const hit = candidates.find(c =>
      c.field === via || c.fkCols.includes(via) || (c.name && c.name === via) ||
      (ownName && c.name === ownName))
    return hit
      ? { fkCols: hit.fkCols, refCols: hit.refCols }
      : { unresolvedVia: via, candidates }
  }

  if (candidates.length > 1) return { ambiguous: candidates }
  if (candidates.length === 1) return { fkCols: candidates[0].fkCols, refCols: candidates[0].refCols }

  // Fallback: a column named after the model, e.g. Account → AccountId.
  const fallback = targetModel.fields.find(f => f.name === `${model.name}Id`)
  return fallback ? { fkCols: [fallback.name], refCols: [idField] } : null
}

// Why this field cannot be a model's display column, or null if it can.
//
// Deliberately looser than sierra's own eight-name scan in one respect and
// tighter in another. Looser: a `readOnly` column is fine here — a `@generated`
// full name is the CASE this attribute exists for, and the scan skips every
// readOnly column because it cannot tell a computed caption from a server-set
// flag. Tighter: the scan takes the first plain string it finds and this
// refuses anything a picker would render as a lie.
function labelFieldRefusal(field, schema) {
  const isEnum  = schema.enums.some(e => e.name === field.type.name)
  const isModel = schema.models.some(m => m.name === field.type.name)
  const has     = (kind) => field.attributes?.some(a => a.kind === kind)

  if (isModel)         return `'${field.name}' is a relation — a picker prints a value, and a row is not one. Name the column on the related model instead`
  if (field.type.array) return `'${field.name}' is an array`
  if (isEnum)          return `'${field.name}' is an enum — its members carry their own labels through @label, so a picker over this model still needs free text to show`
  if (field.type.name !== 'String')
    return `'${field.name}' is ${field.type.name}, and a display column is String. Compose one with @generated(\`{${field.name}}\`)`

  // Not a column, or not one SQLite can order and match — the options query
  // does both. A @computed field is a JS function over a fetched row.
  if (has('computed'))  return `'${field.name}' is @computed — it has no column, so it can be neither sorted nor searched`
  if (has('transient')) return `'${field.name}' is @transient — it is never read back`

  // Readable by nobody, or readable as ciphertext. Either way the picker shows
  // the id fallback for every row, per caller, with nothing saying so.
  if (has('guarded'))   return `'${field.name}' is @guarded — only a system context can read it`
  if (has('encrypted')) return `'${field.name}' is @encrypted — its stored text is a ciphertext, so it neither sorts nor matches as the value`
  if (has('hashed'))    return `'${field.name}' is @hashed — it is one-way and never readable`
  if (field.attributes?.some(a => a.kind === 'omit' && a.level === 'all'))
    return `'${field.name}' is @omit(all) — it is stripped from every read`

  return null
}

// Why this field cannot be the column a record STORES for a value set.
// The same question `labelFieldRefusal` asks about a display column, on the
// other axis: that one has to be readable text, this one has to be a value
// SQLite can compare — every check the strength performs is an equality against
// this column, and every stored record is one of these values forever.
function valueColumnRefusal(field, schema) {
  const has = (kind) => field.attributes?.some(a => a.kind === kind)

  if (schema.models.some(m => m.name === field.type.name)) return `it is a relation, not a value`
  if (field.type.array)  return `it is an array`
  if (has('computed'))   return `it is @computed — no column, so nothing can be matched against it`
  if (has('transient'))  return `it is @transient — it is never stored`
  if (has('guarded'))    return `it is @guarded — a caller can neither read nor write it, so no caller could ever supply a legal value`
  if (has('encrypted'))  return `it is @encrypted — its stored text is a ciphertext, so an equality against it is not an equality against the value`
  if (has('hashed'))     return `it is @hashed — one-way, so a set built on it can never be offered`
  return null
}

// The same shape one column along, and a separate function because the two
// questions differ: a value column is matched for EQUALITY, an order column is
// compared for SEQUENCE. A Json or File column is a legal value and a
// meaningless sort, and @encrypted fails both for different reasons — its
// ciphertext is neither the value nor its order.
function orderColumnRefusal(field, schema) {
  const has = (kind) => field.attributes?.some(a => a.kind === kind)

  if (schema.models.some(m => m.name === field.type.name)) return `it is a relation, not a column`
  if (field.type.array)  return `it is an array`
  if (has('computed'))   return `it is @computed — no column, so there is nothing for the database to sort by`
  if (has('transient'))  return `it is @transient — it is never stored`
  if (has('guarded'))    return `it is @guarded — the Data boundary refuses an orderBy naming it, so the picker's list would fail to load`
  if (has('encrypted'))  return `it is @encrypted — it sorts by ciphertext, which is not the order of the values`
  if (has('hashed'))     return `it is @hashed — one-way, so its order is not the values' order`
  if (field.type.name === 'Json') return `it is Json — its text sorts, its structure does not`
  if (field.type.name === 'File') return `it is File — the column holds a storage reference, so its order is the order things were stored under`
  return null
}

// ─── @default([…]) elements ───────────────────────────────────────────────────
//
// Every element is graded against the column's own base type, which is the half
// the older JSON-string spelling never had: `String[] @default("[1,2]")` is a
// valid JSON array and was accepted, and the numbers reached the column.
//
// An enum element is written as a bare member — `@default([Active])`, the same
// way a scalar enum default is — and is resolved here for the same reason it is
// resolved there: the parser cannot know the field's enum until the schema is
// whole. Anything the element cannot be is refused by name rather than emitted.
function elementErrors(where, field, values, enumNames, schema) {
  const errors = []
  const base   = field.type.name

  if (base === 'File') {
    if (values.length) errors.push(
      `${where}: a File column has no default — a file reference is minted when the bytes are stored, ` +
      `so a literal here names a file nothing put there. @default([]) is the only one it can hold.`)
    return errors
  }

  const isEnum = enumNames.has(base)
  const values_ = isEnum ? (schema.enums.find(e => e.name === base)?.values ?? []).map(v => v.name) : null

  for (const el of values) {
    if (el.kind === 'unsupported') {
      errors.push(`${where}: @default holds ${JSON.stringify(el.value)}, which is not a value a ${base} column can take`)
      continue
    }

    if (isEnum) {
      // A bare member in the literal, or the same member as a string — which is
      // all the JSON spelling can write, since JSON has no bare words.
      const member = el.kind === 'fieldRef' ? el.field : el.kind === 'string' ? el.value : null
      if (member === null) {
        errors.push(
          `${where}: @default([${el.value}]) — an enum element is a member of ${base}, ` +
          `like @default([${values_[0] ?? 'Value'}]).`)
      } else if (!values_.includes(member)) {
        errors.push(
          `${where}: @default([${member}]) — '${member}' is not a value of enum ${base}. ` +
          `One of ${values_.join(', ')}.`)
      } else {
        el.kind  = 'enum'
        el.value = member
        delete el.field
      }
      continue
    }

    if (el.kind === 'fieldRef') {
      errors.push(
        `${where}: @default([${el.field}]) — a bare word in an array is an enum member, and ${base} is not an enum. ` +
        `Quote it: @default(["${el.field}"]).`)
      continue
    }

    if (base === 'String' && el.kind !== 'string') {
      errors.push(`${where}: @default holds ${el.value}, and the column is String[]. Quote it, or change the column.`)
    } else if (base === 'Int' && (el.kind !== 'number' || !Number.isInteger(el.value))) {
      errors.push(`${where}: @default holds ${JSON.stringify(el.value)}, and the column is Int[].`)
    }
  }

  return errors
}

function validate(schema) {
  const errors   = []
  const warnings = []

  const enumNames  = new Set(schema.enums.map(e => e.name))
  const modelNames = new Set(schema.models.map(m => m.name))
  const allTypes   = new Set([...SCALAR_TYPES, ...enumNames])

  for (const model of schema.models) {
    // Collect all field names first so @relation can reference fields declared later
    const fieldNames = new Set(model.fields.map(f => f.name))
    const seen = new Set()

    for (const field of model.fields) {
      if (seen.has(field.name))
        errors.push(`Model '${model.name}': duplicate field '${field.name}'`)
      seen.add(field.name)

      // Resolve @default(bareIdent) — could be enum value or field reference
      // If it matches an enum value name → reclassify as 'enum'
      // If it matches a sibling field name → keep as 'fieldRef'
      // Otherwise → validation error
      const defAttr = field.attributes.find(a => a.kind === 'default')
      if (defAttr?.value?.kind === 'fieldRef') {
        const refName = defAttr.value.field
        // Check if it's an enum value on this field's type
        const fieldEnum = schema.enums.find(e => e.name === field.type.name)
        if (fieldEnum && fieldEnum.values.some(v => v.name === refName)) {
          defAttr.value = { kind: 'enum', value: refName }
        } else if (!fieldNames.has(refName)) {
          errors.push(`Model '${model.name}', field '${field.name}': @default(${refName}) — '${refName}' is not a field or enum value`)
        }
        // else: it's a valid field reference — keep as 'fieldRef'
      }

      // Validate type references — scalars/enums for regular fields, model name for relation fields
      const isRelationField  = field.attributes.some(a => a.kind === 'relation')
      // A name-only @relation("label") on an ARRAY field is still an implicit
      // m2m candidate — the label pairs it with its mirror. Only fields: [...]
      // makes it a belongsTo FK side.
      const _relHasFields    = field.attributes.some(a => a.kind === 'relation' && a.fields)
      const isImplicitM2M    = field.type.array && modelNames.has(field.type.name) && !_relHasFields
      const isFromField      = field.attributes.some(a => a.kind === 'from')
      // The non-owning side of a one-to-one: `b B?` where B holds the FK. It
      // carries no @relation and no column, exactly like the plural hasMany
      // back-reference above, and is paired the same way below. Without this it
      // failed the type check and was reported as `unknown type 'B'` for a model
      // that is registered, which sends the reader hunting a missing model
      // (FJS-563).
      const isBackRefOne = !field.type.array && modelNames.has(field.type.name)
        && !isRelationField && !isFromField
      const validType = allTypes.has(field.type.name)
        || (isRelationField && modelNames.has(field.type.name))
        || isImplicitM2M
        || isBackRefOne
        || (isFromField && modelNames.has(field.type.name))  // @from last/first return model objects
      if (!validType)
        errors.push(`Model '${model.name}', field '${field.name}': unknown type '${field.type.name}'`)
      if (isRelationField) field.type.kind = 'relation'
      if (isImplicitM2M)   field.type.kind = 'implicitM2M'   // wins over name-only @relation
      if (isBackRefOne)    field.type.kind = 'backRefOne'

      // Fix up scalar vs enum kind now that we know all enum names
      if (enumNames.has(field.type.name)) field.type.kind = 'enum'

      // Validate relation references
      const rel = field.attributes.find(a => a.kind === 'relation')
      if (rel) {
        if (!modelNames.has(field.type.name))
          errors.push(`Model '${model.name}', field '${field.name}': @relation references unknown model '${field.type.name}'`)
        if (rel.fields) {
          for (const f of rel.fields) {
            if (!fieldNames.has(f))
              errors.push(`Model '${model.name}': @relation fields references unknown field '${f}'`)
          }
        }
        if (rel.onDelete && !ON_DELETE_ACTIONS.has(rel.onDelete))
          errors.push(`Model '${model.name}': unknown onDelete action '${rel.onDelete}'`)
      }

      // A relation field is not stored, so a field-level @allow/@deny over it has
      // nothing to compile to: the write half is the WHEN of a CASE over a column,
      // and the read half strips a key the row never carried. Both were accepted
      // and both did nothing, one line from the spelling that works — the same
      // predicate on the FK guards the direct write AND the `{ rel: { connect } }`
      // form. A @derived field is NOT this case and is left alone: it rides the
      // SELECT as an expression, so the read strip reaches it.
      // A @capability on a model that does not carry @@capabilities is a
      // declaration that means nothing: the switch is what says this model is
      // graded that way at all, so without it the column is guarded by the gate
      // and the policies exactly as before and the attribute reads as
      // protection nobody applied.
      if (field.attributes.some(a => a.kind === 'capability') &&
          !model.attributes.some(a => a.kind === 'capabilities'))
        errors.push(
          `Model '${model.name}', field '${field.name}': @capability, but '${model.name}' does not ` +
          `declare @@capabilities — the column tier is opt-in ON TOP of the model's own switch. ` +
          `Add @@capabilities to ${model.name}, or drop @capability.`)

      // Three shapes that make @capability contradict its neighbor, refused for
      // the reason @system beside a field @allow('write') is: one says the
      // application fills this column and the other says a granted caller may.
      //
      // The stamp is the one that bites hardest and it is silent in the worst
      // direction — the write check reads the payload AFTER the create path
      // applies @default(auth().x), so the stamp refuses itself and the MODEL
      // becomes uncreatable for everyone who does not hold the column's grant,
      // naming a column the caller never sent. Measured.
      if (field.attributes.some(a => a.kind === 'capability')) {
        const authDefault = field.attributes.find(a =>
          a.kind === 'default' && a.value?.kind === 'call' && a.value.fn === 'auth')
        const notWritable = field.attributes.find(a =>
          a.kind === 'computed' || a.kind === 'generated' || a.kind === 'derived' ||
          a.kind === 'from' || a.kind === 'funcCall')
        const lockedShut  = field.attributes.find(a =>
          a.kind === 'guarded' || a.kind === 'system' || a.kind === 'secret')

        if (authDefault) errors.push(
          `Model '${model.name}', field '${field.name}': @capability with @default(auth().${authDefault.value.field ?? 'id'}) — ` +
          `the stamp writes this column on every create, and the capability says a caller needs a grant to write it. ` +
          `The stamp would be refused for every caller who does not hold '${model.name}.${field.name}', which makes ` +
          `${model.name} uncreatable rather than the column protected. Keep the stamp, or keep the capability.`)

        if (notWritable) errors.push(
          `Model '${model.name}', field '${field.name}': @capability on a @${notWritable.kind} field — ` +
          `it is not a column anyone writes, so there is no write for a capability to grade.`)

        if (lockedShut) errors.push(
          `Model '${model.name}', field '${field.name}': @capability with @${lockedShut.kind} — ` +
          `@${lockedShut.kind} says no caller writes this column at any standing, and @capability says a caller ` +
          `holding '${model.name}.${field.name}' does. Only one of them can be true.`)

        if (field.type.kind === 'relation' || field.type.kind === 'implicitM2M') errors.push(
          `Model '${model.name}', field '${field.name}': @capability on a relation — a relation is not stored, so ` +
          `there is no column to grade.` +
          (rel?.fields?.[0] ? ` Put it on '${rel.fields[0]}', which guards the direct write and the ` +
          `{ ${field.name}: { connect: … } } form alike.` : ''))
      }

      const fieldPolicy = field.attributes.find(a => a.kind === 'fieldAllow')
      if (fieldPolicy && (field.type.kind === 'relation' || field.type.kind === 'implicitM2M')) {
        const fk = rel?.fields?.[0]
        errors.push(
          `Model '${model.name}', field '${field.name}': @allow has no column to guard — ` +
          (fk
            ? `a relation field is not stored. Put it on '${fk}', which guards the direct write and ` +
              `the { ${field.name}: { connect: … } } form alike.`
            : `an implicit many-to-many keeps its keys in a join table this model has no column for. ` +
              `Declare the join as a model of its own to guard it.`))
      }

      // The array literal is legal on the two columns that can hold a list: an
      // array column, and `Json`, which can hold anything. On a column that
      // holds one value it is refused by name — emitted verbatim it is a JSON
      // string sitting in a TEXT column, and a type error anywhere else.
      //
      // A Json element is graded here rather than by `elementErrors`, which
      // reads a base type Json does not have: any literal is a legal member of
      // a JSON array, and a BARE WORD is not — it is the enum spelling, and
      // there is no enum to resolve it against.
      const scalarDef = field.attributes.find(a => a.kind === 'default')
      if (!field.type.array && scalarDef?.value?.kind === 'array') {
        if (field.type.name !== 'Json') {
          errors.push(
            `Model '${model.name}', field '${field.name}': @default([…]) on a column that is not an array. ` +
            `Declare the column as '${field.type.name}[]', or give it a single value.`)
        } else {
          for (const el of scalarDef.value.values) if (el.kind === 'fieldRef') errors.push(
            `Model '${model.name}', field '${field.name}': @default([${el.field}]) — a bare word in an array ` +
            `is an enum member, and a Json column has no enum to read it against. Quote it: @default(["${el.field}"]).`)
        }
      }

      // Array type validation — String, Int, File and a declared enum support [].
      // An enum array is a SET of declared values, stored as a JSON TEXT column
      // like any other array. Membership is checked at the client boundary, not
      // by a CHECK: SQLite forbids a subquery in one, and reading the elements
      // of a JSON array needs json_each, which is a table-valued function.
      if (field.type.array) {
        const arrayAllowed = new Set(['String', 'Int', 'File'])
        const isImplicitM2M = modelNames.has(field.type.name)
          && (field.type.kind !== 'relation' || !field.attributes.some(a => a.kind === 'relation' && a.fields))
        if (!arrayAllowed.has(field.type.name) && !enumNames.has(field.type.name)
            && field.type.kind !== 'relation' && !isImplicitM2M) {
          errors.push(`Model '${model.name}', field '${field.name}': array [] is only supported for String, Int, File, an enum name, or a model name for many-to-many (got ${field.type.name})`)
        }
        // Mark as implicit m2m relation
        if (isImplicitM2M) field.type.kind = 'implicitM2M'

        // An array column is JSON TEXT under a json_type = 'array' CHECK, and a
        // @default is emitted into the DDL verbatim. @default("x") therefore
        // parsed, migrated, and then failed the CHECK on the first insert that
        // relied on it — a schema error surfacing as a constraint violation.
        //
        // Two spellings reach here and exactly one AST leaves: `@default([a, b])`,
        // and the JSON-array STRING that was the only spelling before it. The
        // string is normalized into the literal's shape rather than carried
        // alongside it, so `defaultExpr`, the JSON Schema and the release
        // classifier each read one kind — and it is type-checked by the same
        // rules, which it never used to be: `String[] @default("[1,2]")` was a
        // valid JSON array of the wrong thing and passed.
        const arrDef = field.attributes.find(a => a.kind === 'default')
        if (arrDef && field.type.kind !== 'relation' && field.type.kind !== 'implicitM2M') {
          const where  = `Model '${model.name}', field '${field.name}'`
          const v      = arrDef.value
          let   values = null

          if (v?.kind === 'array') values = v.values
          else if (v?.kind === 'string') {
            let parsed
            try { parsed = JSON.parse(v.value) } catch { parsed = null }
            if (Array.isArray(parsed)) {
              values = parsed.map(x => typeof x === 'string'  ? { kind: 'string',  value: x }
                                     : typeof x === 'number'  ? { kind: 'number',  value: x }
                                     : typeof x === 'boolean' ? { kind: 'boolean', value: x }
                                     : { kind: 'unsupported', value: x })
              warnings.push(
                `${where}: @default("${v.value}") is the JSON spelling of @default(${JSON.stringify(parsed)}). ` +
                `Both are checked the same way and emit the same column DEFAULT; the literal is the one that ` +
                `can hold a bare enum member, so it is the spelling to write.`)
            }
          }

          if (values === null) {
            errors.push(
              `${where}: @default on an array field is an array — @default([]) for the empty one, ` +
              `@default(["a", "b"]) or @default([Active]) for a set. An array column already defaults ` +
              `to [] with no attribute at all, so the empty literal only says so out loud.`)
          } else {
            for (const e of elementErrors(where, field, values, enumNames, schema)) errors.push(e)
            arrDef.value = { kind: 'array', values }
          }
        }
      }

    }  // end per-field loop

    // Validate @funcCall attributes — function must exist and arg count must match
    for (const field of model.fields) {
      const call = field.attributes.find(a => a.kind === 'funcCall')
      if (!call) continue
      const fn = schema.functions.find(f => f.name === call.fn)
      if (!fn) {
        errors.push(`Model '${model.name}', field '${field.name}': @${call.fn} references unknown function '${call.fn}'`)
        continue
      }
      if (call.args.length !== fn.params.length) {
        errors.push(`Model '${model.name}', field '${field.name}': @${call.fn} expects ${fn.params.length} argument(s) but got ${call.args.length}`)
        continue
      }
      for (const arg of call.args) {
        if (!fieldNames.has(arg)) {
          errors.push(`Model '${model.name}', field '${field.name}': @${call.fn} argument '${arg}' is not a field on this model`)
        }
      }
    }


    // Validate @generated expressions:
    //   1. Referenced {fields} exist on this model
    //   2. No self-reference (field references itself)
    //   3. No circular reference among generated fields
    //
    // Extract {fieldName} tokens from an expr string
    function refsInExpr(expr) {
      const refs = []
      let m
      const re = /\{(\w+)\}/g
      while ((m = re.exec(expr)) !== null) refs.push(m[1])
      return [...new Set(refs)]
    }

    // Build dependency map: generatedField → [referencedFields]
    const genDeps = {}
    for (const field of model.fields) {
      const gen = field.attributes.find(a => a.kind === 'generated')
      if (!gen) continue
      const refs = refsInExpr(gen.expr)  // expr already has {x} → "x" substituted in parseGenerated
      // Note: parseGenerated already expanded {x} → "x" — we need to re-extract from raw
      // Actually gen.expr has quotes already, extract names from quoted: "fieldName"
      const quotedRefs = []
      let qm
      const qre = /"(\w+)"/g
      while ((qm = qre.exec(gen.expr)) !== null) quotedRefs.push(qm[1])
      genDeps[field.name] = [...new Set(quotedRefs)]
    }

    // Validate each generated field
    for (const [fieldName, deps] of Object.entries(genDeps)) {
      for (const dep of deps) {
        // 1. Referenced field must exist
        if (!fieldNames.has(dep)) {
          errors.push(`Model '${model.name}', field '${fieldName}': @generated references unknown field '${dep}'`)
        }
        // 2. Self-reference
        if (dep === fieldName) {
          errors.push(`Model '${model.name}', field '${fieldName}': @generated cannot reference itself`)
        }
      }
    }

    // 3. Cycle detection across generated fields (DFS)
    function hasCycle(start, current, visited, stack) {
      visited.add(current)
      stack.add(current)
      for (const dep of genDeps[current] ?? []) {
        if (!genDeps[dep]) continue  // dep is a regular (non-generated) field — no cycle possible
        if (!visited.has(dep)) {
          if (hasCycle(start, dep, visited, stack)) return true
        } else if (stack.has(dep)) {
          return true
        }
      }
      stack.delete(current)
      return false
    }

    const visitedCycle = new Set()
    for (const fieldName of Object.keys(genDeps)) {
      if (!visitedCycle.has(fieldName)) {
        if (hasCycle(fieldName, fieldName, new Set(), new Set())) {
          // Find the cycle members for a helpful error message
          const inCycle = Object.keys(genDeps).filter(f => {
            // Simple: check if they mutually depend on each other
            return genDeps[f]?.some(d => genDeps[d]?.includes(f))
          })
          const label = inCycle.length > 0 ? inCycle.join(' ↔ ') : fieldName
          errors.push(`Model '${model.name}': circular @generated dependency detected: ${label}`)
          break  // one error per model is enough
        }
        visitedCycle.add(fieldName)
      }
    }


    // Model-level attribute field refs
    for (const attr of model.attributes) {
      if (attr.fields) {
        for (const f of attr.fields) {
          if (!fieldNames.has(f))
            errors.push(`Model '${model.name}': @@${attr.kind} references unknown field '${f}'`)
        }
      }
    }

    // @@label(field) — every refusal below is a shape a picker cannot use, and
    // it is refused HERE because the alternative is a screen listing `1, 2, 3`
    // with nothing saying why. The consumer sorts by this column and searches
    // it with `contains`, so a value that is not text the database can order
    // and match is not a display column, however readable it looks.
    const labelAttrs = model.attributes.filter(a => a.kind === 'labelField')
    if (labelAttrs.length > 1)
      errors.push(`Model '${model.name}': duplicate @@label — a model has one display column`)
    if (labelAttrs.length) {
      const attr  = labelAttrs[0]
      const field = model.fields.find(f => f.name === attr.field)
      const why   = !field ? null : labelFieldRefusal(field, schema)
      if (!field)     errors.push(`Model '${model.name}': @@label references unknown field '${attr.field}'`)
      else if (why)   errors.push(`Model '${model.name}': @@label(${attr.field}) — ${why}`)
    }
  }

  // ── Value sets ───────────────────────────────────────────────────────────
  // Everything a `@values` binding needs in order to be checkable at all: the
  // source exists, the column a record stores exists and is one SQLite can
  // match, the scope is a predicate the source declared. A set that cannot be
  // resolved is a picker that silently offers nothing and a validator that
  // silently passes everything, which is the pair this declaration exists to
  // end (`FJS-D120`).
  const valuesets   = schema.valuesets ?? []
  const modelByName = new Map(schema.models.map(m => [m.name, m]))
  const setByName   = new Map()

  for (const vs of valuesets) {
    if (setByName.has(vs.name)) { errors.push(`Duplicate valueset '${vs.name}'`); continue }
    setByName.set(vs.name, vs)

    const src = modelByName.get(vs.source)
    if (!src) {
      errors.push(`valueset '${vs.name}': source '${vs.source}' is not a model in this schema`)
      continue
    }

    // The column a record stores. Defaults to the source's own id, which is the
    // relation case; a set may name a stable CODE instead, which is what keeps
    // a stored value meaningful when the row behind it is replaced.
    const idField = src.fields.find(f => f.attributes?.some(a => a.kind === 'id'))
    const valName = vs.value ?? idField?.name
    if (!valName) {
      errors.push(`valueset '${vs.name}': source '${vs.source}' has no @id, so name the column a record stores — value <field>`)
      continue
    }
    const valField = src.fields.find(f => f.name === valName)
    if (!valField) {
      errors.push(`valueset '${vs.name}': value '${valName}' is not a field on '${vs.source}'`)
      continue
    }
    const why = valueColumnRefusal(valField, schema)
    if (why) errors.push(`valueset '${vs.name}': value '${valName}' — ${why}`)

    if (vs.scope) {
      const scopes = new Set((src.attributes ?? []).filter(a => a.kind === 'scope').map(a => a.name))
      if (!scopes.has(vs.scope))
        errors.push(
          `valueset '${vs.name}': scope '${vs.scope}' is not declared on '${vs.source}'` +
          (scopes.size ? `. It declares: ${[...scopes].sort().join(', ')}` : ` — add @@scope(${vs.scope}, <expr>) to it`))
    }

    vs.valueField = valName
    vs.isIdValue  = valName === idField?.name
    vs.labelField = (src.attributes ?? []).find(a => a.kind === 'labelField')?.field ?? null

    // The order a picker offers, checked against the SOURCE — an order naming a
    // column that is not there is a list that loads alphabetically forever with
    // nothing said, which is the failure this whole axis exists to end.
    // Unstated is not an error: the default is the label column, resolved where
    // the label is (`FJS-D121`), so nothing here restates it.
    for (const o of vs.order ?? []) {
      const f = src.fields.find(x => x.name === o.field)
      if (!f) {
        errors.push(`valueset '${vs.name}': order '${o.field}' is not a field on '${vs.source}'`)
        continue
      }
      const no = orderColumnRefusal(f, schema)
      if (no) errors.push(`valueset '${vs.name}': order '${o.field}' — ${no}`)
    }

    // ── recent(Model.column, clock) — the head ────────────────────────────
    //
    // Three things have to be true and each fails invisibly: the column has to
    // hold values OF THIS SET (a rank over some other column offers a list of
    // things that are not in it), the clock has to be a stored DateTime (SQLite
    // orders whatever text it is given), and both have to exist. A head that
    // resolves to nothing looks exactly like a person who has picked nothing.
    if (vs.recent) {
      const at   = `valueset '${vs.name}': recent(${vs.recent.model}.${vs.recent.field}, ${vs.recent.clock})`
      const rank = modelByName.get(vs.recent.model)
      if (!rank) {
        errors.push(`${at} — '${vs.recent.model}' is not a model in this schema`)
      } else {
        const col = rank.fields.find(f => f.name === vs.recent.field)
        if (!col) {
          errors.push(`${at} — '${vs.recent.field}' is not a field on '${vs.recent.model}'`)
        } else {
          // Drawn from THIS set: either the column binds to it, or it is the
          // foreign key that reaches the source by the column the set stores.
          const bound = col.attributes?.some(a => a.kind === 'values' && a.set === vs.name)
          const fk    = rank.fields.find(f =>
            f.type?.name === vs.source &&
            f.attributes?.some(a => a.kind === 'relation'
              && a.fields?.includes(vs.recent.field)
              && (a.references ?? ['id']).includes(valName)))
          if (!bound && !fk) errors.push(
            `${at} — '${vs.recent.field}' does not hold values of this set, so ranking it would offer rows that are not in the list. ` +
            `Bind it with @values(${vs.name}), or point it at ${vs.source}.${valName} with @relation`)
        }
        const clock = rank.fields.find(f => f.name === vs.recent.clock)
        if (!clock) {
          const dates = rank.fields.filter(f => f.type?.name === 'DateTime' && !f.type.array).map(f => f.name)
          errors.push(
            `${at} — '${vs.recent.clock}' is not a field on '${vs.recent.model}'` +
            (dates.length ? `. It declares: ${dates.join(', ')}` : ', which declares no DateTime column to rank by'))
        } else if (clock.type?.name !== 'DateTime') {
          errors.push(`${at} — '${vs.recent.clock}' is ${clock.type?.name}, and a head is ordered by WHEN. Name a DateTime column`)
        } else {
          const why = orderColumnRefusal(clock, schema)
          if (why) errors.push(`${at} — '${vs.recent.clock}' ${why}`)
        }
      }
    }

    // A `where` is SQL, and a browser may never send SQL (Invariant 8) — so a
    // set narrowed that way used to offer the whole source in a picker and have
    // the save refused (`FJS-430`). It becomes a `@@scope` on the source, named
    // after the set: a NAME crosses, is looked up in this table, and compiles to
    // the same SQL the Data boundary applies. One narrowing, one owner.
    vs.scopes = [...(vs.scope ? [vs.scope] : [])]
    if (vs.where) {
      src.attributes ??= []
      const clash = src.attributes.find(a => a.kind === 'scope' && a.name === vs.name)
      if (clash && clash.mintedBy !== vs.name) {
        errors.push(
          `valueset '${vs.name}': its 'where' mints @@scope(${vs.name}, …) on '${vs.source}', which already declares one. ` +
          `Rename the set, or move the predicate into that scope and drop the where`)
      } else {
        // Idempotent: the same schema object may be validated more than once.
        if (!clash) src.attributes.push({ kind: 'scope', name: vs.name, raw: vs.where, mintedBy: vs.name })
        vs.scopes.push(vs.name)
      }
    }
  }

  // The source model of a set, for the binding walk below. Named rather than
  // re-found inline because the dependency check asks for it three times.
  const src2 = (vs) => modelByName.get(vs.source) ?? { fields: [] }

  // ── @values bindings ─────────────────────────────────────────────────────
  for (const model of schema.models) {
    for (const field of model.fields) {
      const binds = field.attributes.filter(a => a.kind === 'values')
      if (binds.length > 1) {
        errors.push(`Model '${model.name}', field '${field.name}': duplicate @values — a column binds to one set`)
        continue
      }
      if (!binds.length) continue
      const bind = binds[0]
      const at   = `Model '${model.name}', field '${field.name}': @values(${bind.set})`

      const vs = setByName.get(bind.set)
      if (!vs) { errors.push(`${at} — no valueset '${bind.set}' in this schema`); continue }

      // An enum is already a complete set and is required by construction, so a
      // binding could only disagree with it or restate it.
      if (schema.enums.some(e => e.name === field.type.name)) {
        errors.push(`${at} — '${field.name}' is an enum, which is already a value set and is always required. Drop the binding, or make the list a table`)
        continue
      }
      // The relation field is an object; the FK column beside it is the value.
      if (schema.models.some(m => m.name === field.type.name)) {
        const fk = field.attributes.find(a => a.kind === 'relation')?.fields?.[0]
        errors.push(`${at} — '${field.name}' is the relation, not the column that holds the value. Put it on ${fk ? `'${fk}'` : 'the foreign key column'}`)
        continue
      }

      // ── dependsOn — the column of the SOURCE is DERIVED ──────────────────
      //
      // `dependsOn: countryId` says this row's `countryId` narrows the list.
      // Which column of the source it is matched against comes out of the
      // relation path: `Address.countryId` points at `Country`, so the source
      // must reach `Country` too, and the column it reaches it by is the one to
      // compare. Stating both sides would be two places to be wrong; a schema
      // that cannot decide is refused rather than guessed at (`FJS-D122`).
      if (bind.dependsOn) {
        const ctl = model.fields.find(f => f.name === bind.dependsOn)
        if (!ctl) {
          errors.push(`${at} — dependsOn '${bind.dependsOn}' is not a field on '${model.name}'`)
        } else if (bind.dependsOn === field.name) {
          errors.push(`${at} — dependsOn names '${field.name}', the column it is bound to. A list cannot narrow by itself`)
        } else if (bind.dependsOnSource) {
          if (!src2(vs).fields.some(f => f.name === bind.dependsOnSource))
            errors.push(`${at} — dependsOn ... on '${bind.dependsOnSource}' is not a field on '${vs.source}'`)
          else bind.dependsOnField = bind.dependsOnSource
        } else {
          // What does the controlling column point AT? The relation beside it
          // carries the target; a plain column has none, and then there is
          // nothing to walk and the source column must be stated.
          const target = model.fields.find(f =>
            f.attributes?.some(a => a.kind === 'relation' && a.fields?.[0] === bind.dependsOn))?.type?.name
          if (!target) {
            errors.push(
              `${at} — dependsOn '${bind.dependsOn}' is not a foreign key, so there is no relation to follow to ` +
              `'${vs.source}'. Name the column on '${vs.source}' it is matched against: dependsOn: ${bind.dependsOn} on <column>`)
          } else {
            const hops = src2(vs).fields
              .filter(f => f.type?.name === target && f.attributes?.some(a => a.kind === 'relation'))
              .map(f => f.attributes.find(a => a.kind === 'relation').fields?.[0])
              .filter(Boolean)
            if (hops.length === 1) bind.dependsOnField = hops[0]
            else if (!hops.length) errors.push(
              `${at} — dependsOn '${bind.dependsOn}' points at '${target}' and '${vs.source}' has no relation to it, ` +
              `so the two lists are unrelated. Name the column to match on: dependsOn: ${bind.dependsOn} on <column>`)
            else errors.push(
              `${at} — dependsOn '${bind.dependsOn}' points at '${target}' and '${vs.source}' reaches it ` +
              `${hops.length} ways (${hops.join(', ')}), so which one narrows the list is not decidable. ` +
              `State it: dependsOn: ${bind.dependsOn} on <column>`)
          }
        }
      }

      // `open` writes a row from what the caller typed, so it needs to know
      // which column receives the text and it cannot be the primary key.
      if (bind.strength === 'open') {
        if (vs.isIdValue) errors.push(
          `${at} — 'open' cannot create a row by naming its primary key. ` +
          `Give the set a stable code to store: value <field> on valueset '${vs.name}'`)
        else if (!vs.labelField) errors.push(
          `${at} — 'open' writes a new row from what the caller typed and nothing says which column receives it. ` +
          `Add @@label(<column>) to model '${vs.source}'`)
      }
    }
  }

  // Duplicate model or enum names
  const allNames = [...schema.models, ...schema.enums].map(n => n.name)
  const seen = new Set()
  for (const name of allNames) {
    if (seen.has(name)) errors.push(`Duplicate declaration name '${name}'`)
    seen.add(name)
  }

  // ── Database block validation ────────────────────────────────────────────────

  const dbNames    = new Set(schema.databases.map(d => d.name))
  const jsonlNames = new Set(schema.databases.filter(d => d.driver === 'jsonl').map(d => d.name))
  const loggerNames = new Set(schema.databases.filter(d => d.driver === 'logger').map(d => d.name))
  // Where a trail may be written. Two kinds, and the difference is what the
  // trail can then DO: `driver logger` is a directory of append-only jsonl —
  // cheap, fleet-shared, and reachable by no join, no policy and no screen —
  // while a SQLite database with a declared `model` puts the trail in an
  // ordinary table the app owns, which can be joined to `User`, gated, indexed,
  // paged with a cursor and replicated by litestream.
  const logTargets = new Set(schema.databases
    .filter(d => d.driver === 'logger' || (d.driver !== 'jsonl' && d.logModel))
    .map(d => d.name))

  // Duplicate database names
  const seenDb = new Set()
  for (const db of schema.databases) {
    if (seenDb.has(db.name)) errors.push(`Duplicate database name '${db.name}'`)
    seenDb.add(db.name)
    // maxSize only valid on jsonl
    if (db.maxSize && db.driver !== 'jsonl')
      errors.push(`database '${db.name}': maxSize is only valid for jsonl databases`)
    // replication not valid on jsonl or logger
    if (db.replication && (db.driver === 'jsonl' || db.driver === 'logger'))
      errors.push(`database '${db.name}': replication is not supported for ${db.driver} databases`)
    // `model` names the trail's own table. On a logger database it is optional
    // — an auto `<db>Logs` is synthesized when it is absent — and on a SQLite
    // one it is required, because there is nothing to synthesize INTO: a table
    // the app never declared cannot carry a `@@gate`, an `@@allow`, an index or
    // a migration, and those are the whole reason to put a trail in SQLite
    // rather than in a directory of jsonl.
    if (db.logModel && db.driver === 'jsonl')
      errors.push(`database '${db.name}': model key is not valid for jsonl databases — it names an audit trail's own table, and a jsonl database that is not 'driver logger' is ordinary storage`)
    // maxSize not valid on logger
    if (db.maxSize && db.driver === 'logger')
      errors.push(`database '${db.name}': maxSize is not valid for logger databases — use retention instead`)
  }

  // JSONL single-file path (.jsonl extension) with multiple models — ambiguous
  for (const db of schema.databases) {
    if (db.driver !== 'jsonl') continue
    const pathValue = db.path.kind === 'literal' ? db.path.value
                    : db.path.default ?? ''
    if (pathValue.endsWith('.jsonl')) {
      const modelCount = schema.models.filter(m => {
        const dbAttr = m.attributes.find(a => a.kind === 'db')
        return (dbAttr?.name ?? 'main') === db.name
      }).length
      if (modelCount > 1)
        errors.push(
          `database '${db.name}': path '${pathValue}' looks like a single file but ${modelCount} models ` +
          `are assigned to this database. Use a directory path instead: path env("${db.path.var ?? 'VAR'}", "./${db.name}/")`
        )
    }
  }

  // @@db references on models must match a declared database block
  for (const model of schema.models) {
    const dbAttr = model.attributes.find(a => a.kind === 'db')
    if (dbAttr && !dbNames.has(dbAttr.name))
      errors.push(`Model '${model.name}': @@db(${dbAttr.name}) references unknown database '${dbAttr.name}'`)

    // JSONL databases don't support SQLite-only model features
    if (dbAttr && jsonlNames.has(dbAttr.name)) {
      const sqliteOnly = ['softDelete', 'fts', 'sequence']
      for (const kind of sqliteOnly) {
        if (model.attributes.some(a => a.kind === kind))
          errors.push(`Model '${model.name}': @@${kind} is not supported on jsonl databases`)
      }
      // Also check field-level features
      for (const field of model.fields) {
        if (field.attributes.some(a => a.kind === 'sequence'))
          errors.push(`Model '${model.name}', field '${field.name}': @sequence is not supported on jsonl databases`)
        if (field.attributes.some(a => a.kind === 'encrypted'))
          errors.push(`Model '${model.name}', field '${field.name}': @encrypted is not supported on jsonl databases`)
      }
    }

    // @log on fields — db must be a logger database
    for (const field of model.fields) {
      const logAttr = field.attributes.find(a => a.kind === 'log')
      if (!logAttr) continue
      if (!dbNames.has(logAttr.db))
        errors.push(`Model '${model.name}', field '${field.name}': @log references unknown database '${logAttr.db}'`)
      else if (!logTargets.has(logAttr.db))
        errors.push(`Model '${model.name}', field '${field.name}': @log database '${logAttr.db}' is not an audit trail — ${logTargetHint(schema, logAttr.db)}`)
    }

    // @@log on models — the target must be a declared audit trail
    for (const attr of model.attributes) {
      if (attr.kind !== 'log') continue
      if (!dbNames.has(attr.db))
        errors.push(`Model '${model.name}': @@log references unknown database '${attr.db}'`)
      else if (!logTargets.has(attr.db))
        errors.push(`Model '${model.name}': @@log database '${attr.db}' is not an audit trail — ${logTargetHint(schema, attr.db)}`)
    }

    // @required carries a message for a rule it does not create. On a nullable
    // field there is no such rule, so the message can never fire — the author
    // meant to drop the `?` and this would fail silently forever otherwise.
    for (const field of model.fields) {
      const req = field.attributes.find(a => a.kind === 'required')
      if (!req) continue
      const t = field.type
      const isOptional = (typeof t === 'object' && t.optional) || field.optional || false
      const at = `Model '${model.name}', field '${field.name}'`

      // The two halves of `@required` and they want OPPOSITE types. Bare, it
      // only carries the message and the absence of `?` is the rule, so on an
      // optional field the message could never fire. With `where:` it IS the
      // rule — required in the rows the predicate admits — so on a
      // non-optional field it is a second answer to a question the type has
      // already answered, and the two can disagree about a row.
      if (isOptional && !req.where) {
        errors.push(
          `${at}: @required on an optional field. @required only carries the message — drop the '?' to make ` +
          `the field required, state 'where:' to make it required only in some rows, or remove @required.`
        )
        continue
      }
      if (!isOptional && req.where) {
        errors.push(
          `${at}: @required(where: …) on a field that is already required — the absence of '?' says every row ` +
          `needs a value and the predicate says only some do. Add the '?', or drop the 'where:'.`
        )
        continue
      }
      if (!req.where && req.message == null) {
        warnings.push(
          `${at}: @required with no message has no effect — ` +
          `the field is already required by the absence of '?'.`
        )
      }
      if (!req.where) continue

      // ── the predicate ────────────────────────────────────────────────────
      //
      // It becomes a CHECK on the table, which is what gives the rule the reach
      // a boundary rule cannot have — a migration, a seed, `asSystem()` and a
      // raw statement are all held to it — and what decides everything it may
      // not contain. A CHECK is evaluated against one row with no caller and no
      // other table in scope, and SQLite takes no bound parameter there.
      const label = `${at}: @required(where: …)`
      const names = predicateNames(req.where, model)

      if (names.constant) {
        errors.push(constantPredicate(label, names.constant))
        continue
      }
      if (names.auth) {
        errors.push(
          `${label} names auth(), which is a different answer for every caller — this is one answer for the ROW, ` +
          `shared by all of them, and a CHECK cannot see a principal. Whether a caller may WRITE a column is a ` +
          `field @allow('write', …); which rows they may see at all is @@scope or a row policy.`)
        continue
      }
      if (names.now) {
        errors.push(
          `${label} names now(), so a row that was correct when it was written stops being correct with nothing ` +
          `having touched it — and every later write to that row is then refused for a column nobody changed. ` +
          `SQLite ACCEPTS a clock in a CHECK, so nothing below this will refuse it. Compare against a stored ` +
          `column instead.`)
        continue
      }
      if (names.crossesModel) {
        errors.push(
          `${label} reads another model, which a CHECK cannot do — it is evaluated against one row with no other ` +
          `table in scope. Denormalize the column onto this model, or make the rule a row policy.`)
        continue
      }
      if (names.unknown.length) {
        errors.push(
          `${label} names ${names.unknown.map(u => `'${u}'`).join(', ')}, which ` +
          `${names.unknown.length > 1 ? 'are not columns' : 'is not a column'} of this model. ` +
          `The predicate reads the row the column is on and nothing else.`)
        continue
      }

      let compiled
      try {
        compiled = compileStatic(req.where, model.name, schema)
      } catch (e) {
        errors.push(`${label} could not be compiled — ${e.message}`)
        continue
      }
      if (/\bSELECT\b/i.test(compiled.sql)) {
        errors.push(
          `${label} compiles to a subquery, which a CHECK cannot contain — it reads the row the column is on ` +
          `and nothing else.`)
        continue
      }
      // SQLite takes no bound parameter in a CHECK, and this compiler binds
      // every value. The literals are inlined instead — safe because they are
      // the SCHEMA's own and never a caller's: nothing reaches here that a
      // person did not write into the .lite file. The same rule a partial
      // unique's predicate lives under, for the same reason.
      const bad = compiled.params.find(v =>
        v !== null && !['string', 'number', 'boolean'].includes(typeof v))
      if (bad !== undefined) {
        errors.push(
          `${label} compares against a value this cannot write into a CHECK (${JSON.stringify(bad)}). SQLite ` +
          `prohibits a bound parameter there, so the value has to be a literal string, number, boolean or null.`)
        continue
      }
      req.whereSql = inlineParams(compiled.sql, compiled.params)
    }

    // @secret validation — check for conflicting explicit attributes
    for (const field of model.fields) {
      if (!field.attributes.some(a => a.kind === 'secret')) continue

      // @secret cannot be combined with explicit @encrypted or @guarded — it synthesizes them
      if (field.attributes.filter(a => a.kind === 'encrypted').length > 1)
        errors.push(`Model '${model.name}', field '${field.name}': @secret already implies @encrypted — remove the explicit @encrypted`)
      if (field.attributes.filter(a => a.kind === 'guarded').length > 1)
        errors.push(`Model '${model.name}', field '${field.name}': @secret already implies @guarded — remove the explicit @guarded`)

      // @secret on jsonl databases — not supported (inherits @encrypted restriction)
      const dbAttr = model.attributes.find(a => a.kind === 'db')
      if (dbAttr && jsonlNames.has(dbAttr.name))
        errors.push(`Model '${model.name}', field '${field.name}': @secret (and @encrypted) are not supported on jsonl databases`)

      // Warn if no logger database exists — @log won't be synthesized
      if (!schema.databases.some(db => db.driver === 'logger'))
        warnings.push(`Model '${model.name}', field '${field.name}': @secret has no logger database declared — audit logging will not be active. Add a 'database audit { driver logger }' block to enable it.`)
    }
  }


  // ── @hashed validation ──────────────────────────────────────────────────────
  // @hashed is not a flavor of @encrypted and does not compose with one: there is
  // no ciphertext to guard, to rotate, or to hand back under a read policy. Every
  // combination below is a schema that states two different fates for one column.
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (!field.attributes.some(a => a.kind === 'hashed')) continue

      if (field.attributes.some(a => a.kind === 'encrypted'))
        errors.push(`Model '${model.name}', field '${field.name}': @hashed conflicts with @encrypted — @hashed is one-way and there is no ciphertext to decrypt. Pick @encrypted(deterministic: true) if the value has to read back`)
      if (field.attributes.some(a => a.kind === 'secret'))
        errors.push(`Model '${model.name}', field '${field.name}': @hashed conflicts with @secret — @secret implies @encrypted and $rotateKey, and a digest can do neither`)
      if (field.attributes.some(a => a.kind === 'guarded'))
        errors.push(`Model '${model.name}', field '${field.name}': @hashed conflicts with @guarded — @hashed already strips the field from every read, asSystem() included`)
      if (field.attributes.some(a => a.kind === 'fieldAllow'))
        errors.push(`Model '${model.name}', field '${field.name}': @hashed conflicts with @allow — no caller can read a digest, so a read policy over one has nothing to permit`)

      // A digest is TEXT. Hashing a number or a date and comparing it works, but the
      // column's declared type would then describe something it no longer holds.
      if (field.type?.name !== 'String')
        errors.push(`Model '${model.name}', field '${field.name}': @hashed requires a String field — the column holds a base64url digest, not a ${field.type?.name}`)
      if (field.type?.array)
        errors.push(`Model '${model.name}', field '${field.name}': @hashed cannot be applied to an array — each element would need its own digest and no filter could address one`)

      const dbAttr = model.attributes.find(a => a.kind === 'db')
      if (dbAttr && jsonlNames.has(dbAttr.name))
        errors.push(`Model '${model.name}', field '${field.name}': @hashed is not supported on jsonl databases`)
    }
  }

  // ── @system validation ──────────────────────────────────────────────────────
  //
  // @system composes with @guarded — that pair is a column invisible to a client
  // AND unwritable by one, which could not be spelled at all before (FJS-235).
  // It does NOT compose with a field @allow('write', …): one says nobody ever,
  // the other says it depends who is asking, and a field cannot mean both.
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (!field.attributes.some(a => a.kind === 'system')) continue

      if (field.attributes.some(a => a.kind === 'fieldAllow' && a.operations.includes('write')))
        errors.push(`Model '${model.name}', field '${field.name}': @system conflicts with @allow('write', …) — @system means no caller may write it at all, @allow('write') means some may. Pick the one you mean`)

      // A value with no column cannot be written by anyone, system included, so
      // locking the write says nothing and reads as though it did.
      for (const kind of ['computed', 'generated', 'from', 'funcCall']) {
        if (field.attributes.some(a => a.kind === kind))
          errors.push(`Model '${model.name}', field '${field.name}': @system has nothing to lock on a @${kind === 'funcCall' ? 'generated' : kind} field — it is derived, so no caller writes it`)
      }
    }
  }

  // ── @immutable validation ───────────────────────────────────────────────────
  //
  // Every case here is a column the ENGINE writes on update, which is a direct
  // contradiction: the write cannot both be refused and be made on every save.
  // Refused at parse rather than at the first update, because a schema that
  // declares two rules for one column is wrong before any row exists.
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (!field.attributes.some(a => a.kind === 'immutable')) continue

      for (const kind of ['updatedAt', 'version'])
        if (field.attributes.some(a => a.kind === kind))
          errors.push(`Model '${model.name}', field '${field.name}': @immutable contradicts @${kind} — the engine writes that column on every update, and @immutable says nobody may`)

      // A value with no column is not written by anyone, so freezing it says
      // nothing and reads as though it did — @system's reasoning exactly.
      for (const kind of ['computed', 'generated', 'from', 'funcCall', 'derived', 'transient'])
        if (field.attributes.some(a => a.kind === kind))
          errors.push(`Model '${model.name}', field '${field.name}': @immutable has nothing to freeze on a @${kind === 'funcCall' ? 'generated' : kind} field — it is not a column a caller writes`)
    }
  }

  // ── @transient validation ───────────────────────────────────────────────────
  //
  // A transient field has no column, so every attribute that describes storage,
  // derivation or read-side visibility says nothing about it — and the way that
  // goes wrong is silently: @@index([secret]) indexes a column that was never
  // created, @allow('write', …) compiles a rule the Data boundary never reaches
  // because the value never arrives there. Refused by name, with what the
  // attribute would have needed.
  //
  // A deny-list rather than an allow-list of validators: a new validator refused
  // here is loud and one line to fix, where a new storage attribute silently
  // permitted on a field with no column is the shape this whole annotation
  // exists to stop.
  const TRANSIENT_CONFLICTS = {
    id:          'a transient value is not stored, so nothing can be keyed by it',
    unique:      'uniqueness is a property of a column, and there is none to index',
    map:         'there is no column to name',
    default:     'a default fills a column on write; a transient value is sent or it is not',
    relation:    'a relation is a foreign key, which is a column',
    generated:   'a generated value comes from its expression and is stored',
    funcCall:    'a generated value comes from its expression and is stored',
    computed:    'a field is read-only or write-only, not both — @computed is the read half',
    derived:     'a derived value is computed in the SELECT, and this field is never selected',
    from:        'a @from field is read through its target, and this field is never read',
    edge:        'an edge value lives on a join table',
    scoped:      'a scoped value lives on a side table',
    slug:        'a slug is derived into a column on write',
    sequence:    'a sequence numbers rows, and this value has none',
    updatedAt:   'there is no stored value for a write to stamp',
    updatedBy:   'there is no stored value for a write to stamp',
    createdBy:   'there is no stored value for a write to stamp',
    version:     'optimistic concurrency compares a stored counter',
    check:       'a CHECK constraint is enforced by SQLite over a column — validate it with @length/@regex/@gte, which run before the write',
    hashed:      'a digest is what gets stored instead of the value; @transient stores nothing',
    encrypted:   'ciphertext is what gets stored instead of the value; @transient stores nothing',
    keepVersions: 'history is kept per column',
    log:         'the audit trail records column writes, and a transient value is deliberately absent from it',
    guarded:     'a caller writes a transient field by definition — @guarded locks the write',
    system:      'the application writes a @system column and a caller writes a @transient field; they are opposite ends',
    secret:      'a transient value is never read back, so there is nothing to hide from a reader',
    omit:        'a transient value is never in a result, so there is nothing to omit from one',
  }
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (!field.attributes.some(a => a.kind === 'transient')) continue

      if (field.type.kind === 'relation' || field.type.kind === 'implicitM2M') {
        errors.push(`Model '${model.name}', field '${field.name}': @transient cannot be applied to a relation — a relation is a foreign key, which is a column`)
        continue
      }

      for (const attr of field.attributes) {
        const why = TRANSIENT_CONFLICTS[attr.kind]
        if (why) errors.push(`Model '${model.name}', field '${field.name}': @transient conflicts with @${attr.kind === 'funcCall' ? 'generated' : attr.kind} — ${why}`)
      }

      // A field @allow is a rule the Data boundary evaluates, and a transient
      // value is lifted off the payload before it gets there — so the rule
      // would be declared and never run. Half-enforcement reads as enforcement.
      if (field.attributes.some(a => a.kind === 'fieldAllow'))
        errors.push(`Model '${model.name}', field '${field.name}': @transient conflicts with @allow — the value never reaches the Data boundary, so the rule would be declared and never evaluated. Refuse it in the service that consumes it`)

      // Model-level attributes name columns: an index, a compound unique, a
      // full-text set. Each one would be built over a column that does not exist.
      for (const attr of model.attributes) {
        if (Array.isArray(attr.fields) && attr.fields.includes(field.name))
          errors.push(`Model '${model.name}': @@${attr.kind} names '${field.name}', which is @transient — it has no column to ${attr.kind === 'index' ? 'index' : attr.kind === 'unique' ? 'constrain' : 'read'}`)
      }
    }
  }

  // ── @@softDelete with no deletedAt column to mark ───────────────────────────
  //
  // The attribute names a column and the model has to declare it — every read is
  // ANDed with `deletedAt IS NULL` and `remove` stamps it. Without the field
  // there is no column, and SQLite resolves the unknown identifier in that WHERE
  // as a STRING LITERAL rather than raising: `'deletedAt' IS NULL` is false for
  // every row, so the model answers an empty list to every read and null to
  // every update, with a 200 and no error anywhere. `restore()` is the only verb
  // that fails out loud, because it writes the column instead of reading it.
  //
  // NULLABILITY is checked and the TYPE is not, which is measured rather than
  // chosen: `deletedAt String?` behaves identically — litestone writes every
  // instant as ISO-8601 TEXT — and it is what `introspect` emits, since a real
  // database's TEXT column cannot say whether it holds a date. A required column
  // is the other half: it is stamped at create, so every row is born deleted and
  // invisible to every read, or the create is refused outright.
  // `@@sync(refuse)` and `@@sync(field)` both name a revision, and the revision
  // is `@version`. Without that column there is nothing for a held write to
  // carry and nothing for the boundary to compare, so the policy is
  // indistinguishable from `server` while claiming the opposite — the exact
  // shape `FJS-D304` closed the set to avoid. Refused here rather than advised
  // for the same reason `@@softDelete` is: the attribute names a column, and a
  // model without it has already lost.
  for (const model of schema.models) {
    const sync = model.attributes.find(a => a.kind === 'sync')
    if (!SYNC_NEEDS_VERSION.has(sync?.policy)) continue
    if (!model.fields.some(f => f.attributes.some(a => a.kind === 'version')))
      errors.push(
        `Model '${model.name}': @@sync(${sync.policy}) needs an @version field and this model has none. ` +
        `The policy means a held write carries the revision it was made against and is ${
          sync.policy === 'refuse' ? 'refused if the row moved' : 'compared column by column against it'} — ` +
        `with no @version there is no revision, so every held write would apply to whatever ` +
        `is there, which is @@sync(server). Add: version Int @version, or say @@sync(server).`)
  }

  for (const model of schema.models) {
    if (!model.attributes.some(a => a.kind === 'softDelete')) continue
    const field = model.fields.find(f => f.name === 'deletedAt')
    if (!field) {
      errors.push(
        `Model '${model.name}': @@softDelete needs a 'deletedAt DateTime?' field and this model has none. ` +
        `The attribute names that column — every read filters on it and remove stamps it — and without it ` +
        `every read answers an empty list with no error. Add: deletedAt DateTime?`)
      continue
    }
    if (!field.type.optional) {
      errors.push(
        `Model '${model.name}': @@softDelete needs 'deletedAt' to be optional and it is ` +
        `'${field.type.name}'. A live row holds NULL there, so a required column is stamped at create ` +
        `and every row is born deleted. Write: deletedAt ${field.type.name}?`)
    }
  }

  // ── @@index([deletedAt]) on a soft-delete model ─────────────────────────────
  //
  // @@softDelete emits its own partial index over the column, and both derive
  // the same name — `idx_<table>_deletedAt`. The schema validates, the DDL is
  // emitted, and the run dies inside SQLite on `index ... already exists`,
  // naming a physical index about a declaration two attributes away (FJS-480).
  //
  // Refused rather than deduped at emit, because the declaration is redundant
  // either way: a declared index on a soft-delete table is already given the
  // `WHERE "deletedAt" IS NULL` clause, so this one compiled to exactly the
  // index @@softDelete was going to write. Only the single-column form
  // collides — `@@index([deletedAt, status])` derives a different name and is
  // an ordinary composite index.
  for (const model of schema.models) {
    if (!model.attributes.some(a => a.kind === 'softDelete')) continue
    for (const attr of model.attributes) {
      if (attr.kind !== 'index') continue
      if (attr.fields?.length !== 1 || attr.fields[0] !== 'deletedAt') continue
      errors.push(
        `Model '${model.name}': @@index([deletedAt]) duplicates the index @@softDelete already builds — ` +
        `both are named idx_<table>_deletedAt, so the database cannot be created. ` +
        `Remove the @@index: @@softDelete indexes the column over live rows only`)
    }
  }

  // ── @unique over a randomly-encrypted column ────────────────────────────────
  //
  // A UNIQUE constraint is over the STORED bytes, and plain @encrypted uses a
  // random IV: the same plaintext stores different ciphertext every write, so
  // the constraint is declared, built, and can never fire. Measured — two
  // creates of one value both succeed and the model holds two rows. Nothing
  // said so, which makes it a uniqueness guarantee an app believes it has.
  //
  // @encrypted(deterministic: true) derives the IV from the plaintext, so the
  // bytes repeat and the constraint works; @hashed is the other answer, for a
  // value that only ever has to be matched.
  for (const model of schema.models) {
    const composites = model.attributes.filter(a => (a.kind === 'uniqueIndex' || a.kind === 'partialUnique') && Array.isArray(a.fields))
    for (const field of model.fields) {
      const enc = field.attributes.find(a => a.kind === 'encrypted')
      if (!enc || enc.deterministic === true) continue

      const how = field.attributes.some(a => a.kind === 'secret') ? '@secret' : '@encrypted'
      const fix = `Declare ${how}(deterministic: true) — the IV is derived from the plaintext, so equal values store equal bytes — ` +
                  `or @hashed if the value only ever has to be matched`

      if (field.attributes.some(a => a.kind === 'unique'))
        errors.push(`Model '${model.name}', field '${field.name}': @unique cannot be enforced over ${how} — ` +
                    `the constraint is over the stored ciphertext, and a random IV makes every write of the same value different. ${fix}`)

      for (const c of composites)
        if (c.fields.includes(field.name))
          errors.push(`Model '${model.name}': @@unique([${c.fields.join(', ')}]) cannot be enforced — '${field.name}' is ${how}, ` +
                      `and a random IV makes every write of the same value store different ciphertext. ${fix}`)
    }
  }

  // ── @@extensible ────────────────────────────────────────────────────────────
  //
  // The attribute names a column and a model and nothing else, and everything
  // it needs from that model is found by CONVENTION — `model`, `key`, `type`,
  // and `slot` where a pool is asked for. Convention rather than named
  // arguments because a second spelling for columns the app has already written
  // is a second thing to keep in step; a REFUSAL naming the missing column is
  // what keeps that from being a silent guess.
  for (const model of schema.models) {
    const exts = model.attributes.filter(a => a.kind === 'extensible')
    if (!exts.length) continue

    const seen = new Set()
    for (const ext of exts) {
      const where = `Model '${model.name}': @@extensible(${ext.column}, declaredBy: ${ext.declaredBy})`

      if (seen.has(ext.column))
        errors.push(`${where} — '${ext.column}' is declared extensible twice. One column has one set of declarations`)
      seen.add(ext.column)

      const blob = model.fields.find(f => f.name === ext.column)
      if (!blob) { errors.push(`${where} — there is no field '${ext.column}' on this model`); continue }
      if (blob.type.name !== 'Json')
        errors.push(`${where} — '${ext.column}' is ${blob.type.name} and has to be Json. The keys are a tenant's, so the column cannot have a shape`)

      // A `@type` closes the column to the keys the FILE names, which is the
      // one thing an extensible column may not be: a key declared at runtime
      // would be refused until somebody deploys.
      if (blob?.attributes.some(a => a.kind === 'type'))
        errors.push(`${where} — '${ext.column}' also carries @type, which closes it to the keys this file names. A tenant declaring a key would be refused until the next deploy, which is what @@extensible exists to avoid`)

      const decl = schema.models.find(m => m.name === ext.declaredBy)
      if (!decl) { errors.push(`${where} — there is no model '${ext.declaredBy}'`); continue }

      const need = [
        ['model', f => f.type.name === 'String', 'String — which model a declaration is for'],
        ['key',   f => f.type.name === 'String', 'String — the tenant\'s own name for the field'],
        ['type',  f => f.type.kind === 'enum',   'an enum — what KIND of field it is'],
      ]
      if (ext.max) need.push(['slot', f => f.type.name === 'String' && f.type.optional,
                              'String? — which pooled column carries it, null when there is none'])

      for (const [name, ok, want] of need) {
        const f = decl.fields.find(x => x.name === name)
        if (!f)      errors.push(`${where} — '${ext.declaredBy}' has no '${name}' column. A declaring model needs ${name}: ${want}`)
        else if (!ok(f)) errors.push(`${where} — '${ext.declaredBy}.${name}' is ${f.type.name}${f.type.optional ? '?' : ''} and has to be ${want}`)
      }

      // `max:` is keyed by the declaring model's own type enum, which is what
      // makes `{ text: 8 }` mean anything. A key that is not a member would
      // generate a pool no declaration can ever reach.
      const typeField = decl.fields.find(x => x.name === 'type')
      if (ext.max && typeField?.type.kind === 'enum') {
        const en = schema.enums.find(e => e.name === typeField.type.name)
        const members = new Set(en?.values.map(v => v.name) ?? [])
        for (const kind of Object.keys(ext.max)) {
          if (!members.has(kind))
            errors.push(`${where} — max: names '${kind}', which is not a member of ${typeField.type.name} (${[...members].join(', ')}). A pool nothing can be declared into is a tax on every write and reachable by nobody`)
        }
      }

      // A declaring model whose key is not unique PER MODEL is the drift this
      // attribute exists to prevent: two models cannot each declare `notes`,
      // and one model cannot declare it twice. Under row tenancy the key is
      // per model PER TENANT — the tenancy desugar has already prepended the
      // column by now — and an exact-pair test refused the one right spelling.
      const tenantCol = schema.tenancy?.strategy === 'row' ? schema.tenancy.column : null
      const hasKeyUnique = decl.attributes.some(a => {
        if ((a.kind !== 'uniqueIndex' && a.kind !== 'partialUnique') || !Array.isArray(a.fields)) return false
        const key = a.fields[0] === tenantCol ? a.fields.slice(1) : a.fields
        return key.length === 2 && key.includes('model') && key.includes('key')
      })
      if (!hasKeyUnique)
        errors.push(`${where} — '${ext.declaredBy}' does not declare @@unique([model, key]). Without it one model can declare a key twice, and the second declaration is a field whose value nothing can find`)
    }
  }

  // ── A @default its own @type would refuse ───────────────────────────────────
  //
  // `fields Json @default("{}") @type(T)` where T has a required key parses
  // clean, stores `{}` on every create that names no value, and that value
  // would be REFUSED if a caller sent it. The column's two attributes state
  // different documents and the default wins in silence (`FJS-1032`).
  //
  // Decidable here because both halves are literals: the default is text in
  // the file and the type is a shape in the same file, so nothing has to run.
  // It is graded by the WRITE-PATH validator rather than by a check written
  // here, because *does this value satisfy this type* must have one definition
  // — a second one in the parser would drift from the one that refuses a
  // caller, which is the only way this check could ever be wrong in the
  // direction that matters.
  {
    const typeMap = new Map((schema.types ?? []).map(t => [t.name, t]))
    const enums   = new Map((schema.enums ?? []).map(e => [e.name, e.values.map(v => v.name)]))
    if (typeMap.size) for (const model of schema.models) {
      for (const field of model.fields) {
        const typeAttr = field.attributes.find(a => a.kind === 'type')
        const defAttr  = field.attributes.find(a => a.kind === 'default')
        if (!typeAttr || !defAttr || defAttr.value?.kind !== 'string') continue
        if (!typeMap.has(typeAttr.name)) continue

        let parsed
        try { parsed = JSON.parse(defAttr.value.value) }
        catch {
          errors.push(`Model '${model.name}', field '${field.name}': @default is not JSON, and the column is @type(${typeAttr.name}) — ` +
                      `a typed column's default has to be a document the type accepts`)
          continue
        }

        const errs = validateJsonPatch(parsed, typeAttr.name, typeMap, typeAttr.strict !== false, [], 'full', enums)
        if (!errs.length) continue
        const said = errs.map(e => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ')
        errors.push(
          `Model '${model.name}', field '${field.name}': @default(${JSON.stringify(defAttr.value.value)}) is a value @type(${typeAttr.name}) refuses — ${said}. ` +
          `A row written with no value for this column would hold a document the same schema rejects from a caller. ` +
          `Give the default every key the type requires, or make those keys optional`)
      }
    }
  }

  // ── Attribute legality, asked of FACETS rather than of pairs ────────────────
  //
  // The block above is one pair — `@unique` × `@encrypted` — ruled once, with a
  // good message. The same failure recurs one attribute over and was ruled
  // nowhere: `@@fts` over the same column builds an index that can never match,
  // and `@unique` over a field with no column vanishes (`FJS-721`). A rule
  // written per pair is a rule somebody has to remember to write, and the
  // surface is a hundred words.
  //
  // So the question is asked of a field once and the rules read the answer:
  // `storage` is what the column PHYSICALLY holds, which is what any mechanism
  // reading the column has to be true of.
  //
  // What belongs HERE is what cannot be expressed at all — a table SQLite
  // refuses to create, a DEFAULT the first insert rejects, a foreign key that
  // resolves nowhere. What is merely legal and WRONG belongs in `advise.js`,
  // whose own contract is that every rule in it parses, and which already owns
  // `@@fts` over an encrypted column. A rule in both places is a rule the
  // second owner can never reach.
  const fieldStorage = (field) => {
    const has = (k) => field.attributes?.some(a => a.kind === k)
    if (has('computed') || has('transient')) return 'none'
    if (has('from') || has('derived'))       return 'expression'
    if (has('encrypted') || has('secret') || has('hashed')) return 'ciphertext'
    return 'plain'
  }
  for (const model of schema.models) {
    const byName = new Map(model.fields.map(f => [f.name, f]))
    const storageOf = (name) => { const f = byName.get(name); return f ? fieldStorage(f) : null }

    // A constraint or an index is over a COLUMN. `@computed` has none at all,
    // and `@derived`/`@from` are carried in the SELECT rather than stored — so
    // the declaration either vanishes with no diagnostic (`@unique`, which is
    // emitted as a column constraint on a column that is not emitted) or takes
    // the whole table down at boot with SQLite's own words about something
    // nobody wrote: `@@unique([c])` over a `@computed` field is
    // `expressions prohibited in PRIMARY KEY and UNIQUE constraints`, measured.
    // `@generated` is a real column and is deliberately not in this set.
    const NO_COLUMN = { none: 'is @computed, so it is derived in JS after the row is read and there is no column',
                        expression: 'is computed by SQLite from the row rather than stored, so there is no column to constrain' }
    const reason = (name) => NO_COLUMN[storageOf(name)]
    for (const field of model.fields) {
      const why = reason(field.name)
      if (why && field.attributes.some(a => a.kind === 'unique'))
        errors.push(`Model '${model.name}', field '${field.name}': @unique cannot be enforced — it ${why}. ` +
                    `Store the value (@generated makes it a real column), or constrain the columns it is computed from`)
    }
    for (const attr of model.attributes) {
      const label = attr.kind === 'uniqueIndex' || attr.kind === 'partialUnique' ? '@@unique'
                  : attr.kind === 'index' ? '@@index'
                  : attr.kind === 'id' && Array.isArray(attr.fields) ? '@@id'
                  : null
      if (!label) continue
      for (const name of attr.fields ?? []) {
        const why = reason(name)
        if (!why) continue
        errors.push(`Model '${model.name}': ${label}([${(attr.fields ?? []).join(', ')}]) cannot be built — ` +
                    `'${name}' ${why}. Store the value (@generated makes it a real column), or name the ` +
                    `columns it is computed from`)
      }
    }

    // A default is written into the DDL verbatim, so it has to be a value the
    // COLUMN can hold. `@scale`/`@money` is the case that bites: the column is
    // an INTEGER of minor units, so `@default(12.99)` emits `DEFAULT 12.99`
    // into it and STRICT refuses the first defaulted insert —
    // `cannot store REAL value in INTEGER column`, at runtime, naming no
    // schema line. The boundary already refuses a fraction a caller SENDS;
    // this is the same rule for the value the schema sends.
    for (const field of model.fields) {
      const scale = field.attributes.find(a => a.kind === 'scale' || a.kind === 'money')
      const def   = field.attributes.find(a => a.kind === 'default')
      const raw = def?.value?.kind === 'number' ? def.value.value : def?.value
      if (!scale || typeof raw !== 'number' || Number.isInteger(raw)) continue
      // The suggested value is in the CURRENCY's minor units, which for the yen
      // is the yen: suggesting `raw * 100` there is advice that is wrong by a
      // hundred. A bare @money is the app's default currency and is not knowable
      // here, so it keeps the two-place reading.
      let places = scale.places
      if (scale.kind === 'money') {
        try { places = scale.currency ? minorUnits(scale.currency) : 2 }
        catch { places = 2 }
      }
      const minor  = Math.round(raw * 10 ** (places ?? 2))
      errors.push(
        `Model '${model.name}', field '${field.name}': @default(${raw}) is not a value this column can hold — ` +
        `${scale.kind === 'money' ? '@money' : `@scale(${places})`} stores a whole number of MINOR units in an ` +
        `INTEGER column, so the default is written as ${raw} and the first row that takes it is refused by ` +
        `SQLite. Write it in minor units: @default(${minor})`)
    }
  }

  // ── Relation cardinality ────────────────────────────────────────────────────
  //
  // `@minItems`/`@maxItems` on a relation is a count of CHILD ROWS, reached
  // through the foreign key the child holds. Two shapes have no key to count
  // through, and both would otherwise parse into a declaration that grades
  // nothing — the silence the attribute was extended to close, so it is refused
  // here rather than in `advise`.
  //
  // Asked of the FOREIGN KEY rather than of `field.type.kind`, because a list
  // field is still `implicitM2M` at this point in the pass and only becomes
  // `relation` once the back-reference is resolved — a check written against
  // the kind reported every ordinary one-to-many as a many-to-many.
  for (const model of schema.models) {
    for (const field of model.fields) {
      const bound = field.attributes?.find(a => a.kind === 'minItems' || a.kind === 'maxItems')
      if (!bound) continue
      const target = schema.models.find(m => m.name === field.type?.name)
      if (!target) continue                      // a Json array, or a type named elsewhere
      const what = `@${bound.kind}`
      if (field.type.array !== true) {
        errors.push(
          `Model '${model.name}', field '${field.name}': ${what} counts the rows on the MANY side and ` +
          `'${field.name}' holds one row. A to-one relation is made required or optional by its own '?', ` +
          `and how many of them may exist is declared on the other model's list field`)
        continue
      }
      const fk = inferFromFk(model, target, field.attributes.find(a => a.kind === 'relation')?.name ?? null)
      if (fk && !fk.ambiguous && !fk.unresolvedVia) continue
      errors.push(
        `Model '${model.name}', field '${field.name}': ${what} cannot be counted — ` +
        (fk?.ambiguous
          ? `'${target.name}' points at '${model.name}' through ${fk.ambiguous.length} relations ` +
            `(${fk.ambiguous.map(c => c.field).join(', ')}), so there is no one foreign key to count. ` +
            `Name which one with @relation("…") on both ends`
          : `'${target.name}' holds no foreign key to '${model.name}'. A many-to-many keeps its rows in ` +
            `a join table, so declare that model explicitly and put the bound on its list field`))
    }
  }

  // A foreign key names a table, and a table lives in one FILE. A relation
  // whose two ends are assigned to different `database` blocks parses clean,
  // emits an FK into whichever file the child is in, and throws
  // `no such table` on every create — measured. Refused here because the two
  // `@@db` assignments are the only place this is decidable.
  {
    const dbOf = (m) => m.attributes.find(a => a.kind === 'db')?.name ?? 'main'
    const modelByName = new Map(schema.models.map(m => [m.name, m]))
    for (const model of schema.models) {
      if (model.attributes.some(a => a.kind === 'external')) continue
      for (const field of model.fields) {
        const rel = field.attributes.find(a => a.kind === 'relation')
        if (!rel?.fields?.length) continue          // the owning side only
        const target = modelByName.get(typeof field.type === 'string' ? field.type : field.type?.name)
        if (!target || target.attributes.some(a => a.kind === 'external')) continue
        if (dbOf(model) === dbOf(target)) continue
        errors.push(
          `Model '${model.name}', field '${field.name}': a relation cannot cross databases — ` +
          `'${model.name}' is in database '${dbOf(model)}' and '${target.name}' is in '${dbOf(target)}'. ` +
          `A foreign key names a table and a table lives in one file, so this emits a key SQLite resolves ` +
          `nowhere and every create throws 'no such table'. Put both models in one database, or drop the ` +
          `@relation and carry the id as a plain column`)
      }
    }
  }

  // ── What a predicate NAMES ─────────────────────────────────────────────────
  //
  // Three declarations compile a predicate into a place SQLite evaluates
  // against one row with no caller, no principal and no other table in scope:
  // `@@index(where:)`, `@@unique([a], where:)` and `@required(where:)`. What
  // they must refuse is therefore the same set, and this is the walk that finds
  // it — shared because the drift is in the WALK: a node the language gains is
  // one three copies would each have to learn about, and the copy that did not
  // would go on compiling it into a structure that cannot hold it.
  //
  // The SENTENCES are each caller's own and deliberately not shared. The same
  // fact has a different consequence per structure — SQLite REFUSES a clock in
  // an index predicate and ACCEPTS one in a CHECK, where the damage is instead
  // that a row correct when written stops being correct with nothing having
  // touched it — and a refusal that cannot say what this declaration did wrong
  // is the shape `FJS-351` is about.
  //
  // Returns `{ auth, now, crossesModel, unknown, constant }`. `crossesModel` is
  // `check()` and a relation path together: both read another model, and both
  // arrive at the compiler as a subquery.
  //
  // `constant` is a literal standing where a truth value is read. SQLite reads
  // `WHERE 'endedAt IS NULL'` as 0 and accepts it, so a partial unique covered
  // no row and enforced nothing (`FJS-1243`) — and a quoted argument is the
  // reachable spelling, because `@@check("…")` beside it takes SQL.
  function predicateNames(expr, model) {
    let constant
    ;(function truth(n) {
      if (!n || typeof n !== 'object' || constant) return
      if (n.type === 'literal') constant = n
      else if (n.type === 'and' || n.type === 'or') { truth(n.left); truth(n.right) }
      else if (n.type === 'not') truth(n.expr)
    })(expr)

    const named = []
    ;(function walk(n) {
      if (!n || typeof n !== 'object') return
      if (n.type === 'field') named.push(n.name)
      if (n.type === 'auth')  named.push('\0auth')
      if (n.type === 'now')   named.push('\0now')
      if (n.type === 'path')  named.push('\0cross')
      if (n.type === 'check') named.push('\0cross')
      for (const k of ['left', 'right', 'expr', 'cond', 'then', 'else']) walk(n[k])
      if (Array.isArray(n.items)) n.items.forEach(walk)
      if (Array.isArray(n.args))  n.args.forEach(walk)
    })(expr)

    return {
      auth:         named.includes('\0auth'),
      now:          named.includes('\0now'),
      crossesModel: named.includes('\0cross'),
      unknown:      named.filter(n => n[0] !== '\0' && !model.fields.some(f => f.name === n)),
      constant,
    }
  }

  // One sentence for all three callers: the cause is the same and so is the
  // way out, where auth() and now() differ per structure.
  function constantPredicate(label, lit) {
    return typeof lit.value === 'string'
      ? `${label} is the string ${JSON.stringify(lit.value)}, not SQL — SQLite reads a string there as the ` +
        `constant 0, so the predicate admits no row and the rule holds nothing. \`@@check("…")\` takes SQL; ` +
        `this takes an expression, unquoted: \`where: endedAt == null\`, \`where: status == "active"\``
      : `${label} reads the literal ${JSON.stringify(lit.value)} as a truth value — a constant, the same for ` +
        `every row, so the predicate admits all of them or none. Compare a column: \`where: endedAt == null\``
  }

  // ── @@index(where:) — a partial index ───────────────────────────────────────
  //
  // What a predicate may CONTAIN is not a grammar question, and writing one here
  // would be a second statement about the query compiler that goes stale the
  // first time it changes. It is asked instead: compile the predicate, and
  // refuse it if compiling BOUND anything.
  //
  // SQLite proves that a query implies a partial index at PREPARE time, so an
  // index predicate holding `?` can never be matched — and litestone binds every
  // filter value, which means a caller restating the predicate binds it too.
  // A reachable predicate is exactly one that compiles to no parameters, which
  // today is null tests, booleans and their conjunctions. `auth()` and `now()`
  // need no case of their own — both push a parameter — but both get a sentence
  // of their own, because *this binds a value* is not what the author did wrong.
  //
  // The compiled SQL is kept on the attribute and emitted verbatim, so the index
  // predicate and the predicate a query compiles are the same bytes: that is
  // what lets the planner match them, and what keeps the migrator's text
  // comparison exact (FJS-576).
  for (const model of schema.models) {
    const seenIndexNames = new Map()
    for (const attr of model.attributes) {
      // A partial @@unique is a CREATE UNIQUE INDEX, so it is in this loop —
      // but in its OWN name space, `uniq_<table>_<fields>`. The two are
      // different kinds of thing over the same columns and both are legitimate
      // on one model: the ordinary lookup, and *at most one row where the
      // predicate holds*. Sharing the derivation made the second undeclarable
      // (`FJS-614`).
      const partialUnique = attr.kind === 'partialUnique'
      if (attr.kind !== 'index' && !partialUnique) continue
      const word   = partialUnique ? '@@unique' : '@@index'
      const prefix = partialUnique ? 'uniq' : 'idx'

      // Two declarations of the SAME kind over the same columns still derive one
      // name, predicate or not.
      const derived = attr.fields.join('_')
      const key     = `${prefix}:${derived}`
      if (seenIndexNames.has(key)) {
        errors.push(
          `Model '${model.name}': two ${word}([${attr.fields.join(', ')}]) declarations derive the same ` +
          `index name '${prefix}_<table>_${derived}', so the second cannot be created. An index is named for its columns and not ` +
          `for its predicate — give them different column lists, or write one predicate covering both`)
        continue
      }
      seenIndexNames.set(key, attr)

      if (!attr.where) continue

      const names = predicateNames(attr.where, model)

      const where = `${word}([${attr.fields.join(', ')}], where: …)`
      if (names.constant) {
        errors.push(constantPredicate(`Model '${model.name}': ${where}`, names.constant))
        continue
      }
      if (names.auth) {
        errors.push(
          `Model '${model.name}': ${where} names auth(), which is a different answer for every caller — ` +
          `an index is one physical structure shared by all of them. A per-caller narrowing is @@scope or a row policy`)
        continue
      }
      if (names.now) {
        errors.push(partialUnique
          ? `Model '${model.name}': ${where} names now(), so which rows the constraint covers changes under a row that ` +
            `never moved — the index silently stops covering rows it once covered, and on a UNIQUE index that is a ` +
            `duplicate. SQLite ACCEPTS a clock in an index predicate, so nothing below this will refuse it. ` +
            `Compare against a stored column instead`
          : `Model '${model.name}': ${where} names now(), which SQLite refuses in an index predicate — ` +
            `the index would be correct only at the instant it was built. Compare against a stored column instead`)
        continue
      }
      const unknown = names.unknown
      if (unknown.length) {
        errors.push(
          `Model '${model.name}': ${where} names ${unknown.map(u => `'${u}'`).join(', ')}, which ` +
          `${unknown.length > 1 ? 'are not columns' : 'is not a column'} of this model. ` +
          `An index predicate reads the row it indexes and nothing else`)
        continue
      }

      let compiled
      try {
        compiled = compileStatic(attr.where, model.name, schema)
      } catch (e) {
        errors.push(`Model '${model.name}': ${where} could not be compiled — ${e.message}`)
        continue
      }
      if (/\bSELECT\b/i.test(compiled.sql)) {
        errors.push(
          `Model '${model.name}': ${where} compiles to a subquery, which SQLite refuses in an index predicate. ` +
          `An index predicate reads the row it indexes and nothing else`)
        continue
      }
      // Binding nothing is necessary and it is not sufficient, because there are
      // TWO compilers. This one — @@scope, @@allow, the soft-delete injection —
      // and the query builder a caller's own `where` goes through. A predicate
      // only one of them inlines is reachable one way and not the other, which
      // is the silent no-op this rule exists to prevent (FJS-578, where the two
      // disagreed about a boolean until the query builder learned to inline it).
      //
      // Asked of the compiled SQL rather than of the source, so it stays a
      // statement about emitted bytes: what survives the reduction is what one
      // compiler emits and the other cannot.
      // ── the two reachability rules, and they are the INDEX's alone ────────
      //
      // A partial index earns its place by being MATCHED, and SQLite has to
      // prove a query implies it when it PREPARES the query — which is why a
      // predicate the caller's own filter cannot reproduce is a structure
      // maintained on every write and read by nothing.
      //
      // A unique index's job is enforcement on INSERT and enforcement does not
      // go through the planner at all. `where: status == "active"` is a correct
      // constraint that happens to be a useless read path, where the same
      // predicate on @@index is nothing but a useless read path. So the rule
      // that follows is not a correctness rule here, and applying it would
      // refuse most of the partial uniques that exist in the wild.
      if (partialUnique) {
        // …but SQLite's OWN refusal still applies and is a different rule:
        // `parameters prohibited in partial index WHERE clauses`. The compiler
        // binds every value, so a predicate that compares against one arrives
        // here as `? ` and the CREATE fails at migration time, naming a table
        // the author is no longer looking at. The literals are inlined instead,
        // which is what makes `where: status == "active"` — the commonest
        // partial unique there is — expressible at all.
        //
        // Safe because these are the SCHEMA's own literals and never a caller's:
        // nothing reaches this that a person did not write into the .lite file.
        // Anything that is not a plain literal is refused rather than guessed at.
        const bad = compiled.params.find(v =>
          v !== null && !['string', 'number', 'boolean'].includes(typeof v))
        if (bad !== undefined) {
          errors.push(
            `Model '${model.name}': ${where} compares against a value this cannot write into an index predicate ` +
            `(${JSON.stringify(bad)}). SQLite prohibits a bound parameter there, so the value has to be a literal ` +
            `string, number, boolean or null`)
          continue
        }
        attr.whereSql = inlineParams(compiled.sql, compiled.params)
        continue
      }

      const residue = compiled.sql
        .replace(/"[^"]+"/g, ' ')
        .replace(/\bIS\s+(NOT\s+)?NULL\b/gi, ' ')
        .replace(/[=!]=?\s*[01]\b/g, ' ')          // a boolean — both inline it
        .replace(/\b(AND|OR|NOT)\b/gi, ' ')
        .replace(/[()\s]/g, '')
      if (!compiled.params.length && residue) {
        errors.push(
          `Model '${model.name}': ${where} compiles to \`${compiled.sql}\`, which a caller's own filter cannot ` +
          `reproduce — so SQLite could never prove a query implies this index and it would be matched by nothing. ` +
          `Reachable predicates are the ones both compilers write as literal SQL: 'col == null', 'col != null', ` +
          `'col == true', 'col == false', and those joined with && or ||`)
        continue
      }
      if (compiled.params.length) {
        errors.push(
          `Model '${model.name}': ${where} compares against a value, and a partial index over one cannot be reached. ` +
          `SQLite has to prove a query implies the index when it PREPARES the query, and litestone binds every filter ` +
          `value as a parameter — so '${policyExprToString(attr.where)}' would be matched by nothing and maintained on ` +
          `every write. Reachable predicates are the ones that bind nothing: 'col == null', 'col != null', ` +
          `'col == true', and those joined with && or ||`)
        continue
      }
      // The declaration a @@softDelete model already makes. Refused rather than
      // deduped, for FJS-480's reason and in its words: what a dedupe would
      // preserve is the ability to write a line with no effect, and this is the
      // line a converter writes — `WHERE deleted_at IS NULL` is the commonest
      // predicate there is, and on such a model it is already implied.
      // (SQLite does reach the doubled index, so this is coherence and not a
      // correctness fix — measured.)
      if (compiled.sql === '"deletedAt" IS NULL' && model.attributes.some(a => a.kind === 'softDelete')) {
        errors.push(
          `Model '${model.name}': ${where} is the clause @@softDelete already gives every index on this model — ` +
          `the declaration changes nothing. Remove the 'where:', or narrow it to something @@softDelete does not say`)
        continue
      }

      attr.whereSql = compiled.sql
    }
  }

  // A compiled predicate's `?` placeholders replaced by their own literals.
  // Quoted regions are stepped over rather than assumed absent, so a `?` inside
  // a string the compiler did emit cannot consume a parameter.
  function inlineParams(sql, params) {
    let out = '', i = 0, quote = null
    for (const ch of sql) {
      if (quote) { out += ch; if (ch === quote) quote = null; continue }
      if (ch === "'" || ch === '"') { quote = ch; out += ch; continue }
      if (ch === '?') { out += literalSql(params[i++]); continue }
      out += ch
    }
    return out
  }

  function literalSql(v) {
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'boolean') return v ? '1' : '0'
    if (typeof v === 'number')  return String(v)
    return `'${String(v).replace(/'/g, "''")}'`
  }

  // ── @@unique over a NULLABLE column ─────────────────────────────────────────
  //
  // Two NULLs never compare equal, so a UNIQUE index admits `(1, NULL, NULL)`
  // twice. Measured — two identical creates both succeed and the model holds
  // two rows, while the same pair with values is refused. The constraint works
  // exactly where it was never in doubt.
  //
  // COMPOSITE only, and the asymmetry is the point. On one optional column
  // `@unique` has a single reading — unique when present — and every SQL
  // developer already holds it. On a tuple the reading is the tuple, and the
  // shape that surfaced this was `@@unique([product, color, size])`, where the
  // no-color/no-size variant is precisely the row a shop lists twice.
  //
  // Two answers now, and they are one word apart in English, so the sentence
  // has to separate them. `nullsDistinct: true` says *the rows that leave it
  // unset are deliberately unconstrained*; `where:` says *at most one of them
  // is meant to exist*. The second is what an effective-dated model wants — an
  // open row is the one with a NULL end — and reaching it means dropping the
  // nullable column OUT of the tuple and putting it in the predicate, which is
  // why the suggestion is spelled with the column list changed.
  //
  // Making the whole tuple conditional on the NULL member being present is
  // still not offered: that is FJS-204's derivation, and it makes the
  // constraint false for any read that includes those rows.
  for (const model of schema.models) {
    for (const c of model.attributes) {
      const partial = c.kind === 'partialUnique'
      if ((c.kind !== 'uniqueIndex' && !partial) || !Array.isArray(c.fields)) continue
      if (c.fields.length < 2 || c.nullsDistinct) continue
      // A predicate conjunct `col != null` leaves no NULL of that column in the
      // index, so the column is not optional as far as the constraint goes.
      const excluded = partial ? nonNullConjuncts(c.where) : new Set()
      const nullable = c.fields.filter(name => !excluded.has(name) &&
        model.fields.find(f => f.name === name)?.type.optional)
      if (!nullable.length) continue
      const many = nullable.length > 1
      const rest  = c.fields.filter(n => !nullable.includes(n))
      const label = `@@unique([${c.fields.join(', ')}]${partial ? ', where: …' : ''})`
      // Only offered where something is LEFT to be unique over: a tuple whose
      // every member is optional has no narrower constraint to fall back to.
      const move  = rest.length
        ? `@@unique([${rest.join(', ')}], where: ${nullable[0]} == null)`
        : null
      const ways = partial
        ? `Make ${many ? 'them' : 'it'} required with a @default` +
          (move ? `, or move ${many ? 'them' : 'it'} out of the tuple and into the predicate — ${move} is *at most one ` +
                  `row with no ${nullable[0]}*, which is usually what a tuple like this was reaching for` : '')
        : `Make ${many ? 'them' : 'it'} required with a @default; declare ` +
          `@@unique([${c.fields.join(', ')}], nullsDistinct: true) if those rows are deliberately unconstrained` +
          (move ? `; or, if at most ONE of them is meant to exist, put the column in a predicate instead — ${move}` : '')
      errors.push(
        `Model '${model.name}': ${label} cannot be enforced — ` +
        `${nullable.map(n => `'${n}'`).join(', ')} ${many ? 'are' : 'is'} optional, and two NULLs never compare equal, ` +
        `so rows that leave ${many ? 'them' : 'it'} unset are all distinct to the index. ${ways}`)
    }
  }

  // ── @@arc validation ────────────────────────────────────────────────────────
  //
  // The constraint is derived from the member list rather than typed, so the
  // failure this catches is a renamed or mistyped column: a hand-written
  // @@check naming a column that is gone is a string nothing validates, and
  // SQLite reports it at migration time against a table the author is no longer
  // looking at.
  //
  // A REQUIRED member is refused because it makes the arc unsatisfiable or
  // meaningless — two required members can never sum to one, and one required
  // member among optionals is a column that is always the answer.
  for (const model of schema.models) {
    for (const a of model.attributes) {
      if (a.kind !== 'arc' || !Array.isArray(a.fields)) continue

      if (a.fields.length < 2) {
        errors.push(
          `Model '${model.name}': @@arc([${a.fields.join(', ')}]) needs at least two members — ` +
          `an arc is a choice between columns, and with one there is nothing to choose. ` +
          `Make the column required, or write the rule as @@check`)
        continue
      }

      const seen = new Set()
      const dupes = a.fields.filter(n => seen.size === seen.add(n).size)
      if (dupes.length)
        errors.push(
          `Model '${model.name}': @@arc([${a.fields.join(', ')}]) names ` +
          `${[...new Set(dupes)].map(n => `'${n}'`).join(', ')} more than once`)

      // An unknown member is already reported by the generic model-attribute
      // field-ref check, which covers every @@attr carrying a `fields` array.
      // Skip rather than restate it — and skip so the required test below does
      // not also report a column that is not there.
      if (a.fields.some(n => !model.fields.find(f => f.name === n))) continue

      const required = a.fields.filter(n => !model.fields.find(f => f.name === n)?.type.optional)
      if (required.length) {
        const many = required.length > 1
        errors.push(
          `Model '${model.name}': @@arc([${a.fields.join(', ')}]) cannot be enforced — ` +
          `${required.map(n => `'${n}'`).join(', ')} ${many ? 'are' : 'is'} required, and a member that is ` +
          `always set is always the answer. Make ${many ? 'them' : 'it'} optional`)
      }
    }
  }

  // ── @allow (field-level) validation ─────────────────────────────────────────
  for (const model of schema.models) {
    for (const field of model.fields) {
      const fieldAllows = field.attributes.filter(a => a.kind === 'fieldAllow')
      if (!fieldAllows.length) continue

      // @allow on field conflicts with @guarded/@secret — those are system-only locks
      if (field.attributes.some(a => a.kind === 'guarded'))
        errors.push(`Model '${model.name}', field '${field.name}': @allow conflicts with @guarded — use one or the other`)
      if (field.attributes.some(a => a.kind === 'secret'))
        errors.push(`Model '${model.name}', field '${field.name}': @allow conflicts with @secret — @secret already implies @guarded`)
    }
  }

  // ── @sequence validation ────────────────────────────────────────────────────
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (!field.attributes.some(a => a.kind === 'sequence')) continue
      if (field.type.name !== 'Int')
        errors.push(`Model '${model.name}', field '${field.name}': @sequence requires an Integer or Integer? field, got ${field.type.name}`)
      const seqAttr = field.attributes.find(a => a.kind === 'sequence')
      const scopeField = model.fields.find(f => f.name === seqAttr.scope)
      if (!scopeField)
        errors.push(`Model '${model.name}', field '${field.name}': @sequence(scope: ${seqAttr.scope}) — field '${seqAttr.scope}' does not exist on this model`)
    }
  }

  // ── @version validation ─────────────────────────────────────────────────────
  // A row has one version or none. Two would each be a partial answer to "is this
  // the row I read", and a caller could satisfy one while the other had moved.
  for (const model of schema.models) {
    const versioned = model.fields.filter(f => f.attributes.some(a => a.kind === 'version'))
    if (!versioned.length) continue
    if (versioned.length > 1)
      errors.push(`Model '${model.name}': @version declared on ${versioned.map(f => `'${f.name}'`).join(' and ')} — a model has at most one version field`)
    for (const field of versioned) {
      if (field.type.name !== 'Int')
        errors.push(`Model '${model.name}', field '${field.name}': @version requires an Int field, got ${field.type.name}`)
      // Nullable would mean "this row has no version", and every update against it
      // would have nothing to compare — a silent hole in the guarantee.
      if (field.type.optional)
        errors.push(`Model '${model.name}', field '${field.name}': @version cannot be optional — a row with no version cannot be checked`)
      if (field.attributes.some(a => a.kind === 'id'))
        errors.push(`Model '${model.name}', field '${field.name}': @version cannot be the @id — the version changes on every write`)
    }
  }

  // ── @big validation ─────────────────────────────────────────────────────────
  // The declaration says *this column's values use the whole 64 bits*, so every
  // way of declaring one that cannot hold 64 bits is refused rather than
  // producing a column that quietly narrows.
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (!field.attributes.some(a => a.kind === 'big')) continue
      const at = `Model '${model.name}', field '${field.name}'`

      // Int, and the type stays true — same rule @scale follows (`FJS-D142`).
      // SQLite's INTEGER is the only storage class that is 64-bit; a REAL column
      // is the double this attribute exists to get away from.
      if (field.type.name !== 'Int')
        errors.push(`${at}: @big requires an Int field, got ${field.type.name} — only an integer column holds 64 bits`)

      // An array is stored as JSON text, and JSON's number IS the double.
      if (field.type.array)
        errors.push(`${at}: @big cannot be an array — an array column is stored as JSON, whose number is the double @big exists to get past. Declare a String[] and hold the digits.`)

      // @scale and @money bound the column to ±2^53 with a CHECK, deliberately,
      // because their promise is a round trip through a JS number (`FJS-583`).
      // @big is the opposite statement about the same column.
      for (const kind of ['scale', 'money']) {
        if (field.attributes.some(a => a.kind === kind))
          errors.push(`${at}: @big and @${kind} together — @${kind} bounds the column to ±${EXACT_INT_MAX} so its value round-trips through a JS number, which is the thing @big lifts. State one.`)
      }
    }
  }

  // ── @point validation ───────────────────────────────────────────────────────
  //
  // Every refusal here is a shape that would otherwise produce a column pair
  // extracting from something that cannot hold a coordinate — and a generated
  // column over the wrong bytes does not fail, it answers NULL, which reads
  // downstream as *this row has no location*.
  for (const model of schema.models) {
    const declared = new Set(model.fields.map(f => f.name))
    for (const field of model.fields) {
      const pt = field.attributes.find(a => a.kind === 'point')
      if (!pt) continue
      const at = `Model '${model.name}', field '${field.name}'`

      if (field.type.name !== 'Json')
        errors.push(`${at}: @point requires a Json field, got ${field.type.name} — a point is an object with two keys`)
      if (field.type.array)
        errors.push(`${at}: @point cannot be an array — the attribute describes one coordinate`)
      if (pt.lat === pt.lng)
        errors.push(`${at}: @point(${pt.lat}, ${pt.lng}) names one key twice`)

      // The value has to be readable as JSON by the database. Ciphertext is
      // not: `json_extract` over it answers NULL for every row, so the point
      // would be silently absent everywhere rather than refused once.
      for (const kind of ['encrypted', 'secret']) {
        if (field.attributes.some(a => a.kind === kind))
          errors.push(`${at}: @point cannot be combined with @${kind} — the coordinate is extracted in SQL, and ciphertext reads as no location at all`)
      }

      // No column to extract from.
      for (const kind of ['computed', 'from', 'derived', 'transient', 'edge']) {
        if (field.attributes.some(a => a.kind === kind))
          errors.push(`${at}: @point needs a stored column and @${kind} is not one`)
      }

      for (const [key, col] of Object.entries(pointColumnNames(field.name, pt))) {
        if (declared.has(col))
          errors.push(`${at}: @point would derive a column '${col}' for '${key}', and the model already declares a field with that name`)
      }

      // Rule 2 of `FJS-D317`: where a type is declared beside the attribute,
      // the coordinate keys must exist IN it, or the point validates and never
      // matches anything.
      const typeAttr = field.attributes.find(a => a.kind === 'type')
      if (typeAttr) {
        const decl = (schema.types ?? []).find(t => t.name === typeAttr.name)
        if (decl) {
          for (const key of [pt.lat, pt.lng]) {
            const member = decl.fields.find(f => f.name === key)
            if (!member) {
              errors.push(`${at}: @point names '${key}', which type '${decl.name}' does not declare`)
            } else if (!['Float', 'Int'].includes(member.type.name)) {
              errors.push(`${at}: @point names '${key}', which type '${decl.name}' declares as ${member.type.name} — a coordinate is a number`)
            }
          }
        }
      }
    }
  }

  // ── @vector validation ──────────────────────────────────────────────────────
  //
  // `FJS-1193`. Every refusal here is a shape where the comparison would be
  // computed over bytes that are not a vector — and that does not fail loudly:
  // a wrong length throws at the first read, but a wrong COLUMN silently ranks
  // rows by nonsense, which reads exactly like a working similarity search.
  for (const model of schema.models) {
    for (const field of model.fields) {
      const vec = field.attributes.find(a => a.kind === 'vector')
      if (!vec) continue
      const at = `Model '${model.name}', field '${field.name}'`

      if (field.type.name !== 'Bytes')
        errors.push(`${at}: @vector requires a Bytes field, got ${field.type.name} — a vector is a BLOB of float32`)
      if (field.type.array)
        errors.push(`${at}: @vector cannot be an array — the attribute describes one vector`)
      if (!Number.isInteger(vec.dim) || vec.dim < 1)
        errors.push(`${at}: @vector(${vec.dim}) — the dimension is a positive whole number of float32 values`)

      // The bytes are compared arithmetically, so anything that changes them
      // between write and read makes every distance meaningless. Ciphertext is
      // the sharp one: it reads as a valid blob of the right length under
      // deterministic encryption and ranks by nothing at all.
      for (const kind of ['encrypted', 'secret', 'hashed']) {
        if (field.attributes.some(a => a.kind === kind))
          errors.push(`${at}: @vector cannot be combined with @${kind} — the distance is computed over the stored bytes, and encoded bytes rank by nothing`)
      }

      // No column to compare.
      for (const kind of ['computed', 'from', 'derived', 'transient', 'edge']) {
        if (field.attributes.some(a => a.kind === kind))
          errors.push(`${at}: @vector needs a stored column and @${kind} is not one`)
      }

      // A vector is 6 kB of float32 that is equal to nothing and orders as
      // opaque text. `@unique` builds an index over it, and `@@fts` would
      // tokenize it — both are real DDL over bytes no reader can use.
      if (field.attributes.some(a => a.kind === 'unique'))
        errors.push(`${at}: @vector cannot be @unique — two embeddings are near or far, never equal`)
      if (field.attributes.some(a => a.kind === 'id'))
        errors.push(`${at}: @vector cannot be @id — a row is not identified by what it means`)
      if ((model.attributes ?? []).some(a => a.kind === 'fts' && (a.fields ?? []).includes(field.name)))
        errors.push(`${at}: @vector cannot be named in @@fts — FTS5 indexes text, and these bytes are not text`)

      // The ordering stamps the computed distance on the row under a fixed name
      // (`FJS-D329`), so a column already called that would be overwritten with
      // a float on every similarity read and hold its own value on every other
      // one. Refused here rather than at the read, the way findMany({ recursive })
      // refuses a field named `_depth`: this model DECLARES a vector, so the
      // collision is decidable from the schema alone.
      if (model.fields.some(f => f.name === '_distance'))
        errors.push(`${at}: model '${model.name}' declares a field named '_distance', which the similarity ordering writes the computed distance to`)
    }
  }

  // ── @scale / @money validation ──────────────────────────────────────────────
  // The point of the pair is exactness, so every way of declaring one that
  // cannot be exact is refused here rather than producing a plausible number.
  for (const model of schema.models) {
    for (const field of model.fields) {
      const scale = field.attributes.find(a => a.kind === 'scale')
      const money = field.attributes.find(a => a.kind === 'money')
      if (!scale && !money) continue

      const at = `Model '${model.name}', field '${field.name}'`

      // `Int`, and the type stays true. A scaled value stored in a REAL column
      // is the drift the declaration exists to remove, and an attribute that
      // silently overrode its own type would mean `Float` means two things
      // depending on a token further down the line (`FJS-D142`).
      if (field.type.name !== 'Int')
        errors.push(`${at}: @${scale ? 'scale' : 'money'} requires an Int field, got ${field.type.name} — a scaled value is stored as an integer`)

      if (field.type.array)
        errors.push(`${at}: @${scale ? 'scale' : 'money'} cannot be an array — the scale describes one value`)

      // Both would be two answers to what the point means, and the currency's
      // is the one that is not the author's to choose.
      if (scale && money)
        errors.push(`${at}: @scale and @money together — @money derives the scale from the currency, so state one`)

      if (scale) {
        const n = scale.places
        if (!Number.isInteger(n) || n < 0)
          errors.push(`${at}: @scale(${n}) — the number of places must be a whole number, 0 or more`)
        // A signed 64-bit integer holds about 9.2e18. At nine places that still
        // leaves nine figures of major units, and past it the headroom goes
        // where nobody is looking.
        else if (n > 9)
          errors.push(`${at}: @scale(${n}) — at most 9 places, or the integer runs out of room for the value in front of the point`)
      }

      if (money) {
        if (money.currency && !isKnownCurrency(money.currency))
          errors.push(`${at}: @money(${money.currency}) — not an ISO 4217 currency. The scale comes from the currency, so a code nobody recognizes would silently take two places`)

        if (money.field) {
          const sibling = model.fields.find(f => f.name === money.field)
          if (!sibling)
            errors.push(`${at}: @money(field: ${money.field}) — no field '${money.field}' on this model`)
          else if (sibling.type.name !== 'String')
            errors.push(`${at}: @money(field: ${money.field}) — '${money.field}' holds the ISO code and must be String, got ${sibling.type.name}`)
          else if (sibling.type.array)
            errors.push(`${at}: @money(field: ${money.field}) — '${money.field}' must be one code, not an array`)
        }
      }
    }
  }

  // ── @unit validation ────────────────────────────────────────────────────────
  // The attribute's whole contract is that the symbol resolves to a dimension —
  // that is what a form, an agent and the atlas read off it. A symbol that
  // resolves to nothing is therefore a declaration that cannot be EXPRESSED
  // rather than one that is merely wrong, which is the line `FJS-721` draws
  // between this file and `advise.js`; it is the same reason `@money(XYZ)` is
  // refused here, where the unknown code is what the scale would have come from.
  //
  // The walk covers `type` blocks as well as models, and that is not symmetry
  // for its own sake: `@scale`/`@money` are refused inside a `type` outright
  // (there is no column to scale), so their own validation never had to look
  // there, while `@unit` is a statement about a number and is as true of one
  // inside a Json document. The attribute loop in `jsonschema.js` already emits
  // it for both, so a rule that read only the models would have left exactly
  // the declaration this feature exists to remove — stated, emitted, and
  // resolving to nothing.
  for (const owner of [...schema.models.map(m => ['Model', m]), ...(schema.types ?? []).map(t => ['Type', t])]) {
    const [kind, model] = owner
    for (const field of model.fields) {
      const unit = field.attributes.find(a => a.kind === 'unit')
      if (!unit) continue

      const at = `${kind} '${model.name}', field '${field.name}'`

      if (!isKnownUnit(unit.symbol)) {
        const near = suggestUnit(unit.symbol)
        errors.push(near
          ? `${at}: @unit(${unit.symbol}) — no such unit. Did you mean '${near}'? A unit's case is part of it`
          : `${at}: @unit(${unit.symbol}) — no such unit. One of: ` +
            Object.entries(MEASURE_UNITS).map(([d, u]) => `${d} ${u.join(' ')}`).join(' · '))
        continue
      }

      // A unit says what a NUMBER counts, so there has to be a number. A
      // String column carrying '5kg' is a value nothing can compare, order or
      // sum, which is the shape the declaration exists to replace.
      if (field.type.name !== 'Int' && field.type.name !== 'Float')
        errors.push(`${at}: @unit requires an Int or Float field, got ${field.type.name} — a unit counts a number`)

      if (field.type.array)
        errors.push(`${at}: @unit cannot be an array — the unit describes one value`)

      // Two answers to what the number means. A currency IS a unit, which is
      // why `@money` needs no `@unit` beside it — and `@scale` composes, being
      // about where the point sits rather than about what is counted.
      if (field.attributes.some(a => a.kind === 'money'))
        errors.push(`${at}: @unit and @money together — a currency is already the unit, so state one`)
    }
  }

  // ── @@external validation ────────────────────────────────────────────────────
  for (const model of schema.models) {
    if (!model.attributes.some(a => a.kind === 'external')) continue
    if (model.attributes.some(a => a.kind === 'softDelete'))
      warnings.push(`Model '${model.name}': @@external + @@softDelete — Litestone won't manage this table, soft delete triggers won't be set up`)
    if (model.attributes.some(a => a.kind === 'fts'))
      warnings.push(`Model '${model.name}': @@external + @@fts — FTS5 virtual table and triggers won't be created by Litestone`)
  }

  // ── @from validation ────────────────────────────────────────────────────────
  for (const model of schema.models) {
    for (const field of model.fields) {
      const fromAttr = field.attributes.find(a => a.kind === 'from')
      if (!fromAttr) continue
      const { target, op, opValue } = fromAttr
      // Target model must exist
      const targetModel = schema.models.find(m => m.name === target)
      if (!targetModel)
        errors.push(`Model '${model.name}', field '${field.name}': @from(${target}, ...) — unknown model '${target}'`)
      // Type compatibility checks
      if (op === 'last' || op === 'first') {
        if (field.type.name !== target)
          errors.push(`Model '${model.name}', field '${field.name}': @from(${target}, ${op}: true) — field type must be '${target}' or '${target}?', got '${field.type.name}'`)
      }
      if (op === 'count' && field.type.name !== 'Int')
        errors.push(`Model '${model.name}', field '${field.name}': @from(${target}, count: true) — field type must be Integer, got '${field.type.name}'`)
      if (op === 'exists' && field.type.name !== 'Boolean')
        errors.push(`Model '${model.name}', field '${field.name}': @from(${target}, exists: true) — field type must be Boolean, got '${field.type.name}'`)
      // sum/max/min: target field must exist on target model
      if ((op === 'sum' || op === 'max' || op === 'min') && targetModel) {
        const targetField = targetModel.fields.find(f => f.name === opValue)
        if (!targetField)
          errors.push(`Model '${model.name}', field '${field.name}': @from(${target}, ${op}: ${opValue}) — field '${opValue}' does not exist on '${target}'`)
      }
      // A relation must actually join the two models. Same inference the SQL
      // builder runs, so the two cannot disagree: if this passes, buildFromMap
      // produces a subquery; if it fails, buildFromMap would have skipped the
      // field and the column would be absent from every row with no error.
      const fromFk = targetModel ? inferFromFk(model, targetModel, fromAttr.via) : null
      if (targetModel && !fromFk)
        errors.push(`Model '${model.name}', field '${field.name}': @from(${target}, ...) — no relation from '${target}' back to '${model.name}'. Declare '${target}.${lowerFirst(model.name)} ${model.name} @relation(fields: [...], references: [...])'`)
      // More than one relation joins the two models, so the field has to say
      // which. Refused rather than resolved by declaration order: the wrong
      // choice answers a plausible number for the other question, and nothing
      // about the value it returns says which relation produced it.
      if (fromFk?.ambiguous)
        errors.push(
          `Model '${model.name}', field '${field.name}': @from(${target}, ...) is ambiguous — ` +
          `${fromFk.ambiguous.length} relations join '${model.name}' and '${target}' ` +
          `(${fromFk.ambiguous.map(c => `${target}.${c.field}`).join(', ')}). ` +
          `Say which with via: — @from(${target}, ..., via: ${fromFk.ambiguous[0].field})`)
      if (fromFk?.unresolvedVia)
        errors.push(
          `Model '${model.name}', field '${field.name}': @from(${target}, ..., via: ${fromFk.unresolvedVia}) — ` +
          `'${fromFk.unresolvedVia}' names no relation between '${model.name}' and '${target}'. ` +
          `Candidates: ${fromFk.candidates.map(c => `${target}.${c.field}`).join(', ') || '(none)'}`)
      // Can't mix with other virtual attributes
      if (field.attributes.some(a => a.kind === 'computed'))
        errors.push(`Model '${model.name}', field '${field.name}': @from conflicts with @computed`)
    }
  }

  // ── Enum transition validation ───────────────────────────────────────────────
  for (const e of schema.enums) {
    if (!e.transitions) continue
    const valueNames = new Set(e.values.map(v => v.name))
    for (const [tName, { from, to }] of Object.entries(e.transitions)) {
      for (const f of from) {
        if (!valueNames.has(f))
          errors.push(`Enum '${e.name}' transition '${tName}': unknown value '${f}' in 'from'`)
      }
      if (!valueNames.has(to))
        errors.push(`Enum '${e.name}' transition '${tName}': unknown value '${to}' in 'to'`)
      if (from.includes(to))
        errors.push(`Enum '${e.name}' transition '${tName}': self-transition (from and to are the same value '${to}')`)
    }
  }

  // ── @@transitions validation ────────────────────────────────────────────────
  // Attributes carrying `fromEnum` were desugared from an enum block by
  // resolveTransitions() — the loop above already checked their values, and the
  // field is an enum field by construction. Only hand-written ones land here.
  for (const model of schema.models) {
    const seenFields = new Set()
    const seenMoves  = new Map()
    for (const attr of model.attributes) {
      if (attr.kind !== 'transitions') continue

      if (seenFields.has(attr.field))
        errors.push(`Model '${model.name}': two @@transitions declared for field '${attr.field}' — merge them into one`)
      seenFields.add(attr.field)

      // transition(id, name) takes the first machine that declares the name,
      // so the second would be a move nothing can make.
      for (const name of Object.keys(attr.transitions ?? {})) {
        const other = seenMoves.get(name)
        if (other !== undefined && other !== attr.field)
          errors.push(`Model '${model.name}': the move '${name}' is declared on @@transitions(${other}) and ` +
                      `@@transitions(${attr.field}) — transition(id, '${name}') would make the first and never ` +
                      `the second. Name one of them differently.`)
        else seenMoves.set(name, attr.field)
      }

      if (attr.fromEnum) continue

      const field = model.fields.find(f => f.name === attr.field)
      if (!field) {
        errors.push(`Model '${model.name}': @@transitions(${attr.field}) — no such field`)
        continue
      }
      // A state machine needs a CLOSED type, which is what makes a from-state
      // decidable. An enum is one and so is Boolean — `isPrimary`, `isSuspended`
      // and `isPublished` are the two-state machines every schema has, and the
      // two directions are routinely different authorities, which is what the
      // per-move @gate expresses and a single field @allow cannot.
      const enumDef  = schema.enums.find(e => e.name === field.type.name)
      const isBool   = field.type.name === 'Boolean'
      if (!enumDef && !isBool) {
        errors.push(
          `Model '${model.name}': @@transitions(${attr.field}) — '${attr.field}' is ${field.type.name}, ` +
          `which is not a closed type. A from-state has to be decidable, so the field must be an enum or Boolean.`
        )
        continue
      }
      if (field.type.array)
        errors.push(`Model '${model.name}': @@transitions(${attr.field}) — '${attr.field}' is an array; a state machine needs a single value`)

      const valueNames = enumDef ? new Set(enumDef.values.map(v => v.name)) : null
      const known = (v) => isBool ? typeof v === 'boolean' : valueNames.has(v)
      const wanted = isBool ? 'true or false' : `a member of enum '${enumDef.name}'`
      for (const [tName, { from, to, gate }] of Object.entries(attr.transitions)) {
        for (const f of from)
          if (!known(f))
            errors.push(`Model '${model.name}' @@transitions(${attr.field}) '${tName}': unknown value '${f}' in 'from' — expected ${wanted}`)
        if (!known(to))
          errors.push(`Model '${model.name}' @@transitions(${attr.field}) '${tName}': unknown value '${to}' in 'to' — expected ${wanted}`)
        if (from.includes(to))
          errors.push(`Model '${model.name}' @@transitions(${attr.field}) '${tName}': self-transition (from and to are both '${to}')`)
        if (gate != null && (!Number.isInteger(gate) || gate < 0 || gate > 9))
          errors.push(`Model '${model.name}' @@transitions(${attr.field}) '${tName}': @gate level must be an integer 0–9, got ${gate}`)
      }
    }
  }

  // ── @seals / @sealed validation ─────────────────────────────────────────────
  // Two attributes, one feature: @seals says WHEN a row becomes a document and
  // @sealed says which children are part of it. Each is meaningless without the
  // other half being possible, so every refusal here names the half that is
  // missing rather than the half that is present.
  for (const model of schema.models) {
    const sealedFields = model.fields.filter(f => f.attributes.some(a => a.kind === 'sealed'))
    const seals = model.attributes.map(sealedStates).find(Boolean) ?? null

    for (const field of sealedFields) {
      // @sealed is about a set of ROWS that belong to this one. On a scalar
      // there is no set — the column freezing is what @immutable already says.
      if (field.type.kind !== 'relation' && field.type.kind !== 'implicitM2M') {
        errors.push(
          `Model '${model.name}', field '${field.name}': @sealed is for the children a document is made of, ` +
          `and '${field.name}' is not a relation. To freeze a column, use @immutable.`)
        continue
      }
      // The belongsTo side names ONE parent, and a child cannot know when its
      // parent's machine moved. Declared there it would have to name a state,
      // which is the second source of truth @seals exists to remove.
      if (field.attributes.some(a => a.kind === 'relation' && a.fields)) {
        errors.push(
          `Model '${model.name}', field '${field.name}': @sealed goes on the side that OWNS the children — ` +
          `sealing is the parent's event. Move it to the '${field.type.name}[]' field on '${field.type.name}'.`)
        continue
      }
      if (!seals)
        errors.push(
          `Model '${model.name}', field '${field.name}': @sealed says these children seal with the row, and ` +
          `nothing seals '${model.name}'. Mark the move that issues it — @@transitions(<field>, <move>: … @seals).`)
    }

    if (!seals) continue

    // A seal that freezes nothing is a typo, not a no-op: the move parses, the
    // artefacts render it, and no write is ever refused.
    const hasImmutable = model.fields.some(f => f.attributes.some(a => a.kind === 'immutable'))
    if (!sealedFields.length && !hasImmutable)
      errors.push(
        `Model '${model.name}': @@transitions(${seals.field}) '${seals.moves[0]}' declares @seals and there is ` +
        `nothing to seal — '${model.name}' has no @immutable column and no @sealed relation.`)

    // A seal is made from an unsealed state. A from-state that is already
    // sealed is one of two different mistakes, and which seal put it there is
    // what tells them apart.
    for (const fault of sealFaults(model.attributes.find(a => a.kind === 'transitions' && a.field === seals.field))) {
      errors.push(fault.kind === 'unseals'
        ? `Model '${model.name}': @@transitions(${seals.field}) '${fault.move}' — '${fault.state}' is both the ` +
          `state this move seals FROM and one the row can reach afterwards, so the same value means sealed and ` +
          `unsealed. A document that unseals is not a document: issue a correcting row beside it instead.`
        : `Model '${model.name}': @@transitions(${seals.field}) '${fault.move}' — the row is already sealed by ` +
          `'${fault.by}' before this move runs, so @seals on it seals nothing. Drop it: everything reachable ` +
          `from a seal is sealed already.`)
    }
  }

  // ── a single-valued attribute, answered twice ───────────────────────────────
  //
  // Every consumer reads a model attribute with `.find(a => a.kind === …)`, so
  // a second one is not merged and not preferred — it is ignored, in source
  // order, with nothing said. The shape that bites is somebody TIGHTENING a
  // gate by writing the stricter one underneath the old one: the schema reads
  // as tightened and the boundary is unchanged ([FJS-1174](ISSUES.md#fjs-1174)).
  //
  // The refusal names the word as typed and both answers, because *declared
  // twice* is not useful on its own — what the reader needs is which of the two
  // has been in force.
  for (const model of schema.models) {
    const seenModel = new Map()
    for (const attr of model.attributes ?? []) {
      if (REPEATABLE_MODEL_ATTRS.has(attr.kind)) continue
      const first = seenModel.get(attr.kind)
      if (first === undefined) { seenModel.set(attr.kind, attr); continue }
      errors.push(
        `Model '${model.name}': @@${typedAttr(attr.kind)} is declared twice and it takes one answer. ` +
        `${attrAnswer(first)} is the one in force; ${attrAnswer(attr, '@@', 'the second')} is ignored. Keep one.`)
    }

    for (const field of model.fields ?? []) {
      const seenField = new Map()
      for (const attr of field.attributes ?? []) {
        if (REPEATABLE_FIELD_ATTRS.has(attr.kind)) continue
        const first = seenField.get(attr.kind)
        if (first === undefined) { seenField.set(attr.kind, attr); continue }
        errors.push(
          `Model '${model.name}', field '${field.name}': @${typedAttr(attr.kind)} is declared twice and ` +
          `it takes one answer. ${attrAnswer(first, '@')} is the one in force; ${attrAnswer(attr, '@', 'the second')} is ` +
          `ignored. Keep one.`)
      }
    }
  }

  // ── @allow / @@deny validation ──────────────────────────────────────────────
  for (const model of schema.models) {
    for (const attr of model.attributes) {
      if (attr.kind !== 'allow' && attr.kind !== 'deny') continue
      // Operations already validated by normalizePolicyOps at parse time.
      // Warn if model is on a jsonl database — policies aren't supported there.
      const dbAttr = model.attributes.find(a => a.kind === 'db')
      if (dbAttr) {
        const dbDef = schema.databases.find(d => d.name === dbAttr.name)
        if (dbDef?.driver === 'jsonl')
          errors.push(`Model '${model.name}': @@${attr.kind} policies are not supported on jsonl databases`)
      }
    }
    // Warn if @@deny exists with no @@allow — probably a mistake, and the
    // wording matters. A deny DOES restrict the operations it names: measured,
    // a lone `@@deny('update', …)` filters an update out. What stays open is
    // every operation it does not name, which is the thing worth saying. The
    // old text said the deny would not restrict at all, which reads as "this
    // declaration is inert" about a rule that is working.
    const hasAllow = model.attributes.some(a => a.kind === 'allow')
    // Generated rules are excluded: tenancy desugars into denies on every
    // scoped model, and a warning telling an app to add an @@allow it never
    // wrote fires once per model on a schema that is doing the right thing.
    const hasDeny  = model.attributes.some(a => a.kind === 'deny' && !a.generated)
    if (hasDeny && !hasAllow)
      warnings.push(
        `Model '${model.name}': has @@deny and no @@allow. The deny restricts the operations it names; ` +
        `every OTHER operation stays unrestricted, because a model with no @@allow for an operation is open. ` +
        `If that is the intent this is nothing to fix — say so with an @@allow naming the level you mean.`)
  }

  // ── Logger database validation ────────────────────────────────────────────────
  for (const db of schema.databases) {
    if (db.driver === 'jsonl') continue
    if (!db.logModel) continue   // logger auto mode — no model to validate

    // User-defined mode: logModel must reference a declared model
    if (!modelNames.has(db.logModel))
      errors.push(`database '${db.name}': model '${db.logModel}' not found in schema`)
    else {
      // That model must be @@db(this database)
      const logModelDef = schema.models.find(m => m.name === db.logModel)
      const logModelDb  = logModelDef?.attributes.find(a => a.kind === 'db')?.name ?? 'main'
      if (logModelDb !== db.name)
        errors.push(`database '${db.name}': model '${db.logModel}' must be assigned to this database with @@db(${db.name})`)

      // Must have minimum required fields: operation, model, createdAt
      const fieldNames = new Set(logModelDef?.fields.map(f => f.name) ?? [])
      for (const required of ['operation', 'model', 'createdAt']) {
        if (!fieldNames.has(required))
          errors.push(`database '${db.name}': log model '${db.logModel}' is missing required field '${required}'`)
      }
    }
  }

  const viewNames = new Set(schema.views.map(v => v.name))

  // ── @@export ───────────────────────────────────────────────────────────────
  //
  // One walk over models and views, because the attribute means the same thing
  // on both: this dataset may leave, in this shape. Who may take it is the
  // @@gate beside it and is required here even where the schema guards nothing
  // else — an ungated exportable model is a bulk read of every row by anybody,
  // which is a different proposition from an ungated model somebody reads one
  // row of at a time.
  const EXPORT_FORMATS = new Set(['ndjson', 'csv'])
  for (const decl of [...schema.models, ...(schema.views ?? [])]) {
    const ex = (decl.attributes ?? []).find(a => a.kind === 'export')
    if (!ex) continue
    const what = (schema.views ?? []).includes(decl) ? 'View' : 'Model'

    if (!EXPORT_FORMATS.has(ex.format))
      errors.push(
        `${what} '${decl.name}': @@export format '${ex.format}' is not one this can write — ` +
        `${[...EXPORT_FORMATS].join(' or ')}.`)

    if (!(decl.attributes ?? []).some(a => a.kind === 'gate'))
      errors.push(
        `${what} '${decl.name}': @@export needs a @@gate beside it. An export is a bulk read of every ` +
        `row a caller may see, so an ungated one is the whole table to anybody. Write @@gate("0") if ` +
        `this dataset is public on purpose.`)

    if (ex.since) {
      const field = decl.fields.find(f => f.name === ex.since)
      if (!field)
        errors.push(
          `${what} '${decl.name}': @@export(since: ${ex.since}) names no column this ${what.toLowerCase()} declares — ` +
          `the cursor is read off the rows that leave.`)
      else if (field.attributes?.some(a => a.kind === 'computed'))
        errors.push(
          `${what} '${decl.name}': @@export(since: ${ex.since}) names a @computed field, which is not a column — ` +
          `a cursor has to be something the database can order by.`)
    }
  }

  // A schema that guards anything guards its views too, and the refusal is at
  // parse rather than at read: a view is a projection of rows a model gates, so
  // an ungated one is a way around every gate the schema declares — and it
  // cannot be inferred from `@@sql` without parsing SQL to find the sources.
  // `@@gate("0")` is how a schema says a view is public deliberately.
  const schemaGuards = schema.models.some(m =>
    m.attributes?.some(a => a.kind === 'gate' || a.kind === 'allow' || a.kind === 'deny') ||
    m.fields?.some(f => f.attributes?.some(a => a.kind === 'fieldAllow' || a.kind === 'guarded')))
  const rowTenancy = schema.tenancy?.strategy === 'row'

  for (const view of schema.views) {
    const viewAttrs = view.attributes ?? []

    if (schemaGuards && !viewAttrs.some(a => a.kind === 'gate'))
      errors.push(
        `View '${view.name}' must declare @@gate — this schema declares access rules, and a view is a ` +
        `read path onto the rows they guard. Write @@gate("0") if the view is public on purpose.`)

    if (rowTenancy && !viewAttrs.some(a => a.kind === 'tenant'))
      errors.push(
        `View '${view.name}' must declare @@tenant — under 'strategy row' a view's @@sql carries no tenant ` +
        `predicate, so one tenant reads another's rows. Name the view's own tenant column with ` +
        `@@tenant(column: "…"), or @@tenant(none) if the view spans tenants on purpose.`)

    // A view has no relations, so a policy that hops one cannot compile and
    // would otherwise fail later naming a field the author did not write.
    for (const attr of viewAttrs) {
      if (attr.kind === 'tenant' && attr.mode === 'via')
        errors.push(`View '${view.name}': @@tenant(via:) needs a relation and a view declares none — name the column instead`)
    }

    // Must have @@sql
    if (!view.sql)
      errors.push(`View '${view.name}' must declare @@sql("...")`)

    // @@db must reference a declared database
    if (view.db && !dbNames.has(view.db))
      errors.push(`View '${view.name}': @@db(${view.db}) references unknown database '${view.db}'`)

    // Cannot reference a jsonl database
    if (view.db && jsonlNames.has(view.db))
      errors.push(`View '${view.name}': @@db(${view.db}) — views cannot be declared on jsonl databases`)

    // @@refreshOn is what makes a materialized view TRIGGER-refreshed, and its
    // absence is the other refresh strategy rather than an omission: the table
    // is rebuilt when `db.<view>.refresh()` is called and at no other time. It
    // used to be required here, which left the trigger strategy as the only one
    // and its cost — a full re-aggregation per ROW written, inside the write's
    // own transaction — unavoidable for anything declaring `@@materialized`
    // (`FJS-971`).

    // @@refreshOn model names must exist
    for (const ref of view.refreshOn) {
      if (!modelNames.has(ref))
        errors.push(`View '${view.name}': @@refreshOn references unknown model '${ref}'`)
    }

    // @@materialized: all @@refreshOn source models must live in the same db as the view
    if (view.materialized && view.db) {
      for (const ref of view.refreshOn) {
        const sourceModel = schema.models.find(m => m.name === ref)
        if (!sourceModel) continue
        const sourceDb = sourceModel.attributes.find(a => a.kind === 'db')?.name ?? null
        if (sourceDb !== view.db)
          errors.push(
            `View '${view.name}': @@materialized cross-database triggers are not supported. ` +
            `Model '${ref}' is in '${sourceDb ?? 'main'}' but view is in '${view.db}'. ` +
            `Move the view to the same database as its @@refreshOn sources.`
          )
      }
    }
  }

  // Duplicate view names (also check against model/enum names)
  for (const view of schema.views) {
    if (seen.has(view.name)) errors.push(`Duplicate declaration name '${view.name}'`)
    seen.add(view.name)
  }

  // ── Soft delete cascade footgun warning ──────────────────────────────────────
  // If a @@softDelete model has hasMany children that also use @@softDelete,
  // but doesn't declare @@softDelete(cascade), soft-deleting the parent will
  // leave child rows live and visible — almost certainly unintentional.
  // @hardDelete on the relation field is an explicit override and suppresses this.
  {
    const softDeleteModels = new Set(
      schema.models
        .filter(m => m.attributes.some(a => a.kind === 'softDelete'))
        .map(m => m.name)
    )
    const cascadeModels = new Set(
      schema.models
        .filter(m => m.attributes.some(a => a.kind === 'softDelete' && a.cascade))
        .map(m => m.name)
    )
    for (const model of schema.models) {
      if (!softDeleteModels.has(model.name)) continue
      if (cascadeModels.has(model.name)) continue  // already has cascade
      for (const field of model.fields) {
        // Check both explicit relation back-refs and Model[] fields (implicitM2M candidate)
        if (field.type.kind !== 'relation' && field.type.kind !== 'implicitM2M') continue
        const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
        if (rel) continue  // belongsTo side — skip
        // This is the hasMany side (no @relation with fields — it's the inverse)
        const childName = field.type.name
        if (!softDeleteModels.has(childName)) continue
        const hasHardDelete = field.attributes.some(a => a.kind === 'hardDelete')
        if (hasHardDelete) continue  // explicit @hardDelete — intentional, no warning
        const hasKeep = field.attributes.some(a => a.kind === 'keep')
        if (hasKeep) continue        // explicit @keep — the children outlive the parent, said out loud
        warnings.push(
          `Model '${model.name}': has @@softDelete and a hasMany relation to '${childName}' which also uses @@softDelete. ` +
          `Soft-deleting a '${model.name}' row will NOT cascade to '${childName}' rows — they will remain live. ` +
          `Add @@softDelete(cascade) to propagate, @hardDelete on the '${field.name}' field to hard-delete children, ` +
          `or @keep on it to say they outlive the parent on purpose.`
        )
      }
    }
  }

  // Validate implicit m2m: both sides must declare the relation.
  // Also reclassify Model[] fields as hasMany back-references when the target
  // model has an explicit @relation FK pointing back to this model.
  //
  // Relations pair by LABEL first (Prisma parity): an array labeled
  // @relation("user") only matches an FK labeled "user"; an array labeled
  // "members" pairs with the "members" array on the other side (m2m).
  // Unlabeled arrays only pair with unlabeled FKs / unlabeled arrays.
  const _fieldRelLabel = (f) => f.attributes.find(a => a.kind === 'relation')?.name ?? null
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (field.type.kind !== 'implicitM2M') continue
      const targetModel = schema.models.find(m => m.name === field.type.name)
      if (!targetModel) {
        errors.push(`Model '${model.name}', field '${field.name}': unknown model '${field.type.name}'`)
        continue
      }
      const label  = _fieldRelLabel(field)
      const isSelf = targetModel.name === model.name

      // hasMany back-ref: target has an FK @relation to me with a MATCHING label
      const hasFKBack = targetModel.fields.some(f => {
        const rel = f.attributes.find(a => a.kind === 'relation' && a.fields)
        if (!rel || f.type.name !== model.name) return false
        return (rel.name ?? null) === label
      })
      if (hasFKBack) {
        field.type.kind = 'relation'
        continue
      }

      // m2m mirror: array field with the same label pointing back
      // (for self-relations, a DIFFERENT array field on this same model)
      const mirror = (isSelf ? model : targetModel).fields.find(f =>
        f !== field && f.type.kind === 'implicitM2M' && f.type.name === model.name && _fieldRelLabel(f) === label
      )
      if (!mirror) {
        const hint = label
          ? `'${field.type.name}' has no '${model.name}[]' field labeled @relation("${label}").`
          : `'${field.type.name}' has no corresponding unlabeled '${model.name}[]' field. ` +
            `If this pairs with a labeled relation, add the matching @relation("name") label.`
        errors.push(`Implicit many-to-many: '${model.name}.${field.name}' — ${hint} Both sides must declare the relation.`)
      }
      // A label may join exactly two array ends
      const ends = []
      for (const m of schema.models) for (const f of m.fields) {
        if (f.type.kind !== 'implicitM2M') continue
        if (_fieldRelLabel(f) !== label) continue
        if (isSelf ? (m.name === model.name && f.type.name === model.name)
                   : ((m.name === model.name && f.type.name === targetModel.name) ||
                      (m.name === targetModel.name && f.type.name === model.name))) ends.push(`${m.name}.${f.name}`)
      }
      if (ends.length > 2) {
        errors.push(`Many-to-many relation ${label ? `"${label}"` : '(unlabeled)'} between '${model.name}' and '${targetModel.name}' has ${ends.length} array fields (${ends.join(', ')}) — exactly two are allowed. Use distinct @relation("name") labels.`)
      }
    }
  }

  // Pair each unlabelled one-to-one back-reference with the FK that points at
  // it. Same rule as the plural back-reference above; the difference is that a
  // plural one with no FK is an implicit m2m candidate and a singular one has
  // no such fallback, so it is an error naming what is missing (FJS-563).
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (field.type.kind !== 'backRefOne') continue
      const targetModel = schema.models.find(m => m.name === field.type.name)
      if (!targetModel) continue   // already reported by the type check

      const owners = targetModel.fields.filter(f => {
        const rel = f.attributes.find(a => a.kind === 'relation' && a.fields)
        return rel && f.type.name === model.name && (rel.name ?? null) === null
      })

      if (owners.length === 1) {
        const owner = owners[0]
        const rel   = owner.attributes.find(a => a.kind === 'relation' && a.fields)
        const cols  = rel.fields ?? []
        // A back-reference that is singular has to READ as singular. If the
        // foreign key is not unique, many rows point back and the field would
        // answer one of them arbitrarily — so it is a hasMany written as a
        // to-one, and saying nothing makes that a silently wrong read.
        const unique = cols.length > 0 && cols.every(c => {
          const col = targetModel.fields.find(f => f.name === c)
          // A primary key is unique by definition, and a one-to-one keyed on
          // its own foreign key is an ordinary way to write one.
          if (col?.attributes.some(a => a.kind === 'unique' || a.kind === 'id')) return true
          // A model-level @@unique parses as 'uniqueIndex'; the field-level one
          // above is 'unique'. The column set must match exactly — unique on
          // (a, b) says nothing about a on its own.
          return targetModel.attributes.some(a =>
            a.kind === 'uniqueIndex' && Array.isArray(a.fields) &&
            a.fields.length === cols.length && cols.every(x => a.fields.includes(x)))
        })
        if (!unique) {
          errors.push(
            `Model '${model.name}', field '${field.name}': '${targetModel.name}.${owner.name}' is not unique, ` +
            `so many '${targetModel.name}' rows can point back — write '${field.name} ${targetModel.name}[]' for a to-many, ` +
            `or add @unique to '${targetModel.name}.${cols.join(', ')}' for a one-to-one.`
          )
          continue
        }
        field.type.kind = 'relation'
        continue
      }

      if (owners.length === 0) {
        const labeled = targetModel.fields.some(f =>
          f.attributes.some(a => a.kind === 'relation' && a.fields && a.name) && f.type.name === model.name)
        errors.push(
          `Model '${model.name}', field '${field.name}': '${targetModel.name}' declares no unlabelled @relation back to '${model.name}'. ` +
          (labeled
            ? `It has a LABELED one — put the same @relation("name") on this field.`
            : `Add the foreign key on '${targetModel.name}', or a @relation("name") label on both sides.`)
        )
        continue
      }

      errors.push(
        `Model '${model.name}', field '${field.name}': '${targetModel.name}' has ${owners.length} unlabelled @relation fields ` +
        `pointing at '${model.name}' (${owners.map(o => o.name).join(', ')}) — label them with @relation("name") to say which one this pairs with.`
      )
    }
  }

  // ── @@hasTemplates field shape ────────────────────────────────────────────
  // If the user declared the marker field themselves (instead of letting
  // expandHasTemplatesAttributes inject it), enforce the contract: must be
  // a non-optional Boolean. Without this, default WHERE clauses generate
  // SQL that doesn't match what the user expects.
  for (const model of schema.models) {
    const ht = model.attributes.find(a => a.kind === 'hasTemplates')
    if (!ht) continue
    const field = model.fields.find(f => f.name === ht.field)
    // expand step always inserts if missing, so this should always be true,
    // but keep the guard for the case where validate runs without expansion.
    if (!field) continue
    // Field type lives on field.type which is a {kind, name, array, optional}
    // object for scalars (mirrors how the parser emits all field types). Read
    // through the inner shape to support both directly-emitted and
    // user-declared variants.
    const t = field.type
    const typeName = typeof t === 'object' ? t.name : t
    const isArray  = (typeof t === 'object' && t.array)    || field.array    || false
    const isOpt    = (typeof t === 'object' && t.optional) || field.optional || false
    if (typeName !== 'Boolean' || isArray) {
      errors.push(`Model '${model.name}': @@hasTemplates field '${ht.field}' must be Boolean (got ${typeName}${isArray ? '[]' : ''})`)
    }
    if (isOpt) {
      errors.push(`Model '${model.name}': @@hasTemplates field '${ht.field}' must not be optional — templates are categorical, not nullable`)
    }
  }

  // ── @@anonymous: nothing on the model may name or time its writer ─────────
  // Each of these re-attributes a row by itself: a log stamps actorId and the
  // whole row, an authorship column is the writer, and a millisecond clock is a
  // join key against whatever the writer's other write in that request
  // recorded. A day (`String @date`) is the grain that survives. The other end
  // of that join, a log on a DIFFERENT model, is refused per transaction by
  // the client (`FJS-D349`).
  for (const model of schema.models) {
    if (!model.attributes.some(a => a.kind === 'anonymous')) continue
    const where = `Model '${model.name}' is @@anonymous`
    for (const log of model.attributes.filter(a => a.kind === 'log'))
      errors.push(`${where}, and @@log(${log.db}) stamps the writer and the whole row on every write. Remove the log`)
    for (const field of model.fields) {
      const kinds = new Set(field.attributes.map(a => a.kind))
      const dflt  = field.attributes.find(a => a.kind === 'default')?.value
      if (kinds.has('log'))
        errors.push(`${where}, and field '${field.name}' is logged (@log, or the one @secret implies) — an audit entry names its writer`)
      if (kinds.has('createdBy') || kinds.has('updatedBy') || (dflt?.kind === 'call' && dflt.fn === 'auth'))
        errors.push(`${where}, and field '${field.name}' is stamped from the writer (@createdBy, @updatedBy or auth())`)
      if (kinds.has('updatedAt') || (dflt?.kind === 'call' && dflt.fn === 'now'))
        errors.push(`${where}, and field '${field.name}' stamps the clock — a millisecond joins this row to the writer's other writes. Use a String @date the app sets`)
    }
  }

  // ── @@expires / @@effective window shape ──────────────────────────────────
  // The declaration names columns rather than injecting them, so every way it
  // can be wrong is a mismatch with what the model already says.
  //
  // The KIND check is the one that is not obvious. A window is over instants
  // (`DateTime`) or over days (`String @date`) and the live schemas in this
  // repo carry both — a price changes at a moment, a salary changes on a day
  // (`FJS-D143`). Which one a model is decides what `asOf` may carry, so a pair
  // that disagrees has no answer to give a caller and is refused here rather
  // than compared at runtime, where `'2026-06-01' <= '2026-06-01T09:00:00Z'` is
  // true and means nothing.
  for (const model of schema.models) {
    const exp = model.attributes.find(a => a.kind === 'expires')
    const eff = model.attributes.find(a => a.kind === 'effective')
    if (exp && eff) {
      errors.push(
        `Model '${model.name}': declares both @@expires and @@effective. A row out of its window is ` +
        `either dead or history, and the two answer a read with no asOf in opposite ways`)
      continue
    }
    const word  = exp ? '@@expires' : '@@effective'
    const edges = exp ? [[null, exp.column]] : eff ? [['from', eff.from], ['to', eff.to]] : []
    const kinds = []
    for (const [arg, name] of edges) {
      if (!name) continue
      const label = arg ? `${word}(${arg}: ${name})` : `${word}(${name})`
      const field = model.fields.find(f => f.name === name)
      if (!field) {
        errors.push(`Model '${model.name}': ${label} names no field of this model`)
        continue
      }
      const t        = field.type
      const typeName = typeof t === 'object' ? t.name : t
      const isArray  = (typeof t === 'object' && t.array) || field.array || false
      const isDate   = field.attributes?.some(a => a.kind === 'date') ?? false
      if (isArray) {
        errors.push(`Model '${model.name}': ${label} must be a single value, not a list`)
        continue
      }
      if (typeName === 'DateTime')                kinds.push(['instant', arg, name])
      else if (typeName === 'String' && isDate)   kinds.push(['day', arg, name])
      else errors.push(
        `Model '${model.name}': ${label} must be a DateTime or a String @date ` +
        `— a window's edge is a time (got ${typeName}${isDate ? ' @date' : ''})`)
    }
    if (kinds.length === 2 && kinds[0][0] !== kinds[1][0]) errors.push(
      `Model '${model.name}': @@effective mixes kinds — '${kinds[0][2]}' is ${kinds[0][0] === 'day' ? 'a day' : 'an instant'} ` +
      `and '${kinds[1][2]}' is ${kinds[1][0] === 'day' ? 'a day' : 'an instant'}. Both edges of one window are read at ` +
      `the same moment, so they must be the same kind`)
  }

  // ── @from over an @@expires model ─────────────────────────────────────────
  // Refused, because the honest alternatives are both worse.
  //
  // A `@from` is a correlated subquery compiled ONCE at startup into a SQL
  // string with no binds, so it cannot read the client's injected clock —
  // `now()` in a `@from(where:)` expands to SQLite's own `strftime(…,'now')`.
  // Filtering it that way would give one model two clocks: `findMany` answers
  // at the client's and the `@from` beside it at the wall, which agree in
  // production and disagree under exactly the frozen clock a test uses to stage
  // expiry. Not filtering at all is the other way to be silently wrong, and it
  // is the one `@from`'s own contract rules out — it reads the target the way
  // the target is read, `@@softDelete` and `@@hasTemplates` included.
  //
  // So the caller states it. An `@@effective` target is not refused: nothing
  // filters it without a stated `asOf`, so a `@from` reading every row IS
  // reading it the way it is read.
  for (const model of schema.models) {
    for (const field of model.fields) {
      const from = field.attributes?.find(a => a.kind === 'from')
      if (!from?.target || from.where) continue
      const target = schema.models.find(m => m.name === from.target)
      const exp    = target?.attributes.find(a => a.kind === 'expires')
      if (!exp) continue
      errors.push(
        `Model '${model.name}': @from(${from.target}, …) on '${field.name}' reads a model declaring ` +
        `@@expires, and a @from is compiled once at startup — it cannot read the clock every other ` +
        `read of ${from.target} is filtered by. State it yourself: where: "${exp.column} > now()", ` +
        `or where: "1=1" to count every row, expired or not`)
    }
  }

  // ── @@commitment ──────────────────────────────────────────────────────────
  // Every way the declaration can be wrong is a mismatch with what the model
  // already says, and each one is silent at runtime: a transition that is not
  // declared owes nothing, a time column of the wrong kind compares a day with
  // an instant, and an offset column somebody may edit moves a deadline that
  // was agreed (`FJS-D355`).
  //
  // The KIND decides which units an offset may carry. On an instant a month
  // needs a zone the expression does not have, so `mo`/`yr` are refused there;
  // on a day an hour is not a day, so the sub-day units are.
  const DAY_UNITS     = new Set(['d', 'wk', 'mo', 'yr'])
  const INSTANT_UNITS = new Set(['ms', 's', 'min', 'h', 'd', 'wk'])
  for (const model of schema.models) {
    const commitments = model.attributes.filter(a => a.kind === 'commitment')
    if (!commitments.length) continue
    const movesOf = (m) => {
      const moves = new Map()
      for (const t of m.attributes.filter(a => a.kind === 'transitions'))
        for (const [name, spec] of Object.entries(t.transitions)) moves.set(name, spec)
      return moves
    }
    const seen = new Set()
    for (const c of commitments) {
      const label = `@@commitment(${c.name}, …)`
      // The hop. To-ONE only: from an invoice, *its subscription* is one row,
      // and from a customer *its invoices* has no answer to which of them moves.
      let target = model
      if (c.via) {
        const rel = model.fields.find(f => f.name === c.via)
        if (!rel || rel.type?.kind !== 'relation') {
          errors.push(
            `Model '${model.name}': ${label} '${c.via}' names no relation of this model — ` +
            `a commitment on another model's transition reaches it through a to-one relation`)
          continue
        }
        if (rel.type.array) {
          errors.push(
            `Model '${model.name}': ${label} '${c.via}' is a to-many relation, and a commitment moves ONE row. ` +
            `Declare it on ${rel.type.name}, reaching back to ${model.name} through its to-one side`)
          continue
        }
        target = schema.models.find(m => m.name === rel.type.name)
        if (!target) continue
      }
      const moves = movesOf(target)
      if (!moves.has(c.transition)) {
        errors.push(
          `Model '${model.name}': ${label} names no transition of ${c.via ? target.name : 'this model'}` +
          (moves.size ? ` — declared: ${[...moves.keys()].join(', ')}` : `. Declare it on @@transitions first`))
        continue
      }
      if (seen.has(c.name)) errors.push(
        `Model '${model.name}': ${label} is declared twice — a transition is owed at one time. ` +
        `Two deadlines for one outcome are the earlier one`)
      seen.add(c.name)

      const field = model.fields.find(f => f.name === c.on.field)
      let kind = null
      if (!field) {
        errors.push(`Model '${model.name}': ${label} on: '${c.on.field}' names no field of this model`)
      } else {
        const typeName = typeof field.type === 'object' ? field.type.name : field.type
        const isArray  = (typeof field.type === 'object' && field.type.array) || field.array || false
        const isDate   = field.attributes?.some(a => a.kind === 'date') ?? false
        if (!isArray && typeName === 'DateTime')                 kind = 'instant'
        else if (!isArray && typeName === 'String' && isDate)    kind = 'day'
        else errors.push(
          `Model '${model.name}': ${label} on: '${c.on.field}' must be a DateTime or a String @date ` +
          `— a commitment is owed at a time (got ${typeName}${isDate ? ' @date' : ''}${isArray ? '[]' : ''})`)
      }

      const off = c.on.offset
      const unitFits = (unit, where) => {
        if (!kind) return
        const ok = kind === 'day' ? DAY_UNITS : INSTANT_UNITS
        if (ok.has(unit)) return
        errors.push(kind === 'instant'
          ? `Model '${model.name}': ${label} ${where} is in '${unit}', and '${c.on.field}' is an instant. ` +
            `A month has no fixed length, so adding one to an instant needs a zone the schema does not ` +
            `have — use d or wk, or make '${c.on.field}' a String @date`
          : `Model '${model.name}': ${label} ${where} is in '${unit}', and '${c.on.field}' is a day. ` +
            `A day moved by part of a day is not a day — use d, wk, mo or yr`)
      }
      if (off?.unit) unitFits(off.unit, `offset ${off.value}${off.unit}`)
      if (off?.field) {
        const col   = model.fields.find(f => f.name === off.field)
        const where = `offset '${off.field}'`
        if (!col) {
          errors.push(`Model '${model.name}': ${label} ${where} names no field of this model`)
        } else {
          const typeName = typeof col.type === 'object' ? col.type.name : col.type
          const unit     = col.attributes?.find(a => a.kind === 'unit')
          if (typeName !== 'Int' || col.optional || col.type?.optional)
            errors.push(
              `Model '${model.name}': ${label} ${where} must be a required Int — a missing offset would ` +
              `make the transition owed never, with nothing said`)
          if (!unit || unitInfo(unit.symbol)?.dimension !== 'duration')
            errors.push(
              `Model '${model.name}': ${label} ${where} must declare a duration @unit — ` +
              `${off.field} Int @unit(d) @immutable — or the number counts nothing`)
          else unitFits(unit.symbol, `${where}`)
          if (!col.attributes?.some(a => a.kind === 'immutable'))
            errors.push(
              `Model '${model.name}': ${label} ${where} must be @immutable. The offset is the term agreed ` +
              `when the row was written, and an editable one moves a deadline somebody was promised`)
        }
      }

      // `while:` reads this row and nothing else. A commitment is the
      // system's, so there is no caller for `auth()` to name; the time is
      // `on:`'s job, so a `now()` here would be read at the moment of asking
      // rather than at the moment owed; and a hop would make the read a join.
      const walk = (n) => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) return n.forEach(walk)
        if (n.type === 'auth') errors.push(
          `Model '${model.name}': ${label} while: reads auth(), and a commitment has no caller — the system owes it`)
        else if (n.type === 'now') errors.push(
          `Model '${model.name}': ${label} while: reads now(). When it is owed is on:'s to say`)
        else if (n.type === 'path' || n.type === 'check') errors.push(
          `Model '${model.name}': ${label} while: crosses a relation. It reads this row and nothing else — ` +
          `copy the value onto the row when the terms are agreed`)
        else if (n.type === 'field' && !model.fields.some(f => f.name === n.name)) {
          const member = schema.enums?.some(e => e.values?.some(v => v.name === n.name))
          errors.push(
            `Model '${model.name}': ${label} while: '${n.name}' names no field of this model` +
            (member ? ` — an enum member is written quoted: '${n.name}'` : ''))
        }
        for (const k of ['left', 'right', 'expr', 'cond', 'then', 'else', 'items']) walk(n[k])
      }
      walk(c.while)
    }
  }

  validateClaimSources(schema, errors)

  return { valid: errors.length === 0, errors, warnings }
}

// ─── claim … from ────────────────────────────────────────────────────────────
//
// A claim read off a row that points at the caller. Every refusal here is a
// claim that would resolve to the WRONG value rather than to none: a subject
// that is not unique answers whichever row SQLite returns first, a subject
// that is not a key to the @@auth model compares a caller's id against
// something that is not one, and a protected column would be copied onto every
// principal in plain text.
function validateClaimSources(schema, errors) {
  const sources = Object.entries(schema.claimSources ?? {})
  if (!sources.length) return

  const authModel = schema.models.find(m => m.attributes.some(a => a.kind === 'auth'))
  const PROTECTED = new Set(['guarded', 'encrypted', 'hashed', 'secret'])
  const VIRTUAL   = new Set(['computed', 'transient', 'derived', 'from'])

  for (const [name, { model: modelName, subject, column }] of sources) {
    const at = `claim ${name} from ${modelName}(${subject})${column ? '.' + column : ''}`

    if (!authModel) {
      errors.push(`${at}: reads the row that points at the caller, and no model is @@auth — there is no caller's id to look it up by`)
      continue
    }
    if (authModel.fields.some(f => f.name === name)) {
      errors.push(`${at}: '${name}' is already a claim — a column of @@auth ${authModel.name}. One claim, one value`)
      continue
    }
    if (schema.tenancy?.claim === name || (schema.tenancy?.strategy === 'row' && !schema.tenancy?.claim && schema.tenancy?.column === name)) {
      errors.push(`${at}: '${name}' is the tenancy claim, which the tenancy block resolves`)
      continue
    }

    const model = schema.models.find(m => m.name === modelName)
    if (!model) {
      errors.push(`${at}: names no model '${modelName}'`)
      continue
    }

    const subj = model.fields.find(f => f.name === subject)
    if (!subj) {
      errors.push(`${at}: '${subject}' is not a field of ${modelName}`)
      continue
    }
    const pointsAtCaller = model.fields.some(f =>
      f.type.name === authModel.name && !f.type.array &&
      f.attributes.some(a => a.kind === 'relation' && a.fields?.length === 1 && a.fields[0] === subject))
    if (!pointsAtCaller) {
      errors.push(
        `${at}: '${subject}' is not a key to @@auth ${authModel.name} — the lookup compares it with the caller's id, ` +
        `so it must be the column of a @relation(fields: [${subject}]) to ${authModel.name}`)
      continue
    }
    // `@@id([a, b])` stamps @id on every member, so @id identifies a row
    // alone only where the model has exactly one.
    const idFields = model.fields.filter(f => f.attributes.some(a => a.kind === 'id'))
    const unique =
      subj.attributes.some(a => a.kind === 'unique') ||
      (idFields.length === 1 && idFields[0] === subj) ||
      model.attributes.some(a => a.kind === 'uniqueIndex' && a.fields?.length === 1 &&
        (a.fields[0]?.name ?? a.fields[0]) === subject)
    // Under row tenancy a scoped model's @unique is lifted to one per TENANT,
    // so a caller who is in two tenants matches two rows. That is the
    // membership shape, and it is resolved per request with the tenant as key.
    const tenantCol = schema.tenancy?.strategy === 'row' ? schema.tenancy.column : null
    const perTenant = tenantCol && model.attributes.some(a => a.kind === 'uniqueIndex' && a.fields?.length === 2 &&
      a.fields.map(f => f?.name ?? f).includes(subject) && a.fields.map(f => f?.name ?? f).includes(tenantCol))
    if (!unique && perTenant) {
      errors.push(
        `${at}: '${subject}' is unique per tenant, so a caller in two tenants matches two rows. That claim depends on ` +
        `which tenant the request names — resolve it with createApp({ principal: membershipClaim(…) }), or declare ` +
        `'${subject}' @unique(global) if one person is one ${modelName} across the whole installation`)
      continue
    }
    if (!unique) {
      errors.push(
        `${at}: '${subject}' is not unique on ${modelName}, so one caller could match two rows and the claim would hold ` +
        `whichever SQLite returned first. Declare '${subject}' @unique`)
      continue
    }

    if (column == null) {
      if (idFields.length !== 1)
        errors.push(`${at}: ${modelName} has no single-column primary key to read — name the column: from ${modelName}(${subject}).<column>`)
      continue
    }

    const col = model.fields.find(f => f.name === column)
    if (!col) {
      errors.push(`${at}: '${column}' is not a field of ${modelName}`)
      continue
    }
    const modelNames = new Set(schema.models.map(m => m.name))
    if (col.type.array || modelNames.has(col.type.name) || col.attributes.some(a => VIRTUAL.has(a.kind))) {
      errors.push(`${at}: '${column}' is not a stored scalar column — a claim is one value`)
      continue
    }
    if (col.attributes.some(a => PROTECTED.has(a.kind)))
      errors.push(`${at}: '${column}' is protected, and a claim is copied onto every principal in plain text`)
  }
}


// ─── File-aware parse (resolves imports) ──────────────────────────────────────
//
// parseFile(path) reads a .lite file, resolves all import "..." declarations
// recursively, and merges everything into a single schema.
//
// Import paths are resolved relative to the importing file, exactly like
// ES module imports. Circular imports are detected and reported as errors.
//
// Usage:
//   const result = await parseFile('./schema.lite')
//   // result.schema contains all models, enums, and functions from all files
//
// You can also import individual concerns into separate files:
//   schema.lite:     import "./models/users.lite"
//   functions.lite:  function slug(...) { ... }
//   enums.lite:      enum Plan { ... }

import { readFileSync, resolve, dirname, isAbsolute, createRequire, pathToFileURL } from '#host'

// ─── Where an import points ───────────────────────────────────────────────────
//
// A relative or absolute specifier is a path, resolved against the importing
// file. Anything else is a PACKAGE, resolved the way an ESM import would be —
// which is what lets a package ship a schema fragment other apps import by name
// (`import "@frontierjs/auth/schema.lite"`) instead of every app keeping a copy
// that a package upgrade cannot reach.
//
// Resolution is node's, so the package's own `exports` decides what is
// importable. Nothing here guesses at a path inside a package.

const RELATIVE_SPEC = /^\.\.?[\\/]/

export function resolveImportSpecifier(spec, fromPath) {
  if (RELATIVE_SPEC.test(spec) || isAbsolute(spec))
    return { path: resolve(dirname(fromPath), spec), error: null }

  try {
    return { path: createRequire(pathToFileURL(fromPath)).resolve(spec), error: null }
  } catch (e) {
    // Both causes, always, because the runtime decides which one is knowable:
    // node answers ERR_PACKAGE_PATH_NOT_EXPORTED for a subpath a package does
    // not export, and bun collapses it into MODULE_NOT_FOUND with the same shape
    // as an uninstalled package. Branching on the code makes the message depend
    // on which runtime read the schema, so it would say one thing under `bun
    // test` and another under `node scripts/…` for one mistake.
    const detail = e?.message?.split('\n')[0] ?? String(e)
    return {
      path:  null,
      error: `Cannot resolve import "${spec}" from ${fromPath} — is the package ` +
             `installed, and does it export that subpath? (${detail})`,
    }
  }
}

// ─── Imports as TEXT ──────────────────────────────────────────────────────────
//
// parseFile merges ASTs, which is the right answer whenever the files are on
// disk. Two callers cannot use it: `litestone release` reads the previous
// release's schema out of a git ref, where there is no tree to walk, and
// `createTestEnv` needs ONE canonical text — it is the template cache key, so a
// key built from the root file alone reuses a stale database when an imported
// file changes.
//
// Both need the same thing: follow the import lines and splice the sources
// together. Reading and resolving belong to the caller, because a git ref is
// addressed with posix paths through `git show` and a file on disk is not.

// An import on a line of its own, with its optional `into <db>`. `//` is .lite's
// only comment, so a mention inside one cannot reach the line start and match.
const IMPORT_LINE = /^[ \t]*import\s+["']([^"']+)["'](?:\s+into\s+([A-Za-z_]\w*))?;?[ \t]*$/gm

/** Does this source import anything? Cheap enough to ask before doing work. */
export function hasImports(text) {
  IMPORT_LINE.lastIndex = 0
  return IMPORT_LINE.test(text)
}

/**
 * Splice every imported source into `text`, depth-first.
 *
 * `opts.read` answers null for a source it cannot reach; that specifier lands in
 * `opts.missing` and the line is dropped, so a caller can report what is absent
 * rather than silently describing a smaller schema.
 */
export function inlineImports(text, parent, opts, into = null) {
  // This file's OWN models are retargeted before its imports are expanded, so a
  // nested `into` cannot be overwritten by the outer one — the same nearest-wins
  // rule parseFile applies to the AST. Retargeting after the splice would rewrite
  // the child's destination back to the parent's.
  const own = into ? retargetDbText(text, into) : text

  return own.replace(IMPORT_LINE, (_line, spec, childInto) => {
    const child = opts.resolveChild(parent, spec)
    if (child === null) { opts.missing.push(spec); return '' }
    if (opts.seen.has(child)) return ''         // already inlined — and cycles end here
    opts.seen.add(child)
    const source = opts.read(child)
    if (source === null) { opts.missing.push(spec); return '' }
    // An import with no `into` of its own inherits the one it was reached by.
    return inlineImports(source, child, opts, childInto ?? into)
  })
}

// `into` is an AST rewrite in parseFile and there is no AST here, so it is done
// on the text. Line-based rather than one regex: a file may mix models that name
// a database with models that do not, and both have to end up in `db` — a
// fragment meant to land wherever it is asked to usually names none at all.
const BLOCK_OPEN = /^[ \t]*(?:model|view)\s+[A-Za-z_]\w*\s*\{/
const DB_ATTR    = /^([ \t]*)@@db\(\s*[A-Za-z_]\w*\s*\)[ \t]*$/

function retargetDbText(text, db) {
  const out    = []
  let   openAt = -1        // index in `out` of the open block's first line
  let   hasDb  = false

  // A block that named no database gets one. The splice lands above the closing
  // brace, and attribute order inside a body does not matter to the parser.
  const finish = () => {
    if (openAt >= 0 && !hasDb) {
      const indent = (out[openAt].match(/^[ \t]*/)?.[0] ?? '') + '  '
      out.splice(openAt + 1, 0, `${indent}@@db(${db})`)
    }
    openAt = -1
    hasDb  = false
  }

  for (const line of text.split('\n')) {
    if (BLOCK_OPEN.test(line)) {
      finish()
      out.push(line)
      openAt = out.length - 1
    } else if (openAt >= 0 && DB_ATTR.test(line)) {
      out.push(line.replace(DB_ATTR, `$1@@db(${db})`))
      hasDb = true
    } else if (openAt >= 0 && /^[ \t]*\}/.test(line)) {
      out.push(line)
      finish()
    } else {
      out.push(line)
    }
  }
  finish()
  return out.join('\n')
}

/** inlineImports against the working tree. Returns the text and what was missing. */
export function inlineImportsFromDisk(filePath) {
  const abs     = resolve(filePath)
  const missing = []
  const text    = inlineImports(readFileSync(abs, 'utf8'), abs, {
    // The same resolver parseFile uses, so a bare package specifier follows to
    // the same file in both — otherwise a schema parses and its test environment
    // does not, or worse, quietly describes less.
    resolveChild: (parent, spec) => resolveImportSpecifier(spec, parent).path,
    read:         (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
    seen:         new Set([abs]),
    missing,
  })
  return { text, missing }
}

export function parseFile(filePath) {
  const absPath = resolve(filePath)
  const visited = new Set()
  const allErrors   = []
  const allWarnings = []

  // `import "..." into <db>`. Two rules, and they are the same rule stated twice:
  // the NEAREST statement about a model's database wins. An inner `into` on a
  // nested import beats an outer one, and any `into` beats a `@@db` written in
  // the imported file — a package shipping a fragment has to spell some database
  // name, and only the importing app knows what its own are called.
  const stamped = new WeakSet()   // already claimed by a nearer `into`
  const intoFor = new Map()       // resolved path → the `into` it was merged under

  const retarget = (child, db) => {
    for (const model of child.models) {
      if (stamped.has(model)) continue
      stamped.add(model)
      const attr = model.attributes.find(a => a.kind === 'db')
      if (attr) attr.name = db
      else model.attributes.push({ kind: 'db', name: db })
    }
    // A view carries its database as a plain property rather than an attribute.
    for (const view of child.views ?? []) {
      if (stamped.has(view)) continue
      stamped.add(view)
      view.db = db
    }
  }

  function loadFile(currentPath) {
    if (visited.has(currentPath)) return null  // already merged
    visited.add(currentPath)

    let src
    try { src = readFileSync(currentPath, 'utf8') }
    catch (e) { allErrors.push(`Cannot read file: ${currentPath}`); return null }

    // Sniff for binary content. Schemas are UTF-8 text; if we got a SQLite db
    // file, an image, or any binary blob, the tokenizer will explode at some
    // arbitrary offset with a useless "Unexpected character U+0000" error.
    // Catch it here with a message that points at the actual mistake — almost
    // always: schema and db paths got swapped in createClient().
    if (src.startsWith('SQLite format 3\u0000')) {
      allErrors.push(
        `Schema file is a SQLite database, not a .lite schema: ${currentPath}\n` +
        `       Did you swap the 'schema' and 'db' arguments in createClient()?`
      )
      return null
    }
    // Generic binary sniff: NUL byte in the first 512 bytes is a strong signal
    // (legitimate .lite schemas are pure UTF-8 text with no NULs).
    const head = src.slice(0, 512)
    if (head.indexOf('\u0000') !== -1) {
      allErrors.push(
        `Schema file appears to be binary, not text: ${currentPath}\n` +
        `       Expected a UTF-8 .lite schema file.`
      )
      return null
    }

    let tokens
    try { tokens = tokenize(src) }
    catch (e) {
      // Re-raise with the file path so the user sees which file failed when
      // imports chain across multiple files.
      if (e && e.message) e.message = `In ${currentPath}:\n  ${e.message}`
      throw e
    }
    // A ParseError is a RESULT here, exactly as it is in parse() — the two have
    // to answer the same shape or every caller has to know which one it called,
    // and a caller that warns and keeps going (sierra's build, the CLI's error
    // box) got a stack trace instead. Named with its file, since imports chain.
    const parser = new Parser(tokens)
    let schema
    try {
      schema = parser.parseSchema()
    } catch (e) {
      if (!(e instanceof ParseError)) throw e
      allErrors.push(`In ${currentPath}: ${e.message}`)
      return null
    }

    // Recursively resolve imports before merging
    const importedModels    = []
    const importedEnums     = []
    const importedFunctions = []
    const importedDatabases = []
    const importedViews     = []
    const importedTraits    = []
    const importedTypes     = []
    const importedValuesets = []
    const importedExtends   = []
    const importedClaims    = []
    const importedSources   = {}
    let   importedTenancy   = null

    for (const imp of schema.imports) {
      const { path: importPath, error } = resolveImportSpecifier(imp.path, currentPath)
      if (error) { allErrors.push(error); continue }

      const child = loadFile(importPath)

      // One file imported twice under two different `into`s has no single
      // answer — the second import is deduplicated away, so honouring it would
      // mean silently applying the first. Named rather than resolved.
      const previous = intoFor.get(importPath)
      if (previous !== undefined && previous !== (imp.into ?? null))
        allErrors.push(
          `'${imp.path}' is imported twice with different destinations ` +
          `(${previous ?? 'no into'} and ${imp.into ?? 'no into'}) — it is merged once, so only one can hold`
        )
      intoFor.set(importPath, imp.into ?? null)

      if (child && imp.into) retarget(child, imp.into)

      if (child?.tenancy) {
        // A shipped fragment cannot know what an app's tenants are, so a
        // tenancy block reaching the merge from two files has no precedence
        // rule to apply — it is named rather than resolved, the same way a
        // double `into` is.
        if (importedTenancy)
          allErrors.push(`tenancy is declared in more than one imported file — one schema, one tenancy block`)
        importedTenancy = child.tenancy
      }

      if (child) {
        importedModels.push(...child.models)
        importedEnums.push(...child.enums)
        importedFunctions.push(...child.functions)
        importedDatabases.push(...child.databases)
        importedViews.push(...child.views)
        importedTraits.push(...(child.traits ?? []))
        importedTypes.push(...(child.types ?? []))
        importedValuesets.push(...(child.valuesets ?? []))
        importedExtends.push(...(child.extends ?? []))
        importedClaims.push(...(child.claims ?? []))
        // One claim, one row it is read from. Two files naming the same claim
        // are the union above; two files naming it from two different rows
        // have said two things, and only one could be read.
        for (const [n, src] of Object.entries(child.claimSources ?? {})) {
          const prior = importedSources[n] ?? schema.claimSources?.[n]
          if (prior && JSON.stringify(prior) !== JSON.stringify(src))
            allErrors.push(`claim '${n}' is read from two different rows across ${currentPath} and a file it imports`)
          importedSources[n] = src
        }
      }
    }

    if (schema.tenancy && importedTenancy)
      allErrors.push(
        `tenancy is declared both in ${currentPath} and in a file it imports — one schema, one tenancy block`
      )

    return {
      tenancy:   schema.tenancy ?? importedTenancy,
      models:    [...importedModels,    ...schema.models],
      enums:     [...importedEnums,     ...schema.enums],
      functions: [...importedFunctions, ...schema.functions],
      databases: [...importedDatabases, ...schema.databases],
      views:     [...importedViews,     ...schema.views],
      traits:    [...importedTraits,    ...(schema.traits ?? [])],
      types:     [...importedTypes,     ...(schema.types ?? [])],
      // A value set is a top-level declaration like an enum, and a package that
      // ships a list ships it the same way. Dropping it here made the binding on
      // the field report the set as undeclared — in the ROOT file too, since the
      // merge is what builds the schema every caller of `parseFile` validates.
      valuesets: [...importedValuesets, ...(schema.valuesets ?? [])],
      // Order does not matter: resolveExtends indexes the models by name after
      // the whole tree is merged, so a file may extend a model it is imported
      // BY as readily as one it imports.
      extends:   [...importedExtends,   ...(schema.extends ?? [])],
      // A union, where tenancy above is a refusal: two files naming the same
      // claim have said one thing, and a package fragment declaring the claim
      // its own policies read is how an app gets it without restating it.
      claims:    [...new Set([...importedClaims, ...(schema.claims ?? [])])],
      claimSources: { ...importedSources, ...(schema.claimSources ?? {}) },
    }
  }

  const merged = loadFile(absPath)
  if (!merged) return { schema: null, valid: false, errors: allErrors, warnings: allWarnings }

  const schema = {
    imports:   [],  // already resolved — not needed downstream
    tenancy:   merged.tenancy ?? null,
    databases: merged.databases,
    models:    merged.models,
    views:     merged.views,
    enums:     merged.enums,
    functions: merged.functions,
    traits:    merged.traits ?? [],
    types:     merged.types ?? [],
    valuesets: merged.valuesets ?? [],
    extends:   merged.extends ?? [],
    claims:    merged.claims ?? [],
    claimSources: merged.claimSources ?? {},
  }

  // Resolve traits before validation. resolveTraits mutates schema.models,
  // splicing trait fields/attributes in. The schema.traits array is left
  // populated for introspection/debugging but otherwise ignored downstream.
  const extendErrors = resolveExtends(schema)
  allErrors.push(...extendErrors)

  const traitErrors = resolveTraits(schema)
  allErrors.push(...traitErrors)

  // Validate `type` declarations and their `Json @type(T)` references.
  const typeErrors = validateTypes(schema)
  allErrors.push(...typeErrors)

  // Run the full validator on the merged schema
  expandSecretAttributes(schema)
  allErrors.push(...expandCompositeId(schema))
  expandHasTemplatesAttributes(schema)
  allErrors.push(...expandAuthorshipAttributes(schema))
  allErrors.push(...expandEdgeAttributes(schema))
  allErrors.push(...expandExtensible(schema))
  allErrors.push(...expandRelator(schema))
  const tenancy = expandTenancy(schema)
  allErrors.push(...tenancy.errors)
  allWarnings.push(...tenancy.warnings)
  resolveTransitions(schema)
  allErrors.push(...expandCapabilityType(schema))
  const { valid, errors, warnings } = validate(schema)
  allErrors.push(...errors)
  allWarnings.push(...warnings)

  return {
    schema,
    valid:    allErrors.length === 0,
    errors:   allErrors,
    warnings: allWarnings,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function parse(src) {
  const tokens = tokenize(src)
  const parser = new Parser(tokens)
  let schema
  try {
    schema = parser.parseSchema()
  } catch (e) {
    if (e instanceof ParseError)
      return { schema: null, valid: false, errors: [e.message], warnings: [] }
    throw e
  }
  // Before traits, so an extend may carry a @@trait(T) of its own.
  const extendErrors = resolveExtends(schema)
  if (extendErrors.length) {
    return { schema, valid: false, errors: extendErrors, warnings: [] }
  }
  const traitErrors = resolveTraits(schema)
  if (traitErrors.length) {
    return { schema, valid: false, errors: traitErrors, warnings: [] }
  }
  const typeErrors = validateTypes(schema)
  if (typeErrors.length) {
    return { schema, valid: false, errors: typeErrors, warnings: [] }
  }
  expandSecretAttributes(schema)
  const compositeIdErrors = expandCompositeId(schema)
  expandHasTemplatesAttributes(schema)
  const authorshipErrors = expandAuthorshipAttributes(schema)
  const edgeErrors = expandEdgeAttributes(schema)
  const extErrors  = expandExtensible(schema)
  const relatorErrors = expandRelator(schema)
  const tenancy = expandTenancy(schema)
  resolveTransitions(schema)
  const capabilityErrors = expandCapabilityType(schema)
  const { valid, errors, warnings } = validate(schema)
  const merged = [...compositeIdErrors, ...authorshipErrors, ...edgeErrors, ...extErrors, ...relatorErrors, ...tenancy.errors, ...capabilityErrors, ...errors]
  return { schema, valid: merged.length === 0, errors: merged, warnings: [...tenancy.warnings, ...warnings] }
}
