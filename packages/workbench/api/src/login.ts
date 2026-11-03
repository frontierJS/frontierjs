// api/src/login.ts
// POST /door/login -- the pass-phrase (`WORKBENCH_KEY`) in, a session token
// out. The member is the one person whose machine this is; the row is made at
// the first login. The comparison is constant-time and a refusal says nothing
// about which half was wrong.

import { timingSafeEqual } from 'node:crypto'
import type { TransportContext } from '@frontierjs/junction'

import type { WorkbenchAuth } from './auth.ts'

type Db = { asSystem: () => any }

/** The one member's nick. */
export const OWNER = 'owner'

export const LOGIN_PATH = '/door/login'

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function loginRoute (db: Db, auth: WorkbenchAuth, opts: { key: string }) {
  return async (ctx: TransportContext): Promise<Response> => {
    const body = (ctx.body ?? {}) as { key?: unknown }
    if (typeof body.key !== 'string' || !body.key) return ctx.json({ message: 'A login is { key }, the pass-phrase in WORKBENCH_KEY.' }, 400)
    if (!same(body.key, opts.key)) return ctx.json({ message: 'That is not this machine\'s key.' }, 401)

    const sys = db.asSystem()
    const member = await sys.member.findFirst({ where: { nick: OWNER }, select: { id: true, nick: true } })
      ?? await sys.member.create({ data: { nick: OWNER }, select: { id: true, nick: true } })

    const { token, expiresAt } = await auth.mint(member.id)
    return ctx.json({ token, expiresAt, member }, 200)
  }
}

export const ME_PATH     = '/door/me'
export const LOGOUT_PATH = '/door/logout'

/** GET /door/me -- who the bearer is, or 401. The page's restore on a reload. */
export function meRoute (db: Db) {
  return async (ctx: TransportContext): Promise<Response> => {
    if (!ctx.user) return ctx.json({ message: 'Not signed in.' }, 401)
    const member = await db.asSystem().member.findFirst({ where: { id: Number(ctx.user.id) }, select: { id: true, nick: true } })
    return member ? ctx.json(member, 200) : ctx.json({ message: 'Not signed in.' }, 401)
  }
}

/** POST /door/logout -- revokes the bearer's session. */
export function logoutRoute (auth: WorkbenchAuth) {
  return async (ctx: TransportContext): Promise<Response> => {
    const token = /^Bearer (.+)$/i.exec(ctx.headers.authorization ?? '')?.[1]
    if (token) await auth.logout(token)
    return ctx.json({ revoked: !!token }, 200)
  }
}
