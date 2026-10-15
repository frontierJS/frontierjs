// api/src/login.ts
// POST /haven/login — a machine signs `{ publicKey, nick? }` with its private
// key, and answers a session token. The first login with a key makes the
// member; every later one is that member again, which is the whole of the
// identity: a member is the same person tomorrow because the key is.
//
// Verified here, by toolbelt's verifyRequest, and not through the app's
// `credentials` door: that door turns a signature into a principal, and an
// unknown key is no principal yet. The answer here is a token, not a caller.

import { verifyRequest } from '@frontierjs/toolbelt/signature'
import type { TransportContext } from '@frontierjs/junction'

import type { HavenAuth } from './auth.ts'
import { isVoice } from './keyless.ts'

export const LOGIN_PATH = '/haven/login'

/** Seconds a signature stays fresh. */
const WINDOW = 300

type Db = { asSystem: () => any }

export interface LoginOptions {
  /** Seconds, the receiver's clock. Injectable for tests. */
  now?:  () => number
  /** The nicks that are mods. Applied at every login, both ways. */
  mods?: string[]
  /** Observer: told a member's nick once, at the login that made them, and
   *  awaited, so the line is in the room before the member's client loads it. */
  welcome?: (nick: string) => Promise<void> | void
}

export function loginRoute (db: Db, auth: HavenAuth, opts: LoginOptions = {}) {
  const now  = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const mods = new Set((opts.mods ?? []).map(n => n.trim().toLowerCase()))

  // Without it a captured login replays for the whole window and the replayer
  // is handed a fresh session for somebody else's key. TWICE the window, since
  // a timestamp accepted at the limit ahead of this clock stays fresh for
  // another full window (FJS-1833); insertion order is expiry order.
  const seen = new Map<string, number>()
  const seenNonce = (publicKey: string) => (nonce: string): boolean => {
    const t = now()
    for (const [k, until] of seen) { if (until > t) break; seen.delete(k) }
    const id = `${publicKey}\n${nonce}`
    if (seen.has(id)) return true
    seen.set(id, t + 2 * WINDOW)
    return false
  }

  return async (ctx: TransportContext): Promise<Response> => {
    const body = (ctx.body ?? {}) as { publicKey?: unknown, nick?: unknown }
    const publicKey = typeof body.publicKey === 'string' && body.publicKey ? body.publicKey : null
    if (!publicKey) return ctx.json({ message: 'A login is { publicKey, nick }, signed with that key.' }, 400)

    // The key in the body is the key that must have signed it, so a login
    // naming somebody else's key verifies under nothing it holds. No query is
    // signed: the route reads none.
    const verdict = await verifyRequest({
      publicKey, method: ctx.method, path: ctx.path, body: ctx.rawBody ?? '',
      headers: ctx.headers, toleranceSeconds: WINDOW, now: now(), seenNonce: seenNonce(publicKey),
    })
    if (!verdict.ok) return ctx.json({ message: `The login signature does not verify: ${verdict.reason}.` }, 401)

    const sys = db.asSystem()
    let member = await sys.member.findFirst({ where: { publicKey }, select: { id: true, nick: true, role: true } })
    if (!member) {
      if (typeof body.nick !== 'string' || !body.nick) return ctx.json({ message: 'A first login names the nick this key will walk in as.' }, 400)
      const nick  = body.nick.trim().toLowerCase()
      const taken = isVoice(nick) || await sys.member.findFirst({ where: { nick }, select: { id: true } })
      if (taken) return ctx.json({ message: `The nick '${body.nick}' is taken. Choose another.` }, 409)
      member = await sys.member.create({ data: { nick: body.nick, publicKey }, select: { id: true, nick: true, role: true } })
      await opts.welcome?.(member.nick)
    }

    // The standing is the list's, applied on every login so a nick struck from
    // it is a member again on their next run. A nick is held by its member
    // (`@unique`), so the list names a person once they have walked in.
    const role = mods.has(member.nick) ? 'mod' : null
    if (member.role !== role) await sys.member.update({ where: { id: member.id }, data: { role } })

    // A banned member is minted a session like anyone: the ban is a policy, so
    // they walk into an empty Haven rather than being told when to make a key.
    const { token, expiresAt } = await auth.mint(member.id)
    return ctx.json({ token, expiresAt, member: { id: member.id, nick: member.nick, role } }, 200)
  }
}
