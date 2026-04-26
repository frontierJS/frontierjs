// @frontierjs/litestone — package-level type declarations
// These types cover the static package API.
// For per-schema types (typed db.users, db.posts, etc.) run:
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
 * db.products.findMany({
 *   where: { $raw: sql`price > IF(state = ${state}, ${minPrice}, 100)` }
 * })
 */
export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): RawClause

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

// ─── createClient options ─────────────────────────────────────────────────────

export interface CreateClientOptions {
  /** Path to a .lite schema file */
  path?:          string
  /** Inline schema string */
  schema?:        string
  /** Pre-parsed result from parseFile() */
  parsed?:        ParseResult
  /** Override db path (single-DB schemas without a database block) */
  db?:            string
  /** 64-char hex — required for @encrypted / @secret fields */
  encryptionKey?: string
  /** Plugins — GatePlugin, FileStorage, custom */
  plugins?:       Plugin[]
  /** Computed field functions, or path to a file exporting them */
  computed?:      Record<string, Record<string, (row: Record<string, unknown>, ctx: LitestoneCtx) => unknown>> | string
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
  findMany(args?: { where?: TWhere; orderBy?: TOrderBy | TOrderBy[]; limit?: number; offset?: number; include?: Record<string, boolean>; select?: Record<string, boolean>; withDeleted?: boolean; onlyDeleted?: boolean; recursive?: boolean | { direction?: 'descendants' | 'ancestors'; nested?: boolean; maxDepth?: number; via?: string }; distinct?: boolean; window?: WindowSpec }): Promise<(TRow & Record<string, unknown>)[]>
  findFirst(args?: { where?: TWhere; orderBy?: TOrderBy | TOrderBy[]; include?: Record<string, boolean>; select?: Record<string, boolean> }): Promise<TRow | null>
  findUnique(args: { where: TWhere; include?: Record<string, boolean>; select?: Record<string, boolean> }): Promise<TRow | null>
  findFirstOrThrow(args?: { where?: TWhere }): Promise<TRow>
  findUniqueOrThrow(args: { where: TWhere }): Promise<TRow>
  count(args?: { where?: TWhere }): Promise<number>
  exists(args?: { where?: TWhere }): Promise<boolean>
  findManyCursor(args?: { where?: TWhere; limit?: number; cursor?: string; orderBy?: TOrderBy | TOrderBy[] }): Promise<CursorResult<TRow>>
  search(query: string, args?: { where?: TWhere; limit?: number; offset?: number }): Promise<TRow[]>
  create(args: { data: TCreate; include?: Record<string, boolean>; select?: Record<string, boolean> | false }): Promise<TRow | null>
  createMany(args: { data: TCreate[] }): Promise<{ count: number }>
  update(args: { where: TWhere; data: TUpdate; include?: Record<string, boolean>; select?: Record<string, boolean> | false }): Promise<TRow | null>
  updateMany(args: { where: TWhere; data: TUpdate }): Promise<{ count: number }>
  upsert(args: { where: TWhere; create: TCreate; update: TUpdate; include?: Record<string, boolean>; select?: Record<string, boolean> | false }): Promise<TRow | null>
  upsertMany(args: { data: TCreate[]; conflictTarget: string[]; update?: string[] }): Promise<{ count: number }>
  remove(args: { where: TWhere }): Promise<TRow | null>
  removeMany(args: { where: TWhere }): Promise<{ count: number }>
  restore(args: { where: TWhere }): Promise<TRow | null>
  delete(args: { where: TWhere }): Promise<TRow | null>
  deleteMany(args: { where: TWhere }): Promise<{ count: number }>
  transition(id: number | string, name: string): Promise<TRow>
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
  $rotateKey(newKey: string): Promise<Record<string, { rows: number; fields: number }>>
  $lock(key: string, fn: () => Promise<unknown>, opts?: { ttl?: number; timeout?: number }): Promise<unknown>
  $locks: {
    acquire(key: string, opts?: { ttl?: number; owner?: string }): Promise<{ release(): Promise<void>; heartbeat(ms?: number): Promise<void> }>
    release(key: string, owner?: string): Promise<void>
    isHeld(key: string): Promise<boolean>
    list(): Promise<Array<{ key: string; owner: string | null; expiresAt: string | null }>>
  }
  $tapQuery(fn: (event: QueryEvent) => void): () => void
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
  state:      'applied' | 'pending' | 'modified' | 'orphaned'
  applied_at: string | null
  tampered:   boolean
  sql:        string | null
}

export interface ApplyResult {
  applied:  { file: string; ok: boolean; elapsed?: string; error?: string }[]
  pending:  number
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
  diff?:    string
}

export declare function create(db: unknown, parseResult: ParseResult, label?: string, dir?: string, opts?: { pluralize?: boolean }): CreateMigrationResult
export declare function apply(db: unknown, dir?: string, client?: LitestoneClient): Promise<ApplyResult>
export declare function status(db: unknown, dir?: string): MigrationRow[]
export declare function verify(db: unknown, parseResult: ParseResult, dir?: string, opts?: { pluralize?: boolean }): VerifyResult
export declare function autoMigrate(db: LitestoneClient, parseResult?: ParseResult, opts?: { pluralize?: boolean }): Record<string, { state: string; applied?: number; sql?: string }>
export declare function listMigrationFiles(dir: string): string[]
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

export declare class TransitionNotFoundError extends Error {
  model:      string
  transition: string
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

// ─── Seeder / Factory ─────────────────────────────────────────────────────────

export declare class Factory {
  constructor(db: LitestoneClient)
  model: string
  definition(seq: number, rng: { pick<T>(arr: T[]): T; float(): number; int(min: number, max: number): number }): Record<string, unknown>
  state(overrides: Record<string, unknown>): this
  for(relatedId: number | string): this
  withRelation(model: string, id: number | string): this
  afterCreate(fn: (record: Record<string, unknown>, db: LitestoneClient) => Promise<void>): this
  buildOne(overrides?: Record<string, unknown>): Record<string, unknown>
  buildMany(count: number, overrides?: Record<string, unknown>): Record<string, unknown>[]
  createOne(overrides?: Record<string, unknown>): Promise<Record<string, unknown>>
  createMany(count: number, overrides?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  truncate(): Promise<void>
}

export declare class Seeder {
  run(db: LitestoneClient): Promise<void>
  static once(db: LitestoneClient, key: string, fn: () => Promise<void>): Promise<void>
}

export declare function runSeeder(db: LitestoneClient, SeederClass: new () => Seeder): Promise<void>

// ─── JSON Schema ──────────────────────────────────────────────────────────────

export interface JsonSchemaOptions {
  format?:            'definitions' | 'flat'
  mode?:              'create' | 'update' | 'full'
  audience?:          'client' | 'system'
  includeTimestamps?: boolean
  includeDeletedAt?:  boolean
  includeComputed?:   boolean
  inlineEnums?:       boolean
}

export declare function generateJsonSchema(schema: LitestoneSchema, options?: JsonSchemaOptions): Record<string, unknown>

// ─── TypeScript generation ────────────────────────────────────────────────────

export interface TypegenOptions {
  audience?: 'client' | 'system'
}

export declare function generateTypeScript(schema: LitestoneSchema, options?: TypegenOptions): string

// ─── Tenant registry ──────────────────────────────────────────────────────────

export interface TenantRegistryOptions {
  // Schema — same forms as createClient
  path?:          string
  schema?:        string
  parsed?:        ParseResult
  // Tenant directory — defaults to <schemaDir>/tenants
  dir?:           string
  // Registry db — defaults to <schemaDir>/tenants-registry.db
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
