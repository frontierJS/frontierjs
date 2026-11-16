// api/src/providers/chat/sync.ts -- how the chat server's rows reach this
// copy, and the ONE place they land. The socket, the backfill and
// chat.connect all call land(); junction's forward lands the answer to a
// member's own write by the same key.
//
// Each linked member holds their own socket and backfill on their own token
// (`FJS-D1153`): the server sends a channel's events to its members only, so a
// private or direct channel reaches this copy through a member or not at all.
// The same post arrives on every member's socket and lands once by its key.
//
// A row whose loss is a loss of ACCESS is deleted when the server drops it
// (`FJS-D1155`): a ChannelMember is what every private channel's read policy
// asks, and a stale one would keep showing a removed person the room. A post
// or a channel keeps the server's own deletedAt tombstone instead.

import type { App } from '@frontierjs/junction'
import {
  getThread, listChannels, listMembers, listPosts, listProfiles, listTeams, listThreads, me, memberKey, postsSince, threadKey,
  type ChannelMemberRow, type PostPage, type PostRow, type SocketEvent, type ThreadRow, type UnreadRow,
} from '@frontierjs/conduit-mattermost'
import { asCaller, sysOf } from './index.ts'

const ACCESSOR = {
  Team: 'team', Profile: 'profile', Channel: 'channel', ChannelMember: 'channelMember',
  Post: 'post', Reaction: 'reaction', FileInfo: 'fileInfo', Thread: 'thread',
} as const
type Landed = keyof typeof ACCESSOR
type Table = {
  findUnique(args: unknown): Promise<Record<string, unknown> | null>
  upsert(args: unknown): Promise<unknown>
  deleteMany(args: unknown): Promise<unknown>
  findMany(args: unknown): Promise<Array<Record<string, unknown>>>
  updateMany(args: unknown): Promise<unknown>
  update(args: unknown): Promise<unknown>
}
const table = (app: App, model: Landed) => (sysOf(app) as Record<string, Table>)[ACCESSOR[model]]

/**
 * Upsert each row by the server's key as the system. A row landing again is
 * back in the server's answer, so its missingSince clears. The key leaves
 * the update half: it is @immutable, and a row it matched already has it.
 */
export async function land(app: App, model: Landed, rows: ReadonlyArray<{ externalId: string }>): Promise<void> {
  const t = table(app, model)
  for (const row of rows) {
    const { externalId, ...rest } = row
    await t.upsert({ where: { externalId }, create: row, update: { ...rest, missingSince: null } })
  }
}

/**
 * Point a post's author's own unclaimed uploads at it, as the server did on
 * taking the post. The socket's `posted` lands the same rows; this lands them
 * on the create's answer, so the sender's room draws them without waiting.
 */
export async function attach(app: App, post: { externalId: string; profileExternalId: string }, fileExternalIds: string[]): Promise<void> {
  if (!fileExternalIds.length) return
  const t = table(app, 'FileInfo')
  const mine = await t.findMany({ where: { externalId: { in: fileExternalIds }, profileExternalId: post.profileExternalId, postExternalId: null }, select: { externalId: true } })
  for (const f of mine) await t.update({ where: { externalId: f.externalId }, data: { postExternalId: post.externalId } })
}

// ─── Read state ────────────────────────────────────────────

const time = (v: unknown) => (v ? new Date(v as string | Date).getTime() : 0)

/**
 * Count a new post in its room's totals, once. The same post reaches every
 * member's socket, and a backfill may have read the room after it was
 * written; a room whose lastPostAt has reached the post has counted it
 * already, so the condition and the increment are one statement and two
 * sockets cannot both count it. Answers whether this call counted it.
 */
async function countPost(app: App, post: PostRow): Promise<boolean> {
  if (!post.createdAt) return false
  const root = !post.rootExternalId
  const r = await table(app, 'Channel').updateMany({
    where: { externalId: post.channelExternalId, OR: [{ lastPostAt: null }, { lastPostAt: { lt: post.createdAt } }] },
    data: {
      totalMessageCount: { increment: 1 }, lastPostAt: post.createdAt,
      ...(root ? { totalMessageCountRoot: { increment: 1 }, lastRootPostAt: post.createdAt } : {}),
    },
  }) as { count?: number } | undefined
  return (r?.count ?? 0) > 0
}

/** (member, post) pairs already counted as a mention here — a redelivered frame counts nothing twice. Bounded: a pair is only ever met within seconds. */
const mentioned = new Set<string>()
const MENTIONED_MAX = 5000
function firstMention(key: string): boolean {
  if (mentioned.has(key)) return false
  if (mentioned.size >= MENTIONED_MAX) mentioned.delete(mentioned.values().next().value as string)
  mentioned.add(key)
  return true
}

/**
 * The socket's own person and a new post: their own has been seen, so their
 * counts reach the room's totals; one that mentions them is one more owed. A
 * membership the server wrote after the post (a backfill landed it) already
 * holds the mention, so it is left as read.
 */
async function countFor(app: App, profile: string, post: PostRow, mentions: string[]): Promise<void> {
  const key = memberKey(post.channelExternalId, profile)
  const member = await table(app, 'ChannelMember').findUnique({ where: { externalId: key } })
  if (!member) return
  if (post.profileExternalId === profile) {
    const room = await table(app, 'Channel').findUnique({ where: { externalId: post.channelExternalId } })
    if (!room) return
    await table(app, 'ChannelMember').update({ where: { externalId: key }, data: { messageCount: room.totalMessageCount, messageCountRoot: room.totalMessageCountRoot } })
    return
  }
  if (!mentions.includes(profile) || !firstMention(`${key}:${post.externalId}`)) return
  if (time(member.updatedAt) >= time(post.createdAt)) return
  await table(app, 'ChannelMember').update({
    where: { externalId: key },
    data: { mentionCount: { increment: 1 }, ...(post.rootExternalId ? {} : { mentionCountRoot: { increment: 1 } }) },
  })
}

/**
 * A person read a room at `at`, here or anywhere: what they have seen reaches
 * the room's totals and nothing mentions them. A read older than the room's
 * newest post is a late one and would wipe a post they have not seen, so it
 * changes nothing.
 */
export async function viewed(app: App, profile: string, channel: string, at: Date): Promise<void> {
  const room = await table(app, 'Channel').findUnique({ where: { externalId: channel } })
  const key = memberKey(channel, profile)
  const member = await table(app, 'ChannelMember').findUnique({ where: { externalId: key } })
  if (!room || !member || time(room.lastPostAt) > at.getTime()) return
  await table(app, 'ChannelMember').update({
    where: { externalId: key },
    data: {
      messageCount: room.totalMessageCount, messageCountRoot: room.totalMessageCountRoot, mentionCount: 0, mentionCountRoot: 0,
      lastViewedAt: new Date(Math.max(time(member.lastViewedAt), at.getTime())),
    },
  })
}

/** Land threads with their roots first, so the Thread's root is a row when it arrives. */
export async function landThreads(app: App, threads: ThreadRow[], roots: PostRow[]): Promise<void> {
  await land(app, 'Post', roots)
  await land(app, 'Thread', threads)
}

/** One person's thread, changed in place, or nothing when it is not a row here yet. */
async function touchThread(app: App, profile: string, root: string, data: Record<string, unknown>): Promise<boolean> {
  const key = threadKey(profile, root)
  const row = await table(app, 'Thread').findUnique({ where: { externalId: key } })
  if (!row) return false
  await table(app, 'Thread').update({ where: { externalId: key }, data })
  return true
}

/**
 * A post pinned or unpinned, here or elsewhere. The server's `post_edited`
 * carries the same flag; this lands the answer to the caller's own call
 * without waiting for it.
 */
export async function landPinned(app: App, post: string, isPinned: boolean): Promise<void> {
  await table(app, 'Post').updateMany({ where: { externalId: post }, data: { isPinned } })
}

/**
 * A person's room set outright to the server's counts, as `post_unread` and
 * the answer to a mark-unread both say. Unlike `viewed` this moves the
 * watermark BACK, which is the point: a read older than the room's newest post
 * is refused there and is the whole request here.
 */
export async function landUnread(app: App, u: UnreadRow): Promise<void> {
  await table(app, 'ChannelMember').updateMany({
    where: { externalId: memberKey(u.channelExternalId, u.profileExternalId) },
    data: {
      lastViewedAt: u.lastViewedAt, messageCount: u.messageCount, mentionCount: u.mentionCount,
      messageCountRoot: u.messageCountRoot, mentionCountRoot: u.mentionCountRoot,
    },
  })
}

/** A person's mute of a room, as the notify props the server answered. */
export async function landMuted(app: App, profile: string, channel: string, muted: boolean): Promise<void> {
  await table(app, 'ChannelMember').updateMany({ where: { externalId: memberKey(channel, profile) }, data: { muted } })
}

/**
 * A person followed or unfollowed a thread. A thread already a row flips in
 * place; a follow of one that is not reads it, since no frame carries its
 * counts. Answers false when it needed the team and had none.
 */
export async function landFollow(app: App, profile: string, team: string | null, root: string, following: boolean, extra: Record<string, unknown> = {}): Promise<boolean> {
  if (await touchThread(app, profile, root, { isFollowing: following, ...extra })) return true
  if (!following) return true
  if (!team) return false
  const r = await getThread(asCaller(app), profile, team, root)
  if (r.rows) await landThreads(app, r.rows, r.roots ?? [])
  return true
}

/** Delete rows the server no longer holds — for access rows only (FJS-D1155). */
async function drop(app: App, model: 'ChannelMember' | 'Reaction', where: Record<string, unknown>): Promise<void> {
  await table(app, model).deleteMany({ where })
}

// ─── The backfill ──────────────────────────────────────────

/** Read again a minute before the last backfill began, so nothing written during it falls between two. */
const OVERLAP_MS = 60_000
/** A first link reads this many of each channel's newest posts; older history stays the server's. */
const FIRST_PAGE = 200
const MEMBER_PAGE = 200

const fail = (what: string, kind: string) => new Error(`chat backfill: ${what} (${kind})`)

/** Every member of a channel, paged, or null when a page failed — a diff over a partial list would drop real members. */
async function allMembers(app: App, channel: string): Promise<ChannelMemberRow[] | null> {
  const out: ChannelMemberRow[] = []
  for (let page = 0;; page++) {
    const r = await listMembers(asCaller(app), channel, { page, perPage: MEMBER_PAGE })
    if (!r.rows) return null
    out.push(...r.rows)
    if (r.rows.length < MEMBER_PAGE) return out
  }
}

/** Land a channel's members and drop those the server no longer lists. */
export async function syncMembers(app: App, channel: string): Promise<ChannelMemberRow[]> {
  const rows = await allMembers(app, channel)
  if (!rows) throw fail(`the members of ${channel} could not be read`, 'members')
  await land(app, 'ChannelMember', rows)
  await drop(app, 'ChannelMember', { channelExternalId: channel, externalId: { notIn: rows.map(r => r.externalId) } })
  return rows
}

/** A page of posts with each post's reactions as the WHOLE set: one the page no longer names was removed. */
async function landPosts(app: App, page: PostPage): Promise<string[]> {
  const posts = page.rows ?? []
  await land(app, 'Post', posts)
  await land(app, 'Reaction', page.reactions ?? [])
  await land(app, 'FileInfo', page.files ?? [])
  for (const post of posts)
    await drop(app, 'Reaction', {
      postExternalId: post.externalId,
      externalId: { notIn: (page.reactions ?? []).filter(r => r.postExternalId === post.externalId).map(r => r.externalId) },
    })
  return posts.map(p => p.profileExternalId)
}

/**
 * Bring one person's view up to date: their profile, teams, channels (archived
 * included), every member of each, and each channel's posts since the last
 * backfill began. Runs as the person, so every read spends their token. A read
 * that fails throws before the cursor moves, and the next backfill reads the
 * same window again; a membership is dropped only on a list read whole.
 */
export async function backfill(app: App, memberId: string): Promise<void> {
  const began = new Date()
  const sys = sysOf(app)
  const user = await sys.member.findUnique({ where: { id: Number(memberId) }, select: { chatToken: true, profileExternalId: true, chatSyncedAt: true } })
  const profile = user?.profileExternalId
  if (!user?.chatToken || !profile) return
  const mm = asCaller(app)

  const self = await me(mm)
  if (!self.row) throw fail('the server did not answer who this token is', self.error?.kind ?? 'no answer')
  // A token now answering for another profile is a link chat.connect did not make.
  if (self.row.externalId !== profile) throw fail('the token now belongs to a different profile', 'relinked')
  await land(app, 'Profile', [self.row])

  const teams = await listTeams(mm, profile)
  if (!teams.rows) throw fail('teams could not be read', teams.error?.kind ?? 'no answer')
  await land(app, 'Team', teams.rows)

  // A direct or group channel is listed under every team, so channels are keyed once.
  const channels = new Map<string, NonNullable<Awaited<ReturnType<typeof listChannels>>['rows']>[number]>()
  for (const team of teams.rows) {
    const r = await listChannels(mm, profile, team.externalId, { includeDeleted: true })
    if (!r.rows) throw fail(`channels of ${team.externalId} could not be read`, r.error?.kind ?? 'no answer')
    for (const c of r.rows) channels.set(c.externalId, c)
  }
  await land(app, 'Channel', [...channels.values()])

  // Removed from a channel while no socket was open: Mattermost deletes the
  // membership and names it nowhere, so the person's whole list is the answer.
  await drop(app, 'ChannelMember', { profileExternalId: profile, channelExternalId: { notIn: [...channels.keys()] } })

  const since = user.chatSyncedAt ? new Date(user.chatSyncedAt).getTime() - OVERLAP_MS : null
  const people = new Set<string>()

  // The threads this person follows. A direct channel's are listed under
  // every team, so they are keyed once. A first read lists them all, so a
  // thread here and not there was unfollowed while no socket was open.
  const threads = new Map<string, ThreadRow>(), roots = new Map<string, PostRow>()
  for (const team of teams.rows) {
    const r = await listThreads(mm, profile, team.externalId, since === null ? {} : { since })
    if (r.error) throw fail(`threads of ${team.externalId} could not be read`, r.error.kind)
    for (const t of r.rows ?? []) threads.set(t.externalId, t)
    for (const p of r.roots ?? []) { roots.set(p.externalId, p); people.add(p.profileExternalId) }
  }
  await landThreads(app, [...threads.values()], [...roots.values()])
  if (since === null)
    await table(app, 'Thread').updateMany({ where: { profileExternalId: profile, externalId: { notIn: [...threads.keys()] } }, data: { isFollowing: false } })

  for (const c of channels.values()) {
    if (c.deletedAt) continue
    for (const m of await syncMembers(app, c.externalId)) people.add(m.profileExternalId)
    const page = since === null
      ? await listPosts(mm, c.externalId, { perPage: FIRST_PAGE })
      : await postsSince(mm, c.externalId, since)
    if (page.error) throw fail(`posts of ${c.externalId} could not be read`, page.error.kind)
    // An older post edited or deleted inside a gap past Mattermost's cap is not
    // in the answer, and nothing else lists it: said rather than read as whole.
    if ('truncated' in page && page.truncated)
      console.warn(`[chat] ${c.externalId}: more changed since the last backfill than the server answers in one read; older edits in the gap may be missing`)
    for (const author of await landPosts(app, page)) people.add(author)
  }

  const profiles = await listProfiles(mm, [...people])
  if (!profiles.rows) throw fail('profiles could not be read', profiles.error?.kind ?? 'no answer')
  await land(app, 'Profile', profiles.rows)

  await sys.member.update({ where: { id: Number(memberId) }, data: { chatSyncedAt: began.toISOString() } })
}

/**
 * Queue a person's backfill for one cause — a connection, a `seq` gap, or a
 * frame naming a channel they could not read. `unique` holds a RUNNING job
 * as well as a waiting one, so a key per person would fold a redial into a
 * pass that may have read the channel before the drop; keyed per cause, the
 * same cause queues once and a new one queues its own pass.
 */
export function queueBackfill(app: App, memberId: string, cause: string): Promise<string> {
  return app.jobs!.dispatch('chat-backfill', { memberId }, { unique: `chat-backfill:${memberId}:${cause}`, actor: memberId })
}

// ─── The socket ────────────────────────────────────────────

/** What one person's socket hands over, landed as the system. */
export async function applyFrame(app: App, memberId: string, profile: string, ev: SocketEvent): Promise<void> {
  const cause = `frame:${ev.id}`
  switch (ev.type) {
    // Counted before it lands: the post's arrival is what tells a screen to
    // read the counts again. The files after their post, so a screen holding
    // the post when they land can attach them.
    case 'posted':
      await countPost(app, ev.payload.post)
      await countFor(app, profile, ev.payload.post, ev.payload.mentions)
      await land(app, 'Post', [ev.payload.post])
      return land(app, 'FileInfo', ev.payload.files ?? [])
    case 'post_edited': case 'post_deleted':
      await land(app, 'Post', [ev.payload.post])
      return land(app, 'FileInfo', ev.payload.files ?? [])
    // A read is one person's, and only this socket's person's is theirs to land.
    case 'channel_viewed':
      if (ev.payload.profileExternalId !== profile) return
      for (const [channel, at] of Object.entries(ev.payload.times)) await viewed(app, profile, channel, at ?? new Date())
      return
    case 'channel_member_updated':
      return land(app, 'ChannelMember', [ev.payload.member])
    case 'thread_updated':
      if (ev.payload.thread.profileExternalId !== profile) return
      return landThreads(app, [ev.payload.thread], ev.payload.root ? [ev.payload.root] : [])
    case 'thread_read_changed': {
      const { rootExternalId, at, unreadReplies, unreadMentions } = ev.payload
      if (ev.payload.profileExternalId !== profile) return
      // No thread named: every thread on the team was marked read.
      if (!rootExternalId) { await table(app, 'Thread').updateMany({ where: { profileExternalId: profile }, data: { unreadReplies: 0, unreadMentions: 0 } }); return }
      const row = await table(app, 'Thread').findUnique({ where: { externalId: threadKey(profile, rootExternalId) } })
      const seen = Math.max(time(row?.lastViewedAt), at?.getTime() ?? 0)
      await touchThread(app, profile, rootExternalId, { unreadReplies, unreadMentions, ...(seen ? { lastViewedAt: new Date(seen) } : {}) })
      return
    }
    // A follow of a thread not yet a row reads it: no frame carries its counts.
    case 'thread_follow_changed': {
      const { rootExternalId, following, replyCount, teamExternalId } = ev.payload
      if (ev.payload.profileExternalId !== profile) return
      if (!await app.runAs(memberId, () => landFollow(app, profile, teamExternalId, rootExternalId, following, { replyCount }))) await queueBackfill(app, memberId, cause)
      return
    }
    // Marked unread from a post, here or on a phone: the counts are the server's.
    case 'post_unread':
      if (ev.payload.unread.profileExternalId !== profile) return
      return landUnread(app, ev.payload.unread)
    case 'channel_updated':
      return land(app, 'Channel', [ev.payload.channel])
    case 'channel_deleted':
      await table(app, 'Channel').updateMany({ where: { externalId: ev.payload.channelExternalId }, data: { deletedAt: ev.payload.at ?? new Date() } })
      return
    case 'reaction_added':
      return land(app, 'Reaction', [ev.payload.reaction])
    case 'reaction_removed':
      return drop(app, 'Reaction', { externalId: ev.payload.reaction.externalId })
    case 'user_updated':
      return land(app, 'Profile', [ev.payload.profile])
    // A channel this person can now read arrives with no history in the frame.
    case 'channel_created': case 'direct_added': case 'group_added':
      await queueBackfill(app, memberId, cause)
      return
    case 'user_added':
      if (ev.payload.profileExternalId === profile) { await queueBackfill(app, memberId, cause); return }
      await app.runAs(memberId, () => syncMembers(app, ev.payload.channelExternalId))
      return
    case 'user_removed':
      return drop(app, 'ChannelMember', { channelExternalId: ev.payload.channelExternalId, profileExternalId: ev.payload.profileExternalId })
  }
}
