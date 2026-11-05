// src/mirror.ts — the mirror claim (`FJS-D1125`): for each noun a chat
// surface LISTS, how a Mattermost object becomes a row of the app's mirrored
// model, and which verbs the app's default service may forward here.
//
// The schema says only `@@mirror(key: externalId)` and no vendor; this file is
// where the vendor is. A row's relation columns hold the PROVIDER's ids under
// `<relation>ExternalId`, because the app's own foreign keys do not exist
// until the sync has written the related row — resolving one against the
// other is the sync's, through the key the schema names, never this file's.
//
// Where Mattermost has no id for a noun the key is composed here, once per
// model, and `delete` reads it back through the same function: a member is
// `channel:user`, a reaction `post:user:emoji`. A thread is one USER's view of
// a root post, and the user is the request's, so `parse` takes it as `scope`.
//
// A verb answers a request with no `target`; the model names the target it
// spends, and every human verb spends the per-user one (rule 3 of
// `IDEAS/mirror-apps.md`): a message is posted as its author or not at all.
// The app binds the claim with `app.conduit.mirror(mirror)`, and conduit's
// forward runs these verbs for the app's generated writes.

import type { MirrorClaim, MirrorModel } from '@frontierjs/conduit'
import type { Channel, ChannelMember, ChannelPatch, FileInfo, MattermostId, NewChannel, NewPost, Post, PostPatch, Reaction, Team, User, UserThread } from './types.ts'

export const MATTERMOST_TARGET        = 'provider:mattermost'
export const MATTERMOST_USER_TARGET   = 'provider:mattermost:user'
export const MATTERMOST_UPLOAD_TARGET = 'provider:mattermost:upload'
const API = '/api/v4'

/** What a response does not carry and the request did. */
export interface MirrorScope { profileExternalId?: MattermostId }

// ─── Rows ────────────────────────────────────────────────────

const at    = (ms: number | undefined) => ms ? new Date(ms) : null
const ID    = /^[a-z0-9]{26}$/
const isId  = (v: unknown): v is MattermostId => typeof v === 'string' && ID.test(v)
const need  = (v: unknown, what: string) => { if (!isId(v)) throw new TypeError(`mattermost: ${what} is not a Mattermost id`); return v }
const text  = (v: string | undefined, what: string) => { if (typeof v !== 'string' || !v.trim()) throw new TypeError(`mattermost: ${what} is required`); return v }

export interface TeamRow {
  externalId: string; name: string; displayName: string; description: string
  type: 'open' | 'invite'; allowOpenInvite: boolean
  createdAt: Date | null; updatedAt: Date | null; deletedAt: Date | null
}
export interface ChannelRow {
  externalId: string; teamExternalId: string | null; creatorExternalId: string | null
  type: 'open' | 'private' | 'direct' | 'group'
  name: string; displayName: string; header: string; purpose: string
  lastPostAt: Date | null; totalMessageCount: number
  /** Root posts only: what a room's unread badge counts, replies being Threads'. */
  totalMessageCountRoot: number; lastRootPostAt: Date | null
  createdAt: Date | null; updatedAt: Date | null; deletedAt: Date | null
}
export interface ChannelMemberRow {
  externalId: string; channelExternalId: string; profileExternalId: string
  roles: string; isAdmin: boolean; lastViewedAt: Date | null; messageCount: number; mentionCount: number
  messageCountRoot: number; mentionCountRoot: number
  /** `notify_props.mark_unread` is `mention`: the room is unread only when it mentions the member. */
  muted: boolean
  updatedAt: Date | null
}
export interface PostRow {
  externalId: string; channelExternalId: string; profileExternalId: string; rootExternalId: string | null
  message: string; type: string; isPinned: boolean; props: Record<string, unknown>; hashtags: string
  replyCount: number; lastReplyAt: Date | null
  createdAt: Date | null; updatedAt: Date | null; editedAt: Date | null; deletedAt: Date | null
}
export interface ThreadRow {
  externalId: string; rootExternalId: string; profileExternalId: string
  replyCount: number; lastReplyAt: Date | null; lastViewedAt: Date | null
  unreadReplies: number; unreadMentions: number
  isFollowing: boolean
}
export interface ReactionRow {
  externalId: string; postExternalId: string; profileExternalId: string; emojiName: string; createdAt: Date | null
}
export interface ProfileRow {
  externalId: string; username: string; firstName: string; lastName: string; nickname: string
  /**
   * Absent when Mattermost did not say: it sanitizes another person's address
   * to '' for anyone but its owner and an admin, so an empty one is withheld,
   * not cleared, and landing it must leave a known address alone. The same
   * privacy setting blanks `first_name` and `last_name`, which stay as read:
   * a person may have no first name, so '' there says nothing either way.
   */
  email?: string; roles: string; locale: string | null; isBot: boolean
  createdAt: Date | null; updatedAt: Date | null; deletedAt: Date | null
}
export interface FileInfoRow {
  externalId: string; postExternalId: string | null; profileExternalId: string
  name: string; extension: string; size: number; mimeType: string
  width: number | null; height: number | null; hasPreviewImage: boolean
  createdAt: Date | null; updatedAt: Date | null; deletedAt: Date | null
}

const TEAM_TYPE    = { O: 'open', I: 'invite' } as const
const CHANNEL_TYPE = { O: 'open', P: 'private', D: 'direct', G: 'group' } as const
const CHANNEL_CODE = { open: 'O', private: 'P' } as const

export const memberKey   = (channelId: string, userId: string) => `${channelId}:${userId}`
export const reactionKey = (postId: string, userId: string, emoji: string) => `${postId}:${userId}:${emoji}`
export const threadKey   = (userId: string, rootId: string) => `${userId}:${rootId}`

function splitKey(key: string, parts: number, what: string): string[] {
  const xs = key.split(':')
  if (xs.length !== parts || xs.some(x => !x)) throw new TypeError(`mattermost: a ${what} key is ${parts} parts joined by ':'`)
  return xs
}

// ─── The claim ───────────────────────────────────────────────

export const teamModel: MirrorModel<TeamRow, Team> = {
  key: 'externalId', target: MATTERMOST_TARGET,
  parse(t) {
    if (!t || !isId(t.id)) return null
    return {
      externalId: t.id, name: t.name, displayName: t.display_name, description: t.description ?? '',
      type: TEAM_TYPE[t.type] ?? 'invite', allowOpenInvite: !!t.allow_open_invite,
      createdAt: at(t.create_at), updatedAt: at(t.update_at), deletedAt: at(t.delete_at),
    }
  },
}

export const channelModel: MirrorModel<ChannelRow, Channel, NewChannel, ChannelPatch> = {
  key: 'externalId', target: MATTERMOST_USER_TARGET,
  parse(c) {
    if (!c || !isId(c.id)) return null
    return {
      externalId: c.id, teamExternalId: c.team_id || null, creatorExternalId: c.creator_id || null,
      type: CHANNEL_TYPE[c.type] ?? 'open',
      name: c.name, displayName: c.display_name, header: c.header ?? '', purpose: c.purpose ?? '',
      lastPostAt: at(c.last_post_at), totalMessageCount: c.total_msg_count ?? 0,
      totalMessageCountRoot: c.total_msg_count_root ?? 0, lastRootPostAt: at(c.last_root_post_at),
      createdAt: at(c.create_at), updatedAt: at(c.update_at), deletedAt: at(c.delete_at),
    }
  },
  create(input) {
    const type = CHANNEL_CODE[input.type]
    if (!type) throw new TypeError(`mattermost: a channel is created 'open' or 'private'; a direct or group channel is made by its members`)
    return { method: 'POST', path: `${API}/channels`, body: {
      team_id: need(input.teamExternalId, 'teamExternalId'), name: text(input.name, 'name'), display_name: text(input.displayName, 'displayName'), type,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}), ...(input.header !== undefined ? { header: input.header } : {}),
    } }
  },
  update(id, patch) {
    const body: Record<string, unknown> = {}
    if (patch.name !== undefined)        body.name = patch.name
    if (patch.displayName !== undefined) body.display_name = patch.displayName
    if (patch.purpose !== undefined)     body.purpose = patch.purpose
    if (patch.header !== undefined)      body.header = patch.header
    return { method: 'PUT', path: `${API}/channels/${need(id, 'externalId')}/patch`, body }
  },
  delete(id) { return { method: 'DELETE', path: `${API}/channels/${need(id, 'externalId')}` } },
}

export const channelMemberModel: MirrorModel<ChannelMemberRow, ChannelMember, { channelExternalId: string; profileExternalId: string }> = {
  key: 'externalId', target: MATTERMOST_USER_TARGET,
  parse(m) {
    if (!m || !isId(m.channel_id) || !isId(m.user_id)) return null
    return {
      externalId: memberKey(m.channel_id, m.user_id), channelExternalId: m.channel_id, profileExternalId: m.user_id,
      roles: m.roles ?? '', isAdmin: !!m.scheme_admin, lastViewedAt: at(m.last_viewed_at),
      messageCount: m.msg_count ?? 0, mentionCount: m.mention_count ?? 0,
      messageCountRoot: m.msg_count_root ?? 0, mentionCountRoot: m.mention_count_root ?? 0,
      muted: m.notify_props?.mark_unread === 'mention', updatedAt: at(m.last_update_at),
    }
  },
  create(input) {
    return { method: 'POST', path: `${API}/channels/${need(input.channelExternalId, 'channelExternalId')}/members`, body: { user_id: need(input.profileExternalId, 'profileExternalId') } }
  },
  delete(key) {
    const [channel, user] = splitKey(key, 2, 'member')
    return { method: 'DELETE', path: `${API}/channels/${need(channel, 'channel')}/members/${need(user, 'user')}` }
  },
}

export const postModel: MirrorModel<PostRow, Post, NewPost, PostPatch> = {
  key: 'externalId', target: MATTERMOST_USER_TARGET,
  parse(p) {
    if (!p || !isId(p.id) || !isId(p.channel_id)) return null
    return {
      externalId: p.id, channelExternalId: p.channel_id, profileExternalId: p.user_id, rootExternalId: p.root_id || null,
      message: p.message ?? '', type: p.type ?? '', isPinned: !!p.is_pinned, props: p.props ?? {}, hashtags: p.hashtags ?? '',
      replyCount: p.reply_count ?? 0, lastReplyAt: at(p.last_reply_at),
      createdAt: at(p.create_at), updatedAt: at(p.update_at), editedAt: at(p.edit_at), deletedAt: at(p.delete_at),
    }
  },
  // Unkeyed and unreplayable unless the caller states `pendingPostId`: the
  // server collapses a repeat under it inside its window, so conduit may replay
  // a timed-out post and the channel holds one message. Without it a lost
  // answer is `indeterminate` and nothing lists a post by what the caller sent.
  // A post of files alone is one Mattermost takes, so with any the message may be empty.
  create(input) {
    const files = input.fileExternalIds ?? []
    if (!Array.isArray(files) || !files.every(isId)) throw new TypeError('mattermost: fileExternalIds is a list of Mattermost file ids, from uploadFile')
    const message = files.length ? (typeof input.message === 'string' ? input.message : '') : text(input.message, 'message')
    const body: Record<string, unknown> = { channel_id: need(input.channelExternalId, 'channelExternalId'), message }
    if (files.length)          body.file_ids = files
    if (input.rootExternalId)  body.root_id = need(input.rootExternalId, 'rootExternalId')
    if (input.props)           body.props = input.props
    if (input.pendingPostId)   body.pending_post_id = input.pendingPostId
    return { method: 'POST', path: `${API}/posts`, body, ...(input.pendingPostId ? { replayable: true } : {}) }
  },
  // `/patch` and not `PUT /posts/{id}`: the latter replaces the post, so a body
  // that omits `message` blanks it.
  update(id, patch) {
    const body: Record<string, unknown> = {}
    if (patch.message !== undefined)  body.message = text(patch.message, 'message')
    if (patch.isPinned !== undefined) body.is_pinned = patch.isPinned
    if (patch.props !== undefined)    body.props = patch.props
    return { method: 'PUT', path: `${API}/posts/${need(id, 'externalId')}/patch`, body }
  },
  delete(id) { return { method: 'DELETE', path: `${API}/posts/${need(id, 'externalId')}` } },
}

export const threadModel: MirrorModel<ThreadRow, UserThread, never, never, MirrorScope> = {
  key: 'externalId', target: MATTERMOST_USER_TARGET,
  parse(t, scope) {
    if (!t || !isId(t.id)) return null
    const user = scope?.profileExternalId
    if (!isId(user)) throw new TypeError('mattermost: a thread is one user\'s view, so Thread.parse needs scope.profileExternalId')
    return {
      externalId: threadKey(user, t.id), rootExternalId: t.id, profileExternalId: user,
      replyCount: t.reply_count ?? 0, lastReplyAt: at(t.last_reply_at), lastViewedAt: at(t.last_viewed_at),
      unreadReplies: t.unread_replies ?? 0, unreadMentions: t.unread_mentions ?? 0,
      // Mattermost lists and pushes a thread only to its followers, so one it sent is followed unless it says not.
      isFollowing: t.is_following ?? true,
    }
  },
}

export const reactionModel: MirrorModel<ReactionRow, Reaction, { postExternalId: string; profileExternalId: string; emojiName: string }> = {
  key: 'externalId', target: MATTERMOST_USER_TARGET,
  parse(r) {
    if (!r || !isId(r.post_id) || !isId(r.user_id) || !r.emoji_name) return null
    return { externalId: reactionKey(r.post_id, r.user_id, r.emoji_name), postExternalId: r.post_id, profileExternalId: r.user_id, emojiName: r.emoji_name, createdAt: at(r.create_at) }
  },
  create(input) {
    if (!/^[a-z0-9_+-]+$/.test(input.emojiName ?? '')) throw new TypeError('mattermost: an emoji name is its short code without colons — thumbsup')
    return { method: 'POST', path: `${API}/reactions`, body: { post_id: need(input.postExternalId, 'postExternalId'), user_id: need(input.profileExternalId, 'profileExternalId'), emoji_name: input.emojiName } }
  },
  delete(key) {
    const [post, user, emoji] = splitKey(key, 3, 'reaction')
    return { method: 'DELETE', path: `${API}/users/${need(user, 'user')}/posts/${need(post, 'post')}/reactions/${encodeURIComponent(emoji)}` }
  },
}

export const profileModel: MirrorModel<ProfileRow, User> = {
  key: 'externalId', target: MATTERMOST_TARGET,
  parse(u) {
    if (!u || !isId(u.id) || !u.username) return null
    return {
      externalId: u.id, username: u.username, firstName: u.first_name ?? '', lastName: u.last_name ?? '', nickname: u.nickname ?? '',
      ...(u.email ? { email: u.email } : {}), roles: u.roles ?? '', locale: u.locale || null, isBot: !!u.is_bot,
      createdAt: at(u.create_at), updatedAt: at(u.update_at), deletedAt: at(u.delete_at),
    }
  },
}

export const fileInfoModel: MirrorModel<FileInfoRow, FileInfo> = {
  key: 'externalId', target: MATTERMOST_TARGET,
  parse(f) {
    if (!f || !isId(f.id)) return null
    return {
      externalId: f.id, postExternalId: f.post_id || null, profileExternalId: f.user_id,
      name: f.name, extension: f.extension ?? '', size: f.size ?? 0, mimeType: f.mime_type ?? 'application/octet-stream',
      width: f.width ?? null, height: f.height ?? null, hasPreviewImage: !!f.has_preview_image,
      createdAt: at(f.create_at), updatedAt: at(f.update_at), deletedAt: at(f.delete_at),
    }
  },
}

/** What `app.conduit.mirror(mattermost.mirror)` binds: the models of `IDEAS/mirror-apps.md` § Mattermost nouns marked mirrored. */
export const mirror: MirrorClaim = {
  provider: 'mattermost',
  models:   { Team: teamModel, Channel: channelModel, ChannelMember: channelMemberModel, Post: postModel, Thread: threadModel, Reaction: reactionModel, Profile: profileModel, FileInfo: fileInfoModel },
}
