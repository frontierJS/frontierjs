// auth.ts
// createLitestoneAuth(db, opts): IAuth
//
// The data layer. Implements every IAuth method using db.asSystem() directly.
// Never touches HTTP — that is the plugin's job.
// Never sends email — that is the caller's job via the onX callbacks in opts.

import type { IAuth, LoginResult, SessionContext, CreateUserInput, ApiKeyOptions, AuthSessionInfo, ApiKeyInfo } from '@frontierjs/junction'
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
import type { LitestoneAuthOptions, CredentialEvent } from './types.ts'
import {
  beginFlow, exchangeCode, fetchIdentity, stateMatches, isAllowedReturnTo, OAuthError,
} from './oauth.ts'
import type { OAuthIdentity, TokenSet, AuthOAuth, OAuthResolution } from './oauth.ts'
import {
  generateTotpSecret, otpauthUri, verifyTotp as verifyTotpCode,
  generateRecoveryCodes, normalizeRecoveryCode,
} from './totp.ts'
import {
  InvalidCredentialsError, ReauthenticationFailedError, EmailTakenError, InvalidTokenError,
  UserNotFoundError, AuthConfigError,
  LastCredentialError,
  NoPasswordCredentialError, NotFoundError,
  TotpAlreadyEnabledError, InvalidSecondFactorError,
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
    // A support episode's ceiling, and it is short on purpose: the way back is
    // a column, so an operator who walks away leaves an open door for exactly
    // this long. An app raises it deliberately; nothing lets a caller ask for
    // more than it.
    supportTtl           = '30 minutes',
    passwordResetTtl     = '1 hour',
    emailVerificationTtl = '24 hours',
    loginChallengeTtl      = '5 minutes',
    loginChallengeAttempts = 5,
    totpDrift              = 1,
    totpIssuer             = 'FrontierJS',
    onPasswordResetRequested,
    onEmailVerificationRequested,
    sessionFields,
    onLogin,
    onLoginFailed,
    onLogout,
    onRegister,
    onCredentialChanged,
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

  // ─── A way into an account changed ────────────────────────────────────────
  //
  // The trail and `onCredentialChanged` are written through this one function,
  // so the two cannot name different events and a new credential write cannot
  // reach one without the other. `tests/credential-events.test.ts` fails on an
  // `audit()` of one of these operations anywhere else in this file.
  //
  // Not gated on `hasAuditLog`: an app with no logger database still owes the
  // person the email. The address is read here rather than passed by each
  // caller, and only when somebody is listening.
  async function credentialChanged(
    event:  CredentialEvent,
    userId: string,
    entry:  Record<string, unknown> = {},
  ): Promise<void> {
    await audit(event, entry)
    if (!onCredentialChanged) return
    try {
      const user = await sys.user.findUnique({ where: { id: userId } })
      if (!user) return
      await onCredentialChanged({
        event,
        userId:  String(userId),
        email:   user.email,
        actorId: String(entry.actorId ?? userId),
        at:      new Date().toISOString(),
        meta:    (entry.meta ?? {}) as Record<string, unknown>,
      })
    } catch (err) {
      console.warn(`[auth] onCredentialChanged failed for '${event}':`, (err as Error)?.message)
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

  // ─── The second factor ────────────────────────────────────────────────────
  //
  // Three credential types carry it and the split is what makes every read here
  // unambiguous:
  //
  //   totp          the live secret. Its EXISTENCE is what makes a login owe a
  //                 code, so nothing writes it until a code has been produced.
  //   totpPending   an enrollment nobody has proved yet. Gates nothing.
  //   recoveryCode  one row per code, value HMAC'd, deleted when spent.

  const TOTP_LIVE    = 'totp'
  const TOTP_PENDING = 'totpPending'
  const RECOVERY     = 'recoveryCode'

  const liveTotp = (userId: string) =>
    sys.credential.findFirst({ where: { userId, type: TOTP_LIVE } })

  /**
   * Recovery codes are HMAC'd with the app secret rather than bcrypt'd, which is
   * the same reasoning `hashApiKey` documents: the value is 49 bits this package
   * generated, not a word a person chose, so there is nothing to slow an attacker
   * down for. It also makes the lookup one indexed read instead of a bcrypt
   * against every code the person holds.
   */
  const recoveryHash = (code: string) =>
    hashApiKey(normalizeRecoveryCode(code), requireEncryptionKey('recovery codes'))

  const matchRecoveryCode = async (userId: string, code: string) => {
    const normalized = normalizeRecoveryCode(code)
    // Length-checked before the HMAC so a six-digit TOTP code that simply failed
    // does not get hashed and looked up as a recovery code on every attempt.
    if (normalized.length !== 10) return null
    return sys.credential.findFirst({
      where: { userId, type: RECOVERY, value: recoveryHash(code) }
    })
  }

  const countRecoveryCodes = (userId: string) =>
    sys.credential.count({ where: { userId, type: RECOVERY } })

  /** Replaces every code this user holds. Returns the plaintext, once. */
  async function issueRecoveryCodes(userId: string): Promise<string[]> {
    requireEncryptionKey('recovery codes')
    const codes = generateRecoveryCodes()

    await sys.credential.deleteMany({ where: { userId, type: RECOVERY } })
    for (const code of codes) {
      await sys.credential.create({
        data: { userId, type: RECOVERY, value: recoveryHash(code) }
      })
    }
    return codes
  }

  const bumpAttempts = (row: any) =>
    sys.loginChallenge.update({
      where: { id: row.id },
      data:  { attempts: Number(row.attempts ?? 0) + 1 }
    })

  /**
   * Whether typing again is worth anything — read AFTER the bump, and it spends
   * the ticket when it is not. A person left typing into a box that will refuse
   * every future code has been told nothing, which is the whole of what
   * `retryable` is for.
   */
  async function attemptsLeft(row: any): Promise<boolean> {
    if (Number(row.attempts ?? 0) + 1 < loginChallengeAttempts) return true
    await sys.loginChallenge.deleteMany({ where: { id: row.id } })
    return false
  }

  /**
   * The password, again, for a change to the second factor.
   *
   * A session that can enroll its own factor has locked the owner out of their
   * own account, and one that can remove theirs has taken the protection off
   * without ever knowing the password. Both are reachable from a stolen tab, so
   * both ask. Pays the comparison cost on a user with no password credential for
   * the same reason `login()` does.
   */
  async function requireCurrentPassword(userId: string, password: string): Promise<any> {
    const user = await sys.user.findFirst({ where: { id: userId } })
    if (!user) throw new UserNotFoundError()

    const cred = await sys.credential.findFirst({ where: { userId, type: 'password' } })
    if (!cred) {
      await payPasswordCost(password)
      throw new NoPasswordCredentialError('This account has no password to confirm with')
    }
    if (!await verifyPassword(password, cred.value)) throw new ReauthenticationFailedError()
    return user
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

  /**
   * Is this session's support episode still running?
   *
   * One owner for the comparison, because two places ask it and they must agree:
   * `verifySession` decides whether the token resolves to the subject, and
   * `startSupport` decides whether a new episode may begin. Reading the column in
   * one and the clock in the other is what made a lapsed episode unclearable.
   */
  function liveEpisode(session: { impersonatingUserId?: unknown; impersonationEndsAt?: unknown }): boolean {
    return Boolean(session.impersonatingUserId)
      && session.impersonationEndsAt != null
      && new Date(session.impersonationEndsAt as string) > new Date()
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
        // ── Support mode ────────────────────────────────────────────────
        //
        // The token is the OPERATOR's and the principal it answers is the
        // SUBJECT's, which is the whole of how an episode is bounded: every
        // layer above this line grades the subject, so an operator cannot
        // exceed what the person they are helping could do and nothing has to
        // remember to check.
        //
        // The expiry is read HERE rather than left to the sweep. A cron makes
        // an episode end eventually; this makes it end.
        //
        // A subject who no longer exists, or an episode that has lapsed, leaves
        // the operator resolving as themselves — the columns are a modifier on
        // their own session and an inapplicable modifier drops away. Answering
        // null instead would sign an operator out of their own account because
        // somebody else was deleted.
        if (liveEpisode(session)) {
          const subject = await sys.user.findUnique({ where: { id: session.impersonatingUserId } })
          if (subject) return {
            // `toContext` and not `sessionFor`, though they build the same
            // thing: `sessionFor` is documented as never being wired to
            // anything a request can name, and keeping that true is worth more
            // than the one line it saves. The id here comes off a stored column
            // that only an authorised start could write, not off the request.
            ...toContext(subject, 'session'),
            sessionId: String(session.id),
            support: {
              operatorId: String(session.userId),
              // The episode IS this session's excursion, so its id is the
              // session's. A minted one would be a second thing to keep in step.
              episodeId:  String(session.id),
              reason:     String(session.impersonationReason ?? ''),
              endsAt:     session.impersonationEndsAt,
            },
          }
        }

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

    // ── startSupport / endSupport ────────────────────────────────────────
    //
    // Support mode: an operator acts as somebody else, bounded at that
    // person's own standing and recorded against the operator's name.
    //
    // WHO MAY is not decided here. These take a token that has already been
    // resolved by the caller above them, and the route is where the app's
    // guard runs — this package has no way to grade an operator, and a level
    // hard-coded here would be a second answer to a question the app already
    // answers once. The refusals that ARE here are the ones no app should be
    // able to opt out of: no subject, no reason, no self, no chaining.
    //
    // Both are single writes to the operator's own row. There is nothing to
    // mint and nothing to revoke, which is why there is no way back to lose.

    async startSupport(
      token:   string,
      subjectId: string,
      reason:  string,
      ttl?:    string,
    ): Promise<{ endsAt: string }> {
      const session = await sys.session.findFirst({
        where: { token, expiresAt: { gt: new Date() } }
      })
      if (!session) throw new InvalidTokenError('No live session for this token')

      // Chaining is refused rather than nested. An operator already inside an
      // episode is resolving as the subject, so a second start would record
      // the SUBJECT as the operator of the next one — the trail would name a
      // person who did nothing.
      //
      // **Asked with the CLOCK, the same way `verifySession` asks it.** A lapsed
      // episode leaves its columns set until something clears them, and reading
      // the column alone made a lapse permanent: the session resolves as the
      // operator again — correctly, since resolution reads the clock — and every
      // start after that is refused for an episode nobody is in. There is no way
      // out of that state a person could find (`example`: `verify:support`).
      if (session.impersonatingUserId && liveEpisode(session))
        throw new AuthConfigError('Already in a support session — end it before starting another')

      if (String(session.userId) === String(subjectId))
        throw new AuthConfigError('Cannot start a support session against yourself')

      if (!reason?.trim()) throw new AuthConfigError('A support session needs a reason')

      const subject = await sys.user.findUnique({ where: { id: subjectId } })
      if (!subject) throw new UserNotFoundError(`No user '${subjectId}'`)

      // The app may ask for less than the ceiling and never for more. A
      // requested ttl is a preference; the cap is the rule.
      const cap  = new Date(expiresAt(supportTtl))
      const want = ttl ? new Date(expiresAt(ttl)) : cap
      const endsAt = (want < cap ? want : cap).toISOString()

      await sys.session.update({
        where: { id: session.id },
        data:  {
          impersonatingUserId: String(subjectId),
          impersonationReason: reason.trim(),
          impersonationEndsAt: endsAt,
        },
      })

      // The trail already has the write — Session carries @@log(audit), so the
      // stamp above is an entry with `before` and `after`, and the token is
      // @guarded so it is redacted there. This says the same thing in the
      // vocabulary a person reads the trail with, and is what a start that was
      // REFUSED would need if refusals are ever recorded.
      await audit('support.started', {
        model:   'Session',
        records: [String(session.id)],
        actorId: String(session.userId),
        meta:    { subjectId: String(subjectId), reason: reason.trim(), endsAt },
      })

      return { endsAt }
    },

    async endSupport(token: string): Promise<{ ended: boolean }> {
      const session = await sys.session.findFirst({ where: { token } })
      if (!session?.impersonatingUserId) return { ended: false }

      // An explicit null clears (Invariant 9). Ending twice is a no-op rather
      // than an error: the second call is what a reconnecting tab sends.
      await sys.session.update({
        where: { id: session.id },
        data:  {
          impersonatingUserId: null,
          impersonationReason: null,
          impersonationEndsAt: null,
        },
      })

      await audit('support.ended', {
        model:   'Session',
        records: [String(session.id)],
        actorId: String(session.userId),
        meta:    { subjectId: String(session.impersonatingUserId) },
      })

      return { ended: true }
    },

    // ── login ────────────────────────────────────────────────────────────

    async login(email: string, password: string): Promise<LoginResult> {
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
        if (onLoginFailed) await onLoginFailed({ email, userId, reason, stage: 'password' })
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

      // The password is right. Whether that is enough is the next question, and
      // a `totp` credential existing IS the answer — enrollment writes
      // `totpPending` and only `confirmTotp` promotes it, so there is no state
      // here where an unproven secret can gate a login (`FJS-D261`).
      const totp = await liveTotp(user.id)
      if (!totp) return issueSession(user, 'session')

      // One live ticket per person. A second password login supersedes the first
      // rather than adding to it: two open tickets are two independent attempt
      // budgets, so the ceiling below could be walked around by logging in again.
      await sys.loginChallenge.deleteMany({ where: { userId: user.id } })

      const value = generateToken()
      const row   = await sys.loginChallenge.create({
        data: { userId: user.id, value, expiresAt: expiresAt(loginChallengeTtl) }
      })

      // Recorded, because a password that was accepted and never finished is the
      // shape a stolen password makes: the attacker gets this far every time and
      // no further, and nothing else in the trail would say so.
      await audit('login.challenged', {
        model:   'LoginChallenge',
        records: [String(row.id)],
        actorId: user.id,
        actorType: 'user',
        meta:    { factor: 'totp' },
      })

      return { challenge: value, expiresAt: String(row.expiresAt) }
    },

    // ── The second step ──────────────────────────────────────────────────
    //
    // Everything here answers one error — five different things can be wrong
    // and the caller is told none of them, for `login()`'s reason one layer on.
    // The trail carries the `reason`, and `retryable` carries the only
    // distinction a screen can act on: whether typing again is worth anything.
    //
    // No `payPasswordCost` here, and the asymmetry is deliberate rather than an
    // omission. `login()` pays it because an EMAIL is guessable and the clock
    // would say which addresses have accounts. A ticket is 32 random bytes
    // nobody can enumerate, so there is no oracle to close, and paying a bcrypt
    // per attempt would only hand an attacker a way to cost the server 220ms a
    // request.

    async completeLogin(challenge: string, code: string): Promise<{ token: string; user: SessionContext }> {
      const spend = async (reason: string, row: any, retryable = true) => {
        await audit('login.failed', {
          model:   'LoginChallenge',
          records: row ? [String(row.id)] : [],
          actorId: row ? String(row.userId) : null,
          meta:    { reason, stage: 'second-factor' },
        })
        if (onLoginFailed) {
          await onLoginFailed({
            email:  null,
            userId: row ? String(row.userId) : null,
            reason,
            stage:  'second-factor',
          })
        }
        return new InvalidSecondFactorError(undefined, retryable)
      }

      const row = await sys.loginChallenge.findFirst({ where: { value: challenge } })
      if (!row) throw await spend('no-such-challenge', null, false)

      // Read at resolution, so a lapsed ticket stops working the instant it
      // lapses whether or not the sweep has been anywhere near it.
      if (new Date(row.expiresAt) <= new Date()) {
        await sys.loginChallenge.deleteMany({ where: { id: row.id } })
        throw await spend('challenge-expired', row, false)
      }

      const user = await sys.user.findFirst({ where: { id: row.userId } })
      const cred = user ? await liveTotp(row.userId) : null
      // The account was deleted, or the factor was turned off, between the two
      // requests. The ticket dies with it rather than becoming a password-free
      // way in.
      if (!user || !cred) {
        await sys.loginChallenge.deleteMany({ where: { id: row.id } })
        throw await spend(user ? 'factor-removed' : 'no-such-user', row, false)
      }

      const at   = new Date()
      const step = verifyTotpCode(cred.value, code, at, totpDrift)

      if (step !== null) {
        // The window is 30 seconds wide and a code is good for all of it, so
        // without this the window IS a replay window. `<=` and not `<`: the same
        // step is the same code.
        if (cred.totpLastStep != null && step <= Number(cred.totpLastStep)) {
          await bumpAttempts(row)
          throw await spend('code-replayed', row, await attemptsLeft(row))
        }

        await sys.credential.update({ where: { id: cred.id }, data: { totpLastStep: step } })
        await sys.loginChallenge.deleteMany({ where: { id: row.id } })
        return issueSession(user, 'session', { factor: 'totp' })
      }

      // Not a TOTP code — a recovery code is the other thing a person types into
      // that box, and they cannot be asked to say which one it is.
      const recovery = await matchRecoveryCode(row.userId, code)
      if (recovery) {
        // Deleted rather than flagged. A spent code that still exists is one
        // column away from being accepted again, and nothing would read wrong.
        await sys.credential.deleteMany({ where: { id: recovery.id } })
        await sys.loginChallenge.deleteMany({ where: { id: row.id } })

        const left = await countRecoveryCodes(row.userId)
        await credentialChanged('recovery.used', String(row.userId), {
          model:   'Credential',
          records: [String(recovery.id)],
          actorId: String(row.userId),
          actorType: 'user',
          meta:    { remaining: left },
        })
        return issueSession(user, 'session', { factor: 'recovery', recoveryCodesRemaining: left })
      }

      await bumpAttempts(row)
      throw await spend('bad-code', row, await attemptsLeft(row))
    },

    // ── TOTP: enrollment and the way back ────────────────────────────────
    //
    // Every one of these is reached from a service, so the caller is already
    // authenticated and `userId` is theirs. The password is asked for again on
    // the three that change what the account requires.

    async setupTotp(userId: string, currentPassword: string): Promise<{ secret: string; qr: string }> {
      const user = await requireCurrentPassword(userId, currentPassword)

      // Refused rather than replaced. Overwriting would invalidate the secret the
      // person's authenticator holds while their next login still demands a code
      // from it — the account is then locked by a call that answered 200.
      if (await liveTotp(userId)) throw new TotpAlreadyEnabledError()

      // One enrollment in flight. A second `setupTotp` supersedes the first,
      // because a person who scanned the wrong QR code asks again and the
      // abandoned secret must not stay confirmable.
      await sys.credential.deleteMany({ where: { userId, type: TOTP_PENDING } })

      const secret = generateTotpSecret()
      await sys.credential.create({ data: { userId, type: TOTP_PENDING, value: secret } })

      return { secret, qr: otpauthUri({ secret, account: user.email, issuer: totpIssuer }) }
    },

    async confirmTotp(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
      // No password here, and that is not an inconsistency: this call is the
      // second half of `setupTotp`, which asked. What it proves is the DEVICE.
      const pending = await sys.credential.findFirst({ where: { userId, type: TOTP_PENDING } })
      if (!pending) throw new NotFoundError('No enrollment in progress — call setupTotp first')

      const step = verifyTotpCode(pending.value, code, new Date(), totpDrift)
      if (step === null) throw new ReauthenticationFailedError('Invalid code')

      // Promoted rather than copied: the row keeps its id and the `totpPending`
      // spelling stops existing, so there is no window where both types answer
      // for this user.
      //
      // `totpLastStep` is set from the confirming code, which spends it. Left
      // null, the very code that switched the factor on would also log the person
      // in for the rest of its window — the replay the column exists to refuse,
      // reachable on the one request where the code is guaranteed to be on screen.
      await sys.credential.update({
        where: { id: pending.id },
        data:  { type: TOTP_LIVE, totpLastStep: step }
      })

      const recoveryCodes = await issueRecoveryCodes(userId)

      await credentialChanged('totp.enabled', userId, {
        model: 'Credential', records: [String(pending.id)],
        actorId: userId, actorType: 'user',
        meta: { recoveryCodes: recoveryCodes.length },
      })

      return { recoveryCodes }
    },

    async disableTotp(userId: string, currentPassword: string): Promise<void> {
      await requireCurrentPassword(userId, currentPassword)

      const cred = await liveTotp(userId)
      if (!cred) throw new NotFoundError('Two-factor authentication is not enabled')

      // The codes go with it. A recovery code outliving the factor it recovers is
      // a second password nobody remembers having.
      await sys.credential.deleteMany({ where: { userId, type: TOTP_LIVE } })
      await sys.credential.deleteMany({ where: { userId, type: TOTP_PENDING } })
      await sys.credential.deleteMany({ where: { userId, type: RECOVERY } })
      await sys.loginChallenge.deleteMany({ where: { userId } })

      await credentialChanged('totp.disabled', userId, {
        model: 'Credential', records: [String(cred.id)],
        actorId: userId, actorType: 'user',
      })
    },

    async regenerateRecoveryCodes(userId: string, currentPassword: string): Promise<{ recoveryCodes: string[] }> {
      await requireCurrentPassword(userId, currentPassword)

      if (!await liveTotp(userId)) throw new NotFoundError('Two-factor authentication is not enabled')

      const recoveryCodes = await issueRecoveryCodes(userId)
      await credentialChanged('recoveryCodes.regenerated', userId, {
        model: 'Credential', records: [],
        actorId: userId, actorType: 'user',
        meta: { count: recoveryCodes.length },
      })
      return { recoveryCodes }
    },

    // ── resetTotp: an operator removes somebody else's factor ────────────
    //
    // WHO MAY is the service's to decide (`FJS-D264`); this is what a reset IS,
    // whoever asked. Every way the old factor answers goes — the secret, an
    // enrollment in flight, the recovery codes, a half-finished login — and so
    // does every session, because the device that was lost usually holds one.
    // API keys stay: a lost phone is not a leaked key.
    //
    // The two refusals here are the ones no caller may opt out of. Resetting
    // your own is `disableTotp`, which asks for the password this skips.

    async resetTotp(userId: string, opts: { actorId: string }): Promise<{ sessionsRevoked: number }> {
      if (!opts?.actorId) throw new AuthConfigError('resetTotp requires the operator it is recorded against')
      if (String(opts.actorId) === String(userId)) {
        throw new ReauthenticationFailedError('Resetting your own second factor is disableTotp, which asks for your password')
      }

      const user = await sys.user.findUnique({ where: { id: userId } })
      if (!user) throw new UserNotFoundError(`No user '${userId}'`)

      const cred = await liveTotp(userId)
      if (!cred) throw new NotFoundError('Two-factor authentication is not enabled for this account')

      await sys.credential.deleteMany({ where: { userId, type: TOTP_LIVE } })
      await sys.credential.deleteMany({ where: { userId, type: TOTP_PENDING } })
      await sys.credential.deleteMany({ where: { userId, type: RECOVERY } })
      await sys.loginChallenge.deleteMany({ where: { userId } })
      const { count } = await sys.session.deleteMany({ where: { userId } })

      await credentialChanged('totp.reset', userId, {
        model: 'Credential', records: [String(cred.id)],
        actorId: String(opts.actorId), actorType: 'user',
        meta: { subjectId: String(userId), sessionsRevoked: count },
      })
      return { sessionsRevoked: count }
    },

    async totpStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
      const cred = await liveTotp(userId)
      return {
        enabled: Boolean(cred),
        // Asked only when it is on: the rows are deleted with the factor, so the
        // count would be 0 either way and a screen cannot tell *off* from
        // *out of codes* from one number.
        recoveryCodesRemaining: cred ? Number(await countRecoveryCodes(userId)) : 0,
      }
    },

    /**
     * Does this code verify for this user, right now.
     *
     * Does NOT advance `totpLastStep`, where `completeLogin` does. Consuming the
     * step here would refuse a person who signs in and immediately opens their
     * settings, using the code still on their screen — and the exposure it would
     * buy is a replay by somebody who already holds the session, which is not
     * the attack the column is there for.
     */
    async verifyTotp(userId: string, code: string): Promise<boolean> {
      const cred = await liveTotp(userId)
      if (!cred) return false
      return verifyTotpCode(cred.value, code, new Date(), totpDrift) !== null
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
      await credentialChanged('oauth.linked', existing.id, {
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

      // Single use, claimed before anything it authorizes.
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

      await credentialChanged('oauth.linked', user.id, {
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
    // from it: `confirmPasswordReset` refuses an account whose way in is an
    // OAuth credential, so an account holding one cannot gain a password by
    // asking for a reset. Unlinking to zero is a permanent lockout that looks
    // like a button.
    //
    // Which is why the refusal below names ONE remedy and not two. This guard
    // fires only when the single remaining way in is the OAuth credential being
    // removed — so the account has no password by construction, and telling
    // somebody to add one was advice that could not be taken (FJS-987).

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
          'This is the only way you can sign in. Connect another provider first.'
        )
      }

      await sys.credential.delete({ where: { id: row.id } })
      await credentialChanged('oauth.unlinked', userId, {
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

      // BEFORE the hash and before anything destructive, so a refusal burns no
      // token and revokes no session.
      //
      // Three accounts reach here and they are answered differently:
      //   · a password to replace — the ordinary reset.
      //   · NO way in at all — an account an operator made, whose invitation IS
      //     this link. The mailbox is the only thing that has ever vouched for
      //     it, so proving the mailbox is what sets the first password
      //     (`FJS-1099`, `FJS-D265`). Refusing left every invited person
      //     locked out of an account that answered 201.
      //   · an OAuth credential and no password — REFUSED. That account was
      //     secured by its provider and never by its mailbox, and a password
      //     minted from an emailed token would make mailbox access enough to
      //     take it over (`FJS-987`).
      const creds    = await sys.credential.findMany({ where: { userId: user.id } })
      const existing = creds.find((c: any) => c.type === 'password')
      const viaOAuth = creds.some((c: any) => String(c.type).startsWith('oauth:'))

      if (!existing && viaOAuth) {
        await audit('password.reset.refused', {
          model: 'User', records: [user.id], actorId: user.id,
          meta:  { reason: 'no-password-credential' },
        })
        throw new NoPasswordCredentialError(
          'This account has no password. Sign in with a connected provider instead.'
        )
      }

      const hash = await hashPassword(newPassword)

      const written = existing
        ? await sys.credential.update({ where: { id: existing.id }, data: { value: hash } })
        : await sys.credential.create({ data: { userId: user.id, type: 'password', value: hash } })

      // Token consumed — delete it
      await sys.verification.delete({ where: { id: verification.id } })

      // Revoke all sessions — force re-login after password change
      const { count } = await sys.session.deleteMany({ where: { userId: user.id } })

      // The change a person most needs to hear about and the one that recorded
      // nothing: whoever holds the inbox holds the account, and a reset nobody
      // asked for is how they find out.
      await credentialChanged('password.reset', user.id, {
        model: 'Credential', records: [String(written.id)], actorId: user.id, actorType: 'user',
        meta:  { sessionsRevoked: count, firstPassword: !existing },
      })
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

      // The sibling of `apikey.revoked`. Minting a credential that
      // authenticates as this person indefinitely is at least as worth
      // recording as ending one browser session (FJS-991). The key material is
      // never in the entry — `records` is the credential id, and Invariant 7
      // would redact the column regardless.
      await credentialChanged('apikey.created', userId, {
        model: 'Credential', records: [String(cred.id)],
        actorId: userId, actorType: 'user',
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

    async revokeApiKey(keyId: string, opts: { userId: string }): Promise<void> {
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
      // REQUIRED, not `if (opts?.userId)`. The caller supplies the id, so a
      // delete matching on it alone revokes any key in the system whose id you
      // can guess — the same risk `revokeSession` puts in its signature. It was
      // optional here and three of four call sites omitted it, each safe for a
      // different local reason a fourth caller would have had to rediscover
      // (FJS-990).
      if (!opts?.userId) throw new AuthConfigError('revokeApiKey requires the owner it is scoped to')
      const where: Record<string, unknown> = { id: keyId, type: 'apiKey', userId: opts.userId }
      const { count } = await sys.credential.deleteMany({ where })
      if (!count) throw new InvalidTokenError(`No API key with id ${keyId}`)

      // Every other credential mutation here writes one, and this pair is the
      // one that most needs it: an API key outlives a session, carries its own
      // scopes, and is spent by a machine nobody is watching (FJS-991).
      await credentialChanged('apikey.revoked', opts.userId, {
        model: 'Credential', records: [String(keyId)],
        actorId: opts.userId, actorType: 'user',
      })
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
      if (!cred) throw new ReauthenticationFailedError()
      if (!await verifyPassword(currentPassword, cred.value)) throw new ReauthenticationFailedError()

      await sys.credential.update({
        where: { id: cred.id },
        data:  { value: await hashPassword(newPassword) },
      })

      await credentialChanged('password.changed', userId, {
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
