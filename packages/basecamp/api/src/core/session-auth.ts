// src/core/session-auth.ts
// Basecamp's own User columns, projected onto the session — and the one place
// a suspended principal is refused.
//
// @frontierjs/auth owns `model User`; this app adds `status` and
// `isSystemAdmin` to it, and both decide what a request may do. Getting them onto the SessionContext is what
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
    // The fleet Account a workspace is created under. Not the tenant —
    // workspaceId is, through a membership — so auth does not put it here.
    accountId:     user.accountId != null ? String(user.accountId) : undefined,
  }
}

/**
 * Wrap login so a suspended account cannot open a new session.
 *
 * Spread, not a subclass: createLitestoneAuth returns a plain object literal
 * of closures, so every method not named here passes through unchanged — and
 * `_sessionTtl`, which auth reads off the instance, travels with
 * it. A wrapper that rebuilt the object by hand would drop it and the cookie
 * maxAge would silently fall back to auth's own default.
 */
export function refuseSuspendedLogin(auth: IAuth & { _sessionTtl: string }, db: any) {
  const sys = db.asSystem()

  /**
   * The check, applied wherever a session comes out.
   *
   * Both steps of a login end here, which is the whole reason it is a function:
   * a second factor means `login()` can answer a ticket instead of a session
   * (`FJS-D261`), and a suspension checked only on the password step would let a
   * suspended account with an authenticator straight through.
   */
  async function refuseIfSuspended<T extends { token: string; user: { id: string } }>(result: T): Promise<T> {
    const user = await sys.user.findUnique({ where: { id: result.user.id } })
    if (user?.status === 'suspended') {
      // The session row was already written. Delete it rather than leave a valid
      // token nobody was handed — logout takes the token, which is the one thing
      // we have.
      await auth.logout(result.token)
      throw new Forbidden('This account is suspended. Ask a system administrator to restore it.')
    }
    return result
  }

  return {
    ...auth,
    async login(email: string, password: string) {
      // AFTER the password check, never before. Refusing on the email alone
      // tells anyone who asks which addresses are suspended accounts here,
      // which is the same disclosure auth's own InvalidCredentialsError is
      // careful not to make.
      const result = await auth.login(email, password)

      // A half-finished login carries no session to refuse yet, and nothing is
      // disclosed by letting it through: the ticket is worth nothing without a
      // code, and the step that redeems it runs the same check.
      if ('challenge' in result) return result

      return refuseIfSuspended(result)
    },

    // Present only if the provider has it, because `IAuth.completeLogin` is
    // optional and spreading an absent method would define the key as undefined
    // — which reads as *implemented* to every `auth.completeLogin ?` check.
    ...(auth.completeLogin ? {
      async completeLogin(challenge: string, code: string) {
        return refuseIfSuspended(await auth.completeLogin!(challenge, code))
      },
    } : {}),
  } as IAuth & { _sessionTtl: string }
}

/**
 * The installation's three policy switches, as the row says or as its defaults
 * say when no row was ever saved. Takes a SYSTEM client: the answer decides what
 * the caller may do, so it cannot be read through a client that caller scoped.
 */
export async function hubPolicy(sys: any): Promise<{ requireTwoFactorForOwners: boolean; allowApiKeyAuth: boolean; allowBotUsers: boolean }> {
  const row = await sys.hubConfig.findFirst({
    where:  { id: 'hub' },
    select: { requireTwoFactorForOwners: true, allowApiKeyAuth: true, allowBotUsers: true },
  })
  return {
    requireTwoFactorForOwners: row?.requireTwoFactorForOwners ?? false,
    allowApiKeyAuth:           row?.allowApiKeyAuth ?? true,
    allowBotUsers:             row?.allowBotUsers ?? true,
  }
}

/**
 * auth's `requireSecondFactor` predicate: an owner of any workspace owes a
 * second factor while `HubConfig.requireTwoFactorForOwners` is on.
 *
 * Auth asks only about an account with no confirmed factor, and what it does
 * with a yes is HOLD the session to enrollment, not refuse it. A refusal at
 * login would lock out every owner without an authenticator the moment a
 * sysadmin flipped the switch, with no way left to set one up.
 */
export function ownerOwesSecondFactor(db: any) {
  return async function ownerOwesSecondFactor(user: Record<string, any>): Promise<boolean> {
    const sys = db.asSystem()
    if (!(await hubPolicy(sys)).requireTwoFactorForOwners) return false
    return sys.workspaceMember.exists({
      where: { userId: user.id, role: 'owner', acceptedAt: { not: null } },
    })
  }
}

/**
 * auth's `onRegistered`: Basecamp is invitation-only (`FJS-032`), so an account
 * is made by `/setup` before anyone is active, or for an address a live
 * invitation names. auth mounts `POST /auth/register` for every app, and
 * without this anyone who found the box could make a user and hold an address
 * before its owner was invited (`FJS-3685`).
 *
 * The hook runs on every door that makes a row, so a provider sign-in or a
 * magic link is held to the same list as the register route.
 */
export async function refuseUninvited({ user, db }: { user: Record<string, any>; db: any }): Promise<void> {
  if (await db.user.count({ where: { status: 'active' } }) === 0) return
  const invited = await db.invitation.exists({
    where: { email: String(user.email).toLowerCase(), expiresAt: { gt: new Date().toISOString() } },
  })
  if (!invited) throw new Forbidden('Basecamp accounts are made by invitation — ask a workspace admin for one')
}

/**
 * App-level before hook: a suspended principal acts on nothing.
 *
 * Registered under `before: { all: [...] }` in app.ts, so it covers every
 * service and every method including the outpost endpoints — which is correct:
 * an API key belonging to a suspended user is exactly the token that should
 * stop working.
 *
 * An unauthenticated request passes through. Deciding whether anonymity is
 * allowed belongs to each service's own sessionScope, and refusing here would
 * turn every public 401 into a 403.
 */
export function refuseSuspended(): Hook {
  return function refuseSuspended(ctx: ServiceContext): void {
    const user = ctx.user as BasecampSession | undefined
    if (!user) return
    if (user.status === 'suspended')
      throw new Forbidden('This account is suspended.')
  }
}
