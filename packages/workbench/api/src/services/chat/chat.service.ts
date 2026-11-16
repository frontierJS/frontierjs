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
//   openDirect  the direct channel with one person, or a group with two to
//               seven { profileExternalIds }; joining and leaving a room are
//               channelMembers.create and .remove
//
// Member.chatToken and Member.profileExternalId are the system's to write,
// because a caller who could set profileExternalId could read every private
// channel of the profile named. The server answering the token IS the check
// that this member holds that profile, so nothing here takes a profile id.

import { createService } from '@frontierjs/junction'
import type { App, ServiceContext } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import { chatOn, followAs, land, listen, markUnreadAs, muteAs, openDirectAs, pinAs, profileOfCaller, readThreadAs, sysOf, unlisten, viewAs } from '../../providers/chat/index.ts'

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

/** A refusal from the server, as this app's status. */
const refused = (what: string, kind: string) =>
  fail(kind === 'forbidden' ? 403 : kind === 'not_found' || kind === 'gone' ? 404 : 502, `chat.${what}: the chat server refused (${kind})`)

export default createService({
  name:    'chat',
  model:   null,
  methods: [
    { method: 'status',     gate: LEVELS.CREATOR, read: true },
    { method: 'connect',    gate: LEVELS.CREATOR },
    { method: 'disconnect', gate: LEVELS.CREATOR },
    { method: 'view',       gate: LEVELS.CREATOR },
    { method: 'readThread', gate: LEVELS.CREATOR },
    { method: 'pin',        gate: LEVELS.CREATOR },
    { method: 'markUnread', gate: LEVELS.CREATOR },
    { method: 'mute',       gate: LEVELS.CREATOR },
    { method: 'follow',     gate: LEVELS.CREATOR },
    { method: 'openDirect', gate: LEVELS.CREATOR },
  ],

  async status (ctx: Ctx) {
    const m = await sysOf(ctx.app).member.findUnique({ where: { id: callerId(ctx) }, select: { profileExternalId: true, chatSyncedAt: true } })
    const profile = m?.profileExternalId
      ? await sysOf(ctx.app).profile.findUnique({ where: { externalId: m.profileExternalId }, select: { username: true } })
      : null
    return { server: chatOn(ctx.app), profileExternalId: m?.profileExternalId ?? null, username: profile?.username ?? null, syncedAt: m?.chatSyncedAt ?? null }
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
    if (r.error) throw refused('view', r.error.kind)
    return { channelExternalId: channel }
  },

  async readThread (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const root = idOf(ctx, 'rootExternalId')!
    const r = await readThreadAs(ctx.app, profile, root) as { error?: { kind: string } }
    if (r.error) throw refused('readThread', r.error.kind)
    return { rootExternalId: root }
  },

  async pin (ctx: Ctx) {
    serverOn(ctx)
    const post = idOf(ctx, 'postExternalId')!, pinned = flagOf(ctx, 'pinned')
    const r = await pinAs(ctx.app, post, pinned)
    if (r.error) throw refused('pin', r.error.kind)
    return { postExternalId: post, isPinned: pinned }
  },

  async markUnread (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const post = idOf(ctx, 'postExternalId')!
    const r = await markUnreadAs(ctx.app, profile, post)
    if (!r.row) throw refused('markUnread', r.error?.kind ?? 'no answer')
    return { postExternalId: post, channelExternalId: r.row.channelExternalId }
  },

  async mute (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const channel = idOf(ctx, 'channelExternalId')!, muted = flagOf(ctx, 'muted')
    const r = await muteAs(ctx.app, profile, channel, muted)
    if (r.error) throw refused('mute', r.error.kind)
    return { channelExternalId: channel, muted }
  },

  async follow (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const root = idOf(ctx, 'rootExternalId')!, following = flagOf(ctx, 'following')
    const r = await followAs(ctx.app, profile, root, following)
    if (r.error) throw refused('follow', r.error.kind)
    return { rootExternalId: root, following }
  },

  // A direct channel belongs to no team and its members are the two people,
  // so what is opened is read back whole: the channel, the profiles, the members.
  async openDirect (ctx: Ctx) {
    serverOn(ctx)
    const profile = await callerProfile(ctx)
    const r = await openDirectAs(ctx.app, profile, peopleOf(ctx, profile))
    if (!r.row) throw refused('openDirect', r.error?.kind ?? 'no answer')
    return { channelExternalId: r.row.externalId, type: r.row.type }
  },

  async disconnect (ctx: Ctx) {
    const id = callerId(ctx)
    await unlisten(ctx.app, String(id))
    await sysOf(ctx.app).member.update({ where: { id }, data: { chatToken: null, profileExternalId: null, chatSyncedAt: null } })
    return { profileExternalId: null }
  },
} as any)
