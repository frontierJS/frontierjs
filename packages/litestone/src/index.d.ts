// @frontierjs/litestone — package-level type declarations
// These types cover the static package API.
// For per-schema types (typed db.user, db.post, etc.) run:
//   litestone --schema ./db/schema.lite types

// ─── sql tagged template ──────────────────────────────────────────────────────

export interface RawClause {
  readonly _litestoneRaw: true
  readonly sql:    string
  readonly params: unknown[]
}

/**
 * Tagged template for safe parameterized raw SQL in `where: { $raw: sql\`...\` }`.
 *
 * @example
 * db.product.findMany({
 *   where: { $raw: sql`price > IF(state = ${state}, ${minPrice}, 100)` }
 * })
 */
export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): RawClause

/** litestone's own SQL, safe to splice into a `sql` pattern. Only litestone builds one. */
export interface SqlFragment { sql: string; params: unknown[] }

/**
 * The clock, spelled so it can match a stored `DateTime`.
 *
 * `DateTime` is ISO-8601 TEXT and comparisons against it are string-wise, so
 * SQLite's own `datetime('now')` — space separator, no milliseconds, no zone —
 * compares BELOW every value stored today. `sql` refuses it by name; this is
 * what to write instead. Modifiers are bound as parameters.
 *
 * @example
 * db.task.findMany({ where: { $raw: sql`dueAt < ${now()} AND completedAt IS NULL` } })
 * db.task.findMany({ where: { $raw: sql`startedAt > ${now('-7 days')}` } })
 */
export declare function now(...modifiers: string[]): SqlFragment

// ─── Window functions ─────────────────────────────────────────────────────────

export interface WindowFnSpec {
  // Positional
  rowNumber?:   true
  rank?:        true
  denseRank?:   true
  cumeDist?:    true
  percentRank?: true
  ntile?:       number

  // Offset
  lag?:         string
  lead?:        string
  firstValue?:  string
  lastValue?:   string
  nthValue?:    string
  n?:           number
  offset?:      number
  default?:     string | number | null

  // Aggregate
  sum?:   string
  avg?:   string
  min?:   string
  max?:   string
  count?: string | true | '*'

  // OVER clause
  partitionBy?: string | string[]
  orderBy?:     Record<string, 'asc' | 'desc' | { dir: 'asc' | 'desc'; nulls?: 'first' | 'last' }> | Record<string, any>[]
  rows?:        [number | null, number | null]
  range?:       [number | null, number | null]
}

export type WindowSpec = Record<string, WindowFnSpec>

export declare function buildWindowCols(windowSpec: WindowSpec): string[]

// ─── Core context types ───────────────────────────────────────────────────────

export interface LitestoneAuth {
  id?:            number | string
  role?:          string | null
  verifiedAt?:    string | null
  activatedAt?:   string | null
  isAdmin?:       boolean
  isOwner?:       boolean
  isSystemAdmin?: boolean
  [key: string]:  unknown
}

export interface LitestoneCtx {
  auth:       LitestoneAuth | null
  isSystem:   boolean
  policyDebug: boolean | 'verbose'
  [key: string]: unknown
}

// ─── Query event ──────────────────────────────────────────────────────────────

export interface QueryEvent {
  model:     string
  database:  string
  operation: string
  sql:       string
  params:    unknown[]
  duration:  number       // ms
  actorId:   number | string | null
}

// ─── Write event ──────────────────────────────────────────────────────────────

/**
 * What a BULK write tells a subscriber.
 *
 * - `collection` (default) — one event: *`count` rows under this filter changed*.
 *   Always correct, costs nothing, and every open list re-asks the server.
 * - `rows` — one event per row, off `RETURNING`. Buys precision with memory
 *   proportional to the batch, which is why it is opt-in and why it is decided
 *   per CALL: the call site is the only place the batch size is knowable.
 * - `none` — silent, deliberately. Not the same as having no subscribers.
 *
 * Precedence: the call's value → `createClient({ announce })` → `collection`.
 * An unrecognised value is refused by name (`InvalidAnnounceError`, 400).
 */
export type AnnounceMode = 'collection' | 'rows' | 'none'

// What `onEvent` listeners receive, plus the `event` name — which a $tapEvents
// subscriber needs because a 'transition' carries no `operation`.
export interface WriteEvent {
  event:      'create' | 'update' | 'remove' | 'transition'
  model:      string
  // The method that ran, which is not the event: `deleteMany` announces as
  // `remove` and `upsertMany` as `update`.
  operation?: string
  // Whether this event can name the row. `row` — one row, `result` is it, or
  // null where `select: false` skipped the RETURNING. `collection` — `count`
  // rows matching `where`, from a statement that never built them. Never read
  // the distinction off `result`: `result: null` is both of those.
  scope?:     'row' | 'collection'
  count?:     number
  // collection only — the caller's filter, as written
  where?:     unknown
  result?:    unknown
  schema?:    unknown
  // transition only
  transition?: string
  field?:      string
  from?:       string
  to?:         string
  record?:     unknown
}

// ─── Hook context ─────────────────────────────────────────────────────────────

export interface HookContext {
  model:     string
  operation: string
  args:      Record<string, unknown>
  result?:   unknown
  schema?:   unknown
}

// ─── Log entry ────────────────────────────────────────────────────────────────

export interface LogEntry {
  operation:  'create' | 'update' | 'delete' | 'read'
  model:      string
  field:      string | null
  records:    string         // JSON array of affected IDs
  before:     string | null  // JSON snapshot
  after:      string | null  // JSON snapshot
  actorId:    number | string | null
  actorType:  string | null
  meta:       string | null  // JSON
  createdAt:  string
}

// ─── File ref ─────────────────────────────────────────────────────────────────

export interface FileRef {
  key:        string
  bucket:     string | null
  provider:   string
  endpoint:   string | null
  publicBase: string | null
  size:       number
  mime:       string
  uploadedAt: string
}

export type ComputedFn = (row: Record<string, unknown>, ctx: LitestoneCtx) => unknown

/** `needs` lists the stored columns and `@from` fields the fn reads. */
export interface ComputedSpec {
  needs:   string[]
  compute: ComputedFn
}

export type ComputedField = ComputedFn | ComputedSpec

// ─── createClient options ─────────────────────────────────────────────────────

export interface CreateClientOptions {
  /** Path to a .lite schema file */
  path?:          string
  /** Inline schema string */
  schema?:        string
  /** Pre-parsed result from parseFile() */
  parsed?:        ParseResult
  /**
   * Path for the MAIN database. Overrides a declared `database main`; any other
   * declared database keeps its own path — `databases: ':memory:'` moves them all.
   */
  db?:            string
  /** 64-char hex — required for @encrypted / @secret fields */
  encryptionKey?: string
  /**
   * Permissive nested-write co-FK propagation.
   *
   * Default (false, strict): when a nested create involves an FK column that
   * exists on both parent and child, the parent's value silently overwrites
   * any child-supplied value. Prevents referential drift like a line item
   * having a different `tenantId` than its parent order.
   *
   * When true: an explicit child value wins over the parent. Missing child
   * values are still auto-filled. Use this only if you have legitimate
   * cross-context writes (e.g. cross-tenant moves performed via nested ops).
   */
  allowChildFkOverride?: boolean
  /** Plugins — GatePlugin, FileStorage, custom */
  plugins?:       Plugin[]
  /**
   * Computed field functions, or path to a file exporting them.
   *
   * A bare function is handed the whole row and forces `SELECT *` whenever the
   * field is named in a `select`. The `{ needs, compute }` form narrows the
   * fetch to the listed columns, and the row it receives carries only those —
   * reading anything else throws.
   */
  computed?:      Record<string, Record<string, ComputedField>> | string
  /** Permanent WHERE clauses applied to every query on a model */
  filters?:       Record<string, Record<string, unknown> | ((ctx: LitestoneCtx) => Record<string, unknown>)>
  /** Before/after hooks for reads and writes */
  hooks?: {
    before?: {
      setters?: Array<(hook: HookContext, ctx: LitestoneCtx) => void>
      getters?: Array<(hook: HookContext, ctx: LitestoneCtx) => void>
      all?:     Array<(hook: HookContext, ctx: LitestoneCtx) => void>
      [op: string]: Array<(hook: HookContext, ctx: LitestoneCtx) => void> | undefined
    }
    after?: {
      setters?: Array<(hook: HookContext, ctx: LitestoneCtx) => void>
      getters?: Array<(hook: HookContext, ctx: LitestoneCtx) => void>
      all?:     Array<(hook: HookContext, ctx: LitestoneCtx) => void>
      [op: string]: Array<(hook: HookContext, ctx: LitestoneCtx) => void> | undefined
    }
  }
  /** Event listeners — fire after commit, fire-and-forget */
  onEvent?: {
    create?: (event: HookContext, ctx: LitestoneCtx) => void
    update?: (event: HookContext, ctx: LitestoneCtx) => void
    remove?: (event: HookContext, ctx: LitestoneCtx) => void
    change?: (event: HookContext, ctx: LitestoneCtx) => void
  }
  /** The FLOOR for what a bulk write announces; any call may override it */
  announce?:   AnnounceMode
  /** Fires on every SQL query — use for logging, slow query detection */
  onQuery?:    (event: QueryEvent, ctx: LitestoneCtx) => void | Promise<void>
  /** Fires when a @log / @@log entry is written — return extra fields to merge */
  onLog?:      (entry: LogEntry, ctx: LitestoneCtx) => Partial<Pick<LogEntry, 'actorId' | 'actorType' | 'meta'>> | void
  /** ':memory:' forces all SQLite databases to in-memory, jsonl/logger to tmpdir */
  databases?:  ':memory:' | Record<string, { path?: string }>
  /** Per-database access control */
  access?:     Record<string, 'readwrite' | 'readonly' | false>
  /** Open all SQLite databases read-only — write operations throw immediately. Shorthand for access: { '*': 'readonly' } */
  readOnly?:   boolean
  /** Pluralize snake_case table names (User → users, ServiceAgreement → service_agreements). Default: false */
  pluralize?:  boolean
  /** Policy debug logging */
  policyDebug?: boolean | 'verbose'
  /**
   * Reusable named query fragments registered per model. Each scope is an
   * object shaped like findMany args (where, orderBy, limit, etc.). The where
   * may be a function (ctx) => whereObject for dynamic filters that depend on
   * the current auth context. Parameterised scopes are not supported — use
   * a function that returns a where clause and pass it as a caller override.
   *
   * Scope names cannot collide with built-in table methods, relation field
   * names on the same model, or names starting with $ or _. createClient
   * throws at startup if any rule is violated.
   *
   * Scopes appear as callable function-with-properties on the table accessor:
   *   db.customer.active()                  // findMany under the scope
   *   db.customer.active.count()             // count under the scope
   *   db.customer.active.premium()           // chained scopes
   */
  scopes?:     Record<string, Record<string, ScopeDef>>
}

/** A scope definition — same shape as findMany args. */
export interface ScopeDef {
  /** Filter — object literal for static, or (ctx) => object for dynamic. */
  where?:        Record<string, unknown> | ((ctx: LitestoneCtx) => Record<string, unknown>)
  orderBy?:      Record<string, unknown> | Array<Record<string, unknown>>
  limit?:        number
  offset?:       number
  include?:      Record<string, unknown>
  select?:       Record<string, unknown>
  distinct?:     boolean | string[]
  withDeleted?:  boolean
  onlyDeleted?:  boolean
  /** @@hasTemplates: include templates alongside instances. Default false. */
  withTemplates?: boolean
  /** @@hasTemplates: return templates only. Default false. */
  onlyTemplates?: boolean
  [key: string]: unknown
}

// ─── Table operations ─────────────────────────────────────────────────────────

export type WhereOp<T> = T | {
  in?:       T[]
  not?:      T | null
  gt?:       T
  gte?:      T
  lt?:       T
  lte?:      T
  contains?: string
  startsWith?: string
  endsWith?: string
}

/** Base interface mixed into every generated `Where` type — adds the $raw escape hatch. */
export interface WhereBase {
  $raw?: RawClause | string
}

export interface CursorResult<T> {
  rows:       T[]
  nextCursor: string | null
  hasMore:    boolean
}

export interface TableClient<TRow, TCreate, TUpdate, TWhere, TOrderBy> {
  findMany(args?: { where?: TWhere; orderBy?: TOrderBy | TOrderBy[]; limit?: number; offset?: number; include?: Record<string, boolean>; select?: Record<string, boolean>; withDeleted?: boolean; onlyDeleted?: boolean; withTemplates?: boolean; onlyTemplates?: boolean; recursive?: boolean | { direction?: 'descendants' | 'ancestors'; nested?: boolean; maxDepth?: number; via?: string }; distinct?: boolean; window?: WindowSpec }): Promise<(TRow & Record<string, unknown>)[]>
  findFirst(args?: { where?: TWhere; orderBy?: TOrderBy | TOrderBy[]; include?: Record<string, boolean>; select?: Record<string, boolean>; withDeleted?: boolean; onlyDeleted?: boolean; withTemplates?: boolean; onlyTemplates?: boolean }): Promise<TRow | null>
  findUnique(args: { where: TWhere; include?: Record<string, boolean>; select?: Record<string, boolean>; withDeleted?: boolean; onlyDeleted?: boolean; withTemplates?: boolean; onlyTemplates?: boolean }): Promise<TRow | null>
  findFirstOrThrow(args?: { where?: TWhere }): Promise<TRow>
  findUniqueOrThrow(args: { where: TWhere }): Promise<TRow>
  count(args?: { where?: TWhere; withDeleted?: boolean; onlyDeleted?: boolean; withTemplates?: boolean; onlyTemplates?: boolean }): Promise<number>
  exists(args?: { where?: TWhere; withDeleted?: boolean; onlyDeleted?: boolean; withTemplates?: boolean; onlyTemplates?: boolean }): Promise<boolean>
  findManyCursor(args?: { where?: TWhere; limit?: number; cursor?: string; orderBy?: TOrderBy | TOrderBy[] }): Promise<CursorResult<TRow>>
  search(query: string, args?: { where?: TWhere; limit?: number; offset?: number; withDeleted?: boolean; onlyDeleted?: boolean; withTemplates?: boolean; onlyTemplates?: boolean }): Promise<TRow[]>
  create(args: { data: TCreate; include?: Record<string, boolean>; select?: Record<string, boolean> | false }): Promise<TRow | null>
  createMany(args: { data: TCreate[]; announce?: AnnounceMode }): Promise<{ count: number }>
  update(args: { where: TWhere; data: TUpdate; include?: Record<string, boolean>; select?: Record<string, boolean> | false }): Promise<TRow | null>
  updateMany(args: { where: TWhere; data: TUpdate; announce?: AnnounceMode }): Promise<{ count: number }>
  upsert(args: { where: TWhere; create: TCreate; update: TUpdate; include?: Record<string, boolean>; select?: Record<string, boolean> | false }): Promise<TRow | null>
  upsertMany(args: { data: TCreate[]; conflictTarget: string[]; update?: string[]; announce?: AnnounceMode }): Promise<{ count: number }>
  remove(args: { where: TWhere }): Promise<TRow | null>
  removeMany(args: { where: TWhere; announce?: AnnounceMode }): Promise<{ count: number }>
  /** The restored rows, shaped like any other read. `where` can match many. */
  restore(args: { where: TWhere }): Promise<TRow[]>
  delete(args: { where: TWhere }): Promise<TRow | null>
  deleteMany(args: { where: TWhere; announce?: AnnounceMode }): Promise<{ count: number }>
  transition(id: number | string, name: string): Promise<TRow>
  transitions(idOrRow: number | string | TRow): Promise<Array<{ name: string; field: string; from: string; to: string; gate: number | null; allowed: boolean }>>
  optimizeFts(): void
  findManyAndCount(args?: { where?: TWhere; orderBy?: TOrderBy | TOrderBy[]; limit?: number; offset?: number; select?: Record<string, boolean> }): Promise<{ rows: TRow[]; total: number }>
  aggregate(args: { _count?: boolean; _sum?: Record<string, boolean>; _avg?: Record<string, boolean>; _min?: Record<string, boolean>; _max?: Record<string, boolean>; where?: TWhere }): Promise<Record<string, unknown>>
  groupBy(args: { by: (string | { field: string; interval: 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' })[]; interval?: Record<string, string>; fillGaps?: boolean | { start: string; end: string }; where?: TWhere; having?: Record<string, unknown>; orderBy?: Record<string, unknown>; limit?: number; offset?: number; _count?: boolean; _sum?: Record<string, boolean>; _avg?: Record<string, boolean>; _min?: Record<string, boolean>; _max?: Record<string, boolean> }): Promise<Record<string, unknown>[]>
  query(args?: Record<string, unknown>): Promise<TRow[] | Record<string, unknown>[] | Record<string, unknown>>
}

// ─── Client ───────────────────────────────────────────────────────────────────

export interface LitestoneConfig {
  schemaPath:    string | null
  migrationsDir: string | null
}

export interface LitestoneClient {
  $schema:     unknown
  $databases:  Record<string, { driver: string; access: string; path: string | null }>
  $rawDbs:     Record<string, unknown>
  $db:         unknown
  $config:     LitestoneConfig
  $softDelete: Record<string, boolean>
  $cacheSize:  { read: number; write: number } | Record<string, { read: number; write: number }>
  $enums:      Record<string, string[]>
  $close():    void
  /**
   * Is this a valid where key? Ask before you query — for a boundary that can
   * answer 400 rather than the ORM's warn-on-read / throw-on-write. An unknown
   * accessor answers [], because "I cannot judge this" is not "this is wrong".
   */
  $checkWhere(accessor: string, where: unknown): { key: string; suggestion: string | null; allowed: string[] }[]
  /**
   * Is this a valid orderBy key? Same contract as $checkWhere. `reason`
   * separates a field that does not exist from a @computed field, which SQLite
   * can neither sort nor paginate by. Pass `{ aggregates: true }` for
   * groupBy/aggregate, where `_count` is the point rather than a typo.
   */
  $checkOrderBy(accessor: string, orderBy: unknown, opts?: { aggregates?: boolean }): {
    key: string; reason: 'computed' | 'unknown'; suggestion: string | null
    sortable: string[]; message: string
  }[]
  /**
   * The `@@scope` names declared on a model → the predicate as source text.
   *
   * The published list `$checkWhere` validates a `where: { $scope }` against, so
   * a UI offering scopes and the client refusing one cannot disagree. A schema
   * fact, so every flavour of client answers it identically.
   */
  $scopes(accessor: string): Record<string, string>
  /**
   * Record something in the audit trail that `@@log(audit)` cannot see for
   * itself — an event that performs no write (a failed login), or one whose
   * write goes through `asSystem()` and so names no actor.
   *
   * The ONE owner of putting a row in the trail. The log model is an ordinary
   * accessor a caller could write directly; two writers with no shared
   * definition is how a second `operation` vocabulary starts drifting.
   *
   * THROWS, where `@@log(audit)` is fire-and-forget: there the record is a side
   * effect of a write that already succeeded and must not fail it, here the
   * record is what the caller asked for. `actorId` defaults to this client's
   * principal — a system context has none, so state it.
   *
   * `meta` is written as given and nothing redacts it. Never put a password, a
   * token or a key in it.
   */
  $audit(entry: {
    operation: string
    model?: string
    field?: string | null
    records?: unknown[]
    before?: unknown
    after?: unknown
    actorId?: unknown
    actorType?: string
    meta?: Record<string, unknown>
  }, opts?: { database?: string }): Promise<Record<string, unknown>>
  $backup(dest: string, opts?: { vacuum?: boolean }): Promise<{ size: number }>
  $walStatus(): { busy: boolean; frames: number; checkpointed: number } | Record<string, { busy: boolean; frames: number; checkpointed: number } | null>
  $transaction<T>(fn: (tx: LitestoneClient) => Promise<T>): Promise<T>
  /**
   * Runs many per-table query() calls in one snapshot transaction and returns
   * a named-result object keyed by the spec's keys.
   *
   * Each entry routes through the per-table query() dispatcher (findMany /
   * aggregate / groupBy depending on shape).
   *
   * Spec keys are either:
   *   - a model accessor name (e.g. `user`, `order`)
   *   - any name + `model: '<accessor>'` to query the same model multiple times
   *
   * Throws if any single query fails — the whole batch rolls back.
   */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    spec: Record<string, { model?: string; [arg: string]: unknown }>
  ): Promise<T>
  $attach(path: string, alias: string): void
  $detach(alias: string): void
  /**
   * Re-encrypt every key-reversible column with `newKey`, then swap the client's key.
   *
   * Throws BEFORE writing anything if the schema declares a column rotation cannot
   * carry — `@hashed` (one-way) or `@secret(rotate: false)` — naming each one.
   * `orphan` acknowledges them by name; a boolean would let a column added later
   * inherit an acknowledgement made for a different one.
   */
  $rotateKey(newKey: string, opts?: { orphan?: string[] }): Promise<Record<string, { rows: number; fields: number }>>
  $lock(key: string, fn: () => Promise<unknown>, opts?: { ttl?: number; timeout?: number }): Promise<unknown>
  $locks: {
    acquire(key: string, opts?: { ttl?: number; owner?: string }): Promise<{ release(): Promise<void>; heartbeat(ms?: number): Promise<void> }>
    release(key: string, owner?: string): Promise<void>
    isHeld(key: string): Promise<boolean>
    list(): Promise<Array<{ key: string; owner: string | null; expiresAt: string | null }>>
  }
  $tapQuery(fn: (event: QueryEvent) => void): () => void
  $tapEvents(fn: (event: WriteEvent, ctx: LitestoneCtx) => void): () => void
  $setAuth(user: LitestoneAuth): LitestoneClient
  asSystem(): LitestoneClient
  sql: unknown
  [model: string]: unknown
}

export declare function createClient(options: CreateClientOptions): Promise<LitestoneClient>

// ─── Parse ────────────────────────────────────────────────────────────────────

export interface ParseResult {
  schema:   LitestoneSchema
  valid:    boolean
  errors:   string[]
  warnings: string[]
}

export interface LitestoneSchema {
  databases: DatabaseBlock[]
  models:    ModelDef[]
  views:     ViewDef[]
  enums:     EnumDef[]
  functions: FunctionDef[]
  imports:   { path: string }[]
}

export interface DatabaseBlock {
  name:       string
  path:       { kind: 'literal'; value: string } | { kind: 'env'; var: string; default: string | null }
  driver:     'sqlite' | 'jsonl' | 'logger'
  replication: boolean
  retention:  string | null
  maxSize:    string | null
  logModel:   string | null
}

export interface ModelDef {
  name:       string
  fields:     FieldDef[]
  attributes: ModelAttribute[]
  comments:   string[]
}

export interface FieldDef {
  name:       string
  type:       { kind: string; name: string; array: boolean; optional: boolean }
  attributes: FieldAttribute[]
  comments:   string[]
}

export interface EnumDef {
  name:        string
  values:      { name: string; comments: string[] }[]
  transitions: Record<string, { from: string[]; to: string }> | null
  comments:    string[]
}

export interface ViewDef {
  name:         string
  fields:       FieldDef[]
  sql:          string | null
  materialized: boolean
  refreshOn:    string[]
  db:           string | null
  comments:     string[]
}

export interface FunctionDef {
  name:       string
  params:     { name: string; type: string }[]
  returnType: string
  expr:       string
  comments:   string[]
}

export type ModelAttribute = { kind: string; [key: string]: unknown }
export type FieldAttribute = { kind: string; [key: string]: unknown }

export declare function parse(src: string): ParseResult
export declare function parseFile(path: string): ParseResult

// ─── Migrations ───────────────────────────────────────────────────────────────

export interface MigrationRow {
  file:       string
  state:      'applied' | 'pending' | 'modified' | 'orphaned' | 'skipped'
  applied_at: string | null
  tampered:   boolean
  sql:        string | null
}

export interface ApplyResult {
  applied:  { file: string; ok: boolean; elapsed?: string; error?: string }[]
  pending:  number
  /** `.sql`/`.js` files the name pattern rejected — never applied, always named. */
  skipped:  string[]
  /** True when the directory held candidate files and NONE matched: a refusal, not an empty directory. */
  unmatched?: boolean
  failed?:  string
  message?: string
}

export interface CreateMigrationResult {
  created:   boolean
  message?:  string
  name?:     string
  filePath?: string
  summary?:  string
  sql?:      string
}

export interface VerifyResult {
  state:    'in-sync' | 'pending' | 'drift'
  message:  string
  pending?: string[]
  skipped?: string[]
  note?:    string
  diff?:    string
}

export declare function create(db: unknown, parseResult: ParseResult, label?: string, dir?: string, opts?: { pluralize?: boolean }): CreateMigrationResult
export declare function apply(db: unknown, dir?: string, client?: LitestoneClient): Promise<ApplyResult>
export declare function status(db: unknown, dir?: string): MigrationRow[]
export declare function verify(db: unknown, parseResult: ParseResult, dir?: string, opts?: { pluralize?: boolean }): VerifyResult
export declare function autoMigrate(db: LitestoneClient, parseResult?: ParseResult, opts?: { pluralize?: boolean }): Record<string, { state: string; applied?: number; sql?: string }>
export declare function listMigrationFiles(dir: string): string[]
export declare function unmatchedMigrationFiles(dir: string): string[]
export declare function describeSkipped(skipped: string[]): string
export declare function slugify(label: string): string

// ─── DDL ──────────────────────────────────────────────────────────────────────

export declare function generateDDL(schema: LitestoneSchema): string
export declare function generateDDLForDatabase(schema: LitestoneSchema, dbName: string): string
export declare function generateTableDDL(model: ModelDef, schema: LitestoneSchema): string
export declare function generateViewDDL(view: ViewDef): string
export declare function generateIndexDDL(model: ModelDef): string
export declare function detectM2MPairs(schema: LitestoneSchema): [string, string][]
export declare function generateJoinTableDDL(a: string, b: string): string

// ─── Schema diffing ───────────────────────────────────────────────────────────

export declare function introspect(db: unknown): unknown
export declare function buildPristine(db: unknown, parseResult: ParseResult): unknown
export declare function buildPristineForDatabase(db: unknown, parseResult: ParseResult, dbName: string): unknown
export declare function diffSchemas(pristine: unknown, live: unknown, parseResult: ParseResult, dbName?: string, opts?: { pluralize?: boolean }): { hasChanges: boolean; [key: string]: unknown }
export declare function generateMigrationSQL(diff: unknown, parseResult: ParseResult, opts?: { pluralize?: boolean }): string
export declare function summariseDiff(diff: unknown): string
export declare function splitStatements(sql: string): string[]
export declare function checksum(str: string): string

// ─── Plugin system ────────────────────────────────────────────────────────────

export declare class Plugin {
  onInit(schema: LitestoneSchema, ctx: LitestoneCtx): void
  onBeforeRead(model: string, args: unknown, ctx: LitestoneCtx): Promise<void>
  onBeforeCreate(model: string, args: unknown, ctx: LitestoneCtx): Promise<void>
  onBeforeUpdate(model: string, args: unknown, ctx: LitestoneCtx): Promise<void>
  onBeforeDelete(model: string, args: unknown, ctx: LitestoneCtx): Promise<void>
  onAfterRead(model: string, rows: unknown[], ctx: LitestoneCtx): Promise<void>
  onAfterWrite(model: string, operation: string, result: unknown, ctx: LitestoneCtx): Promise<void>
  onAfterDelete(model: string, rows: unknown[], ctx: LitestoneCtx): Promise<void>
  buildReadFilter(model: string, ctx: LitestoneCtx): Record<string, unknown> | null
}

export declare class PluginRunner {
  constructor(plugins: Plugin[])
  hasPlugins: boolean
  init(schema: LitestoneSchema, ctx: LitestoneCtx): void
}

export declare class AccessDeniedError extends Error {
  code:      'ACCESS_DENIED'
  model:     string | undefined
  operation: string | undefined
  required:  number | undefined
  got:       number | undefined
}


// ─── ExternalRefPlugin ────────────────────────────────────────────────────────

export declare class ExternalRefPlugin extends Plugin {
  fieldType: string
  constructor(config?: { autoResolve?: boolean; [key: string]: unknown })
  serialize(value: unknown, opts: { field: string; model: string; id: unknown; ctx: LitestoneCtx }): Promise<Record<string, unknown>>
  resolve(ref: Record<string, unknown>, opts: { field: string; model: string; ctx: LitestoneCtx }): Promise<unknown>
  cleanup(ref: Record<string, unknown>, opts: { field: string; model: string; ctx: LitestoneCtx }): Promise<void>
  cacheKey(ref: Record<string, unknown>): string | null
}

// ─── GatePlugin ───────────────────────────────────────────────────────────────

export declare const LEVELS: {
  readonly STRANGER:      0
  readonly VISITOR:       1
  readonly READER:        2
  readonly CREATOR:       3
  readonly USER:          4
  readonly ADMINISTRATOR: 5
  readonly OWNER:         6
  readonly SYSADMIN:      7
  readonly SYSTEM:        8
  readonly LOCKED:        9
}

export type Level = typeof LEVELS[keyof typeof LEVELS]

export interface GateConfig {
  read:   number
  create: number
  update: number
  delete: number
}

export declare class GatePlugin extends Plugin {
  constructor(opts?: { getLevel?: (user: LitestoneAuth | null, model: string) => number | Promise<number> })
}

export declare function parseGateString(str: string): GateConfig
export declare function FrontierGateGetLevel(user: LitestoneAuth | null): Level

// ─── FileStorage ──────────────────────────────────────────────────────────────

export interface FileStorageOptions {
  provider?:        'r2' | 's3' | 'b2' | 'minio' | 'local'
  bucket?:          string
  endpoint?:        string
  accessKeyId?:     string
  secretAccessKey?: string
  publicBase?:      string
  keyPattern?:      string   // default: ':model/:id/:field/:date-:filename'
  region?:          string
}

export declare function FileStorage(options?: FileStorageOptions): Plugin
export declare function fileUrl(ref: FileRef | string | null | undefined): string | null
export declare function fileUrls(refs: (FileRef | string)[] | string | null | undefined): string[]
export declare function useStorage(options: FileStorageOptions): {
  sign(ref: FileRef, opts?: { expiresIn?: number }): Promise<string>
  download(ref: FileRef): Promise<Buffer>
  delete(key: string): Promise<void>
}
export declare function createProvider(options: FileStorageOptions): unknown

// ─── Errors ───────────────────────────────────────────────────────────────────

export declare class ValidationError extends Error {
  errors: Array<{ path: string[]; message: string }>
}

export declare class TransitionViolationError extends Error {
  model:     string
  field:     string
  from:      string
  to:        string
  retryable: false
}

export declare class TransitionConflictError extends Error {
  model:     string
  field:     string
  expected:  string
  to:        string
  retryable: true
}

/** An update on a `@version` model that did not carry the version it read. 400. */
export declare class VersionRequiredError extends Error {
  model:     string
  field:     string
  status:    400
  retryable: false
}

/** The row moved between the read and the write. 409 — re-read and re-apply. */
export declare class VersionConflictError extends Error {
  model:     string
  field:     string
  expected:  number
  actual:    number
  status:    409
  retryable: true
}

export declare class TransitionNotFoundError extends Error {
  model:      string
  transition: string
  retryable:  false
}

export declare class TransitionGateError extends Error {
  model:      string
  field:      string
  transition: string
  required:   number
  got:        number
  status:     403
  retryable:  false
}

export declare class LockNotAcquiredError extends Error {
  key:          string
  currentOwner: string | null
  expiresAt:    string | null
  retryable:    true
}

export declare class LockReleasedByOtherError extends Error {
  key:       string
  owner:     string
  retryable: false
}

export declare class LockExpiredError extends Error {
  key:       string
  owner:     string
  retryable: false
}

/**
 * A write named a @unique value a SOFT-DELETED row still holds. The row keeps
 * its unique values — it still exists, and restore() has to be able to bring it
 * back — so the value is released by changing it or by hard-deleting the row,
 * both with `withDeleted: true`.
 */
export declare class SoftDeletedUniqueError extends Error {
  model:     string
  fields:    string[]
  values:    unknown[]
  id:        unknown
  status:    409
  retryable: false
}

/**
 * The caller asked this model for something its `.lite` never declared —
 * `search()` below `@@fts`, `restore()` below `@@softDelete`, `transition()`
 * below `@@transitions`, or an `onlyDeleted`/`onlyTemplates` flag on a model
 * with no such category. A 400: nothing broke, and the identical request will
 * fail the identical way until the schema changes.
 */
export declare class CapabilityNotDeclaredError extends Error {
  model:     string
  /** What was asked for — `'search()'`, `'onlyDeleted'`, … */
  asked:     string
  /** The attribute that would make it legal — `'@@fts'`, `'@@softDelete'`, … */
  requires:  string
  status:    400
  retryable: false
}

// ─── Seeder / Factory ─────────────────────────────────────────────────────────

export interface FactoryRng {
  next(): number
  int(min: number, max: number): number
  pick<T>(arr: T[]): T
  bool(p?: number): boolean
  str(len?: number): string
}

export type FactoryRow       = Record<string, unknown>
export type FactoryOverrides = FactoryRow | ((seq: number, rng: FactoryRng | null) => FactoryRow)

export declare class Factory {
  constructor(db: LitestoneClient)

  /** Subclass fields. */
  model: string
  traits?: Record<string, FactoryOverrides>
  afterCreate?: (row: FactoryRow, db: LitestoneClient) => void | Promise<void>
  definition(seq: number, rng: FactoryRng | null): FactoryRow

  /** Chain methods — all return a CLONE, never `this`. */
  state(overrides: FactoryOverrides): this
  seed(n: number): this

  /** Run against a different client — the whole wired graph follows. */
  usingDb(db: LitestoneClient): this
  /** Seed past the Data boundary — required for any schema declaring `@@gate`. */
  asSystem(): this
  /** Seed as a specific principal; gates and policies see it. */
  actingAs(user: unknown): this

  /**
   * Auto-create a parent row and inject its PK as `fk` (default `<name>Id`).
   * One parent is shared across a `createMany` unless `{ fresh: true }`.
   */
  withRelation(name: string, factory: Factory, fk?: string, pk?: string, opts?: { fresh?: boolean }): this
  /** Use an existing parent row — no auto-create. */
  for(name: string, row: FactoryRow, fk?: string, pk?: string): this

  /**
   * Auto-create a parent for every REQUIRED belongsTo the schema declares,
   * recursively. Needs the schema + registry from `makeTestClient({ autoFactories: true })`
   * or `factoryFrom()`. Relation cycles are skipped, not followed.
   */
  withParents(opts?: { depth?: number; optional?: boolean; fresh?: boolean }): this

  /** Create hasMany children after the row, FK pointed back at it. */
  has(name: string, count?: number, opts?: {
    factory?:   Factory
    overrides?: FactoryOverrides
    /** Name the FK when the child declares more than one relation to this model. */
    fk?:        string
    pk?:        string
  }): this

  /** Connect implicit many-to-many rows after the row is created. */
  attach(name: string, countOrRows?: number | FactoryRow[], opts?: {
    factory?:   Factory
    overrides?: FactoryOverrides
  }): this

  buildOne(overrides?: FactoryOverrides): FactoryRow
  buildMany(count: number, overrides?: FactoryOverrides): FactoryRow[]
  createOne(overrides?: FactoryOverrides): Promise<FactoryRow>
  createMany(count: number, overrides?: FactoryOverrides): Promise<FactoryRow[]>

  /** Overloaded on the first argument: a number is a count, anything else is overrides. */
  build(overrides?: FactoryOverrides): FactoryRow
  build(count: number, overrides?: FactoryOverrides): FactoryRow[]
  create(overrides?: FactoryOverrides): Promise<FactoryRow>
  create(count: number, overrides?: FactoryOverrides): Promise<FactoryRow[]>

  truncate(): Promise<void>
}

export interface FactorySpec {
  /** Model name as the schema declares it — PascalCase singular. */
  model:        string
  definition:   (seq: number, rng: FactoryRng | null) => FactoryRow
  traits?:      Record<string, FactoryOverrides>
  afterCreate?: (row: FactoryRow, db: LitestoneClient) => void | Promise<void>
  [key: string]: unknown
}

/**
 * The Factory without the class ceremony. Returns a CLASS, so it drops straight
 * into `makeTestClient({ factories: { user: UserFactory } })`.
 */
export declare function defineFactory(spec: FactorySpec): new (db: LitestoneClient) => Factory

export declare class Seeder {
  run(db: LitestoneClient): Promise<void>
  /** Seeders that must run before this one. Each class runs at most once per call(). */
  static dependsOn?: Array<new () => Seeder>
  /** Run other seeders, dependencies first. */
  call(db: LitestoneClient, seederClasses: Array<new () => Seeder>): Promise<void>
  static once(db: LitestoneClient, key: string, fn: () => Promise<void>): Promise<void>
}

export declare function runSeeder(db: LitestoneClient, SeederClass: new () => Seeder): Promise<void>

export interface LoadFixtureOptions {
  /** Column to match on — makes the fixture re-runnable (upsert instead of create). */
  upsert?:   string
  /** Write past gates and policies. */
  asSystem?: boolean
}

/**
 * Load authored reference data — a `.json` path, a `.csv` path, or an inline array.
 * Rows go through the ORM, so defaults, validators and hooks all apply.
 */
export declare function loadFixture(
  db:        LitestoneClient,
  modelName: string,
  source:    string | FactoryRow[],
  opts?:     LoadFixtureOptions,
): Promise<FactoryRow[]>

/** RFC-4180 CSV → rows. Unquoted scalars are coerced; quoted values stay strings. */
export declare function parseCsv(text: string): Record<string, unknown>[]

// ─── JSON Schema ──────────────────────────────────────────────────────────────

export interface JsonSchemaOptions {
  format?:            'definitions' | 'flat'
  mode?:              'create' | 'update' | 'full'
  audience?:          'client' | 'system'
  includeTimestamps?: boolean
  includeDeletedAt?:  boolean
  inlineEnums?:       boolean
  /** Top-level document title. No CLI flag reaches this. */
  title?:             string
}

export declare function generateJsonSchema(schema: LitestoneSchema, options?: JsonSchemaOptions): Record<string, unknown>

// ─── TypeScript generation ────────────────────────────────────────────────────

export interface TypegenOptions {
  audience?: 'client' | 'system'
}

export declare function generateTypeScript(schema: LitestoneSchema, options?: TypegenOptions): string

// ─── Tenancy ──────────────────────────────────────────────────────────────────

export interface TenantResolution {
  kind: 'subdomain' | 'header' | 'claim'
  /** Header name, or the field on the principal. Null for subdomain. */
  name: string | null
}

export interface DatabaseTenancy {
  strategy: 'database'
  dir:      string
  registry: string
  maxOpen:  number
  key:      string | null
  resolve:  TenantResolution | null
}

export interface RowTenancy {
  strategy: 'row'
  column:   string
  claim:    string
  resolve:  TenantResolution | null
}

export type ResolvedTenancy = DatabaseTenancy | RowTenancy

/** The schema's `tenancy { }` block, with env vars read and paths resolved. */
export declare function resolveTenancy(
  schema: LitestoneSchema,
  opts?: { schemaPath?: string | null; overrides?: Record<string, unknown> },
): ResolvedTenancy | null

/** Which tenant a request names, per the declared `resolve`. */
export declare function tenantFrom(
  resolution: TenantResolution | null,
  from: { host?: string | null; headers?: Record<string, unknown> | null; principal?: Record<string, unknown> | null },
): string | null

// ─── Tenant registry ──────────────────────────────────────────────────────────

export interface TenantRegistryOptions {
  // Schema — same forms as createClient
  path?:          string
  schema?:        string
  parsed?:        ParseResult
  // Tenant directory — the schema's `tenancy { dir }`, else <schemaDir>/tenants
  dir?:           string
  // Registry db — the schema's `tenancy { registry }`, else <schemaDir>/tenants-registry.db
  registry?:      string
  maxOpen?:       number
  // String key or per-tenant function
  encryptionKey?: string | ((tenantId: string) => string | Promise<string>)
  migrationsDir?: string
  // ':memory:' — all tenant DBs in-memory (testing only)
  databases?:     ':memory:'
  // Forwarded to every createClient() call
  clientOptions?: Omit<CreateClientOptions, 'path' | 'schema' | 'parsed' | 'db' | 'encryptionKey'>
}

export declare function createTenantRegistry(options: TenantRegistryOptions): Promise<{
  get(id: string): Promise<LitestoneClient>
  create(id: string, meta?: Record<string, unknown>): Promise<void>
  delete(id: string): Promise<void>
  exists(id: string): boolean
  list(): string[]
  meta:  Map<string, Record<string, unknown>>
  migrate(opts?: { only?: string[]; concurrency?: number }): Promise<{ tenants: number; migrations: number; failed: Array<{ tenantId: string; error: string }> }>
  query<T>(fn: (db: LitestoneClient) => Promise<T>): Promise<Record<string, T>>
  close(): void
}>

// ─── Introspect ───────────────────────────────────────────────────────────────

export declare function generateLiteSchema(db: unknown, opts?: { camelCase?: boolean }): string

// ─── Replication ──────────────────────────────────────────────────────────────

export declare function replicate(configPath: string, opts?: { verbose?: boolean }): Promise<void>

// ─── Retention ────────────────────────────────────────────────────────────────

export declare function parseDuration(str: string): number
export declare function parseSize(str: string): number
export declare function runSqliteRetention(db: unknown, retention: string): void
export declare function compactJsonl(path: string, retention: string): void

// ─── Transform pipeline ───────────────────────────────────────────────────────

export declare const $: Record<string, {
  filter(sql: string): unknown
  drop(...cols: string[]): unknown
  keep(...cols: string[]): unknown
  limit(n: number): unknown
  sample(n: number): unknown
  redact(mode?: 'email' | 'phone' | 'both'): unknown
  mask(col: string, strategy?: string): unknown
  rename(from: string, to: string): unknown
  scope(sql: string): unknown
  truncate(): unknown
  drop(): unknown
  dropExcept(...cols: string[]): unknown
}>

export declare function params(values: Record<string, unknown>): void
export declare function preview(configPath: string): Promise<void>
export declare function execute(configPath: string, opts?: unknown, run?: unknown, pipeline?: unknown[]): Promise<unknown>
export declare function introspectSQL(db: unknown): Record<string, unknown>
export declare function buildFKGraph(db: unknown): Record<string, string[]>
export declare function parseLimit(n: unknown): number
export declare function resolveRowCount(db: unknown, table: string): number
