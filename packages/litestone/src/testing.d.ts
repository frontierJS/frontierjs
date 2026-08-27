// @frontierjs/litestone/testing — type declarations for testing utilities.
//
// Re-exports Factory / Seeder / runSeeder from the main package (typed in
// index.d.ts), plus testing-only helpers that don't belong in the runtime API.

import type { LitestoneClient, ParseResult, Factory, FactoryRng, FactoryRow } from './index.js'

export { Factory, defineFactory, Seeder, runSeeder, loadFixture, parseCsv } from './index.js'
export type { FactoryRng, FactoryRow, FactoryOverrides, FactorySpec, LoadFixtureOptions } from './index.js'

// ─── Value catalogue ─────────────────────────────────────────────────────────

/** Catalogue generators, all driven by the caller's seeded rng. */
export declare const FAKE: Record<string, (rng: FactoryRng, ...rest: number[]) => string>

/**
 * A catalogue value for a well-known field name (`firstName`, `city`, `company`,
 * …), or null when nothing fits. Returns null without an rng — which is what keeps
 * unseeded factories byte-identical to their old output.
 */
export declare function fakeFor(fieldName: string, rng: FactoryRng | null): string | null

// ─── snapshot / restore ──────────────────────────────────────────────────────

/** dbName → tableName → rows, exactly as stored. */
export type DbSnapshot = Record<string, Record<string, Record<string, unknown>[]>>

/**
 * Point-in-time copy of every table in every SQLite database the client holds.
 * Read through the write connection, so `@encrypted` columns keep their exact
 * ciphertext and no gate, policy, hook or audit entry fires.
 */
export declare function snapshot(db: LitestoneClient): DbSnapshot

/**
 * Truncate and re-insert the snapshot's rows. Seed once, restore between tests —
 * cheaper than re-seeding, and NOT a transaction: it does not isolate concurrent work.
 */
export declare function restore(db: LitestoneClient, snap: DbSnapshot): void

// ─── makeTestClient ──────────────────────────────────────────────────────────

export interface MakeTestClientOptions {
  /** Deterministic RNG seed. Same seed → same generated test data. */
  seed?:          number
  /** Auto-generate Factory subclasses for every SQLite-backed model. */
  autoFactories?: boolean
  /** Provide custom Factory subclasses keyed by accessor name. */
  factories?:     Record<string, new (db: LitestoneClient) => Factory>
  /** Optional async seeding fn, run after migrations applied. */
  data?:          (db: LitestoneClient) => Promise<void> | void
  /** Pluralize derived table names (matches createClient option). */
  pluralize?:     boolean
}

export interface TestClientResult {
  db:        LitestoneClient
  /** Keyed by ACCESSOR (`db.user` → `factories.user`), not by model name. */
  factories: Record<string, Factory>
}

/** Build an in-memory client + factories from inline schema text. */
export declare function makeTestClient(
  schemaText: string,
  opts?:      MakeTestClientOptions,
): Promise<TestClientResult>

// ─── Reset / truncate ────────────────────────────────────────────────────────

/** Truncate one model's table (DELETE FROM <table>). */
export declare function truncate(db: LitestoneClient, modelName: string): Promise<void>

/** Truncate every table in dependency order — fastest reset between tests. */
export declare function reset(db: LitestoneClient): Promise<void>

// ─── Test generation ─────────────────────────────────────────────────────────

/**
 * Zero-config Factory bound to a specific model + client — no subclass needed.
 * `registry` (accessor → Factory) is what lets the result use `has()`, `attach()`
 * and `withParents()`; `makeTestClient` passes its own factories map.
 */
export declare function factoryFrom(
  schema:    ParseResult['schema'],
  modelName: string,
  db:        LitestoneClient,
  registry?: Record<string, Factory> | null,
): Factory

/**
 * Derive a `definition(seq, rng)` function from a model's field types and rules —
 * the same shape a Factory subclass would hand-write. Returns the function, not code.
 */
export declare function generateFactory(
  schema:    ParseResult['schema'],
  modelName: string,
  options?:  Record<string, unknown>,
): (seq: number, rng: FactoryRng | null) => FactoryRow

export interface GateCase {
  op:       'read' | 'create' | 'update' | 'delete'
  /** The level the gate declares for this operation. */
  required: number
  level:    number
  label:    string
  expect:   'allow' | 'deny'
}

export interface GateMatrixOptions {
  /**
   * `'full'` (default) — every operation against every reachable level 0–8.
   * `'edges'` — the required level and the one below it.
   */
  levels?: 'full' | 'edges'
}

/**
 * Allow/deny cases derived from a model's `@@gate`. Empty array when it declares
 * none. `modelName` is the MODEL name, PascalCase singular — not the accessor.
 */
export declare function generateGateMatrix(
  schema:    ParseResult['schema'],
  modelName: string,
  options?:  GateMatrixOptions,
): GateCase[]

// ─── Access snapshot ─────────────────────────────────────────────────────────

/** Every level a principal can actually hold. 9 (LOCKED) is a gate value, never a standing. */
export declare const REACHABLE_LEVELS: number[]

/** Level number → name (`4` → `'USER'`). */
export declare function levelLabel(n: number): string

export interface AccessPolicy {
  expr:    string
  message: string | null
}

export interface AccessField {
  name:       string
  /** `@secret` | `@encrypted` | `@guarded(all)` | `@guarded`, or null. */
  protection: string | null
  allows:     Array<{ operations: string[], expr: string }>
}

export interface AccessTransition {
  field: string
  name:  string
  from:  string[]
  to:    string
  gate:  number | null
}

export interface ModelAccess {
  name:        string
  db:          string | null
  external:    boolean
  gate:        { read: number, create: number, update: number, delete: number } | null
  gateSource:  string | null
  softDelete:  'cascade' | boolean
  policies:    Record<string, { allows: AccessPolicy[], denies: AccessPolicy[] }>
  fields:      AccessField[]
  transitions: AccessTransition[]
  /** No `@@gate` and no `@@allow` — nothing at the Data boundary refuses this model. */
  unrestricted: boolean
}

export interface AccessTable {
  /** Sorted by model name, so inserting a model does not shift every row below it. */
  models: ModelAccess[]
  levels: Record<string, number>
  counts: Record<string, number>
}

/** The declared access surface of a schema — gates, policies, protected fields, transition gates. */
export declare function deriveAccess(schema: ParseResult['schema']): AccessTable

/** One model's gate as the grid a runner asserts: every operation × every reachable level. */
export declare function gateLadder(model: ModelAccess): GateCase[]

/** The committed markdown artefact. */
export declare function renderAccessSnapshot(
  access: AccessTable,
  opts?:  { source?: string, command?: string },
): string

/** A parsed `@@allow`/`@@deny` condition, back in the syntax it was written in. */
export declare function policyExprToString(node: unknown): string

/**
 * What `@@gate` MEANS, stated independently of the gate plugin that enforces it.
 * The duplication is deliberate — an expected value taken from the code under
 * test cannot fail. One exhaustive test pins the two statements together.
 */
export declare function expectedVerdict(required: number, level: number): 'allow' | 'deny'

// ─── createTestEnv ───────────────────────────────────────────────────────────

export interface LadderMismatch extends GateCase {
  model:   string
  /** `'error'` — threw something that was not a refusal, so nothing was proven.
   *  `'skipped'` — a row policy covers this operation and refuses a synthetic
   *  principal before the gate is reached. Neither is a verdict. */
  got:     'allow' | 'deny' | 'error' | 'skipped'
  thrown:  string | null
  /** Already a sentence: model, operation, level, expected, actual. */
  message: string
}

export interface ConstraintMismatch {
  model:  string
  field:  string
  /** The declared rule, as written — `@length(3,12)`. */
  rule:   string
  value:  unknown
  expect: 'rejected' | 'accepted'
  /** `'error'` means the write failed before validation could refuse it — the
   *  case proves nothing either way, and is reported rather than swallowed. */
  /**
   * `rejected-by-another-rule` — refused, but by a DIFFERENT rule on the field,
   * so the case proves nothing about the one it names.
   * `uncheckable` — no value could isolate the rule, so it was not asked.
   */
  got:    'rejected' | 'accepted' | 'error' | 'rejected-by-another-rule' | 'uncheckable'
  thrown: string | null
  /** Already a sentence: model, field, rule, what happened. */
  message: string
}

export interface SchemaMutant {
  id:     string
  /** `gate-drop`, `gate-lower`, `allow-drop`, `guarded-drop`, `unique-drop`, … */
  kind:   string
  model:  string
  lineNo: number
  before: string
  after:  string
  /** A sentence: `Person: @@gate delete lowered 5 → 4`. */
  describe: string
  /** The whole mutated schema, not a diff. */
  text:   string
  /** false = the parser refused it, which is a kill it made. */
  parses: boolean
}

export interface MutationResult {
  total:    number
  /** Mutants that actually ran — the denominator. */
  graded:   number
  killed:   number
  byParser: number
  /** The framework would not load these. A kill: such a schema cannot ship. */
  refused:  Array<SchemaMutant & { thrown: string }>
  /** Nothing in the derived suite could see these. The finding. */
  survived: Array<SchemaMutant & { noise?: number }>
  /** The suite fell over — ungraded, and never counted as a kill. */
  errored:  Array<SchemaMutant & { thrown: string }>
  score:    number
}

/** Every mutant of a `.lite` source, one per attribute occurrence. */
export declare function schemaMutants(
  schemaText: string,
  opts?: { kinds?: string[] },
): SchemaMutant[]

/**
 * Build a database from each mutant, run the ORIGINAL schema's derived checks
 * against it, and report what nothing noticed. Expectations must come from the
 * original — deriving them from the mutant makes every mutant survive.
 */
export declare function mutationScore(opts: {
  schema:    string
  build:     (schemaText: string) => Promise<TestEnv>
  check?:    (env: TestEnv, original: ParseResult) => Promise<Array<{ got?: string }>>
  kinds?:    string[]
  onMutant?: (m: SchemaMutant & { outcome: string }) => void
}): Promise<MutationResult>

export interface LadderOptions {
  /**
   * Take the expectations from THIS schema rather than the one the client was
   * built from — the whole of schema mutation testing.
   */
  against?: ParseResult['schema'] | null
  ops?:     Array<'read' | 'create' | 'update' | 'delete'>
}

export interface ProtectionMismatch {
  model:   string
  field:   string | null
  level:   number | null
  got:     'exposed' | 'hidden' | 'error'
  thrown:  string | null
  message: string
}

export interface PolicyMismatch {
  model:  string
  op:     'read' | 'update' | 'delete'
  /** `'admitted'`/`'filtered'` are verdicts; `'error'` and `'skipped'` are not. */
  got:    'admitted' | 'filtered' | 'error' | 'skipped'
  row:    unknown
  message: string
}

export interface TestEnv {
  /** The unscoped client. */
  db:        LitestoneClient
  /** `db.asSystem()` — for arranging fixtures below the boundary. */
  system:    LitestoneClient
  factories: Record<string, Factory>
  schema:    ParseResult['schema']
  /** The throwaway directory holding this env's databases. */
  dir:       string
  /**
   * The clock every client this env opened reads — including the ones `atLevel`
   * builds, so moving it moves those too.
   */
  clock:     TestClock

  /** A scoped client for a principal, graded by the app's own `getLevel`. */
  actingAs(user: unknown): LitestoneClient

  /**
   * A client graded at `n` by a synthetic resolver, for walking the gate grid.
   * Never use it to test behaviour — it does not call the app's `getLevel`, so
   * a grid driven through it says nothing about the app's own derivation.
   * `atLevel(8)` is `asSystem()`, since `getLevel` is clamped to 0–7.
   */
  atLevel(n: number): Promise<LitestoneClient>

  /** Every gated model's ladder, model name attached. The axis, not the run. */
  gateMatrix(modelName?: string): Array<GateCase & { model: string }>

  /**
   * Every gated model's ladder, actually executed — each declared level against
   * a real client, for each of the four operations. Fixtures are built as
   * SYSTEM; anything that fails there is `got: 'error'` and never a verdict.
   *
   * An operation a row policy covers is `got: 'skipped'` in the allow→deny
   * direction only: a policy filters, so it can turn an allow into a deny and
   * never the reverse.
   */
  verifyGateLadder(opts?: LadderOptions): Promise<LadderMismatch[]>

  /** The read column alone — the half that needs no fixture. */
  verifyReadLadder(opts?: Omit<LadderOptions, 'ops'>): Promise<LadderMismatch[]>

  /**
   * Every `@guarded` / `@encrypted` / `@secret` field, actually read. The gate
   * ladder says who may read the ROW; this says which COLUMNS come back when
   * they do. Asserts absence, not nullity.
   */
  verifyFieldProtection(opts?: {
    against?:   ParseResult['schema'] | null
    principal?: unknown
  }): Promise<ProtectionMismatch[]>

  /**
   * Every `@@allow`/`@@deny` policy, executed against rows on both sides of its
   * predicate. Grades the compiled WHERE against litestone's own JS evaluator —
   * two independent implementations of one rule, which is the opposite of the
   * oracle problem.
   *
   * `create` is absent: it is checked by `evalJs` alone, so there is no second
   * implementation to compare against. A `check()` predicate, a model gated
   * above SYSADMIN(7), and a predicate every seeded row falls the same side of
   * are all reported rather than graded.
   */
  verifyRowPolicies(opts?: {
    against?:   ParseResult['schema'] | null
    principal?: unknown
    ops?:       Array<'read' | 'update' | 'delete'>
  }): Promise<PolicyMismatch[]>

  /**
   * Executes `generateValidationCases` against the real write path and returns
   * the cases that disagreed. Runs as SYSTEM (the question is enforcement, not
   * access) and rolls its rows back, so it is safe to call mid-suite.
   */
  verifyConstraints(
    modelName?: string | null,
    opts?: { against?: ParseResult['schema'] | null },
  ): Promise<ConstraintMismatch[]>

  /**
   * The arrange every scenario shares, run once. Takes the same tools
   * `phases().arrange` takes. Its rows are snapshotted and restored by every
   * later `phases()` call, with their ids, so the value it returns stays valid.
   * Refused twice, and refused after the first scenario has run.
   */
  setup<T>(fn: (tools: ArrangeTools) => T | Promise<T>): Promise<T>

  /**
   * Arrange / Act / Assert, scoped by what each phase can reach. Call inside
   * whatever `test()` the package uses — this is not tied to a runner.
   * Begins a scenario: restores `setup()`'s rows when a setup was declared.
   */
  phases(opts?: { as?: unknown }): TestPhases

  /** Snapshot the current rows. */
  seal(): void
  /** Restore the rows `seal()` captured. Throws if nothing was sealed. */
  reset(): void
  /** Closes the client and every `atLevel` client it opened. */
  close(): void
}

export interface ArrangeTools {
  /** `asSystem()` — writes below the boundary, announcing nothing. */
  system:    LitestoneClient
  factories: Record<string, Factory>
  db:        LitestoneClient
}

export interface TestPhases {
  /** Setup, through the system client. Refused once `act` has run. */
  arrange<T>(fn: (tools: ArrangeTools) => T | Promise<T>): Promise<T>
  /** The one mutation, through the principal's graded client. Once per scenario. */
  act<T>(fn: (as: LitestoneClient) => T | Promise<T>): Promise<T>
  /** Assertions, through the principal's graded READ-ONLY client. */
  assert<T>(fn: (read: LitestoneClient) => T | Promise<T>): Promise<T>
}

/**
 * A view of a client that reads and cannot write. Read methods are an
 * allow-list, so a write added to litestone later cannot pass through; the
 * doors back out to a writable client (`asSystem`, `$setAuth`, `sql`,
 * `$rawDbs`, `$transaction`) are refused by name.
 */
export declare function readOnly(client: LitestoneClient): LitestoneClient

export interface TestEnvOptions extends Record<string, unknown> {
  /** The `.lite` text, or a path to a `.lite` file. */
  schema: string
  /**
   * Build the template by replaying committed migrations instead of generating
   * DDL from the schema — a directory, a `.sql` path, or an array of either.
   * Every test then runs against the database a deploy actually produces. A
   * directory contributes every `.sql` it holds, sorted by filename; a `.js`
   * migration is refused, since a template is built on a raw connection.
   */
  migrations?: string | string[]
  /**
   * The clock every client this env opens reads, exposed as `env.clock`.
   *
   * A `Date` or an ISO string FREEZES time there and stays movable; a function
   * is your own source and `env.clock` will refuse to move it. Absent is the
   * wall clock, and `set`/`advance` freeze it from that point.
   *
   * It moves `now()` in a row policy and `@@softDelete`'s stamp. It does NOT
   * move `@default(now())` or `@updatedAt`, which SQLite stamps (`FJS-531`) —
   * state those on the write when a row has to be old.
   */
  now?: Date | string | (() => Date | string)
}

/** A clock a suite can move. See `TestEnvOptions.now`. */
export interface TestClock {
  /** The instant every client reads. */
  now(): Date
  /** Freeze at, or move to, an instant. Answers the new one. */
  set(at: Date | string): Date
  /**
   * Move by a duration — `'90m'`, `'2d'`, `'1y'`, or milliseconds. From the wall
   * clock this also freezes, because an offset from a moving clock is still
   * moving and the assertion after it would be a race.
   */
  advance(by: string | number): Date
  /** Is time standing still? False for the wall clock and for your own source. */
  readonly frozen: boolean
}

/**
 * A migrated database, a client, factories and a principal, in one call. The
 * tables arrive as a file copy from a template migrated once per schema per
 * process, so the per-test cost is a copy rather than a DDL run.
 */
export declare function createTestEnv(opts: TestEnvOptions): Promise<TestEnv>

export interface ValidationCase {
  field:   string
  value:   unknown
  rule:    string
  expect:  'fail' | 'pass'
  message: string
}

/**
 * A case that could not be built so that the rule it names is the only one
 * deciding the outcome — an `@email @length(3, 200)` column has no
 * three-character value, so `@length`'s lower boundary cannot be asked there.
 *
 * Reported rather than dropped: a rule that quietly stops being checked is the
 * failure this runner exists to prevent, one layer up (`FJS-351`).
 */
export interface UncheckableCase {
  field:     string
  rule:      string
  value:     unknown
  /** The other rules' complaints about the value that could not be repaired. */
  blockedBy: string[]
  message:   string
}

export interface ValidationCases {
  /** One complete valid record, from `generateFactory`. */
  valid:    FactoryRow
  /** One failing case per declared constraint, each isolating its own rule. */
  invalid:  ValidationCase[]
  /** Boundary values that should pass, each accepted by every rule on the field. */
  boundary: ValidationCase[]
  /** Cases no value could isolate. Never empty in silence — see the interface. */
  uncheckable: UncheckableCase[]
}

/** Build valid + invalid + boundary validation cases for a model's fields. */
export declare function generateValidationCases(
  schema:    ParseResult['schema'],
  modelName: string,
): ValidationCases

/** One model's seeded row and the payloads a create and a patch would carry. */
export interface ModelSample {
  /** The model's `@id` column. Not assumed to be `id`. */
  idField: string
  row?:    FactoryRow
  /** Creatable: FKs point at parents this call made, server-owned columns absent. */
  create?: FactoryRow
  /** A real update that cannot collide with a `@unique`. */
  patch?:  FactoryRow
  /** Present instead of the rest when the model could not be seeded. */
  error?:  string
}

/**
 * One seeded row per model, keyed by MODEL name. The Data-realm half of deriving
 * a call list — mapping a model onto the service that exposes it is an API-realm
 * fact this package cannot see.
 */
export declare function sampleWrites(
  schema:  ParseResult['schema'],
  system:  unknown,
  opts?:   { models?: string[] | null },
): Promise<Record<string, ModelSample>>

/**
 * A fresh temp directory with the previous runs' already swept. A harness here
 * can delete its own directory at neither of the two moments it would want to
 * — an afterAll races the audit logger's flush, and `process.on('exit')` does
 * not fire under `bun test` — so a run reaps on the way IN, where the owning
 * process is provably gone. `prefix` is what the sweep matches on and must
 * identify one harness.
 */
export declare function tempDir(
  prefix: string,
  opts?:  { olderThanMs?: number, root?: string },
): string

/** The sweep alone, for a harness that names its directory itself. Answers how
 *  many it removed. One sweep per prefix per process unless `force`. */
export declare function reapTempDirs(
  prefixes: string | string[],
  opts?:    { olderThanMs?: number, root?: string, force?: boolean },
): number
