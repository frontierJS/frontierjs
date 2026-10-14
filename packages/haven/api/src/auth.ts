// api/src/auth.ts
// Who a token is. Haven has no passwords and no email: a machine proves
// itself with a key at the login (`login.ts`), and what it gets back is a
// Session — a Grant row whose token leaves in the login's answer and whose
// digest is all that is stored. Every request and every socket after that is an
// ordinary bearer, so the stock Junction client needs nothing new.
//
// `@frontierjs/auth` is not this: it reads `sys.user` and an email address,
// and a member has neither.

import { BadRequest } from '@frontierjs/junction'
import type { IAuth, SessionContext } from '@frontierjs/junction'
import { fingerprint } from '@frontierjs/toolbelt/bearer'

type Db = { asSystem: () => any, $now?: () => Date }

/** Domain separation for the digest — the trait's column, named once. */
const PURPOSE = 'Session.tokenHash'

const DAY = 86_400_000

export interface HavenAuthOptions {
  /** The app secret the stored digest is keyed on. */
  key:      string
  /** How long a minted session lives. The key re-mints one, so this is short. */
  ttlDays?: number
}

export type HavenAuth = IAuth & {
  /** A session for a member whose key has already verified. The token exists
   *  in this answer and nowhere else. */
  mint (memberId: number): Promise<{ token: string, expiresAt: string }>
}

const notHere = (what: string) => async (): Promise<never> => {
  throw new BadRequest(`The haven has no ${what}. A machine signs in with its key: POST /haven/login.`)
}

export function createHavenAuth (db: Db, opts: HavenAuthOptions): HavenAuth {
  // Refused here rather than on the first login: an unkeyed digest can be
  // attacked offline the moment the column leaks.
  if (!opts.key) throw new Error('createHavenAuth: `key` is required — the secret a session token is digested under (HAVEN_SESSION_KEY).')
  const sys    = () => db.asSystem()
  const now    = () => db.$now?.() ?? new Date()
  const ttl    = (opts.ttlDays ?? 30) * DAY
  const digest = (token: string) => fingerprint(token, { key: opts.key, purpose: PURPOSE })

  // No `role`: the ladder ranks a role's presence, and a member is CREATOR(3)
  // until the standing read off the row per call (`principal.ts`) says `mod`.
  const sessionOf = (memberId: number | string, extra: Partial<SessionContext> = {}): SessionContext => ({
    userId:     String(memberId),
    userType:   'user',
    scopes:     [],
    authMethod: 'session',
    ...extra,
  })

  return {
    async mint (memberId) {
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
      const expiresAt = new Date(now().getTime() + ttl).toISOString()
      await sys().session.create({ data: { memberId, tokenHash: await digest(token), expiresAt } })
      return { token, expiresAt }
    },

    async verifySession (token) {
      if (!token) return null
      const row = await sys().session.findFirst({
        where:  { tokenHash: await digest(token) },
        select: { id: true, memberId: true, expiresAt: true, revokedAt: true },
      })
      if (!row || row.revokedAt != null || new Date(row.expiresAt).getTime() <= now().getTime()) return null
      return sessionOf(row.memberId, { sessionId: String(row.id) })
    },

    async logout (token) {
      await sys().session.updateMany({
        where: { tokenHash: await digest(token), revokedAt: null },
        data:  { revokedAt: now().toISOString() },
      })
    },

    async sessionFor (userId) {
      const member = await sys().member.findFirst({ where: { id: Number(userId) }, select: { id: true } })
      return member ? sessionOf(member.id) : null
    },

    // Asked by the transport after `verifySession` answers null, so it answers
    // null rather than refusing: a dead session is not a request for a key.
    async verifyApiKey () { return null },

    login:        notHere('passwords'),
    createUser:   notHere('sign-up form'),
    deleteUser:   notHere('account deletion'),
    createApiKey: notHere('API keys'),
    revokeApiKey: notHere('API keys'),
  }
}
