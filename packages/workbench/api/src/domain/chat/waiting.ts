// api/src/domain/chat/waiting.ts -- who owes whom a reply, read from the mirror
// (`IDEAS/workbench-messages.md` 6.1, 6.2). Every function takes the client
// to read with: the screen's passes the caller's own, so Post's and Channel's
// policies apply, and the follow-up job's passes the system's.
//
// "Answered" has one owner here, `answeredSince`, and the waiting-on-others
// list and the follow-up job both ask it. "Is this post for the member" has
// one too, `noticeKind` in notice.ts, which the bell asks as well.

import { noticeKind } from './notice.ts'

/** How far back a post still counts as waiting: an older one is history, and an open room's mentions would otherwise be read whole. */
export const WAITING_DAYS = 30
const POSTS_MAX = 2000
const ROWS_MAX  = 200

const isDirect = (type: unknown) => type === 'direct' || type === 'group'
const at = (v: unknown): number => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : NaN }

export interface WaitingPost {
  externalId:        string
  channelExternalId: string
  profileExternalId: string
  rootExternalId?:   string | null
  createdAt?:        string | null
}

/**
 * Whether someone else posted after `post` in its conversation: in a direct or
 * group room that is the room, anywhere, and elsewhere it is the thread the
 * post belongs to (its own, for a root). A deleted answer is no answer. A post
 * with no time has nothing to be after, so it reads as unanswered.
 */
export async function answeredSince (db: any, post: WaitingPost, roomType: unknown): Promise<boolean> {
  if (!post.createdAt) return false
  const where: Record<string, unknown> = { channelExternalId: post.channelExternalId, profileExternalId: { not: post.profileExternalId }, deletedAt: null, createdAt: { gt: post.createdAt } }
  if (!isDirect(roomType)) where.rootExternalId = post.rootExternalId ?? post.externalId
  return !!(await db.post.findFirst({ where, select: { id: true } }))
}

export interface Waiting {
  /** Posts to the member, oldest first. */
  onMe:     string[]
  /** The member's own last post in a DM or thread nobody has answered, oldest first, with the reminder pending on it. */
  onOthers: { postExternalId: string, followUpId: number | null, remindAt: string | null }[]
}

export async function waiting (db: any, me: string, now = new Date()): Promise<Waiting> {
  const since = new Date(now.getTime() - WAITING_DAYS * 86_400_000).toISOString()
  const memberships = await db.channelMember.findMany({ where: { profileExternalId: me }, select: { channelExternalId: true, muted: true } })
  const mutedIn = new Map<string, boolean>(memberships.map((m: any) => [m.channelExternalId, !!m.muted]))
  if (!mutedIn.size) return { onMe: [], onOthers: [] }
  const rooms = await db.channel.findMany({ where: { externalId: { in: [...mutedIn.keys()] }, deletedAt: null }, select: { externalId: true, type: true } })
  const typeOf = new Map<string, string>(rooms.map((r: any) => [r.externalId, String(r.type)]))
  const direct = rooms.filter((r: any) => isDirect(r.type)).map((r: any) => r.externalId)
  const other  = rooms.filter((r: any) => !isDirect(r.type)).map((r: any) => r.externalId)

  const mine: WaitingPost[] = await db.post.findMany({
    where: { channelExternalId: { in: rooms.map((r: any) => r.externalId) }, profileExternalId: me, deletedAt: null, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' }, limit: POSTS_MAX,
  })
  return { onMe: await onMe(db, me, mine, direct, other, typeOf, mutedIn, since), onOthers: await onOthers(db, me, mine, typeOf) }
}

async function onMe (db: any, me: string, mine: WaitingPost[], direct: string[], other: string[], typeOf: Map<string, string>, mutedIn: Map<string, boolean>, since: string): Promise<string[]> {
  // The latest own post per room and per thread: a candidate is answered by one after it.
  const lastIn = new Map<string, number>(), lastOn = new Map<string, number>()
  for (const p of mine) {
    const t = at(p.createdAt)
    lastIn.set(p.channelExternalId, Math.max(t, lastIn.get(p.channelExternalId) ?? -Infinity))
    if (p.rootExternalId) lastOn.set(p.rootExternalId, Math.max(t, lastOn.get(p.rootExternalId) ?? -Infinity))
  }

  const base = { profileExternalId: { not: me }, deletedAt: null, createdAt: { gte: since } }
  const candidates: any[] = [
    ...(direct.length ? await db.post.findMany({ where: { ...base, channelExternalId: { in: direct } }, orderBy: { createdAt: 'asc' }, limit: POSTS_MAX }) : []),
    ...(other.length ? await db.post.findMany({ where: { ...base, channelExternalId: { in: other }, message: { contains: '@' } }, orderBy: { createdAt: 'asc' }, limit: POSTS_MAX }) : []),
  ]
  const username = (await db.profile.findUnique({ where: { externalId: me }, select: { username: true } }))?.username ?? ''

  const out: any[] = []
  for (const p of candidates) {
    const kind = noticeKind({ author: p.profileExternalId, member: me, username, roomType: typeOf.get(p.channelExternalId) ?? '', muted: !!mutedIn.get(p.channelExternalId), message: p.message ?? '' })
    if (!kind) continue
    const reply = (p.rootExternalId ? lastOn.get(p.rootExternalId) : lastIn.get(p.channelExternalId)) ?? -Infinity
    if (reply > at(p.createdAt)) continue
    out.push(p)
  }
  return out.sort((a, b) => at(a.createdAt) - at(b.createdAt)).slice(0, ROWS_MAX).map(p => p.externalId)
}

async function onOthers (db: any, me: string, mine: WaitingPost[], typeOf: Map<string, string>): Promise<Waiting['onOthers']> {
  const pending: any[] = await db.followUp.findMany({ where: { status: 'pending' } })
  const reminder = new Map<string, any>(pending.map(f => [f.postExternalId, f]))

  // One row per conversation, its latest post; `mine` is newest first. An open room's root with no
  // reply is a message to the room and not a thread, so it is listed only when a reminder is on it.
  const seen = new Set<string>(), units: WaitingPost[] = []
  for (const p of mine) {
    const unit = isDirect(typeOf.get(p.channelExternalId)) ? `c:${p.channelExternalId}` : p.rootExternalId ? `t:${p.rootExternalId}` : reminder.has(p.externalId) ? `p:${p.externalId}` : null
    if (!unit || seen.has(unit)) continue
    seen.add(unit)
    units.push(p)
  }
  const out: Waiting['onOthers'] = []
  for (const p of units.slice(0, ROWS_MAX)) {
    if (await answeredSince(db, p, typeOf.get(p.channelExternalId))) continue
    const f = reminder.get(p.externalId)
    out.push({ postExternalId: p.externalId, followUpId: f?.id ?? null, remindAt: f?.remindAt ?? null })
  }
  return out.reverse()
}
