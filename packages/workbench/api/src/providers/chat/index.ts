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
  listTeams, me, mirror, muteChannel, pinPost, profileImage, threadKey, unfollowThread, unpinPost, uploadFile, viewChannel,
  clearCustomStatus, deleteDraft, favoriteChannel, listSavedPosts, listStatuses, saveDraft, savePost, searchPosts, setCustomStatus, setStatus,
  unfavoriteChannel, unsavePost,
  createCategory, deleteCategory, editHistory, isCategoryId, listCategories, reorderCategories, setReminder, updateCategory,
  mattermostSocketDialect, mattermostSocketTarget, mattermostTargets,
} from '@frontierjs/conduit-mattermost'
import type { FileSize, NewDraft, NewFile, PostRow } from '@frontierjs/conduit-mattermost'
import type { App } from '@frontierjs/junction'
import {
  applyFrame, dropDraft, land, landDrafts, landFavorite, landFollow, landMuted, landPinned, landPosts, landSaved, landStatuses, landThreads, landUnread,
  queueBackfill, savedKey, syncMembers, syncSections, viewed,
} from './sync.ts'

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

function credentials (db: Db, extra: Record<string, CredentialResolver> = {}): CredentialResolver {
  const table = byRef({
    ...extra,
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
export function chatProvider (app: App, opts: { db: Db, url?: string | null, alongside?: { targets: unknown[], credentials: Record<string, CredentialResolver> } }): void {
  const url = opts.url || null
  const targets = url ? mattermostTargets({ address: url, ref: 'CHAT_TOKEN', userRef: 'CHAT_USER_TOKEN' }) : null
  app.own('chat', { url, sys: () => opts.db.asSystem(), targets } satisfies Chat)
  // An app has one conduit plugin, so another provider's targets ride this one's.
  const all = [...(targets ? Object.values(targets) : []), ...(opts.alongside?.targets ?? [])]
  if (all.length) app.configure(conduit({ targets: all, credentials: credentials(opts.db, opts.alongside?.credentials) } as any))
  if (!targets) return
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

/**
 * A post's address on the chat server: `<server>/<team name>/pl/<post id>`. A
 * direct channel has no team, so the first team the mirror holds names it, as
 * the server's own links do for a direct message.
 */
export async function permalinkOf (app: App, post: { externalId: string, channelExternalId: string }): Promise<string | null> {
  const { url } = chatOf(app)
  if (!url) return null
  const sys = sysOf(app)
  const channel = await sys.channel.findUnique({ where: { externalId: post.channelExternalId }, select: { teamExternalId: true } })
  const team = channel?.teamExternalId
    ? await sys.team.findUnique({ where: { externalId: channel.teamExternalId }, select: { name: true } })
    : await sys.team.findFirst({ orderBy: { id: 'asc' }, select: { name: true } })
  return team?.name ? `${url.replace(/\/+$/, '')}/${team.name}/pl/${post.externalId}` : null
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

/**
 * A person's profile picture, read as the caller with their own token. The
 * route checks the caller may read the Profile row first.
 */
export async function profileImageOf (app: App, externalId: string) {
  return profileImage(asCaller(app), externalId)
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

// ─── A person's own: drafts, saved posts, favorites, presence ───

/** Save the caller's draft for one box; the server keeps one per box and answers it. */
export async function saveDraftAs (app: App, profile: string, draft: NewDraft) {
  const r = await saveDraft(asCaller(app), profile, draft)
  if (r.row) await landDrafts(app, profile, [r.row])
  return r
}

/** Discard the caller's draft for one box -- sent, or emptied. */
export async function deleteDraftAs (app: App, profile: string, channel: string, root: string | null) {
  const r = await deleteDraft(asCaller(app), profile, channel, root)
  // Already gone on the server is the outcome asked for.
  if (!r.error || r.error.kind === 'gone') { await dropDraft(app, profile, channel, root); return { ok: true as const } }
  return r
}

/** Save or unsave a post for the caller. */
export async function saveAs (app: App, profile: string, post: string, saved: boolean) {
  const r = await (saved ? savePost : unsavePost)(asCaller(app), profile, post)
  if (!r.error) await landSaved(app, profile, post, saved)
  return r
}

/** Favorite or unfavorite a room for the caller. */
export async function favoriteAs (app: App, profile: string, channel: string, favorite: boolean) {
  const r = await (favorite ? favoriteChannel : unfavoriteChannel)(asCaller(app), profile, channel)
  if (!r.error) await landFavorite(app, profile, channel, favorite)
  return r
}

/**
 * Land a page of posts the server answered outside a room's own read, so the
 * screen draws them with the room's components. A post in a room this copy
 * holds no Channel for is answered by id and not landed: its row would point
 * at a room that is not here.
 */
async function landFound (app: App, rows: PostRow[], page: { reactions?: any[], files?: any[] }): Promise<string[]> {
  const rooms = new Set((await sysOf(app).channel.findMany({ where: { externalId: { in: [...new Set(rows.map(p => p.channelExternalId))] } }, select: { externalId: true } }))
    .map((c: { externalId: string }) => c.externalId))
  const here = rows.filter(p => rooms.has(p.channelExternalId)), ids = new Set(here.map(p => p.externalId))
  await landPosts(app, { rows: here, reactions: (page.reactions ?? []).filter(r => ids.has(r.postExternalId)), files: (page.files ?? []).filter(f => ids.has(f.postExternalId)) })
  return rows.map(p => p.externalId)
}

/**
 * The caller's saved posts, newest first, read whole and landed: the list is
 * the server's, so a save made while no socket was open is in it.
 */
export async function savedAs (app: App, profile: string) {
  const page = await listSavedPosts(asCaller(app), profile, { perPage: 200 })
  if (!page.rows) return { error: page.error }
  const ids = await landFound(app, page.rows, page)
  for (const id of ids) await landSaved(app, profile, id, true)
  await sysOf(app).savedPost.deleteMany({ where: { profileExternalId: profile, externalId: { notIn: ids.map(id => savedKey(profile, id)) } } })
  return { rows: ids }
}

/** Set the caller's presence; `dndEndAt` ends a dnd. */
export async function setStatusAs (app: App, profile: string, status: 'online' | 'away' | 'offline' | 'dnd', dndEndAt: Date | null) {
  const r = await setStatus(asCaller(app), profile, status, dndEndAt ? { dndEndTime: Math.floor(dndEndAt.getTime() / 1000) } : {})
  if (r.row) await landStatuses(app, [r.row])
  return r
}

/** Set or clear the caller's custom status; the answer is no row, so what was asked is landed. */
export async function setCustomStatusAs (app: App, profile: string, custom: { emoji: string, text: string, expiresAt: Date | null } | null) {
  const mm = asCaller(app)
  const r = custom ? await setCustomStatus(mm, profile, { emoji: custom.emoji, text: custom.text, ...(custom.expiresAt ? { expiresAt: custom.expiresAt } : {}) }) : await clearCustomStatus(mm, profile)
  if (!r.error)
    await sysOf(app).profile.updateMany({ where: { externalId: profile }, data: { customEmoji: custom?.emoji || null, customText: custom?.text || null, customExpiresAt: custom?.expiresAt ?? null } })
  return r
}

/** Presence of the people a screen shows, read now: the server pushes a change to some sockets only. */
export async function statusesAs (app: App, profiles: string[]) {
  const r = await listStatuses(asCaller(app), profiles)
  if (r.rows) await landStatuses(app, r.rows)
  return r
}

// ─── Search and activity ───────────────────────────────────────

/** Posts matching `terms` across the caller's teams, newest first, landed; `matches` is the words each matched. */
export async function searchAs (app: App, profile: string, terms: string) {
  const mm = asCaller(app)
  const teams = await listTeams(mm, profile)
  if (!teams.rows) return { error: teams.error }
  const found = new Map<string, PostRow>(), reactions: any[] = [], files: any[] = []
  const matches: Record<string, string[]> = {}
  for (const t of teams.rows) {
    const r = await searchPosts(mm, t.externalId, terms, { perPage: 100 })
    if (!r.rows) return { error: r.error }
    for (const p of r.rows) found.set(p.externalId, p)
    reactions.push(...(r.reactions ?? [])); files.push(...(r.files ?? []))
    Object.assign(matches, r.matches ?? {})
  }
  const rows = [...found.values()].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
  return { rows: await landFound(app, rows, { reactions, files }), matches }
}

/**
 * What asks for the caller: posts naming them (a search for their @username,
 * since the server keeps no mention list) and the followed threads with
 * replies they have not read, from this copy's Thread rows.
 */
export async function activityAs (app: App, profile: string) {
  const self = await sysOf(app).profile.findUnique({ where: { externalId: profile }, select: { username: true } })
  if (!self?.username) return { error: { kind: 'not_found', message: 'the caller\'s profile is not here yet' } }
  const mentions = await searchAs(app, profile, `@${self.username}`)
  if (!mentions.rows) return { error: mentions.error }
  const threads = await sysOf(app).thread.findMany({
    where: { profileExternalId: profile, isFollowing: true, missingSince: null, unreadReplies: { gt: 0 } }, orderBy: { lastReplyAt: 'desc' }, select: { rootExternalId: true },
  })
  return { mentions: mentions.rows, threads: threads.map((t: { rootExternalId: string }) => t.rootExternalId) }
}

// ─── Edit history and reminders ────────────────────────────────

/**
 * The versions the caller's own post had before each edit, newest first, each
 * stamped when it was written: its own edit, or the post's creation for the
 * first. The server answers another person's post as not found.
 */
export async function editHistoryAs (app: App, post: string) {
  const r = await editHistory(asCaller(app), post)
  if (!r.rows) return { error: r.error }
  return { rows: r.rows.map(v => ({ message: v.message, editedAt: v.editedAt ?? v.createdAt })) }
}

/** The server's own bot messages the caller about a post at `at`; nothing here keeps it, since the server lists none back. */
export async function remindAs (app: App, profile: string, post: string, at: Date) {
  return setReminder(asCaller(app), profile, post, at)
}

// ─── Sidebar sections ──────────────────────────────────────────

/** A section id as the server writes it, a system one or a person's own. */
export const isSectionId = isCategoryId

/**
 * One of the caller's sections as the server holds it NOW: a section is sent
 * back whole, so a stale copy would undo another client's move.
 */
async function liveSection (app: App, profile: string, id: string) {
  const mine = await sysOf(app).chatSection.findFirst({ where: { externalId: id, profileExternalId: profile }, select: { teamExternalId: true } })
  if (!mine) return { error: { kind: 'gone', message: 'that section is not here' } }
  const r = await listCategories(asCaller(app), profile, mine.teamExternalId)
  if (!r.rows) return { error: r.error }
  const row = r.rows.find(c => c.externalId === id)
  return row ? { row, team: mine.teamExternalId as string } : { error: { kind: 'gone', message: 'the server holds no such section' } }
}

const sectionOf = (app: App, id: string) => sysOf(app).chatSection.findUnique({ where: { externalId: id } })

/** A new section of the caller's on a team, holding the rooms named. */
export async function createSectionAs (app: App, profile: string, team: string, name: string, channels: string[]) {
  const r = await createCategory(asCaller(app), profile, team, { displayName: name, channelExternalIds: channels })
  if (!r.row) return { error: r.error }
  await syncSections(app, profile, team)
  return { row: await sectionOf(app, r.row.externalId) }
}

export async function renameSectionAs (app: App, profile: string, id: string, name: string) {
  const live = await liveSection(app, profile, id)
  if (!live.row) return { error: live.error }
  const r = await updateCategory(asCaller(app), profile, live.team, { ...live.row, displayName: name })
  if (!r.row) return { error: r.error }
  await syncSections(app, profile, live.team)
  return { row: await sectionOf(app, id) }
}

/** A section of the caller's own making; its rooms go back where the server puts them. */
export async function deleteSectionAs (app: App, profile: string, id: string) {
  const live = await liveSection(app, profile, id)
  if (!live.row) return { error: live.error }
  const r = await deleteCategory(asCaller(app), profile, live.team, id)
  if (r.error) return { error: r.error }
  await syncSections(app, profile, live.team)
  return { ok: true as const }
}

/** The caller's sections on a team, top to bottom: every one of them, named once. */
export async function reorderSectionsAs (app: App, profile: string, team: string, order: string[]) {
  const r = await reorderCategories(asCaller(app), profile, team, order)
  if (!r.order) return { error: r.error }
  await syncSections(app, profile, team)
  return { order: r.order }
}

/** A room into one of the caller's sections at `index` (the end when absent); the server takes it out of the one that held it. */
export async function moveToSectionAs (app: App, profile: string, channel: string, id: string, index: number | null) {
  const live = await liveSection(app, profile, id)
  if (!live.row) return { error: live.error }
  const rest = live.row.channelExternalIds.filter(c => c !== channel)
  const at = index === null ? rest.length : Math.min(Math.max(index, 0), rest.length)
  const r = await updateCategory(asCaller(app), profile, live.team, { ...live.row, channelExternalIds: [...rest.slice(0, at), channel, ...rest.slice(at)] })
  if (!r.row) return { error: r.error }
  await syncSections(app, profile, live.team)
  return { row: await sectionOf(app, id) }
}

