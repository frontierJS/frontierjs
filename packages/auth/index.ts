// index.ts
// @frontierjs/auth — public API

// ─── Core ─────────────────────────────────────────────────────────────────
export { createLitestoneAuth }         from './auth.ts'
export { createAuthPlugin }   from './plugin.ts'
export { createAuthCleanupJobs } from './cleanup.ts'
export { authSchemaFragments }   from './schema.ts'

// ─── Errors ───────────────────────────────────────────────────────────────
// Exported so a consumer calling createLitestoneAuth() directly — with no
// Junction in the picture — can branch on what actually went wrong.
export {
  AuthError, InvalidCredentialsError, EmailTakenError,
  InvalidTokenError, UserNotFoundError, AuthConfigError,
} from './errors.ts'

// ─── Types ────────────────────────────────────────────────────────────────
export type { LitestoneAuthOptions, AuthPluginOptions } from './types.ts'
export type { AuthCleanupHandle }                    from './cleanup.ts'
