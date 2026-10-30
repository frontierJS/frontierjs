// api/src/login.ts
// POST /haven/login — a Frontier member's machine signs its login with its
// private key, and is answered a session token. The body is
// `{ publicKey, links, row }` (`IDEAS/frontier-network.md` 3.1): `links` is the
// member's chain and must hold the signing key, and `row` is the post's signed
// word on that chain, under `HAVEN_POST_KEY`. The member is the chain's root,
// so every machine in it is one figure, and the nick is the row's: the post
// gave it out, so nobody here races for it. A key in no chain is refused
// (3.2, `FJS-D1477`); a browser walks in on a session `fli haven --browser`
// hands it, and holds no key.
//
// Verified here, by toolbelt's verifyRequest, and not through the app's
// `credentials` door: that door turns a signature into a principal, and an
// unknown key is no principal yet. The answer here is a token, not a caller.

import { verifyRequest } from '@frontierjs/toolbelt/signature'
import { readChain, readRow, rowBindsChain } from '@frontierjs/toolbelt/frontier'
import type { TransportContext } from '@frontierjs/junction'

import type { HavenAuth } from './auth.ts'
import { isVoice } from './keyless.ts'

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
  /** The Frontier post's public signing key, which a chain login's row must be
   *  signed under. Without it a chain login is refused. */
  postKey?: string | null
}

type Member = { id: number, nick: string, role: string | null }
const MEMBER = { id: true, nick: true, role: true }

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

  type Found = { member: Member } | { refused: string, status: number }

  /**
   * A Frontier member: the chain verifies and holds the key that signed, the
   * row is the post's, no older than ROW_AGE (`FJS-D1445`), and names this
   * chain. A revoked machine is in no chain the post signs a row for, so it is
   * refused once the row it holds is a day old.
   */
  const chainMember = async (sys: any, publicKey: string, links: unknown, row: unknown): Promise<Found> => {
    if (!opts.postKey) return { refused: 'This Haven names no Frontier post (HAVEN_POST_KEY), so it takes no Frontier login.', status: 503 }
    const chain = await readChain(links)
    if (!chain.machines || !chain.root) return { refused: `The chain does not verify: ${chain.refused}.`, status: 401 }
    if (!chain.machines.includes(publicKey)) return { refused: 'The key that signed is no machine in this chain.', status: 401 }
    const read = await readRow(row, opts.postKey, now())
    if (!read.row) return { refused: `The member row is refused: ${read.refused}.`, status: 401 }
    const unbound = rowBindsChain(read.row, chain)
    if (unbound) return { refused: `The member row is refused: ${unbound}.`, status: 401 }

    // The row is the nick, written at every login, so the post's word beats a
    // table this haven kept (`FJS-D1451` rules a rename out at the post).
    const nick = read.row.nick
    const member = await sys.member.findFirst({ where: { root: chain.root }, select: MEMBER })
    if (member?.nick === nick) return { member }
    if (isVoice(nick) || await sys.member.findFirst({ where: { nick }, select: { id: true } })) {
      return { refused: `The nick '${nick}' is held here by somebody else.`, status: 409 }
    }
    if (member) return { member: await sys.member.update({ where: { id: member.id }, data: { nick }, select: MEMBER }) }
    return { member: await made(sys, nick, chain.root) }
  }

  const made = async (sys: any, nick: string, root: string): Promise<Member> => {
    const member = await sys.member.create({ data: { nick, root }, select: MEMBER })
    await opts.welcome?.(member.nick)
    return member
  }

  return async (ctx: TransportContext): Promise<Response> => {
    const body = (ctx.body ?? {}) as { publicKey?: unknown, links?: unknown, row?: unknown }
    const publicKey = typeof body.publicKey === 'string' && body.publicKey ? body.publicKey : null
    if (!publicKey) return ctx.json({ message: 'A login is { publicKey, links, row }, signed with that key.' }, 400)

    // The key in the body is the key that must have signed it, so a login
    // naming somebody else's key verifies under nothing it holds. No query is
    // signed: the route reads none.
    const verdict = await verifyRequest({
      publicKey, method: ctx.method, path: ctx.path, body: ctx.rawBody ?? '',
      headers: ctx.headers, toleranceSeconds: WINDOW, now: now(), seenNonce: seenNonce(publicKey),
    })
    if (!verdict.ok) return ctx.json({ message: `The login signature does not verify: ${verdict.reason}.` }, 401)

    if (body.links === undefined) return ctx.json({ message: 'This key is in no Frontier chain, and a haven takes only a member\'s machine: run `fli frontier:stake` or `fli frontier:link` on it.' }, 401)

    const sys = db.asSystem()
    const found = await chainMember(sys, publicKey, body.links, body.row)
    if ('refused' in found) return ctx.json({ message: found.refused }, found.status)
    const member = found.member

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
