// api/src/domain/chat/notice.ts -- whether a live post reaches the member as a
// bell row and a phone ping (`IDEAS/workbench-messages.md` 4.1).
//
// Only the owner (the first Member, as `sendReport` reads it) is pinged on the phone.
//
// Called from the socket's `posted` frame only: a backfill, a search, a saved
// list or a history read lands posts the member was never pinged for, and
// pinging them then would be a flood of old news on every reconnect. The API
// cannot see which room a tab has open, so a post in the room the member is
// reading still rings the bell.

import type { App } from '@frontierjs/junction'
import chatDm from '../../notifications/ChatDm.notification.ts'
import chatMention from '../../notifications/ChatMention.notification.ts'
import chatFollowUp from '../../notifications/ChatFollowUp.notification.ts'
import { notificationChannelName } from '../../core/channels.ts'

export interface QuietWindow {
  isEnabled:  boolean
  /** 0 (Sunday) to 6, the day the window STARTS on. */
  days:       number[]
  fromMinute: number
  toMinute:   number
  timezone:   string
}

/** The weekday and minute past midnight `now` reads as in `timezone`. */
function wallClock (now: Date, timezone: string): { day: number, minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { day, minute: Number(get('hour')) * 60 + Number(get('minute')) }
}

/**
 * Whether `now` falls inside the window. A window whose end is before its
 * start runs past midnight, and its early-morning half belongs to the day
 * before: Friday 22:00 to 07:00 holds Saturday 03:00 but not Sunday 03:00
 * unless Saturday is also a day. Equal ends are a whole day. An unreadable
 * zone holds nothing, so a bad row never silences the phone.
 */
export function inQuietHours (w: QuietWindow | null | undefined, now: Date): boolean {
  if (!w?.isEnabled || !Array.isArray(w.days) || w.days.length === 0) return false
  let clock: { day: number, minute: number }
  try { clock = wallClock(now, w.timezone) } catch { return false }
  if (clock.day < 0) return false
  const { fromMinute: from, toMinute: to } = w
  if (from === to) return w.days.includes(clock.day)
  if (from < to) return w.days.includes(clock.day) && clock.minute >= from && clock.minute < to
  if (clock.minute >= from) return w.days.includes(clock.day)
  if (clock.minute < to) return w.days.includes((clock.day + 6) % 7)
  return false
}

const WIDE = /(^|[^\w@])@(channel|all|here)\b/i
const named = (username: string) => new RegExp(`(^|[^\\w@])@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-]*\\w)`, 'i')

export type NoticeKind = 'dm' | 'mention'

/**
 * Which notice a post owes the member, or none. Their own post owes nothing; a
 * direct or group room owes a DM unless muted; elsewhere `@username` owes a
 * mention even in a muted room, as the server does, and `@channel`, `@all` or
 * `@here` owes one only in a room they have not muted.
 */
export function noticeKind (p: { author: string, member: string, username: string, roomType: string, muted: boolean, message: string }): NoticeKind | null {
  if (p.author === p.member) return null
  if (p.roomType === 'direct' || p.roomType === 'group') return p.muted ? null : 'dm'
  if (p.username && named(p.username).test(p.message)) return 'mention'
  if (!p.muted && WIDE.test(p.message)) return 'mention'
  return null
}

/** Plain text for a bell line and a lock screen: markdown marks dropped, one line, at most `max` characters. */
export function excerpt (message: string, max = 140): string {
  const plain = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

/**
 * What of the post a notification row may hold. The row lives in the main
 * database and on the phone's lock screen, so a private room's or a DM's text
 * stays out; the title still says who and where.
 */
export function noticeExcerpt (roomType: string, message: string): string {
  return roomType === 'open' ? excerpt(message) : ''
}

/** (member, post) pairs already raised in this process: two sockets' frames can race the row check below. */
const raised = new Set<string>()
const RAISED_MAX = 5000
function firstRaise (key: string): boolean {
  if (raised.has(key)) return false
  if (raised.size >= RAISED_MAX) raised.delete(raised.values().next().value as string)
  raised.add(key)
  return true
}

/** `/messages/<channel>/`, with `?thread=<root>` for a reply. */
export const postLink = (p: { channelExternalId: string, rootExternalId?: string | null }) =>
  `/messages/${p.channelExternalId}/${p.rootExternalId ? `?thread=${p.rootExternalId}` : ''}`

/**
 * How a bell row reaches this member, the same for every kind of chat notice:
 * `held` is quiet hours (the row is written and the push is not sent), and
 * `phone` is whether they own the machine's one ntfy topic. Another member's
 * ping would land on the owner's lock screen, and a push with no topic fails
 * the whole notify, so the recipient carries the topic only when it is theirs.
 */
async function deliveryOf (app: App, sys: any, memberId: number, profile: string, now: Date) {
  const owner    = await sys.member.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })
  const schedule = await sys.quietSchedule.findFirst({ where: { profileExternalId: profile } })
  return {
    held:      inQuietHours(schedule, now),
    phone:     owner?.id === memberId,
    recipient: { id: memberId, pushTopic: (app as any).push?.topic },
  }
}

export interface LivePost {
  externalId:        string
  channelExternalId: string
  profileExternalId: string
  rootExternalId?:   string | null
  message:           string
}

/**
 * Raise the member's notice for a post that just arrived on their socket.
 * Never throws: a failed ping must not stop the frame landing, and the bell
 * row is written before the push leaves, so a push failure leaves the row.
 */
export async function raiseChatNotice (app: App, sys: any, memberId: string, profile: string, post: LivePost, now = new Date()): Promise<void> {
  try {
    if (post.profileExternalId === profile) return
    const room   = await sys.channel.findUnique({ where: { externalId: post.channelExternalId }, select: { type: true, name: true, displayName: true } })
    const member = await sys.channelMember.findFirst({ where: { channelExternalId: post.channelExternalId, profileExternalId: profile }, select: { muted: true } })
    if (!room || !member) return
    const me     = await sys.profile.findUnique({ where: { externalId: profile }, select: { username: true } })
    const kind = noticeKind({ author: post.profileExternalId, member: profile, username: me?.username ?? '', roomType: String(room.type), muted: !!member.muted, message: post.message ?? '' })
    if (!kind) return

    const key = `chat:${post.externalId}`
    const id  = Number(memberId)
    if (!firstRaise(`${id}:${key}`)) return
    if (await sys.notification.findFirst({ where: { userId: id, deliveryKey: key }, select: { id: true } })) return

    const author   = await sys.profile.findUnique({ where: { externalId: post.profileExternalId }, select: { username: true, nickname: true } })
    const { held, phone, recipient } = await deliveryOf(app, sys, id, profile, now)
    const payload = {
      postExternalId:    post.externalId,
      channelExternalId: post.channelExternalId,
      author:            author?.nickname || author?.username || 'Someone',
      room:              room.name,
      excerpt:           noticeExcerpt(String(room.type), post.message ?? ''),
      link:              postLink(post),
      held,
      phone,
    }
    await (app as any).notify(recipient, kind === 'dm' ? chatDm(payload) : chatMention(payload))
  } catch (err) {
    app.logger?.warn?.(`chat notice for post ${post.externalId} not raised: ${(err as Error)?.message ?? err}`)
  }
}

/**
 * Raise the bell row for a follow-up whose post nobody has answered. Never
 * throws, and the row's key is the follow-up's own, so a pass that runs twice
 * writes one. A DM's or private room's text stays out of the row, as in `noticeExcerpt`.
 */
export async function raiseFollowUp (app: App, sys: any, followUpId: number, memberId: number, profile: string, post: LivePost, now = new Date()): Promise<void> {
  try {
    const room = await sys.channel.findUnique({ where: { externalId: post.channelExternalId }, select: { type: true, name: true } })
    if (!room) return
    const key = `followup:${followUpId}`
    if (await sys.notification.findFirst({ where: { userId: memberId, deliveryKey: key }, select: { id: true } })) return
    const direct = room.type === 'direct' || room.type === 'group'
    const { held, phone, recipient } = await deliveryOf(app, sys, memberId, profile, now)
    await (app as any).notify(recipient, chatFollowUp({
      followUpId,
      postExternalId:    post.externalId,
      channelExternalId: post.channelExternalId,
      room:              direct ? '' : room.name,
      excerpt:           noticeExcerpt(String(room.type), post.message ?? ''),
      link:              postLink(post),
      held,
      phone,
    }))
  } catch (err) {
    app.logger?.warn?.(`follow-up ${followUpId} for post ${post.externalId} not raised: ${(err as Error)?.message ?? err}`)
  }
}

/** The bell rows a read of their room answers; a follow-up is a reminder and stays until opened. */
const READ_BY_ROOM = ['ChatDm', 'ChatMention']

/**
 * Which of a member's unread chat notices a read covers: the row's room was
 * read at or after its post was written. The row itself is written after the
 * post arrives, so its own time can trail a watermark that already holds the
 * post; `postAt` is the post's time, and a post not in the copy falls back to
 * the row's. `seen` is room to read time. Pure.
 */
export function noticesRead (rows: Array<{ id: number, type: string, data: unknown, createdAt: string | Date }>, seen: Map<string, Date>, postAt: Map<string, string | Date> = new Map()): number[] {
  return rows.filter((n) => {
    if (!READ_BY_ROOM.includes(n.type)) return false
    const data = (typeof n.data === 'string' ? JSON.parse(n.data) : n.data) as { channelExternalId?: string, postExternalId?: string } | null
    const at = data?.channelExternalId ? seen.get(data.channelExternalId) : undefined
    const written = (data?.postExternalId && postAt.get(data.postExternalId)) || n.createdAt
    return !!at && new Date(written).getTime() <= at.getTime()
  }).map(n => n.id)
}

/**
 * A room read here or in another client reads its bell rows too. Nothing else
 * does, so without this every DM and mention stayed unread on the bell and in
 * the tray's count after the room itself was caught up. Each row goes to the
 * member's tabs as `notifications patched`, the frame the bell's tether merges.
 * Never throws: a failed clear must not stop the read landing.
 */
export async function readChatNotices (app: App, sys: any, memberId: number, seen: Map<string, Date>): Promise<void> {
  if (!seen.size) return
  try {
    const rows = await sys.notification.findMany({ where: { userId: memberId, readAt: null, type: { in: READ_BY_ROOM } }, select: { id: true, type: true, data: true, createdAt: true } })
    const posts = rows.map((n: any) => (typeof n.data === 'string' ? JSON.parse(n.data) : n.data)?.postExternalId).filter(Boolean)
    const landed = posts.length ? await sys.post.findMany({ where: { externalId: { in: posts } }, select: { externalId: true, createdAt: true } }) : []
    const ids = noticesRead(rows, seen, new Map(landed.map((p: any) => [p.externalId, p.createdAt])))
    if (!ids.length) return
    const now = new Date().toISOString()
    const channel = (app as unknown as { channel?: (name: string) => { send: (event: string, data: unknown) => void } }).channel?.(notificationChannelName(String(memberId)))
    for (const id of ids) {
      const row = await sys.notification.update({ where: { id }, data: { readAt: now } })
      channel?.send('notifications patched', row)
    }
  } catch (err) {
    app.logger?.warn?.(`chat notices of member ${memberId} not marked read: ${(err as Error)?.message ?? err}`)
  }
}
