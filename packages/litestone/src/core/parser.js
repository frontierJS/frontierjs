// schema.lite parser — recursive descent, zero dependencies

// ─── Tokenizer ────────────────────────────────────────────────────────────────

const TK = {
  IDENT:    'IDENT',
  STRING:   'STRING',
  NUMBER:   'NUMBER',
  BOOL:     'BOOL',
  AT:       'AT',       // @
  ATAT:     'ATAT',     // @@
  ARROW:    'ARROW',    // ->
  LBRACE:   'LBRACE',   // {
  RBRACE:   'RBRACE',   // }
  LBRACKET: 'LBRACKET', // [
  RBRACKET: 'RBRACKET', // ]
  LPAREN:   'LPAREN',   // (
  RPAREN:   'RPAREN',   // )
  COMMA:    'COMMA',    // ,
  COLON:    'COLON',    // :
  QUESTION: 'QUESTION', // ?
  DOT:      'DOT',      // .
  COMMENT:  'COMMENT',  // /// doc comment
  EOF:      'EOF',
  // ── Policy expression operators ─────────────────────────────────────────
  OR:   'OR',   // ||
  AND:  'AND',  // &&
  BANG: 'BANG', // !
  EQ:   'EQ',   // ==
  NEQ:  'NEQ',  // !=
  LT:   'LT',   // <
  GT:   'GT',   // >
  LTE:  'LTE',  // <=
  GTE:  'GTE',  // >=
}

const SCALAR_TYPES = new Set([
  'Text', 'Integer', 'Real', 'Blob', 'Boolean', 'DateTime', 'Json', 'File'
])

const KEYWORDS = new Set([
  'model', 'enum', 'function', 'import', 'database', 'view', 'trait', 'type', 'true', 'false'
])

function tokenize(src) {
  const tokens = []
  let i = 0
  let line = 1
  let col  = 1

  function mark() { return { line, col } }
  function advance(n = 1) {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1 } else col++
      i++
    }
  }

  while (i < src.length) {
    const pos = mark()

    // Whitespace
    if (/\s/.test(src[i])) { advance(); continue }

    // Triple-slash doc comment
    if (src.slice(i, i + 3) === '///') {
      const start = i + 3
      while (i < src.length && src[i] !== '\n') advance()
      tokens.push({ type: TK.COMMENT, value: src.slice(start, i).trim(), ...pos })
      continue
    }

    // Regular line comment — skip
    if (src.slice(i, i + 2) === '//') {
      while (i < src.length && src[i] !== '\n') advance()
      continue
    }

    // Block comment — skip
    if (src.slice(i, i + 2) === '/*') {
      advance(2)
      while (i < src.length && src.slice(i, i + 2) !== '*/') advance()
      advance(2)
      continue
    }

    // @@ before @
    if (src.slice(i, i + 2) === '@@') {
      tokens.push({ type: TK.ATAT, value: '@@', ...pos })
      advance(2); continue
    }

    // Multi-char operators — must check before single chars
    if (src.slice(i, i+2) === '->') { tokens.push({ type: TK.ARROW, value: '->', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '||') { tokens.push({ type: TK.OR,  value: '||', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '&&') { tokens.push({ type: TK.AND, value: '&&', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '==') { tokens.push({ type: TK.EQ,  value: '==', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '!=') { tokens.push({ type: TK.NEQ, value: '!=', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '<=') { tokens.push({ type: TK.LTE, value: '<=', ...pos }); advance(2); continue }
    if (src.slice(i, i+2) === '>=') { tokens.push({ type: TK.GTE, value: '>=', ...pos }); advance(2); continue }
    if (src[i] === '<') { tokens.push({ type: TK.LT,   value: '<',  ...pos }); advance(); continue }
    if (src[i] === '>') { tokens.push({ type: TK.GT,   value: '>',  ...pos }); advance(); continue }
    if (src[i] === '!') { tokens.push({ type: TK.BANG, value: '!',  ...pos }); advance(); continue }

    // Semicolon — field separator in compact inline schemas, treated as whitespace
    if (src[i] === ';') { advance(); continue }

    // Single-char tokens
    const single = { '{': TK.LBRACE, '}': TK.RBRACE, '[': TK.LBRACKET, ']': TK.RBRACKET,
                     '(': TK.LPAREN, ')': TK.RPAREN, ',': TK.COMMA,    ':': TK.COLON,
                     '?': TK.QUESTION, '.': TK.DOT,  '@': TK.AT }
    if (single[src[i]]) {
      tokens.push({ type: single[src[i]], value: src[i], ...pos })
      advance(); continue
    }

    // String literal
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i]
      advance()
      let str = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') { advance(); str += src[i] } else { str += src[i] }
        advance()
      }
      advance() // closing quote
      tokens.push({ type: TK.STRING, value: str, ...pos })
      continue
    }

    // Number
    if (/[0-9]/.test(src[i]) || (src[i] === '-' && /[0-9]/.test(src[i + 1]))) {
      let num = ''
      if (src[i] === '-') { num += '-'; advance() }
      while (i < src.length && /[0-9.]/.test(src[i])) { num += src[i]; advance() }
      tokens.push({ type: TK.NUMBER, value: Number(num), ...pos })
      continue
    }

    // Identifier or keyword or boolean
    if (/[_a-zA-Z]/.test(src[i])) {
      let id = ''
      while (i < src.length && /[\w]/.test(src[i])) { id += src[i]; advance() }
      if (id === 'true' || id === 'false')
        tokens.push({ type: TK.BOOL, value: id === 'true', ...pos })
      else
        tokens.push({ type: TK.IDENT, value: id, ...pos })
      continue
    }

    throw new ParseError(`Unexpected character '${src[i]}'`, pos)
  }

  tokens.push({ type: TK.EOF, value: null, line, col })
  return tokens
}

// ─── Error ────────────────────────────────────────────────────────────────────

class ParseError extends Error {
  constructor(msg, pos) {
    super(pos ? `${msg} (line ${pos.line}, col ${pos.col})` : msg)
    this.name = 'ParseError'
    this.pos  = pos
  }
}

// ─── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  constructor(tokens) {
    this.tokens = tokens
    this.pos    = 0
  }

  // ── Primitives ──────────────────────────────────────────────────────────────

  peek()      { return this.tokens[this.pos] }
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

  // Collect leading /// doc comments
  docComments() {
    const comments = []
    while (this.check(TK.COMMENT)) comments.push(this.advance().value)
    return comments
  }

  // ── Top level ───────────────────────────────────────────────────────────────

  parseSchema() {
    const schema = { imports: [], databases: [], models: [], views: [], enums: [], functions: [], traits: [], types: [] }

    while (!this.isEOF()) {
      const comments = this.docComments()
      const t = this.peek()

      if (t.type === TK.IDENT && t.value === 'import') {
        schema.imports.push(this.parseImport())
      } else if (t.type === TK.IDENT && t.value === 'database') {
        schema.databases.push(this.parseDatabase())
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
      } else {
        throw new ParseError(`Unexpected token '${t.value}' — expected database, model, view, enum, function, trait, type, or import`, t)
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

    while (!this.check(TK.RBRACE)) {
      const key = this.eat(TK.IDENT).value
      switch (key) {
        case 'path':
          path = this.parseEnvOrString()
          break
        case 'driver': {
          const val = this.eat(TK.IDENT).value
          if (val !== 'sqlite' && val !== 'jsonl' && val !== 'logger')
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
        default:
          throw new ParseError(`database '${name}': unknown property '${key}'`, this.peek())
      }
      this.maybeEat(TK.COMMA)
    }

    this.eat(TK.RBRACE)

    if (!path)
      throw new ParseError(`database '${name}' must declare a 'path'`, this.peek())

    return { name, path, driver, replication, retention, maxSize, logModel }
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
  //   id          Integer
  //   name        Text
  //   accountName Text
  //
  //   @@sql("SELECT u.id, u.name, a.name AS accountName FROM users u ...")
  //   @@db(logs)
  // }
  //
  // view accountStats {
  //   accountId Integer
  //   total     Integer
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
    let   sql         = null
    let   materialized = false
    let   refreshOn   = []
    let   db          = null

    while (!this.check(TK.RBRACE)) {
      if (this.check(TK.ATAT)) {
        // Model-level attribute
        this.eat(TK.ATAT)
        const attr = this.eat(TK.IDENT).value
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
            throw new ParseError(`Unknown view attribute '@@${attr}'`, this.peek())
        }
      } else {
        // Field declaration: name Type[?]
        const fieldComments = this.docComments()
        const fieldName = this.eat(TK.IDENT).value
        const type      = this.parseFieldType()
        fields.push({ name: fieldName, type, comments: fieldComments })
        this.maybeEat(TK.COMMA)
      }
    }

    this.eat(TK.RBRACE)

    return { name, fields, sql, materialized, refreshOn, db, comments }
  }


  // ── Function ─────────────────────────────────────────────────────────────────
  // Defines a named SQL expression usable as a @generated field shorthand.
  //
  // function discount(price: Integer, pct: Real): Integer {
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

  parseImport() {
    this.eatIdent('import')
    const path = this.eat(TK.STRING).value
    this.maybeEat(TK.IDENT, ';')
    return { path }
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
  //   street     Text
  //   city       Text
  //   state      Text?
  //   postalCode Text
  //   country    Text @default("US")
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
      case 'unique':   return { kind: 'unique' }
      case 'map':      return { kind: 'map',       name: this.parseParenString() }
      case 'default':  return { kind: 'default',   value: this.parseDefault() }
      case 'relation': return { kind: 'relation',  ...this.parseRelation() }
      case 'generated':return { kind: 'generated', ...this.parseGenerated() }
      case 'from': return { kind: 'from', ...this.parseFrom() }

      case 'computed':   return { kind: 'computed' }
      case 'hardDelete': return { kind: 'hardDelete' }

      // ── Field visibility + access control ─────────────────────────────────
      case 'omit': {
        // @omit        → skip lists, include on findUnique
        // @omit(all)   → skip everything unless explicitly selected
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const arg = this.eat(TK.IDENT).value
          this.eat(TK.RPAREN)
          if (arg !== 'all') throw new ParseError(`@omit only accepts (all) as an argument, got (${arg})`, this.peek())
          return { kind: 'omit', level: 'all' }
        }
        return { kind: 'omit', level: 'lists' }
      }
      case 'guarded': {
        // @guarded      → absent unless explicitly selected AND system context
        // @guarded(all) → absent unless system context (select cannot unlock)
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const arg = this.eat(TK.IDENT).value
          this.eat(TK.RPAREN)
          if (arg !== 'all') throw new ParseError(`@guarded only accepts (all) as an argument, got (${arg})`, this.peek())
          return { kind: 'guarded', level: 'all' }
        }
        return { kind: 'guarded', level: 'select' }
      }
      case 'encrypted': {
        // @encrypted → implies @guarded(all), AES-256-GCM on write/read
        // @encrypted(searchable: true) → deterministic HMAC, usable in WHERE
        let searchable = false
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const key = this.eat(TK.IDENT).value
          this.eat(TK.COLON)
          const val = this.eat(TK.BOOL).value
          this.eat(TK.RPAREN)
          if (key !== 'searchable') throw new ParseError(`@encrypted only accepts (searchable: true/false), got (${key})`, this.peek())
          searchable = val === true || val === 'true'
        }
        return { kind: 'encrypted', searchable }
      }
      case 'check':    return { kind: 'check',     expr: this.parseParenString() }

      // ── @secret — composite encrypted+guarded+logged field ─────────────────
      // @secret                   — rotatable (default)
      // @secret(rotate: false)    — permanently bound to original key
      //
      // Expands at parse time (expandSecretAttributes) to:
      //   @encrypted @guarded(all) @log(<first logger db>)   (log only if logger db declared)
      // The { kind: 'secret', rotate } attr is kept for key rotation tracking.
      case 'secret': {
        let rotate = true
        if (this.check(TK.LPAREN)) {
          this.eat(TK.LPAREN)
          const key = this.eat(TK.IDENT).value
          this.eat(TK.COLON)
          const val = this.eat(TK.BOOL).value
          this.eat(TK.RPAREN)
          if (key !== 'rotate')
            throw new ParseError(`@secret only accepts (rotate: true/false), got (${key})`, this.peek())
          rotate = val === true || val === 'true'
        }
        return { kind: 'secret', rotate }
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

      // ── String validators ──────────────────────────────────────────────────
      case 'email':      return { kind: 'email',      ...this.parseOptMessage() }
      case 'url':        return { kind: 'url',        ...this.parseOptMessage() }
      case 'phone':      return { kind: 'phone',      ...this.parseOptMessage() }
      case 'markdown':   return { kind: 'markdown' }   // semantic annotation — no validation
      case 'accept':     return { kind: 'accept', types: this.parseParenString() }   // e.g. @accept("image/*")
      case 'date':       return { kind: 'date',       ...this.parseOptMessage() }
      case 'datetime':   return { kind: 'datetime',   ...this.parseOptMessage() }
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
      case 'uniqueItems': return { kind: 'uniqueItems' }

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
    throw new ParseError(`Invalid default value`, t)
  }

  parseRelation() {
    this.eat(TK.LPAREN)
    const rel = {}

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

  parseGenerated() {
    this.eat(TK.LPAREN)
    const raw    = this.eat(TK.STRING).value
    const stored = this.check(TK.COMMA) && (this.advance(), this.eat(TK.IDENT).value === 'stored')
    this.eat(TK.RPAREN)
    // Expand {fieldName} → "fieldName" so no quote-escaping is needed in the schema.
    // @generated("{price} * 1.08") becomes "price" * 1.08 in SQL.
    const expr = raw.replace(/\{(\w+)\}/g, '"$1"')
    return { expr, stored }
  }

  // ── @from parser ────────────────────────────────────────────────────────────
  // @from(targetModel, op: value, [where: "sql", orderBy: field])
  //
  // Operations (exactly one required):
  //   last: true     — last row as full object  (ORDER BY {orderBy|id} DESC LIMIT 1)
  //   first: true    — first row as full object (ORDER BY {orderBy|id} ASC  LIMIT 1)
  //   count: true    — COUNT(*) as Integer
  //   sum: fieldName — COALESCE(SUM(field), 0) as Real/Integer
  //   max: fieldName — MAX(field) as DateTime/Real/Integer
  //   min: fieldName — MIN(field) as DateTime/Real/Integer
  //   exists: true   — EXISTS(...) as Boolean
  parseFrom() {
    this.eat(TK.LPAREN)
    const target = this.eat(TK.IDENT).value
    this.eat(TK.COMMA)

    // Parse key: value pairs
    let op = null, opValue = null, where = null, orderBy = null

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
        default:
          throw new ParseError(`@from: unknown option '${key}'`, this.peek())
      }
      this.maybeEat(TK.COMMA)
    }

    this.eat(TK.RPAREN)
    if (!op) throw new ParseError(`@from requires an operation (last, first, count, sum, max, min, exists)`, this.peek())
    return { target, op, opValue, where: where ?? null, orderBy: orderBy ?? null }
  }

  parseParenString() {
    this.eat(TK.LPAREN)
    const val = this.eat(TK.STRING).value
    this.eat(TK.RPAREN)
    return val
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

    // Named form — parse key: LEVEL pairs
    const LEVEL_NAMES = {
      STRANGER: 0, VISITOR: 1, READER: 2, CREATOR: 3,
      USER: 4, ADMINISTRATOR: 5, OWNER: 6,
      SYSADMIN: 7,  // global system admin — real human, user.isSystemAdmin
      SYSTEM:   8,  // asSystem() only
      LOCKED:   9,  // absolute wall
    }
    const VALID_KEYS = new Set(['read', 'create', 'update', 'delete', 'write'])

    const named = {}
    do {
      const key = this.eat(TK.IDENT).value
      if (!VALID_KEYS.has(key))
        throw new ParseError(`@@gate: unknown key "${key}". Valid keys: read, create, update, delete, write`, this.peek())
      this.eat(TK.COLON)
      const levelToken = this.eat(TK.IDENT)
      const level = LEVEL_NAMES[levelToken.value]
      if (level === undefined)
        throw new ParseError(`@@gate: unknown level "${levelToken.value}". Valid: ${Object.keys(LEVEL_NAMES).join(', ')}`, levelToken)
      named[key] = level
    } while (this.maybeEat(TK.COMMA))

    this.eat(TK.RPAREN)

    // Expand 'write' shorthand → create, update, delete
    if ('write' in named) {
      if (!('create' in named)) named.create = named.write
      if (!('update' in named)) named.update = named.write
      if (!('delete' in named)) named.delete = named.write
      delete named.write
    }

    // Build dotted string — missing positions cascade from read (same as parseGateString)
    const r = named.read   ?? 0
    const c = named.create ?? r
    const u = named.update ?? c
    const d = named.delete ?? u
    return `${r}.${c}.${u}.${d}`
  }

  // ─── Policy expression parser ──────────────────────────────────────────────
  // Parses the condition argument of @@allow / @@deny.
  //
  // Grammar (standard boolean precedence):
  //   expr     ::= or
  //   or       ::= and  ('||' and)*
  //   and      ::= not  ('&&' not)*
  //   not      ::= '!' not | primary
  //   primary  ::= '(' expr ')' | value [compOp value]
  //   value    ::= auth() [.field] | now() | check(field [,op]) | null | bool | string | number | ident
  //   compOp   ::= '==' | '!=' | '<' | '>' | '<=' | '>='

  parsePolicyExpr()    { return this.parsePolicyOr() }
  parsePolicyOr()      {
    let left = this.parsePolicyAnd()
    while (this.check(TK.OR))  { this.eat(TK.OR);  left = { type: 'or',  left, right: this.parsePolicyAnd() } }
    return left
  }
  parsePolicyAnd()     {
    let left = this.parsePolicyNot()
    while (this.check(TK.AND)) { this.eat(TK.AND); left = { type: 'and', left, right: this.parsePolicyNot() } }
    return left
  }
  parsePolicyNot()     {
    if (this.check(TK.BANG)) { this.eat(TK.BANG); return { type: 'not', expr: this.parsePolicyNot() } }
    return this.parsePolicyPrimary()
  }
  parsePolicyPrimary() {
    if (this.check(TK.LPAREN)) {
      this.eat(TK.LPAREN)
      const expr = this.parsePolicyExpr()
      this.eat(TK.RPAREN)
      return expr
    }
    const left = this.parsePolicyValue()
    const op   = this.checkPolicyCompOp()
    if (op) {
      this.advance()
      const right = this.parsePolicyValue()
      return { type: 'compare', op, left, right }
    }
    return left
  }
  checkPolicyCompOp() {
    const t = this.peek().type
    if (t === TK.EQ)  return '=='
    if (t === TK.NEQ) return '!='
    if (t === TK.LT)  return '<'
    if (t === TK.GT)  return '>'
    if (t === TK.LTE) return '<='
    if (t === TK.GTE) return '>='
    return null
  }
  parsePolicyValue() {
    const t = this.peek()

    // auth() or auth().field
    if (t.type === TK.IDENT && t.value === 'auth') {
      this.eat(TK.IDENT)
      this.eat(TK.LPAREN); this.eat(TK.RPAREN)
      if (this.check(TK.DOT)) {
        this.eat(TK.DOT)
        const field = this.eat(TK.IDENT).value
        return { type: 'auth', field }
      }
      return { type: 'auth', field: null }
    }

    // now()
    if (t.type === TK.IDENT && t.value === 'now') {
      this.eat(TK.IDENT)
      this.eat(TK.LPAREN); this.eat(TK.RPAREN)
      return { type: 'now' }
    }

    // check(field) or check(field, 'operation')
    if (t.type === TK.IDENT && t.value === 'check') {
      this.eat(TK.IDENT)
      this.eat(TK.LPAREN)
      const field = this.eat(TK.IDENT).value
      let operation = null
      if (this.maybeEat(TK.COMMA)) operation = this.eat(TK.STRING).value
      this.eat(TK.RPAREN)
      return { type: 'check', field, operation }
    }

    // null keyword
    if (t.type === TK.IDENT && t.value === 'null') {
      this.eat(TK.IDENT)
      return { type: 'literal', value: null }
    }

    // boolean literal
    if (t.type === TK.BOOL) {
      this.eat(TK.BOOL)
      return { type: 'literal', value: t.value }
    }

    // string literal
    if (t.type === TK.STRING) {
      this.eat(TK.STRING)
      return { type: 'literal', value: t.value }
    }

    // number literal
    if (t.type === TK.NUMBER) {
      this.eat(TK.NUMBER)
      return { type: 'literal', value: t.value }
    }

    // field reference (any other identifier)
    if (t.type === TK.IDENT) {
      this.eat(TK.IDENT)
      return { type: 'field', name: t.value }
    }

    throw new ParseError(`Expected a value in policy expression, got '${t.value ?? t.type}'`, t)
  }

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

  // ── Model attributes ────────────────────────────────────────────────────────

  parseModelAttribute() {
    this.eat(TK.ATAT)
    const name = this.eat(TK.IDENT).value

    switch (name) {
      case 'index':  return { kind: 'index',       fields: this.parseFieldListParen() }
      case 'unique': return { kind: 'uniqueIndex',  fields: this.parseFieldListParen() }
      case 'strict':   return { kind: 'strict' }    // legacy explicit opt-in
      case 'noStrict': return { kind: 'noStrict' }  // opt-out from default strict
      case 'fts':    return { kind: 'fts',          fields: this.parseFieldListParen() }
      case 'map':    return { kind: 'map',          name: this.parseParenString() }
      case 'external': return { kind: 'external' }  // table exists outside migrations
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
      case 'softDeleteCascade':
        throw new ParseError(`@@softDeleteCascade is no longer supported. Use @@softDelete(cascade) instead.`, this.peek())
      // ── Access policies ──────────────────────────────────────────────────────
      // @@allow('read', published || owner == auth())
      // @@allow('create,update', auth() != null)
      // @@deny('delete', status == 'archived')
      case 'allow':
      case 'deny': {
        this.eat(TK.LPAREN)
        const opStr = this.eat(TK.STRING).value
        const operations = normalisePolicyOps(opStr, this.peek())
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
      case 'gate':   return { kind: 'gate',         value: this.parseGateArg() }
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

  // ── Enum ────────────────────────────────────────────────────────────────────

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
          if (tName in transitions)
            throw new ParseError(`Enum '${name}': duplicate transition name '${tName}'`, this.peek())
          transitions[tName] = { from: froms, to }
        }
        this.eat(TK.RBRACE)
      } else {
        values.push({ name: this.eat(TK.IDENT).value, comments: enumComments })
      }
    }

    this.eat(TK.RBRACE)
    return { name, comments, values, transitions: transitions ?? undefined }
  }
}

// ─── Policy operation normaliser ─────────────────────────────────────────────
// Accepts: 'read', 'create', 'update', 'post-update', 'delete',
//          'write' (= create+update+delete), 'all' (= all five),
//          or comma-separated combos: 'update,delete'
// Returns: array of canonical op names, deduplicated

const VALID_POLICY_OPS = new Set(['read', 'create', 'update', 'post-update', 'delete'])

function normalisePolicyOps(str, token) {
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
// Synthesizes @encrypted, @guarded(all), and optionally @log(<loggerDb>) onto
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

const TRAIT_FORBIDDEN_FIELD_ATTRS = new Set(['id'])
const TRAIT_FORBIDDEN_MODEL_ATTRS = new Set(['id', 'map', 'db', 'fts'])

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
//   - Scalar fields (Text, Integer, Real, Boolean, DateTime)
//   - Optional fields (Text?)
//   - Array fields (Text[], Integer[])
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
//   - File / Blob field types — bytes don't JSON-encode
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

const TYPE_FORBIDDEN_FIELD_ATTRS = new Set([
  'id', 'unique', 'map', 'relation', 'generated', 'from',
  'encrypted', 'guarded', 'secret', 'updatedAt', 'allow', 'deny',
])
const TYPE_FORBIDDEN_FIELD_TYPES = new Set(['File', 'Blob'])
const TYPE_DEFAULT_FORBIDDEN_KINDS = new Set(['now', 'cuid', 'ulid', 'uuid', 'auth'])

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
      if (!field.attributes.some(a => a.kind === 'secret')) continue

      // Synthesize @encrypted + @guarded(all) unconditionally.
      // If the field already had an explicit @encrypted or @guarded, this produces
      // duplicates — validate() catches those as conflict errors.
      field.attributes.push({ kind: 'encrypted', searchable: false })
      field.attributes.push({ kind: 'guarded', level: 'all' })

      // Synthesize @log(<loggerDb>) — audit writes only by default.
      // reads:false matches @@log model-level default — reads are high-volume and opt-in.
      // To audit reads, declare @log(audit, reads: true) explicitly on the field.
      if (loggerDb && !field.attributes.some(a => a.kind === 'log'))
        field.attributes.push({ kind: 'log', db: loggerDb.name, reads: false, writes: true })
    }
  }
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
      const isImplicitM2M    = field.type.array && modelNames.has(field.type.name) && !isRelationField
      const isFromField      = field.attributes.some(a => a.kind === 'from')
      const validType = allTypes.has(field.type.name)
        || (isRelationField && modelNames.has(field.type.name))
        || isImplicitM2M
        || (isFromField && modelNames.has(field.type.name))  // @from last/first return model objects
      if (!validType)
        errors.push(`Model '${model.name}', field '${field.name}': unknown type '${field.type.name}'`)
      if (isRelationField) field.type.kind = 'relation'
      if (isImplicitM2M)   field.type.kind = 'implicitM2M'

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
        const validActions = new Set(['Cascade', 'SetNull', 'Restrict', 'NoAction'])
        if (rel.onDelete && !validActions.has(rel.onDelete))
          errors.push(`Model '${model.name}': unknown onDelete action '${rel.onDelete}'`)
      }

      // Array type validation — only Text, Integer, and File support []
      if (field.type.array) {
        const arrayAllowed = new Set(['Text', 'Integer', 'File'])
        const isImplicitM2M = modelNames.has(field.type.name) && field.type.kind !== 'relation'
        if (!arrayAllowed.has(field.type.name) && field.type.kind !== 'relation' && !isImplicitM2M) {
          errors.push(`Model '${model.name}', field '${field.name}': array [] is only supported for Text, Integer, File, or a model name for many-to-many (got ${field.type.name})`)
        }
        // Mark as implicit m2m relation
        if (isImplicitM2M) field.type.kind = 'implicitM2M' 
      }

      // Json fields can't be part of indexes (warn, not error)
      if (field.type.name === 'Json') {
        const inIndex = model.attributes.some(a =>
          (a.kind === 'index' || a.kind === 'uniqueIndex') && a.fields.includes(field.name)
        )
        if (inIndex)
          warnings.push(`Model '${model.name}': Json field '${field.name}' used in index — SQLite will index the raw JSON text`)
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
    // model key only valid on logger
    if (db.logModel && db.driver !== 'logger')
      errors.push(`database '${db.name}': model key is only valid for logger databases`)
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
      else if (!loggerNames.has(logAttr.db))
        errors.push(`Model '${model.name}', field '${field.name}': @log database '${logAttr.db}' must use driver logger (got '${schema.databases.find(d => d.name === logAttr.db)?.driver}')`)
    }

    // @@log on models — db must be a logger database
    for (const attr of model.attributes) {
      if (attr.kind !== 'log') continue
      if (!dbNames.has(attr.db))
        errors.push(`Model '${model.name}': @@log references unknown database '${attr.db}'`)
      else if (!loggerNames.has(attr.db))
        errors.push(`Model '${model.name}': @@log database '${attr.db}' must use driver logger (got '${schema.databases.find(d => d.name === attr.db)?.driver}')`)
    }

    // @secret validation — check for conflicting explicit attributes
    for (const field of model.fields) {
      if (!field.attributes.some(a => a.kind === 'secret')) continue

      // @secret cannot be combined with explicit @encrypted or @guarded — it synthesizes them
      if (field.attributes.filter(a => a.kind === 'encrypted').length > 1)
        errors.push(`Model '${model.name}', field '${field.name}': @secret already implies @encrypted — remove the explicit @encrypted`)
      if (field.attributes.filter(a => a.kind === 'guarded').length > 1)
        errors.push(`Model '${model.name}', field '${field.name}': @secret already implies @guarded(all) — remove the explicit @guarded`)

      // @secret on jsonl databases — not supported (inherits @encrypted restriction)
      const dbAttr = model.attributes.find(a => a.kind === 'db')
      if (dbAttr && jsonlNames.has(dbAttr.name))
        errors.push(`Model '${model.name}', field '${field.name}': @secret (and @encrypted) are not supported on jsonl databases`)

      // Warn if no logger database exists — @log won't be synthesized
      if (!schema.databases.some(db => db.driver === 'logger'))
        warnings.push(`Model '${model.name}', field '${field.name}': @secret has no logger database declared — audit logging will not be active. Add a 'database audit { driver logger }' block to enable it.`)
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
        errors.push(`Model '${model.name}', field '${field.name}': @allow conflicts with @secret — @secret already implies @guarded(all)`)
    }
  }

  // ── @sequence validation ────────────────────────────────────────────────────
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (!field.attributes.some(a => a.kind === 'sequence')) continue
      if (field.type.name !== 'Integer')
        errors.push(`Model '${model.name}', field '${field.name}': @sequence requires an Integer or Integer? field, got ${field.type.name}`)
      const seqAttr = field.attributes.find(a => a.kind === 'sequence')
      const scopeField = model.fields.find(f => f.name === seqAttr.scope)
      if (!scopeField)
        errors.push(`Model '${model.name}', field '${field.name}': @sequence(scope: ${seqAttr.scope}) — field '${seqAttr.scope}' does not exist on this model`)
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
      if (op === 'count' && field.type.name !== 'Integer')
        errors.push(`Model '${model.name}', field '${field.name}': @from(${target}, count: true) — field type must be Integer, got '${field.type.name}'`)
      if (op === 'exists' && field.type.name !== 'Boolean')
        errors.push(`Model '${model.name}', field '${field.name}': @from(${target}, exists: true) — field type must be Boolean, got '${field.type.name}'`)
      // sum/max/min: target field must exist on target model
      if ((op === 'sum' || op === 'max' || op === 'min') && targetModel) {
        const targetField = targetModel.fields.find(f => f.name === opValue)
        if (!targetField)
          errors.push(`Model '${model.name}', field '${field.name}': @from(${target}, ${op}: ${opValue}) — field '${opValue}' does not exist on '${target}'`)
      }
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

  // ── @allow / @@deny validation ──────────────────────────────────────────────
  for (const model of schema.models) {
    for (const attr of model.attributes) {
      if (attr.kind !== 'allow' && attr.kind !== 'deny') continue
      // Operations already validated by normalisePolicyOps at parse time.
      // Warn if model is on a jsonl database — policies aren't supported there.
      const dbAttr = model.attributes.find(a => a.kind === 'db')
      if (dbAttr) {
        const dbDef = schema.databases.find(d => d.name === dbAttr.name)
        if (dbDef?.driver === 'jsonl')
          errors.push(`Model '${model.name}': @@${attr.kind} policies are not supported on jsonl databases`)
      }
    }
    // Warn if @@deny exists with no @@allow — probably a mistake
    const hasAllow = model.attributes.some(a => a.kind === 'allow')
    const hasDeny  = model.attributes.some(a => a.kind === 'deny')
    if (hasDeny && !hasAllow)
      warnings.push(`Model '${model.name}': has @@deny but no @@allow — all operations are open by default, @@deny alone won't restrict access unless you add @@allow rules`)
  }

  // ── Logger database validation ────────────────────────────────────────────────
  for (const db of schema.databases) {
    if (db.driver !== 'logger') continue
    if (!db.logModel) continue   // auto mode — no model to validate

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

  for (const view of schema.views) {
    // Must have @@sql
    if (!view.sql)
      errors.push(`View '${view.name}' must declare @@sql("...")`)

    // @@db must reference a declared database
    if (view.db && !dbNames.has(view.db))
      errors.push(`View '${view.name}': @@db(${view.db}) references unknown database '${view.db}'`)

    // Cannot reference a jsonl database
    if (view.db && jsonlNames.has(view.db))
      errors.push(`View '${view.name}': @@db(${view.db}) — views cannot be declared on jsonl databases`)

    // @@materialized requires @@refreshOn
    if (view.materialized && view.refreshOn.length === 0)
      errors.push(`View '${view.name}': @@materialized requires @@refreshOn([...]) declaring source models`)

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
        warnings.push(
          `Model '${model.name}': has @@softDelete and a hasMany relation to '${childName}' which also uses @@softDelete. ` +
          `Soft-deleting a '${model.name}' row will NOT cascade to '${childName}' rows — they will remain live. ` +
          `Add @@softDelete(cascade) to propagate, or @hardDelete on the '${field.name}' field to hard-delete children.`
        )
      }
    }
  }

  // Validate implicit m2m: both sides must declare the relation.
  // Also reclassify Model[] fields as hasMany back-references when the target
  // model has an explicit @relation FK pointing back to this model.
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (field.type.kind !== 'implicitM2M') continue
      const targetModel = schema.models.find(m => m.name === field.type.name)
      if (!targetModel) {
        errors.push(`Model '${model.name}', field '${field.name}': unknown model '${field.type.name}'`)
        continue
      }
      // Check if the target model has a @relation field pointing back (hasMany back-ref)
      const hasFKBack = targetModel.fields.some(f => {
        if (!f.attributes.some(a => a.kind === 'relation' && a.fields)) return false
        return f.type.name === model.name
      })
      if (hasFKBack) {
        // Reclassify as a hasMany back-reference — not a join-table M2M
        field.type.kind = 'relation'
        continue
      }
      const mirror = targetModel.fields.find(f =>
        f.type.kind === 'implicitM2M' && f.type.name === model.name
      )
      if (!mirror) {
        errors.push(
          `Implicit many-to-many: '${model.name}.${field.name}' references '${field.type.name}' ` +
          `but '${field.type.name}' has no corresponding '${model.name}[]' field. ` +
          `Both sides must declare the relation.`
        )
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
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

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'

export function parseFile(filePath) {
  const absPath = resolve(filePath)
  const visited = new Set()
  const allErrors   = []
  const allWarnings = []

  function loadFile(currentPath) {
    if (visited.has(currentPath)) return null  // already merged
    visited.add(currentPath)

    let src
    try { src = readFileSync(currentPath, 'utf8') }
    catch (e) { allErrors.push(`Cannot read file: ${currentPath}`); return null }

    const tokens = tokenize(src)
    const parser = new Parser(tokens)
    const schema = parser.parseSchema()

    // Recursively resolve imports before merging
    const importedModels    = []
    const importedEnums     = []
    const importedFunctions = []
    const importedDatabases = []
    const importedViews     = []
    const importedTraits    = []
    const importedTypes     = []

    for (const imp of schema.imports) {
      const importPath = resolve(dirname(currentPath), imp.path)
      const child = loadFile(importPath)
      if (child) {
        importedModels.push(...child.models)
        importedEnums.push(...child.enums)
        importedFunctions.push(...child.functions)
        importedDatabases.push(...child.databases)
        importedViews.push(...child.views)
        importedTraits.push(...(child.traits ?? []))
        importedTypes.push(...(child.types ?? []))
      }
    }

    return {
      models:    [...importedModels,    ...schema.models],
      enums:     [...importedEnums,     ...schema.enums],
      functions: [...importedFunctions, ...schema.functions],
      databases: [...importedDatabases, ...schema.databases],
      views:     [...importedViews,     ...schema.views],
      traits:    [...importedTraits,    ...(schema.traits ?? [])],
      types:     [...importedTypes,     ...(schema.types ?? [])],
    }
  }

  const merged = loadFile(absPath)
  if (!merged) return { schema: null, valid: false, errors: allErrors, warnings: allWarnings }

  const schema = {
    imports:   [],  // already resolved — not needed downstream
    databases: merged.databases,
    models:    merged.models,
    views:     merged.views,
    enums:     merged.enums,
    functions: merged.functions,
    traits:    merged.traits ?? [],
    types:     merged.types ?? [],
  }

  // Resolve traits before validation. resolveTraits mutates schema.models,
  // splicing trait fields/attributes in. The schema.traits array is left
  // populated for introspection/debugging but otherwise ignored downstream.
  const traitErrors = resolveTraits(schema)
  allErrors.push(...traitErrors)

  // Validate `type` declarations and their `Json @type(T)` references.
  const typeErrors = validateTypes(schema)
  allErrors.push(...typeErrors)

  // Run the full validator on the merged schema
  expandSecretAttributes(schema)
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
  const traitErrors = resolveTraits(schema)
  if (traitErrors.length) {
    return { schema, valid: false, errors: traitErrors, warnings: [] }
  }
  const typeErrors = validateTypes(schema)
  if (typeErrors.length) {
    return { schema, valid: false, errors: typeErrors, warnings: [] }
  }
  expandSecretAttributes(schema)
  const { valid, errors, warnings } = validate(schema)
  return { schema, valid, errors, warnings }
}
