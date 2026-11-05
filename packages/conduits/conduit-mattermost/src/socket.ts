// src/socket.ts — what Mattermost PUSHES over the WebSocket the app dials, as
// a `broker` target and a FrameDialect for `app.conduit.receive({ target })`
// (`FJS-D1127`). Conduit holds the connection, reconnects without bound and
// reports `health()`; this file is only Mattermost's framing and its events.
//
// Mattermost sends a channel's events only to that channel's members — no
// role, admin or bot, widens it (server `ShouldSendEvent`) — so a mirror that
// shows people their private and direct channels holds one socket PER PERSON,
// on that person's token (`FJS-D1153`), as Mattermost's own clients do. The
// same post reaches every member's socket and lands once by its key.
//
// The dial carries `Authorization: Bearer` from the target's auth, and the
// handshake sends `authentication_challenge` with the same token, because a
// server reads one or the other and which is unverified; `hello` is the
// success signal either way and a `FAIL` reply to the challenge is the
// refusal. Mattermost acks nothing and redelivers nothing, so a frame whose
// apply throws is gone from the socket and the REST backfill after the gap
// is what brings the row back (caravan, dispatched `unique`).
//
// `seq` restarts at 0 on every connection, so it names a frame only together
// with the connection: the key is `socket:<connection_id>:<seq>`, the id
// `hello` carries. Mattermost's resume (`connection_id` and `sequence_number`
// on the redial) is not built, so a reconnect is a new connection and its
// gap is the backfill's. A `seq` that skips ahead on one connection is a gap
// too — frames the server never sent — and the framing's `sequence` hands it
// to the receiver's `gap`, every event counted, the ones `parse` ignores too.

import type { BrokerFraming, BrokerMessage, FrameDialect, ReceivedEvent, TargetDescriptor } from '@frontierjs/conduit'
import { channelMemberModel, channelModel, fileInfoModel, postModel, profileModel, reactionModel, threadModel, type ChannelMemberRow, type ChannelRow, type FileInfoRow, type PostRow, type ProfileRow, type ReactionRow, type ThreadRow } from './mirror.ts'
import type { Channel, ChannelMember, FileInfo, MattermostId, Post, Reaction, User, UserThread } from './types.ts'

export const MATTERMOST_SOCKET_TARGET = 'broker:mattermost'

/**
 * One person's socket, dialed with their token: `id` and `ref` name the person
 * (`broker:mattermost:<profile>`), since a target holds one subscription.
 */
export function mattermostSocketTarget(opts: { address: string; ref?: string; id?: string }): TargetDescriptor {
  if (!opts.address || !/^https?:\/\//.test(opts.address)) throw new TypeError('mattermost: address is the instance\'s origin, https://chat.example — Mattermost is self-hosted and has no default')
  return {
    id: opts.id ?? MATTERMOST_SOCKET_TARGET, kind: 'broker', protocol: 'websocket',
    address: `${opts.address.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/v4/websocket`,
    auth: { type: 'bearer', ref: opts.ref ?? 'MATTERMOST_TOKEN' },
    registered_at: Date.now(), last_seen_at: null,
  }
}

// ─── Frames ──────────────────────────────────────────────────

/** One server frame. `data`'s `post` and `channel` are JSON STRINGS on the wire. */
export interface SocketFrame {
  event: string
  data: Record<string, unknown>
  broadcast: { user_id?: string; channel_id?: string; team_id?: string; omit_users?: Record<string, boolean> | null }
  seq: number
}

const readJson = (raw: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null }
}

export const mattermostFraming: BrokerFraming<string> = {
  async handshake(link, secret) {
    if (!secret) throw new Error('mattermost: the socket target has no token to present — its auth must be the service bearer')
    link.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: secret } }))
    const f = readJson(await link.next(raw => {
      const x = readJson(raw)
      return x?.event === 'hello' || (x?.seq_reply === 1 && x?.status === 'FAIL')
    }))!
    if (f.status === 'FAIL') throw new Error(`mattermost refused the socket token: ${String((f.error as { message?: unknown } | undefined)?.message ?? 'no reason given')}`)
    // A server older than reliable websockets sends no connection id; a fresh
    // one per connection keeps two connections' `seq` from colliding.
    const id = (f.data as { connection_id?: unknown } | undefined)?.connection_id
    return typeof id === 'string' && id ? id : `local-${crypto.randomUUID()}`
  },
  decode(raw, connection) {
    const f = readJson(raw)
    if (!f || typeof f.event !== 'string' || typeof f.seq !== 'number') return null
    return { id: `${connection}:${f.seq}`, body: f }
  },
  // Mattermost pushes nothing to a quiet person, so silence alone cannot tell a
  // dead connection from an idle one; the `ping` action is answered
  // `{ status: 'OK', seq_reply, data: { text: 'pong' } }` (seen on 11.5.1).
  // The challenge is seq 1, so the pings start at 2. A reply carries no
  // `event`, and an unknown action's `FAIL` is a reply too.
  keepalive: {
    ping: (n) => JSON.stringify({ seq: n + 1, action: 'ping' }),
    beat: (raw) => { const x = readJson(raw); return typeof x?.seq_reply === 'number' && x.event === undefined },
  },
  sequence: (m) => (m.body as SocketFrame).seq,
}

// ─── Events ──────────────────────────────────────────────────

/** The events a mirror lands. Every other event Mattermost pushes — `typing`, `status_change`, `hello` on a redial — is not an event here and writes no receipt. */
export type SocketEvent =
  /**
   * `mentions` are the people the post notifies — named, or the other side of a
   * direct channel — which is what a member's mention count counts. Only a
   * `posted` frame carries them; an edit notifies nobody again.
   */
  | (ReceivedEvent & { type: 'posted'; payload: { post: PostRow; files: FileInfoRow[]; mentions: MattermostId[]; channelType: string; senderName: string } })
  | (ReceivedEvent & { type: 'post_edited' | 'post_deleted'; payload: { post: PostRow; files: FileInfoRow[] } })
  | (ReceivedEvent & { type: 'channel_updated'; payload: { channel: ChannelRow } })
  | (ReceivedEvent & { type: 'channel_deleted'; payload: { channelExternalId: MattermostId; at: Date | null } })
  | (ReceivedEvent & { type: 'user_added' | 'user_removed'; payload: { channelExternalId: MattermostId; profileExternalId: MattermostId } })
  | (ReceivedEvent & { type: 'reaction_added' | 'reaction_removed'; payload: { reaction: ReactionRow } })
  /** The socket's person can now read a channel they could not: a mirror reads it whole, since no frame carries its history. */
  | (ReceivedEvent & { type: 'channel_created' | 'direct_added' | 'group_added'; payload: { channelExternalId: MattermostId } })
  | (ReceivedEvent & { type: 'user_updated'; payload: { profile: ProfileRow } })
  /**
   * The socket's person read channels somewhere — here, a phone, the web app.
   * `channel_viewed` names one and no time (it is now); a newer server sends
   * `multiple_channels_viewed` with each channel's time. Both are this one
   * person's, never a channel's.
   */
  | (ReceivedEvent & { type: 'channel_viewed'; payload: { profileExternalId: MattermostId; times: Record<MattermostId, Date | null> } })
  /** A membership changed in place — its notify props (mute) or its counts. */
  | (ReceivedEvent & { type: 'channel_member_updated'; payload: { member: ChannelMemberRow } })
  /** A followed thread changed: a reply, a read elsewhere. The row is the socket person's view. */
  | (ReceivedEvent & { type: 'thread_updated'; payload: { thread: ThreadRow; root: PostRow | null; teamExternalId: MattermostId | null } })
  /** A thread was read, or with no `rootExternalId` every thread on the team was. */
  | (ReceivedEvent & { type: 'thread_read_changed'; payload: { profileExternalId: MattermostId; rootExternalId: MattermostId | null; at: Date | null; unreadReplies: number; unreadMentions: number; teamExternalId: MattermostId | null } })
  | (ReceivedEvent & { type: 'thread_follow_changed'; payload: { profileExternalId: MattermostId; rootExternalId: MattermostId; following: boolean; replyCount: number; teamExternalId: MattermostId | null } })

const inner = <T>(v: unknown): T | null => typeof v === 'string' ? readJson(v) as T | null : null
const str = (v: unknown) => typeof v === 'string' ? v : ''
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0
const when = (v: unknown) => { const n = num(v); return n > 0 ? new Date(n) : null }
const ID = /^[a-z0-9]{26}$/
/** `mentions` is a JSON string of ids on the wire, absent when the post names nobody. */
const idList = (v: unknown): MattermostId[] => {
  const xs = typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return null } })() : v
  return Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string' && ID.test(x)) : []
}

export const mattermostSocketDialect: FrameDialect<SocketEvent> = {
  framing: mattermostFraming,
  parse(m: BrokerMessage): SocketEvent | null {
    const f = m.body as SocketFrame
    const data = f.data ?? {}, b = f.broadcast ?? {}
    switch (f.event) {
      case 'posted': case 'post_edited': case 'post_deleted': {
        const raw = inner<Post>(data.post)
        const post = postModel.parse(raw as Post)
        // A post's files ride in its `metadata`, as on a read (listPosts); a
        // frame that dropped them would land an image post with nothing to draw
        // until the next backfill.
        const meta = (raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}) as { files?: FileInfo[] }
        const files = (meta.files ?? []).map(x => fileInfoModel.parse(x)).filter((x): x is FileInfoRow => !!x)
        if (!post) return null
        if (f.event !== 'posted') return { id: m.id, type: f.event, payload: { post, files } }
        return { id: m.id, type: 'posted', payload: { post, files, mentions: idList(data.mentions), channelType: str(data.channel_type), senderName: str(data.sender_name) } }
      }
      case 'channel_updated': {
        const channel = channelModel.parse(inner<Channel>(data.channel) as Channel)
        return channel ? { id: m.id, type: 'channel_updated', payload: { channel } } : null
      }
      case 'channel_deleted': {
        const channelExternalId = str(data.channel_id)
        const at = Number(data.delete_at)
        return channelExternalId ? { id: m.id, type: 'channel_deleted', payload: { channelExternalId, at: at > 0 ? new Date(at) : null } } : null
      }
      case 'user_added': case 'user_removed': {
        // The removed user's own copy names the channel in `data`; everyone else's in `broadcast`.
        const channelExternalId = str(data.channel_id) || str(b.channel_id), profileExternalId = str(data.user_id) || str(b.user_id)
        return channelExternalId && profileExternalId ? { id: m.id, type: f.event, payload: { channelExternalId, profileExternalId } } : null
      }
      case 'reaction_added': case 'reaction_removed': {
        const reaction = reactionModel.parse(inner<Reaction>(data.reaction) as Reaction)
        return reaction ? { id: m.id, type: f.event, payload: { reaction } } : null
      }
      case 'channel_created': case 'direct_added': case 'group_added': {
        const channelExternalId = str(data.channel_id) || str(b.channel_id)
        return channelExternalId ? { id: m.id, type: f.event, payload: { channelExternalId } } : null
      }
      // `data.user` is an object here, not a JSON string, and sanitized for
      // anyone but its owner and an admin: no email in another person's copy.
      case 'user_updated': {
        const profile = profileModel.parse(data.user as User)
        return profile ? { id: m.id, type: 'user_updated', payload: { profile } } : null
      }
      case 'channel_viewed': {
        const channel = str(data.channel_id), user = str(b.user_id)
        return ID.test(channel) && ID.test(user) ? { id: m.id, type: 'channel_viewed', payload: { profileExternalId: user, times: { [channel]: when(data.last_viewed_at) } } } : null
      }
      case 'multiple_channels_viewed': {
        const user = str(b.user_id), raw = (data.channel_times && typeof data.channel_times === 'object' ? data.channel_times : {}) as Record<string, unknown>
        const times = Object.fromEntries(Object.entries(raw).filter(([id]) => ID.test(id)).map(([id, t]) => [id, when(t)]))
        return ID.test(user) && Object.keys(times).length ? { id: m.id, type: 'channel_viewed', payload: { profileExternalId: user, times } } : null
      }
      case 'channel_member_updated': {
        const member = channelMemberModel.parse(inner<ChannelMember>(data.channelMember) as ChannelMember)
        return member ? { id: m.id, type: 'channel_member_updated', payload: { member } } : null
      }
      // Pushed to the one follower, so the broadcast names whose view the thread is.
      case 'thread_updated': {
        const user = str(b.user_id), raw = inner<UserThread>(data.thread)
        if (!ID.test(user) || !raw) return null
        const thread = threadModel.parse(raw, { profileExternalId: user })
        return thread ? { id: m.id, type: 'thread_updated', payload: { thread, root: raw.post ? postModel.parse(raw.post) : null, teamExternalId: str(b.team_id) || null } } : null
      }
      case 'thread_read_changed': {
        const user = str(b.user_id), root = str(data.thread_id)
        if (!ID.test(user)) return null
        return { id: m.id, type: 'thread_read_changed', payload: {
          profileExternalId: user, rootExternalId: ID.test(root) ? root : null, at: when(data.timestamp),
          unreadReplies: num(data.unread_replies), unreadMentions: num(data.unread_mentions), teamExternalId: str(b.team_id) || null,
        } }
      }
      case 'thread_follow_changed': {
        const user = str(b.user_id), root = str(data.thread_id)
        return ID.test(user) && ID.test(root) ? { id: m.id, type: 'thread_follow_changed', payload: {
          profileExternalId: user, rootExternalId: root, following: data.state === true, replyCount: num(data.reply_count), teamExternalId: str(b.team_id) || null,
        } } : null
      }
      default: return null
    }
  },
  dedupeKey: (m) => `socket:${m.id}`,
}
