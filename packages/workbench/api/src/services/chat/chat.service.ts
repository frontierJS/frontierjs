// src/services/chat/chat.service.ts -- a member's link to the team chat
// server; not a model's verbs, so no model.
//
//   connect     keep the caller's token, after the server has said whose it
//               is, link the member to that Profile, and open the socket whose
//               first connection backfills their view
//   disconnect  close the socket and forget both
//   status      whether the caller is linked, and as whom (never the token)
//   view        the caller read a room: its counts clear here and on the server
//   readThread  the caller read a thread, the same for its unread replies
//   pin         pin or unpin a post { postExternalId, pinned }
//   markUnread  the room reads as unread from a post { postExternalId }
//   mute        mute or unmute a room { channelExternalId, muted }
//   follow      follow or unfollow a thread { rootExternalId, following }
//   browse      the open channels of the caller's teams they are not in, landed
//               in the mirror and answered { channels: [...] }
//   openDirect  the direct channel with one person, or a group with two to
//               seven { profileExternalIds }; joining and leaving a room are
//               channelMembers.create and .remove
//   saveDraft   the caller's draft for one box { channelExternalId,
//               rootExternalId?, message, fileExternalIds? } -> the Draft row
//   deleteDraft discard it { channelExternalId, rootExternalId? }; hidden
//               here even when the server refuses
//   save        save or unsave a post { postExternalId, saved }
//   saved       the saved list read whole and landed -> { postExternalIds },
//               newest first
//   favorite    favorite or unfavorite a room { channelExternalId, favorite }
//   setStatus   the caller's presence { status, dndEndAt? }
//   setCustomStatus  { emoji, text?, expiresAt? }, or null/{} to clear
//   statuses    presence of the people on screen, read now { profileExternalIds }
//   search      posts matching { terms }, landed -> { postExternalIds, matches }
//   activity    -> { mentions: postExternalIds, threads: rootExternalIds }
//   waiting     -> { onMe: postExternalIds, onOthers: [{ postExternalId, followUpId, remindAt }] },
//               read from the mirror alone (`domain/chat/waiting.ts`)
//   catchUp     -> { groups: [{ key, channelExternalId, rootExternalId, since, postExternalIds, more }] },
//               the unread posts per room and followed thread (`domain/chat/catchup.ts`)
//   recap       one group's unread posts since `since` summarized by a tool-less `claude -p`
//               { channelExternalId, rootExternalId?, since } -> { text, posts, omitted }; held nowhere
//   editHistory the caller's own post's earlier versions { postExternalId }
//               -> { versions: [{ message, editedAt }] }, newest first
//   remind      the server messages the caller about a post { postExternalId, at }
//   todoProjects / todoLists { projectId }  Basecamp's projects and a project's to-do lists -> { projects | lists: [{ id, name }] }
//   todoNotes   { postExternalId } -> { notes }: the permalink, which is all a to-do carries
//   makeTodo    { postExternalId, projectId, listId, title } -> { id, appUrl }; 503 when Basecamp is not configured
//   createSection   { teamExternalId, name, channelExternalIds? } -> the ChatSection row
//   renameSection   { sectionExternalId, name } -> the row
//   deleteSection   { sectionExternalId }; a system section is the server's 400
//   reorderSections { teamExternalId, sectionExternalIds } -> every section on
//                   the team, top to bottom
//   moveToSection   { channelExternalId, sectionExternalId, index? } -> the row
//
// Someone typing reaches the members of the room as a `chat typing` frame
// { channelExternalId, rootExternalId, profileExternalId }; nothing stores it.
//
// Member.chatToken and Member.profileExternalId are the system's to write,
// because a caller who could set profileExternalId could read every private
// channel of the profile named. The server answering the token IS the check
// that this member holds that profile, so nothing here takes a profile id.

import { createService, $ } from '@frontierjs/junction'
import { waiting } from '../../domain/chat/waiting.ts'
import { catchUp, recap } from '../../domain/chat/catchup.ts'
import { env } from '../../core/env.ts'
import type { App, ServiceContext } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import {
  activityAs, browseAs, chatOn, createSectionAs, deleteDraftAs, deleteSectionAs, editHistoryAs, isSectionId, moveToSectionAs, remindAs, renameSectionAs, reorderSectionsAs, favoriteAs, followAs, land, listen, markUnreadAs, muteAs, openDirectAs, pinAs, profileOfCaller, readThreadAs,
  saveAs, saveDraftAs, savedAs, searchAs, setCustomStatusAs, setStatusAs, statusesAs, sysOf, unlisten, viewAs, permalinkOf,
} from '../../providers/chat/index.ts'
import { connect as connectTodos, kindOf, listsOf, makeTodo, projectsOf, signInState, todosOn } from '../../providers/bc3/index.ts'

type Ctx = ServiceContext & { app: App }

const fail = (status: number, message: string) => Object.assign(new Error(message), { status })
const callerId = (ctx: Ctx): number => {
  const id = ctx.user?.id
  if (!id) throw fail(401, 'chat: sign in first')
  return Number(id)
}
const serverOn = (ctx: Ctx) => {
  if (!chatOn(ctx.app)) throw fail(503, 'chat: no chat server is configured on this machine (CHAT_URL)')
}

/** The caller's linked Profile; a read is theirs, on their own token. */
async function callerProfile (ctx: Ctx): Promise<string> {
  const profile = (await sysOf(ctx.app).member.findUnique({ where: { id: callerId(ctx) }, select: { profileExternalId: true } }))?.profileExternalId
  if (!profile) throw fail(409, 'chat: this member is not linked to a chat account')
  return profile
}

const ID = /^[a-z0-9]{26}$/
const idOf = (ctx: Ctx, key: string, optional = false): string | null => {
  const v = (ctx.data as Record<string, unknown> | undefined)?.[key]
  if (optional && (v === undefined || v === null || v === '')) return null
  if (typeof v !== 'string' || !ID.test(v)) throw fail(400, `chat: ${key} is a chat id`)
  return v
}

const flagOf = (ctx: Ctx, key: string): boolean => {
  const v = (ctx.data as Record<string, unknown> | undefined)?.[key]
  if (typeof v !== 'boolean') throw fail(400, `chat: ${key} is true or false`)
  return v
}

/** The people a channel is opened with: one to seven chat ids, never the caller's own. */
const peopleOf = (ctx: Ctx, self: string): string[] => {
  const v = (ctx.data as Record<string, unknown> | undefined)?.profileExternalIds
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && ID.test(x))) throw fail(400, 'chat: profileExternalIds is a list of chat ids')
  const others = [...new Set(v as string[])].filter(x => x !== self)
  if (!others.length || others.length > 7) throw fail(400, 'chat.openDirect: name one person for a direct channel, two to seven for a group')
  return others
}

const dataOf = (ctx: Ctx) => (ctx.data ?? {}) as Record<string, unknown>
const textOf = (ctx: Ctx, key: string, max: number, optional = false): string => {
  const v = dataOf(ctx)[key]
  if (optional && (v === undefined || v === null)) return ''
  if (typeof v !== 'string' || v.length > max) throw fail(400, `chat: ${key} is text of at most ${max} characters`)
  return v
}
/** A time to come, or null when absent. */
const laterOf = (ctx: Ctx, key: string): Date | null => {
  const v = dataOf(ctx)[key]
  if (v === undefined || v === null || v === '') return null
  const at = new Date(v as string)
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) throw fail(400, `chat: ${key} is a time to come`)
  return at
}
const idsOf = (ctx: Ctx, key: string, max: number): string[] => {
  const v = dataOf(ctx)[key]
  if (!Array.isArray(v) || v.length > max || !v.every(x => typeof x === 'string' && ID.test(x))) throw fail(400, `chat: ${key} is a list of at most ${max} chat ids`)
  return [...new Set(v as string[])]
}

/**
 * A refusal from the server, as this app's status: what it refused as malformed is the caller's 400.
 * The server's own code and words ride along -- a bare 'server_error' left a failing
 * delete undiagnosable.
 */
const refused = (what: string, kind: string, said?: { code?: string, message?: string }) => {
  const why = [said?.code, said?.message].filter(Boolean).join(': ')
  if (why) console.warn(`[chat] ${what} refused (${kind}): ${why}`)
  return fail(kind === 'forbidden' ? 403 : kind === 'not_found' || kind === 'gone' ? 404 : kind === 'refused' ? 400 : 502, `chat.${what}: the chat server refused (${kind})${why ? ` -- ${why}` : ''}`)
}

/** Basecamp's refusal as this app's status; the kind is all the caller is told. */
const todoRefused = (what: string, e: Parameters<typeof kindOf>[0]) => {
  const kind = kindOf(e)
  const said = e as { code?: string, message?: string } | undefined
  const why = [said?.code, said?.message].filter(Boolean).join(': ')
  if (why) console.warn(`[chat] ${what}: Basecamp refused (${kind}): ${why}`)
  return fail(kind === 'forbidden' ? 403 : kind === 'gone' ? 404 : kind === 'refused' ? 400 : kind === 'rate_limited' ? 429 : 502, `chat.${what}: Basecamp refused (${kind})`)
}
const todosReady = (ctx: Ctx) => {
  if (!todosOn(ctx.app)) throw fail(503, 'chat: Basecamp is not connected on this machine -- Connect Basecamp on /laptop/')
}
const wholeOf = (ctx: Ctx, key: string): number => {
  const v = dataOf(ctx)[key]
  if (!Number.isSafeInteger(v) || (v as number) < 1) throw fail(400, `chat: ${key} is a Basecamp id`)
  return v as number
}
/** A post the caller can read, by the row policy; one they cannot is the same 404 as one that is not there. */
async function readablePost (ctx: Ctx) {
  const post = await $.db.post.findFirst({ where: { externalId: idOf(ctx, 'postExternalId')! }, select: { externalId: true, channelExternalId: true } })
  if (!post) throw fail(404, 'chat: that post is not here')
  return post as { externalId: string, channelExternalId: string }
}

const sectionNameOf = (ctx: Ctx): string => {
  const name = textOf(ctx, 'name', 22).trim()
  if (!name) throw fail(400, 'chat: name is the section\'s name')
  return name
}
const sectionIdOf = (ctx: Ctx, key: string): string => {
  const v = dataOf(ctx)[key]
  if (!isSectionId(v)) throw fail(400, `chat: ${key} is a section id`)
  return v
}

export default createService({
  name:    'chat',
  model:   null,
  methods: [
    { method: 'todoConnect', gate: LEVELS.ADMINISTRATOR },
    { method: 'status',     gate: LEVELS.CREATOR, read: true },
    { method: 'connect',    gate: LEVELS.CREATOR },
    { method: 'disconnect', gate: LEVELS.CREATOR },
    { method: 'view',       gate: LEVELS.CREATOR },
    { method: 'readThread', gate: LEVELS.CREATOR },
    { method: 'pin',        gate: LEVELS.CREATOR },
    { method: 'markUnread', gate: LEVELS.CREATOR },
    { method: 'mute',       gate: LEVELS.CREATOR },
    { method: 'follow',     gate: LEVELS.CREATOR },
    { method: 'browse',     gate: LEVELS.CREATOR, read: true },
    { method: 'openDirect', gate: LEVELS.CREATOR },
    { method: 'saveDraft',  gate: LEVELS.CREATOR },
    { method: 'deleteDraft', gate: LEVELS.CREATOR },
    { method: 'save',       gate: LEVELS.CREATOR },
    { method: 'saved',      gate: LEVELS.CREATOR, read: true },
    { method: 'favorite',   gate: LEVELS.CREATOR },
    { method: 'setStatus',  gate: LEVELS.CREATOR },
    { method: 'setCustomStatus', gate: LEVELS.CREATOR },
    { method: 'statuses',   gate: LEVELS.CREATOR, read: true },
    { method: 'search',     gate: LEVELS.CREATOR, read: true },
    { method: 'activity',   gate: LEVELS.CREATOR, read: true },
    { method: 'waiting',    gate: LEVELS.CREATOR, read: true },
    { method: 'catchUp',    gate: LEVELS.CREATOR, read: true },
    { method: 'recap',      gate: LEVELS.CREATOR, read: true },
    { method: 'editHistory', gate: LEVELS.CREATOR, read: true },
    { method: 'remind',     gate: LEVELS.CREATOR },
    { method: 'todoProjects', gate: LEVELS.CREATOR, read: true },
    { method: 'todoLists',    gate: LEVELS.CREATOR, read: true },
    { method: 'todoNotes',    gate: LEVELS.CREATOR, read: true },
    { method: 'makeTodo',     gate: LEVELS.CREATOR },
    { method: 'createSection',   gate: LEVELS.CREATOR },
    { method: 'renameSection',   gate: LEVELS.CREATOR },
    { method: 'deleteSection',   gate: LEVELS.CREATOR },
    { method: 'reorderSections', gate: LEVELS.CREATOR },
    { method: 'moveToSection',   gate: LEVELS.CREATOR },
  ],

  async status (ctx: Ctx) {
    const m = await sysOf(ctx.app).member.findUnique({ where: { id: callerId(ctx) }, select: { profileExternalId: true, chatSyncedAt: true } })
    const profile = m?.profileExternalId
      ? await sysOf(ctx.app).profile.findUnique({ where: { externalId: m.profileExternalId }, select: { username: true } })
      : null
    return { server: chatOn(ctx.app), todos: todosOn(ctx.app), todoSignIn: signInState(ctx.app), profileExternalId: m?.profileExternalId ?? null, username: profile?.username ?? null, syncedAt: m?.chatSyncedAt ?? null }
  },

  async connect (ctx: Ctx) {
    serverOn(ctx)
    const id = callerId(ctx)
    const sys = sysOf(ctx.app)
    const token = (ctx.data as { token?: unknown } | undefined)?.token
    if (typeof token !== 'string' || !token.trim()) throw fail(400, 'chat.connect takes { token }: the personal access token the chat server issued you')

    // The resolver reads the token off the row, so it is written before the
    // server is asked and put back if the server refuses it -- a bad token
    // must not replace a good one.
    const before = await sys.member.findUnique({ where: { id }, select: { chatToken: true } })
    await sys.member.update({ where: { id }, data: { chatToken: token.trim() } })
    const { row, error } = await profileOfCaller(ctx.app)
    if (!row) {
      await sys.member.update({ where: { id }, data: { chatToken: before?.chatToken ?? null } })
      throw error?.kind === 'auth_failed' || error?.kind === 'forbidden'
        ? fail(422, 'chat.connect: the chat server refused that token')
        : fail(502, `chat.connect: the chat server could not be asked (${error?.kind ?? 'no answer'})`)
    }

    const holder = await sys.member.findFirst({ where: { profileExternalId: row.externalId }, select: { id: true } })
    if (holder && holder.id !== id) {
      await sys.member.update({ where: { id }, data: { chatToken: before?.chatToken ?? null } })
      throw fail(409, 'chat.connect: that chat account is already linked to another member here')
    }

    // A new token is a new dial, and a relinked profile reads its view whole.
    await unlisten(ctx.app, String(id))
    await land(ctx.app, 'Profile', [row])
    await sys.member.update({ where: { id }, data: { profileExternalId: row.externalId, chatSyncedAt: null } })
    await listen(ctx.app, String(id))
    return { profileExternalId: row.externalId, username: row.username }
  },

  // The server answers a read only to a member, on the member's own token,
  // and this copy changes only the caller's own membership and thread.
  async view (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const channel = idOf(ctx, 'channelExternalId')!
    const r = await viewAs(ctx.app, profile, channel, idOf(ctx, 'prevChannelExternalId', true))
    if (r.error) throw refused('view', r.error.kind, r.error)
    return { channelExternalId: channel }
  },

  async readThread (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const root = idOf(ctx, 'rootExternalId')!
    const r = await readThreadAs(ctx.app, profile, root) as { error?: { kind: string, code?: string, message?: string } }
    if (r.error) throw refused('readThread', r.error.kind, r.error)
    return { rootExternalId: root }
  },

  async pin (ctx: Ctx) {
    serverOn(ctx)
    const post = idOf(ctx, 'postExternalId')!, pinned = flagOf(ctx, 'pinned')
    const r = await pinAs(ctx.app, post, pinned)
    if (r.error) throw refused('pin', r.error.kind, r.error)
    return { postExternalId: post, isPinned: pinned }
  },

  async markUnread (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const post = idOf(ctx, 'postExternalId')!
    const r = await markUnreadAs(ctx.app, profile, post)
    if (!r.row) throw refused('markUnread', r.error?.kind ?? 'no answer', r.error)
    return { postExternalId: post, channelExternalId: r.row.channelExternalId }
  },

  async mute (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const channel = idOf(ctx, 'channelExternalId')!, muted = flagOf(ctx, 'muted')
    const r = await muteAs(ctx.app, profile, channel, muted)
    if (r.error) throw refused('mute', r.error.kind, r.error)
    return { channelExternalId: channel, muted }
  },

  async follow (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const root = idOf(ctx, 'rootExternalId')!, following = flagOf(ctx, 'following')
    const r = await followAs(ctx.app, profile, root, following)
    if (r.error) throw refused('follow', r.error.kind, r.error)
    return { rootExternalId: root, following }
  },

  async browse (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const r = await browseAs(ctx.app, profile)
    if (!r.rows) throw refused('browse', r.error?.kind ?? 'no answer', r.error)
    return { channels: r.rows.map(c => ({ externalId: c.externalId, teamExternalId: c.teamExternalId, name: c.name, displayName: c.displayName, purpose: c.purpose })) }
  },

  // A direct channel belongs to no team and its members are the two people,
  // so what is opened is read back whole: the channel, the profiles, the members.
  async openDirect (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const r = await openDirectAs(ctx.app, profile, peopleOf(ctx, profile))
    if (!r.row) throw refused('openDirect', r.error?.kind ?? 'no answer', r.error)
    return { channelExternalId: r.row.externalId, type: r.row.type }
  },

  // The server keeps one draft per box, so a save replaces the box's last.
  async saveDraft (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const channel = idOf(ctx, 'channelExternalId')!, root = idOf(ctx, 'rootExternalId', true)
    const files = dataOf(ctx).fileExternalIds === undefined ? [] : idsOf(ctx, 'fileExternalIds', 10)
    const r = await saveDraftAs(ctx.app, profile, { channelExternalId: channel, ...(root ? { rootExternalId: root } : {}), message: textOf(ctx, 'message', 16383), fileExternalIds: files })
    if (!r.row) throw refused('saveDraft', r.error?.kind ?? 'no answer', r.error)
    return await sysOf(ctx.app).draft.findFirst({ where: { profileExternalId: profile, channelExternalId: channel, rootExternalId: root } })
  },

  async deleteDraft (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const channel = idOf(ctx, 'channelExternalId')!, root = idOf(ctx, 'rootExternalId', true)
    await deleteDraftAs(ctx.app, profile, channel, root)
    return { channelExternalId: channel, rootExternalId: root }
  },

  async save (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const post = idOf(ctx, 'postExternalId')!, saved = flagOf(ctx, 'saved')
    const r = await saveAs(ctx.app, profile, post, saved)
    if (r.error) throw refused('save', r.error.kind, r.error)
    return { postExternalId: post, saved }
  },

  async saved (ctx: Ctx) {
    serverOn(ctx)
    const r = await savedAs(ctx.app, await callerProfile(ctx))
    if (!r.rows) throw refused('saved', r.error?.kind ?? 'no answer', r.error)
    return { postExternalIds: r.rows }
  },

  async favorite (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const channel = idOf(ctx, 'channelExternalId')!, favorite = flagOf(ctx, 'favorite')
    const r = await favoriteAs(ctx.app, profile, channel, favorite)
    if (r.error) throw refused('favorite', r.error.kind, r.error)
    return { channelExternalId: channel, favorite }
  },

  async setStatus (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const status = dataOf(ctx).status
    if (status !== 'online' && status !== 'away' && status !== 'offline' && status !== 'dnd') throw fail(400, 'chat.setStatus: status is online, away, offline or dnd')
    const r = await setStatusAs(ctx.app, profile, status, status === 'dnd' ? laterOf(ctx, 'dndEndAt') : null)
    if (!r.row) throw refused('setStatus', r.error?.kind ?? 'no answer', r.error)
    return { profileExternalId: profile, status: r.row.status }
  },

  // An empty emoji and text is a clear.
  async setCustomStatus (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const emoji = textOf(ctx, 'emoji', 64, true), text = textOf(ctx, 'text', 100, true)
    const custom = emoji || text ? { emoji, text, expiresAt: laterOf(ctx, 'expiresAt') } : null
    const r = await setCustomStatusAs(ctx.app, profile, custom)
    if (r.error) throw refused('setCustomStatus', r.error.kind, r.error)
    return { profileExternalId: profile, customEmoji: custom?.emoji || null, customText: custom?.text || null, customExpiresAt: custom?.expiresAt ?? null }
  },

  async statuses (ctx: Ctx) {
    serverOn(ctx)
    await callerProfile(ctx)
    const r = await statusesAs(ctx.app, idsOf(ctx, 'profileExternalIds', 200))
    if (!r.rows) throw refused('statuses', r.error?.kind ?? 'no answer', r.error)
    return { statuses: r.rows.map(s => ({ profileExternalId: s.profileExternalId, status: s.status })) }
  },

  async search (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const terms = textOf(ctx, 'terms', 500).trim()
    if (!terms) throw fail(400, 'chat.search takes { terms }')
    const r = await searchAs(ctx.app, profile, terms)
    if (!r.rows) throw refused('search', r.error?.kind ?? 'no answer', r.error)
    return { postExternalIds: r.rows, matches: r.matches }
  },

  async activity (ctx: Ctx) {
    serverOn(ctx)
    const r = await activityAs(ctx.app, await callerProfile(ctx))
    if (!('mentions' in r) || !r.mentions) throw refused('activity', r.error?.kind ?? 'no answer', r.error)
    return r
  },

  // The mirror holds every post this member can see, so nothing here asks the server; the
  // caller's own client reads, and Post's and Channel's policies grade it.
  async waiting (ctx: Ctx) {
    return waiting($.db, await callerProfile(ctx))
  },

  async catchUp (ctx: Ctx) {
    return catchUp($.db, await callerProfile(ctx))
  },

  // The one place a post's text leaves for Claude, and only on a press: nothing is kept.
  async recap (ctx: Ctx) {
    const profile = await callerProfile(ctx)
    const channel = idOf(ctx, 'channelExternalId')!
    const root = idOf(ctx, 'rootExternalId', true)
    const since = textOf(ctx, 'since', 40)
    if (!Number.isFinite(Date.parse(since))) throw fail(400, 'chat.recap takes { since }, a time')
    const r = await recap($.db, profile, { channelExternalId: channel, rootExternalId: root, since }, env.CLAUDE_BIN)
    if ('empty' in r) return { text: '', posts: 0, omitted: 0 }
    return r
  },

  async editHistory (ctx: Ctx) {
    serverOn(ctx)
    await callerProfile(ctx)
    const r = await editHistoryAs(ctx.app, idOf(ctx, 'postExternalId')!)
    if (!r.rows) throw refused('editHistory', r.error?.kind ?? 'no answer', r.error)
    return { versions: r.rows }
  },

  async remind (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const post = idOf(ctx, 'postExternalId')!, at = laterOf(ctx, 'at')
    if (!at) throw fail(400, 'chat.remind takes { postExternalId, at }')
    const r = await remindAs(ctx.app, profile, post, at)
    if (r.error) throw refused('remind', r.error.kind, r.error)
    return { postExternalId: post, at }
  },

  // The owner's grant, which every to-do is authored on (`FJS-D2341`), so only an administrator replaces it.
  async todoConnect (ctx: Ctx) {
    const r = await connectTodos(ctx.app)
    if ('error' in r) throw todoRefused('todoConnect', r.error)
    return r.signIn
  },

  async todoProjects (ctx: Ctx) {
    todosReady(ctx)
    const r = await projectsOf(ctx.app)
    if (!('rows' in r)) throw todoRefused('todoProjects', r.error)
    return { projects: r.rows }
  },

  async todoLists (ctx: Ctx) {
    todosReady(ctx)
    const r = await listsOf(ctx.app, wholeOf(ctx, 'projectId'))
    if (!('rows' in r)) throw todoRefused('todoLists', r.error)
    return { lists: r.rows }
  },

  // The notes a to-do made from this post will carry: the permalink and nothing else.
  async todoNotes (ctx: Ctx) {
    todosReady(ctx); serverOn(ctx)
    const link = await permalinkOf(ctx.app, await readablePost(ctx))
    if (!link) throw fail(409, 'chat: no team is mirrored yet, so the post has no address')
    return { notes: link }
  },

  // Built only from what the dialog sent and the address computed here; the post's own text is never read.
  async makeTodo (ctx: Ctx) {
    todosReady(ctx); serverOn(ctx)
    const title = textOf(ctx, 'title', 255).trim()
    if (!title) throw fail(400, 'chat.makeTodo takes a title')
    const projectId = wholeOf(ctx, 'projectId'), listId = wholeOf(ctx, 'listId')
    const link = await permalinkOf(ctx.app, await readablePost(ctx))
    if (!link) throw fail(409, 'chat: no team is mirrored yet, so the post has no address')
    const r = await makeTodo(ctx.app, { projectId, listId, title, notes: link })
    if (!r.row) throw todoRefused('makeTodo', r.error)
    return r.row
  },

  async createSection (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const channels = dataOf(ctx).channelExternalIds === undefined ? [] : idsOf(ctx, 'channelExternalIds', 200)
    const r = await createSectionAs(ctx.app, profile, idOf(ctx, 'teamExternalId')!, sectionNameOf(ctx), channels)
    if (!r.row) throw refused('createSection', r.error?.kind ?? 'no answer', r.error)
    return r.row
  },

  async renameSection (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const r = await renameSectionAs(ctx.app, profile, sectionIdOf(ctx, 'sectionExternalId'), sectionNameOf(ctx))
    if (!r.row) throw refused('renameSection', r.error?.kind ?? 'no answer', r.error)
    return r.row
  },

  async deleteSection (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const id = sectionIdOf(ctx, 'sectionExternalId')
    const r = await deleteSectionAs(ctx.app, profile, id)
    if (r.error) throw refused('deleteSection', r.error.kind, r.error)
    return { sectionExternalId: id }
  },

  async reorderSections (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const order = dataOf(ctx).sectionExternalIds
    if (!Array.isArray(order) || order.length > 200 || !order.every(isSectionId)) throw fail(400, 'chat: sectionExternalIds is a list of section ids')
    const r = await reorderSectionsAs(ctx.app, profile, idOf(ctx, 'teamExternalId')!, order as string[])
    if (!r.order) throw refused('reorderSections', r.error?.kind ?? 'no answer', r.error)
    return { sectionExternalIds: r.order }
  },

  async moveToSection (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const index = dataOf(ctx).index
    if (index !== undefined && index !== null && !(Number.isInteger(index) && (index as number) >= 0)) throw fail(400, 'chat: index is a whole number from 0')
    const r = await moveToSectionAs(ctx.app, profile, idOf(ctx, 'channelExternalId')!, sectionIdOf(ctx, 'sectionExternalId'), (index ?? null) as number | null)
    if (!r.row) throw refused('moveToSection', r.error?.kind ?? 'no answer', r.error)
    return r.row
  },

  async disconnect (ctx: Ctx) {
    const id = callerId(ctx)
    await unlisten(ctx.app, String(id))
    await sysOf(ctx.app).member.update({ where: { id }, data: { chatToken: null, profileExternalId: null, chatSyncedAt: null } })
    return { profileExternalId: null }
  },
} as any)
