// index.ts
// @frontierjs/auth — public API

// ─── Core ─────────────────────────────────────────────────────────────────
export { createLitestoneAuth }         from './auth.ts'
export { createAuthPlugin }   from './plugin.ts'
// The service half of the surface. The plugin registers these itself; this is
// for an app that wants them somewhere else, or wants one of them alone.
export { createAuthServices, DEFAULT_SERVICE_NAMES } from './services.ts'
export { createAuthCleanupJobs } from './cleanup.ts'
// Two halves and their composition. The split is by owner — User is the app's,
// the credential machinery is this package's — and `fli auth:install` puts them
// in two files for that reason. `authSchemaFragments` is both, for a caller
// assembling one schema string in memory.
export { authUserModel, authMachineryModels, authSchemaFragments, retargetDb } from './schema.ts'

// ─── OAuth ────────────────────────────────────────────────────────────────
// The flow engine. Separate from the routes that drive it, because a URL, a
// token exchange and an identity are decidable with no server and no database.
export {
  defineProvider, beginFlow, exchangeCode, fetchIdentity,
  generateVerifier, challengeFor, stateMatches, isAllowedReturnTo,
  OAUTH_STATE_COOKIE, PROVIDER_PRESETS, OAuthError,
} from './oauth.ts'
export type {
  OAuthProvider, OAuthProviderOptions, OAuthIdentity, TokenSet, BeginResult, AuthOAuth,
} from './oauth.ts'

// ─── Errors ───────────────────────────────────────────────────────────────
// Exported so a consumer calling createLitestoneAuth() directly — with no
// Junction in the picture — can branch on what actually went wrong.
export {
  AuthError, InvalidCredentialsError, EmailTakenError,
  InvalidTokenError, UserNotFoundError, AuthConfigError,
  LastCredentialError, NotFoundError,
} from './errors.ts'

// ─── Types ────────────────────────────────────────────────────────────────
export type { LitestoneAuthOptions, AuthPluginOptions, AuthServicesOptions } from './types.ts'
export type { AuthCleanupHandle }                    from './cleanup.ts'
