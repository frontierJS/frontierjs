// api/src/auth.ts
// Who a token is. Workbench has no passwords and no email: the door
// (`login.ts`) takes the machine's pass-phrase and answers a Session -- a Grant
// row whose token leaves in the login's answer and whose digest is all that is
// stored. Every request and every socket after that is an ordinary bearer.
//
// `@frontierjs/auth` is not this (`FJS-D1786`): it reads `sys.user` and an
// email address, and a member has neither.

import { BadRequest } from '@frontierjs/junction'
import type { IAuth, SessionContext } from '@frontierjs/junction'
import { fingerprint } from '@frontierjs/toolbelt/bearer'

type Db = { asSystem: () => any, $now?: () => Date }

/** Domain separation for the digest -- the trait's column, named once. */
const PURPOSE = 'Session.tokenHash'

const DAY = 86_400_000

export interface WorkbenchAuthOptions {
  /** The app secret the stored digest is keyed on. */
  key:      string
  /** How long a minted session lives. The pass-phrase re-mints one. */
  ttlDays?: number
}

export type WorkbenchAuth = IAuth & {
  /** A session for a member whose pass-phrase has already verified. The token
   *  exists in this answer and nowhere else. */
  mint (memberId: number): Promise<{ token: string, expiresAt: string }>
}

const notHere = (what: string) => async (): Promise<never> => {
  throw new BadRequest(`Workbench has no ${what}. Sign in at the door: POST /door/login.`)
}

/** Delete every session past its `expiresAt`, answering how many. */
export async function sweepSessions (db: Db, now: Date = db.$now?.() ?? new Date()): Promise<number> {
  const { count } = await db.asSystem().session.deleteMany({ where: { expiresAt: { lt: now.toISOString() } } })
  return count
}

export function createWorkbenchAuth (db: Db, opts: WorkbenchAuthOptions): WorkbenchAuth {
  // Refused here rather than on the first login: an unkeyed digest can be
  // attacked offline the moment the column leaks.
  if (!opts.key) throw new Error('createWorkbenchAuth: `key` is required -- the secret a session token is digested under (WORKBENCH_KEY).')
  const sys    = () => db.asSystem()
  const now    = () => db.$now?.() ?? new Date()
  const ttl    = (opts.ttlDays ?? 30) * DAY
  const digest = (token: string) => fingerprint(token, { key: opts.key, purpose: PURPOSE })

  // The one member is the machine's owner and grades ADMINISTRATOR (5): the
  // screens that move in from basecamp keep their `@@gate(5.8)` lines, and a
  // plain signed-in CREATOR (3) would be refused by every one of them.
  const sessionOf = (memberId: number | string, extra: Partial<SessionContext> = {}): SessionContext => ({
    id:         String(memberId),
    userType:   'user',
    scopes:     [],
    authMethod: 'session',
    isAdmin:    true,
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
