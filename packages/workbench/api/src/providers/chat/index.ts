// api/src/providers/chat/index.ts -- the team chat server, and the ONE folder
// in Workbench that names it (`IDEAS/workbench-messages.md`, moved from the
// chat prototype). Everything else says Post, Channel and Profile and imports
// from here, so removing the server is this folder and a dependency.
//
// Who authors a write decides whose credential it spends (`FJS-D1126`): a
// member's post, edit or reaction spends their own Member.chatToken, so the
// server records them as the author and refuses what it would refuse them.
// The sync READS as the member whose view it is (`FJS-D1153`): each linked
// member holds a socket on their own token and their backfill spends it,
// because the server sends a channel's events to its members only.

import { byRef, conduit, createEnvResolver } from '@frontierjs/conduit'
import type { CredentialCaller, CredentialResolver } from '@frontierjs/conduit'
import {
  bindMattermost, browseChannels, createDirectChannel, createGroupChannel, fileBytes, followThread, getThread, listProfiles, markThreadRead, markUnread,
  listTeams, me, mirror, muteChannel, pinPost, threadKey, unfollowThread, unpinPost, uploadFile, viewChannel,
  mattermostSocketDialect, mattermostSocketTarget, mattermostTargets,
} from '@frontierjs/conduit-mattermost'
import type { FileSize, NewFile } from '@frontierjs/conduit-mattermost'
import type { App } from '@frontierjs/junction'
import { applyFrame, land, landFollow, landMuted, landPinned, landThreads, landUnread, queueBackfill, syncMembers, viewed } from './sync.ts'

export { attach, backfill, land } from './sync.ts'

type Db = { asSystem: () => any }

/** What one app's chat holds: where the server is and the client the sync writes through. */
export interface Chat {
  /** The server's address; null is chat off, and every verb below answers so. */
  url:     string | null
  sys:     () => any
  targets: ReturnType<typeof mattermostTargets> | null
}

const chatOf = (app: App): Chat => (app as unknown as { chat: Chat }).chat
/** The system client the chat writes through. */
export const sysOf = (app: App) => chatOf(app).sys()
/** Whether a chat server is configured at all. */
export const chatOn = (app: App) => !!chatOf(app).url

/** A member's calls spend their own token: the call runs as them. */
export function asCaller (app: App) {
  const { targets } = chatOf(app)
  if (!targets) throw Object.assign(new Error('chat: no chat server is configured (CHAT_URL)'), { status: 503 })
  return bindMattermost(app.conduit!, targets, { as: 'user' })
}

const tokenOfMember = async (db: Db, id: string | number): Promise<string | null> =>
  (await db.asSystem().member.findUnique({ where: { id: Number(id) }, select: { chatToken: true } }))?.chatToken ?? null

// A socket is dialed outside any call, so its member is in the ref:
// `CHAT_SOCKET:<member id>`, one target per linked member.
const SOCKET_REF = 'CHAT_SOCKET:'
const socketTarget = (memberId: string) => `broker:chat:${memberId}`

function credentials (db: Db): CredentialResolver {
  const table = byRef({
    CHAT_TOKEN:      createEnvResolver(),
    // The member in the call's own token. Null fails the send closed.
    CHAT_USER_TOKEN: { get: async () => null, getFor: async (_ref: string, who: CredentialCaller) => who.principal ? tokenOfMember(db, who.principal) : null },
  })
  return { ...table, get: ref => ref.startsWith(SOCKET_REF) ? tokenOfMember(db, ref.slice(SOCKET_REF.length)) : table.get(ref) }
}

/**
 * Open a linked member's socket. Every connection it makes -- the first and
 * each redial -- queues their backfill before its first frame is applied,
 * since the server redelivers nothing sent while it was down. So does a skip
 * in a connection's `seq`: frames it dropped while still connected.
 */
export async function listen (app: App, memberId: string): Promise<void> {
  const { url } = chatOf(app)
  if (!url) return
  const member = await sysOf(app).member.findUnique({ where: { id: Number(memberId) }, select: { chatToken: true, profileExternalId: true } })
  const profile = member?.profileExternalId
  if (!member?.chatToken || !profile) return
  const target = socketTarget(memberId)
  await app.conduit!.register(mattermostSocketTarget({ address: url, id: target, ref: `${SOCKET_REF}${memberId}` }))
  await app.conduit!.receive({
    provider: 'chat', target, dialect: mattermostSocketDialect,
    opened: ({ connection }: { connection: unknown }) => { void queueBackfill(app, memberId, `connection:${String(connection)}`) },
    gap: ({ connection, at }: { connection: unknown, at: unknown }) => { void queueBackfill(app, memberId, `gap:${String(connection)}:${String(at)}`) },
    async apply (ev: any) { await applyFrame(app, memberId, profile, ev); return 'applied' as const },
  } as any)
}

/** Close a member's socket: their token is gone, or about to be replaced. */
export async function unlisten (app: App, memberId: string): Promise<void> {
  if (!chatOn(app)) return
  await app.conduit!.deregister(socketTarget(memberId))
}

/**
 * Claims `app.chat`, and with a server configured registers its targets and
 * binds the mirror claim, so the generated create, update and remove on a
 * claimed model reach the server as the caller and land the answered row
 * (`FJS-D1125`); then opens each linked member's socket. With no server the
 * claim is unbound and a write to a mirrored model is refused as @system.
 */
export function chatProvider (app: App, opts: { db: Db, url?: string | null }): void {
  const url = opts.url || null
  const targets = url ? mattermostTargets({ address: url, ref: 'CHAT_TOKEN', userRef: 'CHAT_USER_TOKEN' }) : null
  app.own('chat', { url, sys: () => opts.db.asSystem(), targets } satisfies Chat)
  if (!targets) return
  app.configure(conduit({ targets: Object.values(targets), credentials: credentials(opts.db) } as any))
  app.conduit!.mirror(mirror)
  // A socket acts unasked, so it opens with the workers and not in a one-shot boot.
  app.configure({
    name: 'chat-sync',
    requires: ['conduit', 'caravan'],
    async work (a: App) {
      const linked = await opts.db.asSystem().member.findMany({ where: { profileExternalId: { not: null } }, select: { id: true } })
      for (const m of linked) await listen(a, String(m.id))
    },
  } as any)
}

/** The Profile a token belongs to, asked as the caller -- what `chat.connect` checks before keeping one. */
export async function profileOfCaller (app: App) {
  return me(asCaller(app))
}

/**
 * The caller read a room: the server's watermark moves, so its own clients
 * clear the room too, and so does this copy without waiting for the push.
 */
export async function viewAs (app: App, profile: string, channel: string, prev?: string | null) {
  const r = await viewChannel(asCaller(app), channel, prev)
  if (r.error) return r
  const times: Array<[string, unknown]> = Object.entries(r.times ?? {})
  // An older server answers only OK: the room was read now.
  if (!times.length) times.push([channel, new Date()])
  for (const [id, at] of times) await viewed(app, profile, id, new Date(at as string | Date))
  return r
}

/**
 * The caller read a thread, up to its newest reply or now, whichever is
 * later, so a reply stamped ahead of this clock is read too. The server files
 * a thread under a team, and a direct channel's under any team the member is on.
 */
export async function readThreadAs (app: App, profile: string, root: string) {
  const sys = sysOf(app)
  const post = await sys.post.findUnique({ where: { externalId: root }, select: { channelExternalId: true, lastReplyAt: true } })
  if (!post) return { error: { kind: 'not_found', message: 'that thread is not here' } }
  const team = await teamOfChannel(app, profile, post.channelExternalId)
  if (!team) return { error: { kind: 'not_found', message: 'no team to read that thread under' } }
  const thread = await sys.thread.findUnique({ where: { externalId: threadKey(profile, root) }, select: { lastReplyAt: true } })
  const at = Math.max(Date.now(), new Date(thread?.lastReplyAt ?? post.lastReplyAt ?? 0).getTime())
  const r = await markThreadRead(asCaller(app), profile, team, root, at)
  if (r.row) await land(app, 'Thread', [r.row])
  return r
}

/** The team a thread is filed under: its channel's, or for a direct channel any team the member is on. */
async function teamOfChannel (app: App, profile: string, channel: string): Promise<string | null> {
  const sys = sysOf(app)
  const room = await sys.channel.findUnique({ where: { externalId: channel }, select: { teamExternalId: true } })
  if (room?.teamExternalId) return room.teamExternalId
  const mine = await sys.channelMember.findMany({ where: { profileExternalId: profile }, select: { channelExternalId: true } })
  return (await sys.channel.findFirst({ where: { externalId: { in: mine.map((m: { channelExternalId: string }) => m.channelExternalId) }, teamExternalId: { not: null } }, select: { teamExternalId: true } }))?.teamExternalId ?? null
}

/**
 * Pin or unpin a post as the caller. `POST /pin` lets any member of the
 * channel pin any post in it; `posts.update { isPinned }` forwards through
 * `/patch`, which only the post's author may make.
 */
export async function pinAs (app: App, post: string, pinned: boolean) {
  const r = await (pinned ? pinPost : unpinPost)(asCaller(app), post)
  if (!r.error) await landPinned(app, post, pinned)
  return r
}

/**
 * The caller's room reads as unread from a post. A reply marks its THREAD
 * unread and leaves the room's counts alone, so the thread is read back
 * rather than waiting for the push.
 */
export async function markUnreadAs (app: App, profile: string, post: string) {
  const r = await markUnread(asCaller(app), profile, post)
  if (!r.row) return r
  await landUnread(app, r.row)
  const root = (await sysOf(app).post.findUnique({ where: { externalId: post }, select: { rootExternalId: true } }))?.rootExternalId
  const team = r.row.teamExternalId ?? await teamOfChannel(app, profile, r.row.channelExternalId)
  if (root && team) {
    const t = await getThread(asCaller(app), profile, team, root)
    if (t.rows) await landThreads(app, t.rows, t.roots ?? [])
  }
  return r
}

/** Mute or unmute a room for the caller. */
export async function muteAs (app: App, profile: string, channel: string, muted: boolean) {
  const r = await muteChannel(asCaller(app), channel, profile, muted)
  if (!r.error) await landMuted(app, profile, channel, muted)
  return r
}

/** Follow or unfollow a thread as the caller. */
export async function followAs (app: App, profile: string, root: string, following: boolean) {
  const post = await sysOf(app).post.findUnique({ where: { externalId: root }, select: { channelExternalId: true } })
  if (!post) return { error: { kind: 'not_found', message: 'that thread is not here' } }
  const team = await teamOfChannel(app, profile, post.channelExternalId)
  if (!team) return { error: { kind: 'not_found', message: 'no team to follow that thread under' } }
  const r = await (following ? followThread : unfollowThread)(asCaller(app), profile, team, root)
  if (!r.error) await landFollow(app, profile, team, root, following)
  return r
}

/**
 * Open the direct channel with one person, or a group channel with two to
 * seven, the caller among them; the channel that exists is answered when there
 * is one. The people land first, so the memberships have a Profile to point at.
 */
export async function openDirectAs (app: App, profile: string, others: string[]) {
  const mm = asCaller(app)
  const r = others.length === 1 ? await createDirectChannel(mm, profile, others[0]) : await createGroupChannel(mm, [profile, ...others])
  if (!r.row) return r
  const people = await listProfiles(mm, [profile, ...others])
  if (people.rows) await land(app, 'Profile', people.rows)
  await land(app, 'Channel', [r.row])
  await syncMembers(app, r.row.externalId)
  return r
}

/**
 * A file's bytes, read as the caller with their own token: the server answers
 * a file only to a member of its post's channel. The caller's read of the
 * FileInfo row is the route's to check first.
 */
export async function fileOf (app: App, externalId: string, size: FileSize) {
  return fileBytes(asCaller(app), externalId, size)
}

/** Upload one file as the caller into a channel; a post naming it in `fileExternalIds` claims it. */
export async function uploadAs (app: App, file: NewFile) {
  return uploadFile(asCaller(app), file)
}

/**
 * The open channels of the caller's teams that they are not in, read live and
 * landed so each is a row the screen can open. The caller's own memberships are
 * the mirror's, which the sync keeps whole, so a channel they hold is left out
 * without a second question to the server.
 */
export async function browseAs (app: App, profile: string) {
  const mm = asCaller(app)
  const teams = await listTeams(mm, profile)
  if (!teams.rows) return { error: teams.error }
  const found: any[] = []
  for (const t of teams.rows) {
    const r = await browseChannels(mm, t.externalId)
    if (!r.rows) return { error: r.error }
    found.push(...r.rows)
  }
  const open = found.filter(c => c.type === 'open' && !c.deletedAt)
  if (open.length) await land(app, 'Channel', open)
  const mine = new Set((await sysOf(app).channelMember.findMany({ where: { profileExternalId: profile }, select: { channelExternalId: true } })).map((m: { channelExternalId: string }) => m.channelExternalId))
  return { rows: open.filter(c => !mine.has(c.externalId)) }
}
