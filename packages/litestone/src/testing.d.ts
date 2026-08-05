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
  op:     'read' | 'create' | 'update' | 'delete'
  level:  number
  label:  string
  expect: 'allow' | 'deny'
}

/** Allow/deny cases derived from a model's `@@gate`. Empty array when it declares none. */
export declare function generateGateMatrix(
  schema:    ParseResult['schema'],
  modelName: string,
): GateCase[]

export interface ValidationCase {
  field:   string
  value:   unknown
  rule:    string
  expect:  'fail' | 'pass'
  message: string
}

export interface ValidationCases {
  /** One complete valid record, from `generateFactory`. */
  valid:    FactoryRow
  /** One failing case per declared constraint. */
  invalid:  ValidationCase[]
  /** Boundary values that should pass. */
  boundary: ValidationCase[]
}

/** Build valid + invalid + boundary validation cases for a model's fields. */
export declare function generateValidationCases(
  schema:    ParseResult['schema'],
  modelName: string,
): ValidationCases
