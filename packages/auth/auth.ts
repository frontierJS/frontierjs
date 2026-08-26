// auth.ts
// createLitestoneAuth(db, opts): IAuth
//
// The data layer. Implements every IAuth method using db.asSystem() directly.
// Never touches HTTP — that is the plugin's job.
// Never sends email — that is the caller's job via the onX callbacks in opts.

import type { IAuth, SessionContext, CreateUserInput, ApiKeyOptions, AuthSessionInfo, ApiKeyInfo } from '@frontierjs/junction'
import {
  hashPassword,
  verifyPassword,
  payPasswordCost,
  generateApiKey,
  hashApiKey,
  generateToken,
  generateSessionToken,
  expiresAt,
  API_KEY_PREFIX,
} from './crypto.ts'
import type { LitestoneAuthOptions } from './types.ts'
import {
  beginFlow, exchangeCode, fetchIdentity, stateMatches, isAllowedReturnTo, OAuthError,
} from './oauth.ts'
import type { OAuthIdentity, TokenSet, AuthOAuth, OAuthResolution } from './oauth.ts'
import {
  InvalidCredentialsError, EmailTakenError, InvalidTokenError,
  UserNotFoundError, AuthConfigError,
  LastCredentialError, NotFoundError,
} from './errors.ts'

// Minimal interface — avoids a hard import of @frontierjs/litestone types
// while still getting type-safe asSystem() usage.
//
// `$databases` is OPTIONAL because reading it is feature detection: an older
// client may not have the property, and a Litestone proxy THROWS on an unknown
// one rather than answering undefined, so the read is guarded at runtime too.
interface LitestoneClient {
  asSystem(): any
  $databases?: Record<string, { driver?: string } | undefined>
}

export function createLitestoneAuth(
  db:   LitestoneClient,
  opts: LitestoneAuthOptions = {}
): IAuth & AuthOAuth & { _sessionTtl: string } {

  const {
    encryptionKey,
    sessionTtl           = '30 days',
    passwordResetTtl     = '1 hour',
    emailVerificationTtl = '24 hours',
    onPasswordResetRequested,
    onEmailVerificationRequested,
    sessionFields,
    onLogin,
    onLoginFailed,
    onLogout,
    onRegister,
    oauthProviders       = {},
    oauthFlowTtl         = '10 minutes',
    oauthReturnToAllow   = [],
    oauthLinkTtl         = '1 hour',
    onOAuthLinkRequested,
  } = opts

  const sys = db.asSystem()

  // ─── The audit trail ──────────────────────────────────────────────────────
  //
  // `@@log(audit)` covers writes, so it covered exactly the auth events that ARE
  // writes and none of the ones an app most wants: a failed login performs no
  // write and left no trace at all, and a successful one left `create:session`
  // with `actorId: null`, because the write goes through `asSystem()` and a
  // system context names no principal (`FJS-276`, `FJS-277`).
  //
  // `db.$audit` is litestone's one owner of "put a row in the audit trail" — the
  // log model is an ordinary accessor and could be written directly, but two
  // writers with no shared definition is how a second `operation` vocabulary
  // starts drifting from the first.
  //
  // TWO deliberate softenings, because this is on the login path:
  //
  //   · An app is not required to declare a logger database. Auth's own schema
  //     fragment does, but an app may bring its own User model — and a login
  //     that throws because there is nowhere to write the record would be a
  //     worse failure than the missing record.
  //   · A failed WRITE does not fail the request. $audit throws by design, and
  //     that is right for a caller whose whole purpose is the record; here the
  //     caller's purpose is the login. It is reported rather than swallowed.
  //
  // An app that wants a sign-in refused when it cannot be recorded has to say so
  // itself — that is a policy decision this package should not make quietly.

  const hasAuditLog = (() => {
    try {
      return Object.values(db.$databases ?? {}).some((d: any) => d?.driver === 'logger')
    } catch {
      // A Litestone client THROWS on an unknown property, so feature-detection
      // is itself a throwing expression on an older client.
      return false
    }
  })()

  async function audit(operation: string, entry: Record<string, unknown> = {}): Promise<void> {
    if (!hasAuditLog) return
    try {
      await sys.$audit({ operation, ...entry })
    } catch (err) {
      console.warn(`[auth] could not record '${operation}' in the audit trail:`, (err as Error)?.message)
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  function toContext(user: any, authMethod: SessionContext['authMethod']): SessionContext {
    return {
      userId:    user.id,
      userType:  user.role ?? 'user',
      // The User model's role was written to userType and then dropped, so
      // SessionContext.role — the field consumers actually read, including
      // anything grading a caller for @@gate — was always undefined.
      role:      user.role ?? undefined,
      email:     user.email,
      name:      user.name ?? undefined,
      // The column is a String now, so this coerces nothing an app has not
      // already made a string. Kept because the column belongs to the APP: it is
      // a hook this package declares and does not write, so what is in it is
      // whatever that app put there.
      accountId: user.accountId != null ? String(user.accountId) : undefined,

      // Verification standing, in the vocabulary sessionGateLevel() grades on.
      // The User model carries a boolean, not a timestamp, so this is
      // deliberately null-or-absent rather than a fabricated date:
      //   emailVerified false → null      → VISITOR (1)
      //   emailVerified true  → undefined → no objection; grades USER (4)
      // Absence means "nothing holding this user back", never "not yet".
      ...(user.emailVerified === false ? { verifiedAt: null } : {}),

      authMethod,

      // Last: an app that states a field wins. Spreading it first would mean
      // adding any key above here silently overrides what the app asked for,
      // which is a breaking change nobody would see.
      ...(sessionFields ? sessionFields(user) : {}),
    }
  }

  // The tail every proven identity shares: the app's veto, a token, the session
  // row, the trail. Password login is one caller and it must not be the only one
  // — a hook that fires for passwords alone is a lockout that OAuth walks past,
  // which is the whole of what `onLogin` exists to prevent.
  //
  // What a caller must have done BEFORE reaching here is prove who this is.
  // Nothing in this function proves anything.
  async function issueSession(
    user:       any,
    authMethod: SessionContext['authMethod'],
    meta:       Record<string, unknown> = {},
  ): Promise<{ token: string; user: SessionContext }> {
    // Before the session is issued, so a refusal leaves nothing behind. The hook
    // therefore has no session id to be given — what happened after this point
    // is the trail's to report, not the gate's.
    if (onLogin) {
      try {
        await onLogin({ user: toContext(user, authMethod) })
      } catch (err) {
        // A veto that leaves no trace is the class of defect FJS-277 was.
        await audit('login.failed', {
          model: 'User', records: [user.id], actorId: user.id,
          meta:  { ...meta, reason: 'refused-by-app', email: user.email, message: (err as Error)?.message },
        })
        throw err
      }
    }

    const token = generateSessionToken()

    const session = await sys.session.create({
      data: {
        userId:    user.id,
        token,
        expiresAt: expiresAt(sessionTtl),
      }
    })

    // Beside the `create:session` row @@log(audit) already writes, not instead
    // of it: that one records the WRITE and cannot name the actor, this one
    // records the EVENT and does.
    await audit('login.succeeded', {
      model: 'Session', records: [session.id], actorId: user.id, actorType: 'user',
      ...(Object.keys(meta).length ? { meta } : {}),
    })

    return { token, user: { ...toContext(user, authMethod), sessionId: String(session.id) } }
  }

  // Guards for API key operations — encryptionKey is required for these.
  // Using a lazy check so apps that never use API keys don't need to provide it.
  function requireEncryptionKey(operation: string): string {
    if (!encryptionKey) {
      throw new AuthConfigError(
        `LitestoneAuthOptions.encryptionKey is required for ${operation}. ` +
        `Pass { encryptionKey: process.env.ENCRYPTION_KEY } to createLitestoneAuth().`
      )
    }
    return encryptionKey
  }

  // A named function rather than only a method, because verifySession has to
  // call it: the transport resolves every Bearer token through verifySession,
  // so a key that is only reachable via auth.verifyApiKey() is a key nothing
  // ever presents.
  async function verifyApiKeyImpl(rawKey: string): Promise<SessionContext | null> {
    // Issuing is the loud path — createApiKey throws AuthConfigError without a
    // key, which is where a developer finds out. Verifying is the quiet one: it
    // runs on attacker-supplied input on every request, so a missing config
    // answers "not authenticated" rather than throwing a 500 anyone can
    // trigger. verifySession also reaches here as a fallback for any token that
    // missed, and an app with no API keys at all must not pay a throw for that.
    if (!encryptionKey) return null
    const hash = hashApiKey(rawKey, encryptionKey)

    const cred = await sys.credential.findFirst({
      where: { type: 'apiKey', value: hash }
    })
    if (!cred) return null

    // Check credential-level expiry if set
    if (cred.tokenExpiresAt && new Date(cred.tokenExpiresAt) < new Date()) return null

    const user = await sys.user.findUnique({ where: { id: cred.userId } })
    if (!user) return null

    return {
      ...toContext(user, 'apiKey'),
      // createApiKey stores the scopes and this dropped them, so a key issued
      // with `servers:read` authenticated with the full standing of its owner
      // and nothing downstream could tell the difference. `scope` is stored
      // space-joined, the same shape OAuth uses.
      ...(cred.scope ? { scopes: cred.scope.split(/\s+/).filter(Boolean) } : {}),
      // Which key this was. An app that records per-key usage, or revokes one
      // key without touching the others, has no other way to ask.
      credentialId: String(cred.id),
    }
  }

  // ─── IAuth ────────────────────────────────────────────────────────────────

  return {

    // Exposed so createAuthPlugin can read it without requiring the caller
    // to pass sessionTtl to both createLitestoneAuth and createAuthPlugin.
    _sessionTtl: sessionTtl,

    // ── verifySession ────────────────────────────────────────────────────
    // Hot path — called on every authenticated request.
    // Two db lookups maximum: session → user.
    // Sessions are not extended on access (no sliding expiry) — the expiresAt
    // set at login is final. Intentional: avoids a write on every request.

    async verifySession(token: string): Promise<SessionContext | null> {
      // An API key is a Bearer token too, and the transport has one door:
      // http.ts calls verifySession and nothing else. Without this branch
      // createApiKey() succeeds and every request carrying the key it returned
      // is anonymous — a key that can be issued and never used. The prefix is
      // ours (crypto.ts), so it routes without costing a session lookup.
      if (token.startsWith(API_KEY_PREFIX)) return verifyApiKeyImpl(token)

      const session = await sys.session.findFirst({
        where: {
          token,
          expiresAt: { gt: new Date() },
        }
      })
      if (session) {
        const user = await sys.user.findUnique({ where: { id: session.userId } })
        // The session id travels on the context so a service can tell which of
        // the caller's sessions is the one asking — without ever being handed
        // the token that would let it answer by comparison.
        return user ? { ...toContext(user, 'session'), sessionId: String(session.id) } : null
      }

      // A key issued before the prefix existed, or by an app that generates its
      // own. One extra query, and only on a token that already missed.
      return verifyApiKeyImpl(token)
    },

    // ── sessionFor ───────────────────────────────────────────────────────
    //
    // A session for a caller who is presenting nothing, because there is
    // nothing left to present: deferred work runs long after the request that
    // asked for it, so `app.runAs(userId, …)` has an id and no token.
    //
    // It goes through `toContext` like every other path, which is the point —
    // the standing a job is graded at is built by the same function, from the
    // same row, with the app's own `sessionFields` applied. A parallel builder
    // here would be a second answer to "what standing does this user hold",
    // diverging exactly where it matters least visibly.
    //
    // `authMethod: 'created'` says how this session came to exist: not a
    // session row, not a key, no credential proved. Anything auditing *how* a
    // caller authenticated can tell it apart from one that did.
    //
    // Read fresh, never restored. A user demoted since enqueue is graded at the
    // standing they hold now, and a deleted one answers null.

    async sessionFor(userId: string): Promise<SessionContext | null> {
      const user = await sys.user.findUnique({ where: { id: userId } })
      return user ? toContext(user, 'created') : null
    },

    // ── login ────────────────────────────────────────────────────────────

    async login(email: string, password: string): Promise<{ token: string; user: SessionContext }> {
      // Every refusal records the same way and answers the same error. The three
      // branches are distinguishable in the trail by `reason` and nowhere else —
      // telling a caller whether the address exists is an enumeration oracle.
      // Recorded FIRST, then the hook runs. A hook that replaces the error must
      // not also be able to erase the attempt from the trail — the record is
      // what happened, the hook only decides what the caller is told.
      const refuse = async (reason: string, userId: string | null) => {
        await audit('login.failed', {
          model:   'User',
          records: userId ? [userId] : [],
          actorId: userId,
          // The attempted address, on purpose: a spray across many addresses is
          // invisible without it, and it is the only identifier a failed attempt
          // for an unknown user has. Never the attempted password.
          meta:    { reason, email },
        })
        // A throw here REPLACES InvalidCredentialsError — a lockout answers 429,
        // not 401. Returned rather than thrown so the call sites read `throw
        // await refuse(...)` and cannot forget to.
        if (onLoginFailed) await onLoginFailed({ email, userId, reason })
        return new InvalidCredentialsError()
      }

      // The two branches that never reach the real comparison pay its cost
      // anyway. Same error, same trail shape, and now the same clock — an early
      // return here answers in a millisecond where a wrong password takes ~220ms,
      // which enumerates users through a message that says nothing.
      const user = await sys.user.findFirst({ where: { email } })
      if (!user) {
        await payPasswordCost(password)
        throw await refuse('no-such-user', null)
      }

      const cred = await sys.credential.findFirst({
        where: { userId: user.id, type: 'password' }
      })
      if (!cred) {
        await payPasswordCost(password)
        throw await refuse('no-password-credential', user.id)
      }

      const valid = await verifyPassword(password, cred.value)
      if (!valid) throw await refuse('bad-password', user.id)

      return issueSession(user, 'session')
    },

    // ── OAuth: which providers is this app configured for? ───────────────
    //
    // A sign-in screen has to render one button per provider, and until this
    // existed the only way to know was to hardcode the same list the API was
    // configured with — in a second codebase, with nothing to fail when the two
    // disagreed. A provider that is dropped from the server leaves a button
    // that redirects into `oauth_error=unavailable`; one that is added appears
    // nowhere.
    //
    // NOT secret: these names are on the sign-in page of every site that has
    // one, and the screen that needs them has no session by definition.

    oauthProviderNames(): string[] {
      return Object.keys(oauthProviders)
    },

    // ── OAuth: start a flow ──────────────────────────────────────────────
    //
    // Writes the flow down and answers where to send the browser. The state is
    // returned so the caller can put it in a cookie as well: a flow record found
    // by the state value ALONE is login CSRF — an attacker starts a flow, keeps
    // their own code and state, and hands the callback URL to somebody else, who
    // is then signed in as the attacker in their own browser. RFC 9700 requires
    // the token be bound to the user agent, and a cookie is that binding. PKCE
    // does not cover it: the verifier is ours rather than the browser's.

    async oauthBegin(
      providerName: string,
      args: { redirectUri: string; returnTo?: string | null; extra?: Record<string, string> },
    ): Promise<{ authorizeUrl: string; state: string }> {
      const provider = oauthProviders[providerName]
      if (!provider) throw new OAuthError(`Unknown OAuth provider '${providerName}'`)

      // Checked HERE rather than at the callback, so what gets written down is
      // already known good and the way back has nothing left to decide. A
      // rejected value is dropped rather than refused: the person asked to sign
      // in, and where they land afterwards is not worth failing that over.
      const returnTo = isAllowedReturnTo(args.returnTo, oauthReturnToAllow)
        ? args.returnTo!
        : null

      const { authorizeUrl, state, verifier } = beginFlow(provider, args.redirectUri, args.extra)

      await sys.oauthFlow.create({
        data: {
          state,
          provider:  providerName,
          verifier,
          returnTo,
          expiresAt: expiresAt(oauthFlowTtl),
        }
      })

      return { authorizeUrl, state }
    },

    // ── OAuth: come back from one ────────────────────────────────────────
    //
    // Ends at an IDENTITY and deliberately not at a session. Who that identity
    // IS — link, create, or refuse and ask for proof — is a separate decision
    // with its own rules, and it is the one the published CVEs are about.

    async oauthCallback(
      providerName: string,
      args: { code: string; state: string; cookieState: string | null; redirectUri: string },
    ): Promise<{ identity: OAuthIdentity; tokens: TokenSet; returnTo: string | null }> {
      const provider = oauthProviders[providerName]
      if (!provider) throw new OAuthError(`Unknown OAuth provider '${providerName}'`)

      // FIRST, before any database read. A caller who cannot present the cookie
      // never started this flow, and there is nothing to look up on their behalf
      // — doing the lookup anyway would make the row's existence probeable.
      if (!stateMatches(args.cookieState, args.state)) {
        await audit('oauth.refused', { meta: { provider: providerName, reason: 'state-mismatch' } })
        throw new OAuthError('OAuth state did not match')
      }

      const flow = await sys.oauthFlow.findFirst({
        where: {
          state:     args.state,
          expiresAt: { gt: new Date() },
        }
      })
      if (!flow) {
        await audit('oauth.refused', { meta: { provider: providerName, reason: 'no-flow' } })
        throw new OAuthError('OAuth flow has expired or was already used')
      }

      // Claimed before the exchange, so a replay finds nothing. A network
      // failure at the token endpoint therefore costs the person a restart —
      // which is the right side of that trade: the alternative leaves a live
      // flow row behind every failure, and a code is single-use at the provider
      // anyway, so the retry it buys would fail too.
      await sys.oauthFlow.delete({ where: { id: flow.id } })

      // A flow started for one provider must not be finished with another's
      // code — the state matched and the cookie matched, and the only thing
      // left saying which provider this is, is the URL the browser came back on.
      if (flow.provider !== providerName) {
        await audit('oauth.refused', { meta: { provider: providerName, reason: 'provider-mismatch' } })
        throw new OAuthError('OAuth state did not match')
      }

      const tokens   = await exchangeCode(provider, {
        code:        args.code,
        verifier:    flow.verifier,
        redirectUri: args.redirectUri,
      })
      const identity = await fetchIdentity(provider, tokens)

      return { identity, tokens, returnTo: flow.returnTo ?? null }
    },

    // ── OAuth: who is this identity? ─────────────────────────────────────
    //
    // The security core, and the part every published CVE in this area is
    // about. Four branches, and the order is the argument:
    //
    //   1. We have seen this provider account before  → it is them.
    //   2. No address                                 → nothing to match on.
    //   3. Nobody holds the address                   → create.
    //   4. Somebody holds it                          → THREE conditions.
    //
    // Branch 4 is the one that gets written wrong. `CVE-2026-53516` (Better
    // Auth) and `CVE-2026-35511` (Authorizer) are both the same omission: the
    // gate reads the PROVIDER's `emailVerified` and never the local row's. The
    // attack is pre-registration — somebody signs up with the victim's address
    // and a password they control, the row is written unverified, the victim
    // later signs in with Google, and the two are fused with the attacker's
    // password still on the account.
    //
    // No token is stored. This is sign-in; holding a third-party access token
    // that nothing refreshes pays the whole security cost of keeping one and
    // buys a capability that expires within the hour.

    async oauthResolve(providerName: string, identity: OAuthIdentity): Promise<OAuthResolution> {
      const provider = oauthProviders[providerName]
      if (!provider) throw new OAuthError(`Unknown OAuth provider '${providerName}'`)

      const type = `oauth:${providerName}`

      // ── 1. Seen before ────────────────────────────────────────────────
      //
      // Keyed on (provider, subject) and never on the address. An address is
      // mutable at the provider and, on some of them, unverified by design —
      // which is the whole of nOAuth.
      const cred = await sys.credential.findFirst({ where: { type, value: identity.providerId } })
      if (cred) {
        const known = await sys.user.findUnique({ where: { id: cred.userId } })
        if (!known) throw new UserNotFoundError()
        await audit('oauth.signin', {
          model: 'User', records: [known.id], actorId: known.id,
          meta:  { provider: providerName },
        })
        return { outcome: 'signed-in', ...(await issueSession(known, 'session', { provider: providerName })) }
      }

      // ── 2. No address ─────────────────────────────────────────────────
      //
      // Nothing to match on and nothing to create with — `User.email` is
      // required and unique. GitHub reaches here whenever the account's primary
      // address is unverified, which is a real and ordinary case.
      if (!identity.email) {
        throw new OAuthError(`'${providerName}' returned no verified email address for this account`)
      }

      // `@lower` is a transform applied on WRITE, so the stored value is
      // lowercase and a where-clause carrying the provider's casing matches
      // nothing — which would read as *nobody holds this address* and create a
      // second account for a person who already has one.
      const email    = identity.email.toLowerCase()
      const existing = await sys.user.findFirst({ where: { email } })

      // ── 3. Nobody holds it → create ───────────────────────────────────
      if (!existing) {
        // The app's own gate, already awaited and already able to refuse — a
        // closed beta, a blocked domain. Before the row, per the ordering rule.
        if (onRegister) await onRegister({ email, name: identity.name })

        const proven = provider.trustEmail && identity.emailVerified
        const made   = await sys.user.create({
          data: { email, name: identity.name ?? null, emailVerified: proven },
        })
        await sys.credential.create({ data: { userId: made.id, type, value: identity.providerId } })
        await audit('oauth.registered', {
          model: 'User', records: [made.id], actorId: made.id,
          meta:  { provider: providerName, emailVerified: proven },
        })
        return { outcome: 'signed-in', ...(await issueSession(made, 'session', { provider: providerName })) }
      }

      // ── 4. Somebody holds it → three conditions ───────────────────────
      //
      // `existing.emailVerified` is the third, and it is the one the CVEs miss.
      // An account that never proved it owns the address is not evidence of
      // anything, so there is nothing here to attach an identity to.
      const linkable =
        provider.trustEmail &&           // this issuer's claim means something
        identity.emailVerified &&        // and it made one
        existing.emailVerified === true  // and WE already established the same

      if (!linkable) {
        await audit('oauth.link.refused', {
          model: 'User', records: [existing.id], actorId: existing.id,
          meta: {
            provider:         providerName,
            trustedProvider:  provider.trustEmail,
            providerVerified: identity.emailVerified,
            accountVerified:  existing.emailVerified === true,
          },
        })
        // One pending invitation per address: a fresh attempt replaces the last
        // rather than leaving a drawer of live tokens behind it.
        await sys.verification.deleteMany({ where: { purpose: 'oauthLink', identifier: email } })

        const token = generateToken()
        await sys.verification.create({
          data: {
            purpose:    'oauthLink',
            identifier: email,
            value:      token,
            provider:   providerName,
            subject:    identity.providerId,
            expiresAt:  expiresAt(oauthLinkTtl),
          }
        })

        // Still in memory — after this it is @guarded and nothing reads it back.
        await onOAuthLinkRequested?.({ email, token, provider: providerName })

        return { outcome: 'proof-required', email }
      }

      await sys.credential.create({ data: { userId: existing.id, type, value: identity.providerId } })
      await audit('oauth.linked', {
        model: 'User', records: [existing.id], actorId: existing.id,
        meta:  { provider: providerName },
      })
      return { outcome: 'signed-in', ...(await issueSession(existing, 'session', { provider: providerName })) }
    },

    // ── OAuth: prove the address, then attach ────────────────────────────
    //
    // The way out of `proof-required`. The token went to the address, so
    // presenting it proves control of it — the same proof a password reset is,
    // and the only kind this package can perform without a provider it trusts.
    //
    // What it does beyond attaching is the other half of the CVE fix. The
    // account being claimed was NEVER VERIFIED, which means nothing already on
    // it was ever shown to belong to whoever owns the address: not the
    // password, and not an identity from some other issuer nobody vouched for.
    // Attaching to it while leaving those in place would hand the person an
    // account somebody else can still open. So every credential that predates
    // the proof is evicted, and every session with it.
    //
    // The cost is real and is the right side of the trade: somebody who made
    // their OWN unverified account and then linked loses their own password
    // too, because an unverified row cannot tell the two apart. The way back is
    // a password reset, which proves the same address.

    async confirmOAuthLink(token: string): Promise<{ token: string; user: SessionContext }> {
      const pending = await sys.verification.findFirst({
        where: {
          purpose:   'oauthLink',
          value:     token,
          expiresAt: { gt: new Date() },
        }
      })
      if (!pending) throw new InvalidTokenError('Invalid or expired link token')

      // Single use, claimed before anything it authorises.
      await sys.verification.delete({ where: { id: pending.id } })

      const user = await sys.user.findFirst({ where: { email: pending.identifier } })
      if (!user) throw new UserNotFoundError()

      const wasUnverified = user.emailVerified !== true

      if (wasUnverified) {
        await sys.credential.deleteMany({ where: { userId: user.id } })
        await sys.session.deleteMany({ where: { userId: user.id } })
      }

      await sys.credential.create({
        data: {
          userId: user.id,
          type:   `oauth:${pending.provider}`,
          value:  pending.subject,
        }
      })

      // The proof IS the verification — this is exactly what the address was
      // asked to demonstrate, and leaving the row unverified would send the
      // next identity round the same loop.
      const verified = await sys.user.update({
        where: { id: user.id },
        data:  { emailVerified: true },
      })

      await audit('oauth.linked', {
        model: 'User', records: [user.id], actorId: user.id,
        meta:  { provider: pending.provider, viaProof: true, evictedPriorCredentials: wasUnverified },
      })

      return issueSession(verified, 'session', { provider: pending.provider })
    },

    // ── OAuth: what is attached to this account ──────────────────────────

    async listConnections(userId: string): Promise<Array<{ id: string; provider: string; createdAt: string }>> {
      const rows = await sys.credential.findMany({ where: { userId } })
      return rows
        .filter((c: any) => String(c.type).startsWith('oauth:'))
        .map((c: any) => ({
          id:        String(c.id),
          provider:  String(c.type).slice('oauth:'.length),
          createdAt: c.createdAt,
          // Never `value`. It is the provider's subject for this person — not a
          // secret, but an identifier at a third party that nothing on a
          // settings screen needs and every log it lands in keeps.
        }))
    },

    // ── OAuth: detach one ────────────────────────────────────────────────
    //
    // Refuses to remove the last way in. Not politeness — there is no way back
    // from it: `confirmPasswordReset` updates a password credential and does
    // not create one, so an account with none cannot gain one by asking for a
    // reset. Unlinking to zero is a permanent lockout that looks like a button.

    async removeConnection(userId: string, credentialId: string): Promise<{ id: string }> {
      const all = await sys.credential.findMany({ where: { userId } })
      const row = all.find((c: any) => String(c.id) === String(credentialId))

      // Scoped by construction: the row had to be among the caller's own, so a
      // credential id belonging to somebody else is NOT FOUND rather than
      // forbidden — the two answers differ, and the second one confirms it
      // exists.
      if (!row || !String(row.type).startsWith('oauth:')) {
        throw new NotFoundError('No such connection')
      }

      // Everything that can open this account, this one included. An API key is
      // not in the count: it authenticates a machine holding a secret this
      // person may not have, and it cannot be used to sign in and re-link.
      const waysIn = all.filter((c: any) =>
        c.type === 'password' || String(c.type).startsWith('oauth:'))

      if (waysIn.length <= 1) {
        throw new LastCredentialError(
          'This is the only way you can sign in. Add a password or another provider first.'
        )
      }

      await sys.credential.delete({ where: { id: row.id } })
      await audit('oauth.unlinked', {
        model: 'User', records: [userId], actorId: userId,
        meta:  { provider: String(row.type).slice('oauth:'.length) },
      })
      return { id: String(credentialId) }
    },

    // ── logout ───────────────────────────────────────────────────────────

    async logout(token: string): Promise<void> {
      // Read before the delete — afterwards there is nothing left to name, and a
      // logout that says which session ended is the half that makes a trail
      // followable. An unknown token is still recorded: it is what a replayed or
      // already-expired token looks like.
      const session = await sys.session.findFirst({ where: { token } })

      // Before the delete, per the ordering rule — a refusal that has already
      // destroyed the session it refused to destroy is not a refusal.
      if (onLogout) await onLogout({ userId: session?.userId ?? null, sessionId: session?.id ?? null })

      await sys.session.deleteMany({ where: { token } })

      await audit('logout', {
        model:   'Session',
        records: session ? [session.id] : [],
        actorId: session?.userId ?? null,
        meta:    session ? undefined : { reason: 'unknown-session' },
      })
    },

    // ── createUser ───────────────────────────────────────────────────────
    // Admin operation — creates user + password credential.
    // No session is issued here — call login() after to get one.
    // authMethod is 'created' to reflect that: a user record was created,
    // not that a session exists.

    async createUser(data: CreateUserInput): Promise<SessionContext> {
      const existing = await sys.user.findFirst({ where: { email: data.email } })
      if (existing) throw new EmailTakenError()

      // Before anything is written, so a refusal — a blocked domain, a closed
      // list — leaves no half-made account behind. It has no user row to be
      // given for the same reason.
      if (onRegister) await onRegister({ email: data.email, name: data.name ?? null })

      const user = await sys.user.create({
        data: {
          email: data.email,
          name:  data.name  ?? null,
          role:  data.role  ?? 'user',
        }
      })

      if (data.password) {
        await sys.credential.create({
          data: {
            userId: user.id,
            type:   'password',
            value:  await hashPassword(data.password),
          }
        })
      }

      return toContext(user, 'created')
    },

    // ── deleteUser ───────────────────────────────────────────────────────

    async deleteUser(userId: string): Promise<void> {
      // Fetch the user first so we can clean up email-scoped verification tokens
      const user = await sys.user.findUnique({ where: { id: userId } })

      await sys.credential.deleteMany({ where: { userId } })
      await sys.session.deleteMany({ where: { userId } })

      // Clean up any pending password-reset / email-verify tokens for this
      // address. An exact match now the identifier IS the address — it used to
      // be `endsWith(':' + email)` against a `reset:`/`verify:` prefix, which
      // is the parsing FJS-476 retired.
      if (user?.email) {
        await sys.verification.deleteMany({
          where: { identifier: user.email }
        })
      }

      await sys.user.delete({ where: { id: userId } })
    },

    // ── requestPasswordReset ─────────────────────────────────────────────
    // Always resolves — never reveals whether the email is registered.

    async requestPasswordReset(email: string): Promise<void> {
      const user = await sys.user.findFirst({ where: { email } })
      if (!user) return   // silent — don't reveal email existence

      await sys.verification.deleteMany({
        where: { purpose: 'passwordReset', identifier: email }
      })

      const token = generateToken()

      await sys.verification.create({
        data: {
          purpose:    'passwordReset',
          identifier: email,
          value:      token,
          expiresAt:  expiresAt(passwordResetTtl),
        }
      })

      // Token is still in memory — pass to callback before it becomes @guarded
      await onPasswordResetRequested?.(email, token)
    },

    // ── confirmPasswordReset ─────────────────────────────────────────────

    async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
      // `purpose` is not decoration: without it this matched an EMAIL-VERIFY
      // token too, and what refused it was two steps downstream and accidental
      // (FJS-476).
      const verification = await sys.verification.findFirst({
        where: {
          purpose:   'passwordReset',
          value:     token,
          expiresAt: { gt: new Date() },
        }
      })
      if (!verification) throw new InvalidTokenError('Invalid or expired reset token')

      const email = verification.identifier
      const user  = await sys.user.findFirst({ where: { email } })
      if (!user) throw new UserNotFoundError()

      const hash = await hashPassword(newPassword)

      await sys.credential.updateMany({
        where: { userId: user.id, type: 'password' },
        data:  { value: hash },
      })

      // Token consumed — delete it
      await sys.verification.delete({ where: { id: verification.id } })

      // Revoke all sessions — force re-login after password change
      await sys.session.deleteMany({ where: { userId: user.id } })
    },

    // ── requestEmailVerification ─────────────────────────────────────────

    async requestEmailVerification(userId: string): Promise<void> {
      const user = await sys.user.findUnique({ where: { id: userId } })
      if (!user) throw new UserNotFoundError()
      if (user.emailVerified) return   // already verified — no-op

      await sys.verification.deleteMany({
        where: { purpose: 'emailVerify', identifier: user.email }
      })

      const token = generateToken()

      await sys.verification.create({
        data: {
          purpose:    'emailVerify',
          identifier: user.email,
          value:      token,
          expiresAt:  expiresAt(emailVerificationTtl),
        }
      })

      // Token is still in memory — pass to callback before it becomes @guarded
      await onEmailVerificationRequested?.(user.email, token)
    },

    // ── verifyEmail ──────────────────────────────────────────────────────

    async verifyEmail(token: string): Promise<SessionContext> {
      // See the note in confirmPasswordReset — this matched a RESET token
      // without the purpose filter (FJS-476).
      const verification = await sys.verification.findFirst({
        where: {
          purpose:   'emailVerify',
          value:     token,
          expiresAt: { gt: new Date() },
        }
      })
      if (!verification) throw new InvalidTokenError('Invalid or expired verification token')

      const email = verification.identifier
      const user  = await sys.user.findFirst({ where: { email } })
      if (!user) throw new UserNotFoundError()

      await sys.user.update({
        where: { id: user.id },
        data:  { emailVerified: true },
      })

      await sys.verification.delete({ where: { id: verification.id } })

      return toContext({ ...user, emailVerified: true }, 'verified')
    },

    // ── createApiKey ─────────────────────────────────────────────────────
    // Raw key returned once — never stored.
    // HMAC of the raw key (keyed on encryptionKey) stored in credentials.value.

    async createApiKey(userId: string, opts?: ApiKeyOptions): Promise<{ key: string; id: string }> {
      const secret = requireEncryptionKey('createApiKey')
      const rawKey = generateApiKey()
      const hash   = hashApiKey(rawKey, secret)

      const cred = await sys.credential.create({
        data: {
          userId,
          type:           'apiKey',
          value:          hash,
          label:          opts?.name      ?? null,
          tokenExpiresAt: opts?.expiresAt ?? null,
          scope:          opts?.scopes?.join(' ') ?? null,
        }
      })

      return { key: rawKey, id: String(cred.id) }
    },

    // ── listApiKeys ──────────────────────────────────────────────────────
    // Never the stored value: it is the HMAC a presented key is matched
    // against, and a list that carried it would be a list of working keys.

    async listApiKeys(userId: string): Promise<ApiKeyInfo[]> {
      const creds = await sys.credential.findMany({
        where:   { userId, type: 'apiKey' },
        orderBy: { createdAt: 'desc' },
      })
      return creds.map((c: any) => ({
        id:        String(c.id),
        name:      c.label ?? null,
        scopes:    c.scope ? String(c.scope).split(/\s+/).filter(Boolean) : [],
        createdAt: c.createdAt ?? null,
        expiresAt: c.tokenExpiresAt ?? null,
      }))
    },

    // ── revokeApiKey ─────────────────────────────────────────────────────

    async revokeApiKey(keyId: string, opts?: { userId?: string }): Promise<void> {
      // Not Number(keyId). schema.ts ships `Credential.id Int`, but the
      // fragments are a starting point apps edit, and an app whose ids are
      // uuids got Number(uuid) === NaN — a delete that matches nothing and
      // does not throw. Revoke reported success and the key kept working.
      // Litestone coerces a where-value to the column type either way, so
      // passing it through is correct for both shapes.
      // `type: 'apiKey'` as well as the id: revoke must not be able to delete
      // somebody's password because a caller passed the wrong id.
      //
      // `userId` scopes it to one owner, and the api-keys service always passes
      // it: the caller supplies the id, so a delete matching on the id alone
      // revokes any key in the system whose id you can guess. The refusal is
      // the same "no such key" either way — whose key it is is not the
      // caller's to learn.
      const where: Record<string, unknown> = { id: keyId, type: 'apiKey' }
      if (opts?.userId) where.userId = opts.userId
      const { count } = await sys.credential.deleteMany({ where })
      if (!count) throw new InvalidTokenError(`No API key with id ${keyId}`)
    },

    // ── changePassword ───────────────────────────────────────────────────
    // The current password is verified here rather than trusted from a
    // service: this is the one call that can turn a stolen session into a
    // stolen account, and the check belongs beside the hash it compares.

    async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
      const cred = await sys.credential.findFirst({ where: { userId, type: 'password' } })
      // Same refusal for "no password set" as for "wrong password". An account
      // with only an OAuth credential is a fact about that account, and this is
      // reachable by anyone holding a session for it.
      if (!cred) throw new InvalidCredentialsError()
      if (!await verifyPassword(currentPassword, cred.value)) throw new InvalidCredentialsError()

      await sys.credential.update({
        where: { id: cred.id },
        data:  { value: await hashPassword(newPassword) },
      })

      await audit('password.changed', {
        model: 'Credential', records: [String(cred.id)], actorId: userId, actorType: 'user',
      })
    },

    // ── listSessions ─────────────────────────────────────────────────────
    // Expired rows are left out rather than shown as expired: the question a
    // caller is asking is "where am I signed in", and cleanup.ts is what
    // eventually removes them.

    async listSessions(userId: string): Promise<AuthSessionInfo[]> {
      const rows = await sys.session.findMany({
        where:   { userId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      })
      // `current` is decided by the caller — this layer is not told which token
      // presented. The service fills it in; false here means "not known to be".
      return rows.map((s: any) => ({
        id:        String(s.id),
        createdAt: s.createdAt ?? null,
        expiresAt: s.expiresAt ?? null,
        current:   false,
      }))
    },

    // ── revokeSession ────────────────────────────────────────────────────

    async revokeSession(userId: string, sessionId: string): Promise<void> {
      // userId in the where, not checked after the read: a delete keyed on the
      // id alone ends anyone's session whose id is guessable, and the id is
      // what a UI hands back from listSessions.
      const { count } = await sys.session.deleteMany({ where: { id: sessionId, userId } })
      if (!count) throw new InvalidTokenError(`No session with id ${sessionId}`)

      await audit('session.revoked', {
        model: 'Session', records: [String(sessionId)], actorId: userId, actorType: 'user',
      })
    },

    // ── revokeSessions ───────────────────────────────────────────────────

    async revokeSessions(userId: string, opts?: { exceptSessionId?: string }): Promise<number> {
      const where: Record<string, unknown> = { userId }
      if (opts?.exceptSessionId) where.id = { not: opts.exceptSessionId }

      const { count } = await sys.session.deleteMany({ where })

      await audit('session.revoked', {
        model: 'Session', records: [], actorId: userId, actorType: 'user',
        meta:  { count, keptCurrent: Boolean(opts?.exceptSessionId) },
      })
      return count
    },

    // ── verifyApiKey ─────────────────────────────────────────────────────

    verifyApiKey: verifyApiKeyImpl,
  }
}
