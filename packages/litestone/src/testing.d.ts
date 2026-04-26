// @frontierjs/litestone/testing — type declarations for testing utilities.
//
// Re-exports Factory / Seeder / runSeeder from the main package (typed in
// index.d.ts), plus testing-only helpers that don't belong in the runtime API.

import type { LitestoneClient, ParseResult } from './index.js'

export { Factory, Seeder, runSeeder } from './index.js'

// ─── makeTestClient ──────────────────────────────────────────────────────────

export interface MakeTestClientOptions {
  /** Deterministic RNG seed. Same seed → same generated test data. */
  seed?:          number
  /** Auto-generate Factory subclasses for every SQLite-backed model. */
  autoFactories?: boolean
  /** Provide custom Factory subclasses keyed by accessor name. */
  factories?:     Record<string, new (db: LitestoneClient) => unknown>
  /** Optional async seeding fn, run after migrations applied. */
  data?:          (db: LitestoneClient) => Promise<void> | void
  /** Pluralize derived table names (matches createClient option). */
  pluralize?:     boolean
}

export interface TestClientResult {
  db:        LitestoneClient
  factories: Record<string, unknown>
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

/** Build a Factory bound to a specific model + client. */
export declare function factoryFrom(
  schema:    ParseResult['schema'],
  modelName: string,
  db:        LitestoneClient,
): unknown

/** Generate a Factory class definition (returns code as string). */
export declare function generateFactory(
  schema:    ParseResult['schema'],
  modelName: string,
  options?:  Record<string, unknown>,
): string

/** Build a matrix of gate allow/deny test cases for a model. */
export declare function generateGateMatrix(
  schema:    ParseResult['schema'],
  modelName: string,
): Array<{ name: string; level: number; expected: 'allow' | 'deny' }>

/** Build valid + invalid + boundary validation cases for a model's fields. */
export declare function generateValidationCases(
  schema:    ParseResult['schema'],
  modelName: string,
): Array<{ name: string; field: string; data: unknown; expected: 'pass' | 'fail' }>
