// The migration verbs, reached by `@frontierjs/litestone/migrations`. They are bare
// words that mean nothing beside `createClient`, so the main entry does not export them.

import type {
  ParseResult, CreateMigrationResult, ApplyResult, MigrationRow, VerifyResult,
} from '../index.js'

export declare function create(db: unknown, parseResult: ParseResult, label?: string, dir?: string, opts?: { pluralize?: boolean }): CreateMigrationResult
export declare function apply(db: unknown, dir?: string): Promise<ApplyResult>
export declare function status(db: unknown, dir?: string): MigrationRow[]
export declare function verify(db: unknown, parseResult: ParseResult, dir?: string, opts?: { pluralize?: boolean; dbName?: string }): VerifyResult
