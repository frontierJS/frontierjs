// oauth.ts
// The OAuth flow engine — what a provider is, and the three steps of a sign-in.
//
// No HTTP server, no database, no session. It builds a URL, trades a code for
// tokens, and turns whatever came back into one normalised identity. Routes are
// plugin.ts's; deciding WHO that identity is, is auth.ts's. Kept apart because
// the interesting parts of this file are testable with neither.
//
// ── What the shape is defending against ─────────────────────────────────────
//
// Three published failures shaped this, and each one is a line of code that
// looks optional and is not:
//
//   • `state` is bound to the BROWSER, not just stored. A flow record found by
//     the state value alone lets an attacker start a flow, keep their own code
//     and state, and hand the callback URL to somebody else — who is then
//     signed in as the attacker, in their own browser, and starts typing things
//     into an account that is not theirs. RFC 9700 requires the token be
//     "securely bound to the user agent"; here that is a cookie the callback
//     must present as well. PKCE does NOT cover this — it addresses code
//     interception on the device, and the verifier is ours rather than the
//     browser's.
//
//   • The identity is `(provider, sub)` and never the address. An email is
//     mutable at the provider and, on some of them, unverified by design —
//     which is nOAuth: create a tenant, set a mail attribute to somebody
//     else's, sign in, become them. So `trustEmail` is per provider and the
//     generic OIDC preset defaults it OFF, because the issuer is whatever the
//     app pointed it at.
//
//   • `returnTo` is checked against a list the app states. An open redirector
//     is how an authorization code leaves the building; RFC 9700 states it as a
//     MUST rather than as hardening.
//
// ── One deliberate simplification ───────────────────────────────────────────
//
// The `id_token` is not validated and is not read. The identity comes from the
// userinfo endpoint, which is one extra round trip per sign-in at human
// frequency, and buys a single code path for OIDC providers and for GitHub —
// no JWKS cache, no JWT verification, no clock skew. It does not dodge nOAuth,
// which is about what a claim SAYS rather than about what carries it.

import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { AuthError }                                from './errors.ts'

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * The flow could not be completed. 400 because every reachable cause is
 * something about the request: a provider that refused, a code already spent, a
 * state that does not match the browser presenting it.
 *
 * Never carries the provider's own error body. It is attacker-influenced text
 * and this ends up on a screen.
 */
export class OAuthError extends AuthError {
  readonly name = 'OAuthError'
  readonly status = 400
}

// ─── What a provider is ─────────────────────────────────────────────────────

/** The normalised end of the flow. Everything above this line is provider-shaped. */
export interface OAuthIdentity {
  /**
   * The provider's own immutable id for this person — `sub` on OIDC, the
   * numeric id on GitHub. Stored in `Credential.value`.
   *
   * NEVER the email. The whole of nOAuth is applications that used the address
   * here because it was the readable one.
   */
  providerId:    string
  email:         string | null
  /** The provider's claim, untranslated. What is DONE with it is auth.ts's. */
  emailVerified: boolean
  name:          string | null
}

export interface OAuthProvider {
  /** The name in the URL and in `Credential.type` — `oauth:<name>`. */
  name:          string
  clientId:      string
  clientSecret:  string
  authorizeUrl:  string
  tokenUrl:      string
  userinfoUrl:   string
  scope:         string
  /**
   * May this provider's `emailVerified` be believed at all?
   *
   * Off for the generic OIDC preset: the issuer is whatever the app configured,
   * and an attacker who can stand one up can assert any address. Turning it on
   * is a statement about a specific issuer, which only the app can make.
   *
   * It is one of THREE conditions before an address links an identity to an
   * existing account — see auth.ts. On its own it decides nothing.
   */
  trustEmail:    boolean
  /** userinfo body (+ a fetcher, for providers that need a second call) → identity. */
  identify:      (raw: any, get: (url: string) => Promise<any>) => Promise<OAuthIdentity>
}

/** What an app states. The preset supplies everything else. */
export interface OAuthProviderOptions {
  clientId:      string
  clientSecret:  string
  /** Widen or replace the preset's scope. The preset's is the sign-in minimum. */
  scope?:        string
  trustEmail?:   boolean
  /** Required by `oidc`, which has no endpoints of its own. */
  authorizeUrl?: string
  tokenUrl?:     string
  userinfoUrl?:  string
}

type Preset = Omit<OAuthProvider, 'name' | 'clientId' | 'clientSecret'>

// ─── The presets ────────────────────────────────────────────────────────────

const PRESETS: Record<string, Preset> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:     'https://oauth2.googleapis.com/token',
    userinfoUrl:  'https://openidconnect.googleapis.com/v1/userinfo',
    scope:        'openid email profile',
    trustEmail:   true,
    async identify(raw) {
      return {
        providerId:    String(raw?.sub ?? ''),
        email:         raw?.email ?? null,
        // Present as a real boolean on Google and as the string 'true' on some
        // OIDC implementations. Compared rather than coerced: `Boolean('false')`
        // is true, which would turn every unverified address into a verified one.
        emailVerified: raw?.email_verified === true || raw?.email_verified === 'true',
        name:          raw?.name ?? null,
      }
    },
  },

  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl:     'https://github.com/login/oauth/access_token',
    userinfoUrl:  'https://api.github.com/user',
    scope:        'read:user user:email',
    trustEmail:   true,
    // GitHub's /user answers the PUBLIC profile email, which is null for most
    // accounts and carries no verification state either way. The addresses live
    // behind a second call, and the one that means anything is primary AND
    // verified — so a sign-in that trusted /user alone would take an address the
    // person never proved, or none at all.
    async identify(raw, get) {
      const emails  = await get('https://api.github.com/user/emails').catch(() => [])
      const primary = Array.isArray(emails)
        ? emails.find((e: any) => e?.primary && e?.verified)
        : null

      return {
        providerId:    String(raw?.id ?? ''),
        email:         primary?.email ?? null,
        emailVerified: !!primary,
        name:          raw?.name ?? raw?.login ?? null,
      }
    },
  },

  // Any OIDC provider the app points at — Entra, Okta, Auth0, Keycloak. The
  // endpoints are stated rather than discovered: discovery is a network call at
  // boot, and a provider that cannot be constructed offline cannot be tested
  // offline either.
  oidc: {
    authorizeUrl: '',
    tokenUrl:     '',
    userinfoUrl:  '',
    scope:        'openid email profile',
    trustEmail:   false,
    async identify(raw) {
      return {
        providerId:    String(raw?.sub ?? ''),
        email:         raw?.email ?? null,
        emailVerified: raw?.email_verified === true || raw?.email_verified === 'true',
        name:          raw?.name ?? raw?.preferred_username ?? null,
      }
    },
  },
}

export const PROVIDER_PRESETS = Object.keys(PRESETS)

/**
 * Preset + what the app stated → a provider.
 *
 * `name` is the app's word for it and the preset is the shape, so the same
 * preset can be configured twice — two Entra tenants, a staging Okta — without
 * either one answering to the other's name.
 */
export function defineProvider(
  name:   string,
  preset: string,
  opts:   OAuthProviderOptions,
): OAuthProvider {
  const base = PRESETS[preset]
  if (!base) {
    throw new OAuthError(
      `Unknown OAuth preset '${preset}'. Available: ${PROVIDER_PRESETS.join(', ')}`
    )
  }
  if (!opts.clientId || !opts.clientSecret) {
    throw new OAuthError(`OAuth provider '${name}' needs both clientId and clientSecret`)
  }

  const provider: OAuthProvider = {
    ...base,
    name,
    clientId:     opts.clientId,
    clientSecret: opts.clientSecret,
    scope:        opts.scope        ?? base.scope,
    trustEmail:   opts.trustEmail   ?? base.trustEmail,
    authorizeUrl: opts.authorizeUrl ?? base.authorizeUrl,
    tokenUrl:     opts.tokenUrl     ?? base.tokenUrl,
    userinfoUrl:  opts.userinfoUrl  ?? base.userinfoUrl,
  }

  // The `oidc` preset ships three empty strings, so a missing endpoint would
  // otherwise surface as a fetch of '' at the moment somebody clicks sign-in.
  for (const key of ['authorizeUrl', 'tokenUrl', 'userinfoUrl'] as const) {
    if (!provider[key]) {
      throw new OAuthError(`OAuth provider '${name}' (preset '${preset}') needs ${key}`)
    }
  }

  return provider
}

// ─── PKCE ───────────────────────────────────────────────────────────────────
//
// Required for every authorization code flow, confidential clients included —
// RFC 9700 and OAuth 2.1 both. S256 only; `plain` is in the spec and is the
// version with nothing in it.

export function generateVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ─── The browser binding ────────────────────────────────────────────────────

/**
 * Set at the start of a flow, required at the callback.
 *
 * MUST be SameSite=Lax and must not be Strict: the callback is a cross-site
 * top-level GET navigation from the provider, and Strict withholds the cookie
 * on exactly that, so the flow would fail every single time.
 */
export const OAUTH_STATE_COOKIE = 'fjs_oauth_state'

/** Constant-time compare of the state the browser carries against the one the URL does. */
export function stateMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  // timingSafeEqual throws on a length mismatch, which is itself an answer —
  // returning it directly is the same information without the exception.
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

// ─── returnTo ───────────────────────────────────────────────────────────────

/**
 * Where the browser may be sent once the flow finishes.
 *
 * Same-origin relative paths only, matched against a list the app states. An
 * open redirector is how an authorization code leaves the building, so the
 * default is refusal and there is no wildcard.
 *
 * `//evil.test` and `/\evil.test` are the two shapes that read as a path and
 * are parsed as an authority — both refused before the list is consulted.
 */
export function isAllowedReturnTo(returnTo: string | null | undefined, allow: string[]): boolean {
  if (!returnTo) return false
  if (!returnTo.startsWith('/')) return false
  if (returnTo.startsWith('//') || returnTo.startsWith('/\\')) return false
  return allow.includes(returnTo) || allow.some(p => p.endsWith('/') && returnTo.startsWith(p))
}

// ─── Step 1 — where to send the browser ─────────────────────────────────────

export interface BeginResult {
  authorizeUrl: string
  /** Goes in the URL, in the flow row, AND in the cookie. All three must agree. */
  state:        string
  /** Never leaves this process. Stored guarded, spent at the token endpoint. */
  verifier:     string
}

/**
 * `extra` is passed to the authorize endpoint untouched, for the params that
 * are provider-specific and flow-specific rather than ours.
 *
 * Sign-in needs none of them, which is why none are set here. Delegated access
 * needs several and they are not interchangeable: Google returns a refresh
 * token ONLY on first consent unless it is asked with
 * `access_type=offline` + `prompt=consent`, so a second sign-in silently
 * yields none; Microsoft returns one on every redemption but only when
 * `offline_access` is in the scope. Both are observed in production code, not
 * inferred.
 *
 * It cannot overwrite the seven parameters below it — those are the flow's own,
 * and `state` or `code_challenge` arriving from a caller is the flow being
 * disarmed by its own configuration.
 */
export function beginFlow(
  provider:    OAuthProvider,
  redirectUri: string,
  extra:       Record<string, string> = {},
): BeginResult {
  const state    = randomBytes(32).toString('base64url')
  const verifier = generateVerifier()

  const url = new URL(provider.authorizeUrl)
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  url.searchParams.set('response_type',         'code')
  url.searchParams.set('client_id',             provider.clientId)
  // Exact-string matched by the provider, so it is passed through untouched and
  // never rebuilt — RFC 9700 removed pattern matching from the acceptable set.
  url.searchParams.set('redirect_uri',          redirectUri)
  url.searchParams.set('scope',                 provider.scope)
  url.searchParams.set('state',                 state)
  url.searchParams.set('code_challenge',        challengeFor(verifier))
  url.searchParams.set('code_challenge_method', 'S256')

  return { authorizeUrl: url.toString(), state, verifier }
}

// ─── Step 2 — the code for tokens ───────────────────────────────────────────

export interface TokenSet {
  accessToken:  string
  refreshToken: string | null
  expiresIn:    number | null
  scope:        string | null
}

export async function exchangeCode(
  provider: OAuthProvider,
  args:     { code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code:          args.code,
    redirect_uri:  args.redirectUri,
    client_id:     provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: args.verifier,
  })

  const res = await fetch(provider.tokenUrl, {
    method:  'POST',
    // GitHub answers form-encoded unless asked otherwise, and every OIDC
    // provider answers JSON regardless — so asking makes one parse path.
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  })

  const raw = await res.json().catch(() => null) as any

  // GitHub answers 200 with `{ error: 'bad_verification_code' }`, so the status
  // alone is not the question. The provider's own message is deliberately not
  // carried into ours: it is attacker-influenced text headed for a screen.
  if (!res.ok || !raw || raw.error || !raw.access_token) {
    throw new OAuthError(`OAuth token exchange failed for '${provider.name}'`)
  }

  return {
    accessToken:  String(raw.access_token),
    refreshToken: raw.refresh_token ? String(raw.refresh_token) : null,
    expiresIn:    typeof raw.expires_in === 'number' ? raw.expires_in : null,
    scope:        raw.scope ? String(raw.scope) : null,
  }
}

// ─── Step 3 — the tokens for an identity ────────────────────────────────────

export async function fetchIdentity(
  provider: OAuthProvider,
  tokens:   TokenSet,
): Promise<OAuthIdentity> {
  const get = async (url: string) => {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        accept:        'application/json',
        // GitHub refuses a request with no User-Agent outright.
        'user-agent':  '@frontierjs/auth',
      },
    })
    if (!res.ok) throw new OAuthError(`OAuth userinfo failed for '${provider.name}'`)
    return res.json()
  }

  const identity = await provider.identify(await get(provider.userinfoUrl), get)

  // A provider that answers no subject leaves nothing to key a credential on,
  // and the readable alternative is the address — which is the mistake this
  // whole file is arranged around. Refuse instead.
  if (!identity.providerId) {
    throw new OAuthError(`OAuth provider '${provider.name}' returned no subject`)
  }

  return identity
}

// ─── What createLitestoneAuth adds ──────────────────────────────────────────

/**
 * The OAuth half of the auth instance's surface.
 *
 * Declared here and NOT on junction's `IAuth`, which describes what junction
 * itself calls — and junction knows nothing about this flow. `FJS-D10` already
 * made that split for the other direction: what junction accepts is
 * `SessionVerifier`, a narrow slice of `IAuth`, because the interface declares
 * more than the framework uses. Adding a redirect flow to it would push the gap
 * the other way.
 *
 * Both are optional at the point of use: the plugin feature-detects them the
 * same way it already does `requestEmailVerification`, so a third-party IAuth
 * provider with no OAuth is a mounted route that refuses by name rather than a
 * type error in an app that never wanted OAuth.
 */
export type OAuthResolution =
  | { outcome: 'signed-in';      token: string; user: import('@frontierjs/junction').SessionContext }
  /**
   * An account already holds this address and has not proved it owns it, so
   * there is nothing here to link to safely. NOT an error — it is a legitimate
   * state with a way out, and the way out is proving the address by mail.
   */
  | { outcome: 'proof-required'; email: string }

export interface AuthOAuth {
  /** The provider names this app is configured for, in declaration order. */
  oauthProviderNames(): string[]

  oauthBegin(
    providerName: string,
    args: { redirectUri: string; returnTo?: string | null; extra?: Record<string, string> },
  ): Promise<{ authorizeUrl: string; state: string }>

  oauthCallback(
    providerName: string,
    args: { code: string; state: string; cookieState: string | null; redirectUri: string },
  ): Promise<{ identity: OAuthIdentity; tokens: TokenSet; returnTo: string | null }>

  oauthResolve(providerName: string, identity: OAuthIdentity): Promise<OAuthResolution>

  confirmOAuthLink(token: string): Promise<{
    token: string
    user:  import('@frontierjs/junction').SessionContext
  }>

  listConnections(userId: string): Promise<Array<{ id: string; provider: string; createdAt: string }>>
  removeConnection(userId: string, credentialId: string): Promise<{ id: string }>
}
