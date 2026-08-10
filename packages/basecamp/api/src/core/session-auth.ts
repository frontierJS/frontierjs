// src/core/session-auth.ts
// Basecamp's own User columns, projected onto the session — and the one place
// a suspended principal is refused.
//
// @frontierjs/auth owns `model User`; this app adds four columns to it
// (`kind`, `status`, `isSystemAdmin`, `scopes`) and two of them decide what a
// request may do. Getting them onto the SessionContext is what
// `sessionFields` is for: auth calls it with the user row it already fetched,
// so this costs no query on the hot path. The alternative — wrapping
// verifySession and re-reading the user — is a third round trip on every
// authenticated request, forever.
//
// ─── Suspension has two doors and they are not the same door ───────────────
//
// A suspended user must not be able to sign in, and a user suspended DURING a
// session must stop being able to act. Those are different code paths:
//
//   login          → refused here, by wrapping it. Cold path, one extra read,
//                    and the caller gets a sentence rather than a 401 they
//                    would read as a wrong password.
//   an issued token → refused by refuseSuspended() below, an app-level before
//                    hook. It reads `status` off the session sessionFields put
//                    there, so it costs nothing and covers every service,
//                    every method, both transports.
//
// Revoking the Session rows instead would close the second door too, but only
// for tokens that exist at the moment of suspension — an API key is a
// Credential, not a Session, and would keep working. One rule at the door
// beats two cleanup passes.

import { Forbidden } from '@frontierjs/junction'
import type { IAuth, ServiceContext, Hook } from '@frontierjs/junction'

/** What this app puts on a session beyond what auth issues. */
export interface BasecampSession {
  userId?:        string
  status?:        string
  kind?:          string
  isSystemAdmin?: boolean
}

/**
 * The User columns that belong on a session.
 *
 * `isSystemAdmin` is not an app-private key — it is the standing
 * sessionGateLevel() grades SYSADMIN(7) on, so declaring it here is what makes
 * the hub tier reachable from @@gate when FJS-007 lands rather than only from
 * this app's hooks.
 */
export function basecampSessionFields(user: Record<string, any>): Record<string, unknown> {
  return {
    isSystemAdmin: user.isSystemAdmin === true,
    // Basecamp's own, deliberately under its own name rather than squeezed
    // into `activatedAt`. A suspended user is not an unactivated one, and a
    // hook reading `status === 'suspended'` says what it means at the site.
    status:        user.status,
    kind:          user.kind,
  }
}

/**
 * Wrap login so a suspended account cannot open a new session.
 *
 * Spread, not a subclass: createLitestoneAuth returns a plain object literal
 * of closures, so every method not named here passes through unchanged — and
 * `_sessionTtl`, which createAuthPlugin reads off the instance, travels with
 * it. A wrapper that rebuilt the object by hand would drop it and the cookie
 * maxAge would silently fall back to auth's own default.
 */
export function refuseSuspendedLogin(auth: IAuth & { _sessionTtl: string }, db: any) {
  const sys = db.asSystem()

  return {
    ...auth,
    async login(email: string, password: string) {
      // AFTER the password check, never before. Refusing on the email alone
      // tells anyone who asks which addresses are suspended accounts here,
      // which is the same disclosure auth's own InvalidCredentialsError is
      // careful not to make.
      const result = await auth.login(email, password)

      const user = await sys.user.findUnique({ where: { id: result.user.userId } })
      if (user?.status === 'suspended') {
        // The session row was already written by auth.login. Delete it rather
        // than leave a valid token nobody was handed — logout takes the token,
        // which is the one thing we have.
        await auth.logout(result.token)
        throw new Forbidden('This account is suspended. Ask a system administrator to restore it.')
      }

      return result
    },
  } as IAuth & { _sessionTtl: string }
}

/**
 * App-level before hook: a suspended principal acts on nothing.
 *
 * Registered under `before: { all: [...] }` in app.ts, so it covers every
 * service and every method including the agent endpoints — which is correct:
 * an API key belonging to a suspended user is exactly the token that should
 * stop working.
 *
 * An unauthenticated request passes through. Deciding whether anonymity is
 * allowed belongs to each service's own sessionScope, and refusing here would
 * turn every public 401 into a 403.
 */
export function refuseSuspended(): Hook {
  return (ctx: ServiceContext): void => {
    const user = ctx.auth?.user as BasecampSession | undefined
    if (!user) return
    if (user.status === 'suspended')
      throw new Forbidden('This account is suspended.')
  }
}
