// ─────────────────────────────────────────────
// STORE
// SQLite-backed persistence layer.
//
// Modules:
//   db           — IDatabase, SqlJsAdapter (tests), BunSqliteAdapter (prod), runMigrations
//   flows        — IFlowStore, SQLiteFlowStore
//   executions   — SQLiteExecutionStore (implements IExecutionStore)
//   credentials  — ICredentialStore, SQLiteCredentialStore, MissingSecretError
// ─────────────────────────────────────────────

export type { IDatabase, SQLParam }           from "./db"
export type { FlowStatus, FlowRow, IFlowStore } from "./flows"
export type { CredentialInput, CredentialMeta, ICredentialStore } from "./credentials"

export { createSqlJsDatabase, BunSqliteAdapter, runMigrations } from "./db"
export { SQLiteFlowStore }                    from "./flows"
export { SQLiteExecutionStore }               from "./executions"
export { SQLiteCredentialStore, MissingSecretError } from "./credentials"
