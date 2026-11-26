// The migration verbs, reached by `@frontierjs/litestone/migrations`. They are bare
// words that mean nothing beside `createClient`, so the main entry does not export them.

import type {
  ParseResult, CreateMigrationResult, ApplyResult, MigrationRow, VerifyResult,
} from '../index.js'

export declare function create(db: unknown, parseResult: ParseResult, label?: string, dir?: string, opts?: { pluralize?: boolean }): CreateMigrationResult
export declare function apply(db: unknown, dir?: string): Promise<ApplyResult>
export declare function accept(db: unknown, file: string, dir?: string): { ok: boolean; message: string; file?: string; class?: string }
export declare function migrationStatus(db: unknown, dir?: string): MigrationRow[]
/** Copies the database beside it, under `pre-migrate/`, when migrations are pending over applied ones; null when there was nothing to copy. Throws when the copy fails, so the caller migrates nothing. */
export declare function copyBeforeMigrating(rawDb: unknown, dbPath: string, migrationsDir: string, log: { info(msg: string, meta?: object): void }): string | null
export declare function preMigrateDir(dbPath: string): string
/** Each SQLite database the schema declares, at the path createClient with the same resolveFrom opens; a boot migrates these before it builds the client. */
export declare function declaredDatabasePaths(schemaPath: string, opts?: { resolveFrom?: 'cwd' | 'schema' | string | URL }): { name: string; path: string }[]
export declare const PRE_MIGRATE_KEEP: number
export declare function verify(db: unknown, parseResult: ParseResult, dir?: string, opts?: { pluralize?: boolean; dbName?: string }): VerifyResult
export { autoMigrate, listMigrationFiles, unmatchedMigrationFiles, describeSkipped } from '../index.js'
