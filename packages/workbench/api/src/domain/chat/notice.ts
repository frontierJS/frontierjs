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

export interface QuietWindow {
  enabled:    boolean
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
  if (!w?.enabled || !Array.isArray(w.days) || w.days.length === 0) return false
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

    const owner    = await sys.member.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })
    const author   = await sys.profile.findUnique({ where: { externalId: post.profileExternalId }, select: { username: true, nickname: true } })
    const schedule = await sys.quietSchedule.findFirst({ where: { profileExternalId: profile } })
    const payload = {
      postExternalId:    post.externalId,
      channelExternalId: post.channelExternalId,
      author:            author?.nickname || author?.username || 'Someone',
      room:              room.name,
      excerpt:           noticeExcerpt(String(room.type), post.message ?? ''),
      link:              `/messages/${post.channelExternalId}/${post.rootExternalId ? `?thread=${post.rootExternalId}` : ''}`,
      held:              inQuietHours(schedule, now),
      phone:             owner?.id === id,
    }
    // The machine's one ntfy topic is the owner's phone: another member's ping would land on
    // the owner's lock screen, and a push with no topic fails the whole notify.
    const recipient = { id, pushTopic: (app as any).push?.topic }
    await (app as any).notify(recipient, kind === 'dm' ? chatDm(payload) : chatMention(payload))
  } catch (err) {
    app.logger?.warn?.(`chat notice for post ${post.externalId} not raised: ${(err as Error)?.message ?? err}`)
  }
}
