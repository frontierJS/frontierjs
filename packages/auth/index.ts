// index.ts
// @frontierjs/auth — public API

// ─── Core ─────────────────────────────────────────────────────────────────
export { createLitestoneAuth }         from './auth.ts'
export { createAuthPlugin }   from './plugin.ts'
export { createAuthCleanupJobs } from './cleanup.ts'
export { authSchemaFragments }   from './schema.ts'

// ─── Types ────────────────────────────────────────────────────────────────
export type { LitestoneAuthOptions, AuthPluginOptions } from './types.ts'
export type { AuthCleanupHandle }                    from './cleanup.ts'
