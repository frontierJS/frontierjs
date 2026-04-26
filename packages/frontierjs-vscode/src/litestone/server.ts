// litestone/server.ts
// The Litestone Language Server — runs as a separate Node.js process.
// VS Code communicates with it via the Language Server Protocol (LSP).
//
// ─── What's implemented ──────────────────────────────────────────────────────
//
//  ✓  Diagnostics      — parse() on every change → error squiggles + warnings
//  ✓  Completions      — field types, attributes, model/enum/function keywords,
//                        @funcName(fieldArg) completions
//  ✓  Hover            — attribute docs, type docs, function signature on hover
//  ✓  Formatting       — re-align fields, normalize spacing, sort attributes
//  ✓  Go-to-definition — jump from @relation to model, from @funcName to function
//
// ─── Parser bridge ───────────────────────────────────────────────────────────
//
//  The Litestone parser is bundled to CJS by scripts/build-parser.js (esbuild).
//  It runs at build time and outputs out/litestone/parser-bundle.js.
//
//  The bundle is a single CJS file — no Bun runtime needed, no subprocess,
//  no async overhead. parse() is a synchronous call: ~0.1ms per document.

import {
  createConnection,
  TextDocuments,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  Hover,
  MarkupKind,
  DocumentFormattingParams,
  TextEdit,
  Range,
  Definition,
  Location,
} from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import * as path from 'path'

// ─── Connection ───────────────────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all)
const documents  = new TextDocuments(TextDocument)

// ─── Parser bridge ────────────────────────────────────────────────────────────

type ParseResult = {
  valid:    boolean
  errors:   string[]
  warnings: string[]
  schema: {
    models:    any[]
    enums:     any[]
    functions: any[]
  }
}

let _parse: ((src: string) => ParseResult) | null = null
let _parseError: string | null = null

function loadParser() {
  if (_parse) return
  try {
    const bundle = require(path.join(__dirname, 'parser-bundle'))
    _parse = bundle.parse
  } catch (e: any) {
    _parseError = [
      `Litestone parser bundle not found.`,
      `Run: npm run build:parser`,
      `(${e.message})`,
    ].join(' ')
    connection.window.showErrorMessage(
      `FrontierJS: parser bundle missing. Run "npm run build:parser" in the frontierjs-vscode directory.`
    )
  }
}

function callParser(src: string): ParseResult {
  loadParser()
  if (!_parse) {
    return {
      valid:    false,
      errors:   [_parseError ?? 'Parser not loaded'],
      warnings: [],
      schema:   { models: [], enums: [], functions: [] },
    }
  }
  try {
    return _parse(src)
  } catch (e: any) {
    return {
      valid:    false,
      errors:   [`Parser error: ${e.message}`],
      warnings: [],
      schema:   { models: [], enums: [], functions: [] },
    }
  }
}

// ─── Document cache ───────────────────────────────────────────────────────────

const parseCache = new Map<string, ParseResult>()

// ─── Initialization ───────────────────────────────────────────────────────────

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync:           TextDocumentSyncKind.Incremental,
      completionProvider:         { resolveProvider: true, triggerCharacters: ['@', '.', ' ', '\n'] },
      hoverProvider:              true,
      documentFormattingProvider: true,
      definitionProvider:         true,
    }
  }
})

// ─── Diagnostics ─────────────────────────────────────────────────────────────

documents.onDidChangeContent(change => {
  validateDocument(change.document)
})

documents.onDidClose(e => {
  parseCache.delete(e.document.uri)
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] })
})

function validateDocument(doc: TextDocument) {
  const text   = doc.getText()
  const result = callParser(text)
  parseCache.set(doc.uri, result)

  const diagnostics = [
    ...result.errors.map(msg => makeDiagnostic(doc, msg, DiagnosticSeverity.Error)),
    ...result.warnings.map(msg => makeDiagnostic(doc, msg, DiagnosticSeverity.Warning)),
  ]

  connection.sendDiagnostics({ uri: doc.uri, diagnostics })
}

function makeDiagnostic(doc: TextDocument, msg: string, severity: DiagnosticSeverity) {
  const text  = doc.getText()
  const lines = text.split('\n')

  const fieldMatch = msg.match(/field '(\w+)'/)
  const modelMatch = msg.match(/Model '(\w+)'/)
  const searchTerm = fieldMatch?.[1] ?? modelMatch?.[1]

  if (searchTerm) {
    for (let i = 0; i < lines.length; i++) {
      const col = lines[i].indexOf(searchTerm)
      if (col !== -1) {
        return {
          severity,
          range:   Range.create(i, col, i, col + searchTerm.length),
          message: msg,
          source:  'litestone',
        }
      }
    }
  }

  return {
    severity,
    range:   Range.create(0, 0, 0, lines[0]?.length ?? 0),
    message: msg,
    source:  'litestone',
  }
}

// ─── Completions ──────────────────────────────────────────────────────────────

const SCALAR_TYPES = ['Integer', 'Real', 'Text', 'Boolean', 'DateTime', 'Json', 'Blob', 'File']

const FIELD_ATTRS = [
  // Identity / constraints
  '@id', '@unique',
  // Defaults
  '@default(now())', '@default(uuid())', '@default(ulid())', '@default(cuid())', '@default(nanoid())',
  // Relations & generation
  '@relation', '@generated', '@computed',
  // Lifecycle stamps
  '@updatedAt', '@updatedBy',
  // Sequence
  '@sequence',
  // Security
  '@omit', '@omit(all)',
  '@guarded', '@guarded(all)',
  '@encrypted', '@encrypted(searchable: true)',
  '@secret', '@secret(rotate: false)',
  // Audit
  '@log',
  // File storage
  '@keepVersions', '@accept',
  // Derived fields
  '@from',
  // Mapping
  '@map',
  // Validators
  '@email', '@url', '@phone', '@date', '@datetime',
  '@regex', '@length', '@gt', '@gte', '@lt', '@lte',
  '@startsWith', '@endsWith', '@contains',
  // Transforms
  '@trim', '@lower', '@upper', '@slug',
  // Annotations
  '@markdown', '@hardDelete',
  // Field-level policy
  "@allow('read',", "@allow('write',", "@allow('all',",
]

const MODEL_ATTRS = [
  '@@db', '@@index', '@@unique', '@@fts',
  '@@softDelete', '@@softDelete(cascade)',
  '@@gate', '@@auth', '@@allow', '@@deny',
  '@@log', '@@external',
  '@@map', '@@noStrict', '@@strict',
]

const TOP_KEYWORDS = ['model', 'enum', 'function', 'database', 'import']

const DATABASE_DRIVERS = ['sqlite', 'jsonl', 'logger']

connection.onCompletion((pos: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(pos.textDocument.uri)
  if (!doc) return []

  const text   = doc.getText()
  const lines  = text.split('\n')
  const line   = lines[pos.position.line] ?? ''
  const result = parseCache.get(pos.textDocument.uri)
  const trimmed    = line.trimStart()
  const atTrigger  = trimmed.includes('@') && !trimmed.includes('@@')
  const aatTrigger = trimmed.includes('@@')
  const inModel    = isInsideBlock(lines, pos.position.line, 'model')
  const inDatabase = isInsideBlock(lines, pos.position.line, 'database')
  const inFunction = isInsideBlock(lines, pos.position.line, 'function')

  // Top-level keywords
  if (!inModel && !inFunction && !inDatabase && !trimmed.startsWith('@')) {
    return TOP_KEYWORDS.map(kw => ({
      label:      kw,
      kind:       CompletionItemKind.Keyword,
      insertText: kw,
    }))
  }

  // database block — driver values
  if (inDatabase && trimmed.startsWith('driver')) {
    return DATABASE_DRIVERS.map(d => ({
      label: d,
      kind:  CompletionItemKind.EnumMember,
      detail: 'database driver',
    }))
  }

  const items: CompletionItem[] = []

  // Field types + enum names (when not typing an attribute)
  if (inModel && !atTrigger && !aatTrigger) {
    for (const t of SCALAR_TYPES) {
      items.push({ label: t, kind: CompletionItemKind.TypeParameter, detail: 'scalar type' })
    }
    for (const e of result?.schema.enums ?? []) {
      items.push({ label: e.name, kind: CompletionItemKind.EnumMember, detail: 'enum' })
    }
    for (const m of result?.schema.models ?? []) {
      items.push({ label: m.name, kind: CompletionItemKind.Class, detail: 'model (relation)' })
    }
  }

  // Field-level attributes
  if (inModel && atTrigger) {
    for (const a of FIELD_ATTRS) {
      items.push({ label: a, kind: CompletionItemKind.Property, detail: 'field attribute' })
    }
    // Named schema function calls — @funcName(...)
    for (const fn of result?.schema.functions ?? []) {
      const params = fn.params.map((p: any) => p.name).join(', ')
      items.push({
        label:         `@${fn.name}`,
        kind:          CompletionItemKind.Function,
        detail:        `function(${params}): ${fn.returnType}`,
        insertText:    `@${fn.name}(${fn.params.map((p: any) => p.name).join(', ')})`,
        documentation: { kind: MarkupKind.Markdown, value: `\`\`\`\n@@expr("${fn.expr}")\n\`\`\`` },
      })
    }
  }

  // Model-level attributes
  if (inModel && aatTrigger) {
    for (const a of MODEL_ATTRS) {
      items.push({ label: a, kind: CompletionItemKind.Property, detail: 'model attribute' })
    }
  }

  // @@gate level completions — numeric string form "R.C.U.D"
  const GATE_LEVELS = ['STRANGER', 'VISITOR', 'READER', 'CREATOR', 'USER', 'ADMINISTRATOR', 'OWNER', 'SYSADMIN', 'SYSTEM', 'LOCKED']
  if (inModel && line.includes('@@gate')) {
    for (const l of GATE_LEVELS) {
      items.push({ label: l, kind: CompletionItemKind.EnumMember, detail: `level ${GATE_LEVELS.indexOf(l)}` })
    }
  }

  // @@db — database name completions from parsed schema
  if (inModel && line.includes('@@db')) {
    const dbs = extractDatabaseNames(text)
    for (const db of dbs) {
      items.push({ label: db, kind: CompletionItemKind.Module, detail: 'database' })
    }
  }

  // @log / @@log — database name completions
  if (inModel && (line.includes('@log') || line.includes('@@log'))) {
    const dbs = extractDatabaseNames(text)
    for (const db of dbs) {
      items.push({ label: db, kind: CompletionItemKind.Module, detail: 'logger database' })
    }
  }

  // @from — relation name completions when inside @from(...)
  if (inModel && line.includes('@from')) {
    for (const m of result?.schema.models ?? []) {
      items.push({ label: m.name.toLowerCase(), kind: CompletionItemKind.Field, detail: 'relation name' })
    }
  }

  // @relation model references
  if (inModel && atTrigger && line.includes('@relation')) {
    for (const m of result?.schema.models ?? []) {
      items.push({ label: m.name, kind: CompletionItemKind.Class, detail: 'model' })
    }
  }

  return items
})

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return item
})

// ─── Hover ────────────────────────────────────────────────────────────────────

const ATTR_DOCS: Record<string, string> = {

  // ── Field attributes ────────────────────────────────────────────────────────

  '@id':
    'Marks this field as the primary key. `Integer @id` auto-increments.',

  '@unique':
    'Adds a UNIQUE constraint on this column.',

  '@default':
    'Sets a default value.\n\nSpecial forms: `now()`, `uuid()`, `ulid()`, `cuid()`, `nanoid()` (21-char URL-safe ID), `auth().field` (stamped from `ctx.auth` at write time — runtime only).\n\nCopy a sibling field: `@default(fieldName)` — useful with `@slug` to auto-derive a slug from a title.',

  '@relation':
    'Defines a foreign key relationship.\n\n```\n@relation(fields: [accountId], references: [id], onDelete: Cascade)\n```',

  '@generated':
    'SQLite `GENERATED ALWAYS AS` column. Use a schema `function` for reusable SQL expressions.\n\n```\ntitle   Text\nslug    Text  @slug(title)   // schema function → STORED generated column\n```',

  '@computed':
    'App-layer derived field — implemented in `computed.js`, not stored in the DB.\n\n```js\n// computed.js\nexport default {\n  users: {\n    fullName: row => [row.firstName, row.lastName].filter(Boolean).join(" "),\n  }\n}\n```',

  '@updatedAt':
    'Automatically set to the current UTC timestamp on every `update()` call.',

  '@updatedBy':
    'Automatically stamps `ctx.auth.id` on every `update()` call. Use `@updatedBy(auth().field)` to stamp a different auth field.',

  '@sequence':
    'Per-scope auto-increment. Each unique value of the scope field gets its own counter starting at 1.\n\n```\nmodel quotes {\n  id          Integer @id\n  accountId   Integer\n  quoteNumber Integer @sequence(scope: accountId)\n}\n```\n\nManaged in `_litestone_sequences` table.',

  '@map':
    'Maps this field to a different column name in the DB.\n\n`@map("column_name")`',

  '@omit':
    'Excludes this field from `findMany`/`findFirst` results. Still returned by `findUnique`.',

  '@omit(all)':
    'Excludes this field from ALL read operations. Pass it explicitly in `select` to unlock.',

  '@guarded':
    'Excluded from all reads unless `asSystem()` is used. Unlike `@omit`, an explicit `select` alone is not enough.',

  '@guarded(all)':
    'Excluded from all operations (reads and writes) unless `asSystem()` is used.',

  '@encrypted':
    'Encrypts the value at rest using AES-256-GCM. Requires `encryptionKey` (64-char hex) in `createClient()`.\n\nImplies `@guarded(all)` — only readable via `asSystem()`.',

  '@encrypted(searchable: true)':
    'Stores an HMAC of the encrypted value alongside the ciphertext, so equality `where` filters work without decrypting.\n\n```\nemail Text @encrypted(searchable: true)\n// WHERE email = \'alice@example.com\'  ✓ works\n```',

  '@secret':
    'Composite attribute — expands to `@encrypted + @guarded(all) + @log(audit)`.\n\nThe field is encrypted at rest, hidden from all reads unless `asSystem()`, and every read/write is logged to the audit logger database.\n\nUse `@secret(rotate: false)` to exclude from `db.$rotateKey()`.',

  '@log':
    'Logs reads and writes of this field to a `logger` database.\n\n```\napiKey Text @secret   // @log(audit) is implicit via @secret\nsalary Real @log(audit)\n```\n\nSee also: `@@log` for model-level logging.',

  '@keepVersions':
    'On `File?` and `File[]` fields: keeps the old S3/R2 object when the field is updated instead of deleting it. Useful for versioned assets.',

  '@accept':
    'On `File` / `File[]` fields: validates the MIME type before upload. Throws `ValidationError` if the type doesn\'t match.\n\nSupports wildcards and comma-separated lists:\n```\navatar File? @accept("image/*")\ndocs   File[] @accept("application/pdf,application/msword")\n```',

  '@markdown':
    'Semantic annotation — indicates this `Text` field contains Markdown. No runtime validation; used by Studio and tooling to enable rich rendering.',

  '@hardDelete':
    'On a relation field in a `@@softDelete(cascade)` model: hard-deletes those children (removes the rows) instead of stamping `deletedAt`.\n\n```\nmodel accounts {\n  sessions sessions[] @hardDelete  // ← rows gone permanently\n  users    users[]                  // ← soft-deleted\n  deletedAt DateTime?\n  @@softDelete(cascade)\n}\n```',

  '@from':
    'Derived field — computed from a relation at query time, not stored in the DB.\n\n```\nmodel accounts {\n  userCount Integer @from(users, count: true)\n  revenue   Real    @from(orders, sum: amount)\n  lastOrder DateTime @from(orders, last: true)\n  hasOverdue Boolean @from(invoices, exists: true, where: "paid = 0 AND due_at < date(\'now\')")\n}\n```\n\nSupported: `count`, `sum`, `max`, `min`, `first`, `last`, `exists`.',

  '@phone':
    'Validates the value is a valid phone number (E.164 and common formats) on every write.',

  '@slug':
    'Transforms the string value to a URL-safe slug before writing to the DB (lowercases, replaces spaces with hyphens, strips special characters).\n\nCommonly combined with `@default(fieldName)` to auto-derive from another field:\n```\ntitle Text\nslug  Text  @default(title) @slug\n```',

  '@email':
    'Validates the value is a valid email address on every write.',

  '@url':
    'Validates the value is a valid URL on every write.',

  '@date':
    'Validates the value is a valid date string (`YYYY-MM-DD`) on every write.',

  '@datetime':
    'Validates the value is a valid ISO-8601 datetime string on every write.',

  '@trim':
    'Trims leading/trailing whitespace from the string before writing to the DB.',

  '@lower':
    'Lowercases the string before writing to the DB.',

  '@upper':
    'Uppercases the string before writing to the DB.',

  '@regex':
    'Validates the value against a regular expression on every write.\n\n`@regex("^[A-Z]{2}[0-9]{4}$")`',

  '@length':
    'Validates string length. `@length(min, max)` — either bound can be omitted.',

  '@gt':  'Validates the numeric value is greater than `n`. `@gt(0)`',
  '@gte': 'Validates the numeric value is greater than or equal to `n`. `@gte(0)`',
  '@lt':  'Validates the numeric value is less than `n`. `@lt(100)`',
  '@lte': 'Validates the numeric value is less than or equal to `n`. `@lte(100)`',

  '@startsWith': 'Validates the string starts with the given prefix.',
  '@endsWith':   'Validates the string ends with the given suffix.',
  '@contains':   'Validates the string contains the given substring.',

  '@allow':
    'Field-level conditional access policy.\n\n```\nsalary Real? @allow(\'read\',  auth().role == \'admin\')\napiKey Text? @allow(\'write\', auth().role == \'admin\')\n```\n\n- `\'read\'` — field silently stripped from results when expr is false\n- `\'write\'` — field silently dropped from write data when expr is false\n- `\'all\'` — both\n\n`asSystem()` always sees and writes all fields. Conflicts with `@guarded` and `@secret`.',

  // ── Model attributes ────────────────────────────────────────────────────────

  '@@db':
    'Assigns this model to a named database block. Models without `@@db` go to the default database.\n\n```\nmodel apiRequests {\n  @@db(logs)\n}\n```',

  '@@index':
    'Creates an index on one or more columns.\n\n`@@index([col1, col2])`\n\nOn `@@softDelete` models, automatically adds `WHERE deletedAt IS NULL` (partial index over live rows only).',

  '@@unique':
    'Creates a composite UNIQUE constraint.\n\n`@@unique([col1, col2])`',

  '@@fts':
    'Creates an FTS5 full-text search virtual table and sync triggers.\n\n`@@fts([title, body])`\n\nEnables `db.model.search("query")`.',

  '@@softDelete':
    'Enables soft delete on this model. Requires a `deletedAt DateTime?` field.\n\nAll reads automatically filter `WHERE deletedAt IS NULL`. Use `withDeleted: true` to include soft-deleted rows.',

  '@@softDelete(cascade)':
    'Soft delete + cascade: `remove()` and `restore()` walk the FK graph and apply to child models that also have `@@softDelete`.\n\nUse `@hardDelete` on a specific relation field to hard-delete those children instead.\n\nThe parser emits a warning when a `@@softDelete` model has `hasMany` relations to other `@@softDelete` models without cascade.',

  '@@gate':
    'Declares the minimum access level required per CRUD operation.\n\n```\n@@gate("R.C.U.D")    // positional: Read.Create.Update.Delete\n@@gate("4")          // shorthand: all ops require USER (level 4+)\n@@gate("2.4.4.6")    // READER to read, USER to write, OWNER to delete\n@@gate("5.8.8.9")    // ADMIN to read, SYSTEM to write, LOCKED to delete\n```\n\n**Levels:** `0=STRANGER  1=VISITOR  2=READER  3=CREATOR  4=USER  5=ADMINISTRATOR  6=OWNER  7=SYSADMIN`\n\nReserved: `8=SYSTEM` (asSystem() only) · `9=LOCKED` (impassable)',

  '@@auth':
    'Marks this model as the auth subject. `auth()` in policy expressions resolves to a row from this model.',

  '@@allow':
    'Row-level allow policy — compiled to a SQL `WHERE` injection.\n\nMakes the operation deny-by-default for that op: blocked unless at least one `@@allow` matches.\n\n```\n@@allow(\'read\',   status == \'published\' || ownerId == auth().id)\n@@allow(\'create\', auth() != null)\n@@allow(\'update\', ownerId == auth().id, "You can only edit your own posts")\n```\n\nOptional third argument is a custom error message.',

  '@@deny':
    'Row-level deny policy — always wins over `@@allow`.\n\n```\n@@deny(\'delete\', status == \'published\')\n@@deny(\'update\', status == \'archived\', "Archived posts cannot be edited")\n```\n\nOptional third argument is a custom error message.',

  '@@log':
    'Model-level audit log — fires a log entry for every `create`, `update`, and `delete` on this model.\n\n```\nmodel users {\n  @@log(audit)\n}\n```\n\nRequires a `database` block with `driver logger`.',

  '@@external':
    'Marks this model\'s table as managed outside Litestone (e.g. a view, a FTS virtual table, or a table from another tool). Litestone will not emit DDL or run migrations for it, but it is fully queryable.\n\n```\nmodel search_index {\n  id    Integer @id\n  body  Text\n  @@external\n}\n```',

  '@@map':
    'Maps this model to a different table name in the DB.\n\n`@@map("table_name")`',

  '@@noStrict':
    'Opts this model out of SQLite STRICT mode (all models are STRICT by default).',

  '@@strict':
    'Explicitly opts into STRICT mode (default — only needed if overriding a previous `@@noStrict`).',
}

const TYPE_DOCS: Record<string, string> = {
  'Integer':  'SQLite `INTEGER` — stored as 64-bit integer. JavaScript `number`.',
  'Real':     'SQLite `REAL` — stored as 64-bit float. JavaScript `number`.',
  'Text':     'SQLite `TEXT` — UTF-8 string. JavaScript `string`.',
  'Boolean':  'SQLite `INTEGER` 0/1 — auto-coerced to `true`/`false` by the client.',
  'DateTime': 'SQLite `TEXT` ISO-8601 — auto-validated on write. JavaScript `string`.',
  'Json':     'SQLite `TEXT` — auto-serialized/deserialized by the client. JavaScript `object` (or `Array`).',
  'Blob':     'SQLite `BLOB` — raw binary. JavaScript `Buffer`.',
  'File':     'Stores a JSON reference object in SQLite; actual bytes live in S3/R2/local storage via the `FileStorage` plugin.\n\n```\navatar  File?              // single file\nphotos  File[]             // multiple files\ndocs    File[] @accept("application/pdf")\nresume  File?  @keepVersions  // keep old S3 object on update\n```\n\nResolves to a URL string automatically when `autoResolve: true` (default). Use `fileUrl(row.avatar)` or `fileUrls(row.photos)` to derive URLs manually.',
}

connection.onHover((pos: TextDocumentPositionParams): Hover | null => {
  const doc = documents.get(pos.textDocument.uri)
  if (!doc) return null

  const lines = doc.getText().split('\n')
  const line  = lines[pos.position.line] ?? ''
  const col   = pos.position.character

  const word = wordAt(line, col)
  if (!word) return null

  // Attribute hover — try longest match first (e.g. @omit(all) before @omit)
  const candidates = [word, '@' + word, '@@' + word]
  // Also check for @omit(all), @guarded(all) etc. by looking at surrounding context
  const lineWord = (() => {
    const start = line.slice(0, col).search(/@@?\w+/)
    if (start === -1) return null
    const rest = line.slice(start)
    const m = rest.match(/^@@?\w+(\([^)]*\))?/)
    return m ? m[0] : null
  })()
  if (lineWord && ATTR_DOCS[lineWord]) {
    return { contents: { kind: MarkupKind.Markdown, value: ATTR_DOCS[lineWord] } }
  }
  for (const c of candidates) {
    if (ATTR_DOCS[c]) {
      return { contents: { kind: MarkupKind.Markdown, value: ATTR_DOCS[c] } }
    }
  }

  // Type hover
  const typeDoc = TYPE_DOCS[word]
  if (typeDoc) {
    return { contents: { kind: MarkupKind.Markdown, value: typeDoc } }
  }

  // Model hover — show field summary
  const result = parseCache.get(doc.uri)
  if (result) {
    const model = result.schema.models.find((m: any) => m.name === word)
    if (model) {
      const fields = model.fields
        .filter((f: any) => f.type.kind !== 'relation')
        .map((f: any) => `  ${f.name}  ${f.type.name}${f.type.optional ? '?' : ''}`)
        .join('\n')
      return {
        contents: {
          kind:  MarkupKind.Markdown,
          value: `**model ${model.name}**\n\`\`\`litestone\n${fields}\n\`\`\``,
        }
      }
    }

    const fn = result.schema.functions.find((f: any) => f.name === word)
    if (fn) {
      const params = fn.params.map((p: any) => `${p.name}: ${p.type}`).join(', ')
      return {
        contents: {
          kind:  MarkupKind.Markdown,
          value: `**function ${fn.name}**(${params}): ${fn.returnType}\n\n\`@@expr("${fn.expr}")\``,
        }
      }
    }

    const en = result.schema.enums.find((e: any) => e.name === word)
    if (en) {
      const values = en.values.map((v: any) => `  ${v.name}`).join('\n')
      return {
        contents: {
          kind:  MarkupKind.Markdown,
          value: `**enum ${en.name}**\n\`\`\`litestone\n${values}\n\`\`\``,
        }
      }
    }
  }

  return null
})

// ─── Go-to-definition ─────────────────────────────────────────────────────────

connection.onDefinition((pos: TextDocumentPositionParams): Definition | null => {
  const doc = documents.get(pos.textDocument.uri)
  if (!doc) return null

  const lines  = doc.getText().split('\n')
  const line   = lines[pos.position.line] ?? ''
  const col    = pos.position.character
  const word   = wordAt(line, col)
  const result = parseCache.get(doc.uri)
  if (!word || !result) return null

  const text = doc.getText()

  const modelMatch = findDeclaration(text, 'model', word)
  if (modelMatch !== null) return Location.create(doc.uri, Range.create(modelMatch, 0, modelMatch, 0))

  const enumMatch = findDeclaration(text, 'enum', word)
  if (enumMatch !== null) return Location.create(doc.uri, Range.create(enumMatch, 0, enumMatch, 0))

  const fnMatch = findDeclaration(text, 'function', word)
  if (fnMatch !== null) return Location.create(doc.uri, Range.create(fnMatch, 0, fnMatch, 0))

  const dbMatch = findDeclaration(text, 'database', word)
  if (dbMatch !== null) return Location.create(doc.uri, Range.create(dbMatch, 0, dbMatch, 0))

  return null
})

// ─── Formatting ───────────────────────────────────────────────────────────────

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri)
  if (!doc) return []

  const formatted = formatLite(doc.getText())
  const full      = Range.create(0, 0, doc.lineCount, 0)
  return [TextEdit.replace(full, formatted)]
})

function formatLite(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let inBlock    = false
  let blockLines: string[] = []
  let blockType  = ''

  function flushBlock() {
    if (!blockLines.length) return
    if (blockType === 'model') {
      out.push(...formatModelBlock(blockLines))
    } else {
      out.push(...blockLines)
    }
    blockLines = []
    out.push('')
  }

  for (const raw of lines) {
    const trimmed = raw.trim()

    if (!inBlock) {
      if (
        trimmed.startsWith('model ')    ||
        trimmed.startsWith('enum ')     ||
        trimmed.startsWith('function ') ||
        trimmed.startsWith('database ')
      ) {
        flushBlock()
        blockType = trimmed.split(' ')[0]
        inBlock   = true
        blockLines.push(raw)
      } else if (trimmed.startsWith('import ') || trimmed.startsWith('///') || trimmed.startsWith('//')) {
        flushBlock()
        out.push(trimmed)
      } else if (trimmed === '') {
        if (out.length && out[out.length - 1] !== '') out.push('')
      } else {
        out.push(raw.trimEnd())
      }
    } else {
      blockLines.push(raw)
      if (trimmed === '}') {
        inBlock = false
        flushBlock()
      }
    }
  }

  flushBlock()
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.join('\n') + '\n'
}

function formatModelBlock(lines: string[]): string[] {
  const header = lines[0]
  const footer = lines[lines.length - 1]
  const fields = lines.slice(1, -1)

  const parsed = fields.map(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@')) {
      return { raw: trimmed, isField: false }
    }
    const attrStart = trimmed.search(/\s+@/)
    const [nameType, attrsRaw] = attrStart !== -1
      ? [trimmed.slice(0, attrStart).trim(), trimmed.slice(attrStart).trim()]
      : [trimmed, '']
    const parts = nameType.split(/\s+/)
    return { raw: line, isField: true, name: parts[0] ?? '', type: parts[1] ?? '', attrs: attrsRaw }
  })

  const fieldRows = parsed.filter(p => p.isField)
  if (!fieldRows.length) return lines

  const maxName = Math.max(...fieldRows.map(p => (p.name ?? '').length))
  const maxType = Math.max(...fieldRows.map(p => (p.type ?? '').length))

  const formatted = parsed.map(p => {
    if (!p.isField) return `  ${p.raw}`
    const name  = (p.name ?? '').padEnd(maxName)
    const type  = (p.type ?? '').padEnd(maxType)
    const attrs = p.attrs ? `  ${p.attrs}` : ''
    return `  ${name}  ${type}${attrs}`.trimEnd()
  })

  return [header, ...formatted, footer]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wordAt(line: string, col: number): string {
  const start = line.slice(0, col).search(/[@@\w]+$/)
  const end   = col + (line.slice(col).match(/^\w+/) ?? [''])[0].length
  return start !== -1 ? line.slice(start, end) : ''
}

function isInsideBlock(lines: string[], lineIdx: number, blockKeyword: string): boolean {
  let depth = 0
  for (let i = 0; i <= lineIdx; i++) {
    const t = lines[i].trim()
    if (t.startsWith(blockKeyword + ' ') && t.endsWith('{')) depth++
    if (t === '}') depth--
  }
  return depth > 0
}

function findDeclaration(text: string, keyword: string, name: string): number | null {
  const lines = text.split('\n')
  const re    = new RegExp(`^\\s*${keyword}\\s+${name}\\b`)
  const idx   = lines.findIndex(l => re.test(l))
  return idx !== -1 ? idx : null
}

/** Extract all database block names from the schema source */
function extractDatabaseNames(src: string): string[] {
  const names: string[] = []
  const re = /^\s*database\s+(\w+)\s*\{/gm
  let m
  while ((m = re.exec(src)) !== null) names.push(m[1])
  return names
}

// ─── Start ────────────────────────────────────────────────────────────────────

documents.listen(connection)
connection.listen()
