// src/receive.ts — what Mattermost DELIVERS to an app over HTTP, as two
// Dialects for `app.conduit.receive()` (`FJS-D899`): the outgoing webhook,
// fired when a post in a channel starts with a trigger word, and the slash
// command, fired when a person types `/something`. The socket is a
// `broker` target with a FrameDialect, in `socket.ts` (`FJS-D1127`).
//
// Mattermost SIGNS NOTHING. Each webhook and each command carries its own
// static token, in the body as `token` and — on a slash command, and on a
// webhook from a recent server — in `Authorization: Token <t>`. The verifier
// is a constant-time compare of every token present against the credential
// the app holds for THAT hook; the replay guard is not the verifier but the
// dedupe key, since a captured request verifies forever: the webhook's is the
// post's id and the command's is Mattermost's `trigger_id`, minted once per
// invocation. Mattermost retries neither delivery, so a duplicate here is a
// second hook on the same post, not a redelivery.
//
// The answer body is conduit's (`{ received, outcome }`), and Mattermost reads
// a body with no `text` as *nothing to post*, so a reply is a SEND: a command
// answers through its `response_url` with `respond()`, a webhook answers with
// `postMessage()` as the bot, `rootExternalId` the triggering post. The
// receiver's `apply` runs after verify, so both spend nothing on a forgery.

import { timingSafeEqual } from 'node:crypto'
import type { Delivery, Dialect, ReceivedEvent, Verdict } from '@frontierjs/conduit'
import { translate, type MattermostFailure } from './errors.ts'
import type { MattermostSend } from './index.ts'
import type { MattermostId } from './types.ts'

// ─── Envelopes ───────────────────────────────────────────────

/** The outgoing webhook's body, form-encoded or JSON as the hook was configured. `timestamp` is the post's `create_at`. */
export interface OutgoingWebhookPayload {
  token: string; team_id: MattermostId; team_domain: string
  channel_id: MattermostId; channel_name: string
  timestamp: number | string; user_id: MattermostId; user_name: string
  post_id: MattermostId; text: string; trigger_word: string
  /** Comma-separated, or absent. */
  file_ids?: string
}

/** The slash command's body, form-encoded. `response_url` answers five more messages for 30 minutes. */
export interface SlashCommandPayload {
  token: string; team_id: MattermostId; team_domain: string
  channel_id: MattermostId; channel_name: string
  user_id: MattermostId; user_name: string
  command: string; text: string
  response_url: string; trigger_id: string
}

export interface WebhookEventPayload {
  postExternalId: MattermostId; channelExternalId: MattermostId; teamExternalId: MattermostId; profileExternalId: MattermostId
  channelName: string; teamDomain: string; userName: string
  triggerWord: string; text: string; fileExternalIds: MattermostId[]
  at: Date | null
}

export interface CommandEventPayload {
  /** `/weather` — the trigger with its slash. */
  command: string
  /** Everything typed after the trigger, untrimmed. */
  text: string
  responseUrl: string; triggerId: string
  channelExternalId: MattermostId; teamExternalId: MattermostId; profileExternalId: MattermostId
  channelName: string; teamDomain: string; userName: string
}

export interface MattermostWebhookEvent extends ReceivedEvent { type: 'webhook'; payload: WebhookEventPayload }
export interface MattermostCommandEvent extends ReceivedEvent { type: 'command'; payload: CommandEventPayload }

// ─── The verifier (C8, Postmark's family) ────────────────────

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
const fields = (d: Delivery): Record<string, unknown> => d.body && typeof d.body === 'object' && !Array.isArray(d.body) ? d.body as Record<string, unknown> : {}
// Junction's form parser hands a numeric-looking field back as a number, so every field is read as text.
const str = (v: unknown) => v === undefined || v === null ? '' : String(v)
const ID = /^[a-z0-9]{26}$/
const isId = (v: string): v is MattermostId => ID.test(v)

/**
 * Pure. Every token the request carries must match: the body's `token`, and
 * `Authorization: Token <t>` where the server sent one. A request with
 * neither is refused. The reason is for the log and never the response.
 */
export function verifyMattermostToken(opts: { token?: string | null; authorization?: string | null; credential: string | undefined }): Verdict {
  if (!opts.credential) return { ok: false, reason: 'no token is configured on this side' }
  const presented: string[] = []
  if (opts.token) presented.push(opts.token)
  if (opts.authorization) {
    if (!/^Token /.test(opts.authorization)) return { ok: false, reason: 'Authorization is not a Mattermost token' }
    presented.push(opts.authorization.slice(6).trim())
  }
  if (!presented.length) return { ok: false, reason: 'no token on the request' }
  for (const t of presented) if (!same(t, opts.credential)) return { ok: false, reason: 'token does not match' }
  return { ok: true }
}

const verify = (d: Delivery, cred: string): Verdict =>
  verifyMattermostToken({ token: str(fields(d).token), authorization: d.headers.authorization ?? null, credential: cred })

// ─── The dialects ────────────────────────────────────────────

/**
 * `app.conduit.receive({ provider: 'mattermost', path, dialect: mattermostWebhookDialect, credential, apply })`.
 * The credential is the hook's token; with several hooks at one path it is
 * a function of the delivery, chosen before the body is believed. A body
 * that is not a webhook's (no post, no channel, no author) is not an event.
 */
export const mattermostWebhookDialect: Dialect<string, MattermostWebhookEvent> = {
  verify,
  parse(d) {
    const f = fields(d)
    const postExternalId = str(f.post_id), channelExternalId = str(f.channel_id), profileExternalId = str(f.user_id), teamExternalId = str(f.team_id)
    if (!isId(postExternalId) || !isId(channelExternalId) || !isId(profileExternalId) || !isId(teamExternalId)) return null
    const ms = Number(str(f.timestamp))
    return {
      id: postExternalId, type: 'webhook',
      payload: {
        postExternalId, channelExternalId, teamExternalId, profileExternalId,
        channelName: str(f.channel_name), teamDomain: str(f.team_domain), userName: str(f.user_name),
        triggerWord: str(f.trigger_word), text: str(f.text),
        fileExternalIds: str(f.file_ids).split(',').map(s => s.trim()).filter(isId),
        at: Number.isFinite(ms) && ms > 0 ? new Date(ms) : null,
      },
    }
  },
  dedupeKey: (_d, ev) => `post:${ev.id}`,
}

/**
 * The slash command, configured in Mattermost as POST — conduit mounts a
 * receiver as `app.post`, so a command configured as GET reaches no route.
 * A body with no `trigger_id` is not an event: every supported server mints
 * one per invocation and it is the only thing that tells two identical
 * commands apart.
 */
export const mattermostCommandDialect: Dialect<string, MattermostCommandEvent> = {
  verify,
  parse(d) {
    const f = fields(d)
    const command = str(f.command), triggerId = str(f.trigger_id), responseUrl = str(f.response_url)
    const channelExternalId = str(f.channel_id), profileExternalId = str(f.user_id), teamExternalId = str(f.team_id)
    if (!command.startsWith('/') || !triggerId || !isId(channelExternalId) || !isId(profileExternalId) || !isId(teamExternalId)) return null
    return {
      id: triggerId, type: 'command',
      payload: {
        command, text: str(f.text), responseUrl, triggerId,
        channelExternalId, teamExternalId, profileExternalId,
        channelName: str(f.channel_name), teamDomain: str(f.team_domain), userName: str(f.user_name),
      },
    }
  },
  dedupeKey: (_d, ev) => `command:${ev.id}`,
}

// ─── The reply ───────────────────────────────────────────────

/** What a command answers. `ephemeral` is the default and only the person sees it; `in_channel` is a post. */
export interface CommandReply {
  text?:              string
  responseType?:      'ephemeral' | 'in_channel'
  /** Mattermost's message attachments, passed through. Required where `text` is absent. */
  attachments?:       unknown[]
  props?:             Record<string, unknown>
  /** A URL the person's client opens. */
  gotoLocation?:      string
  username?:          string
  iconUrl?:           string
  /** Another channel to post in; the command's own is the default. */
  channelExternalId?: MattermostId
}

/**
 * `POST` the reply to a command's `response_url` — an unauthenticated address
 * on the Mattermost origin, good for five messages inside 30 minutes of the
 * command. It goes through `api`, with whichever bearer the bundle was bound
 * `as`, which the hook ignores. Unkeyed and unreplayable: a lost answer is `indeterminate`
 * and nothing lists what a response URL posted (C6, slack's amendment), so a
 * second attempt may show the person two replies.
 */
export async function respond(mm: MattermostSend, responseUrl: string, reply: CommandReply): Promise<{ error?: MattermostFailure }> {
  if (!/^https?:\/\//.test(responseUrl)) throw new TypeError('mattermost: responseUrl is the command\'s response_url, an http(s) URL')
  if (!reply.text?.trim() && !reply.attachments?.length) throw new TypeError('mattermost: a reply needs text or attachments')
  const body = {
    ...(reply.text !== undefined ? { text: reply.text } : {}),
    ...(reply.responseType ? { response_type: reply.responseType } : {}),
    ...(reply.attachments ? { attachments: reply.attachments } : {}),
    ...(reply.props ? { props: reply.props } : {}),
    ...(reply.gotoLocation ? { goto_location: reply.gotoLocation } : {}),
    ...(reply.username ? { username: reply.username } : {}),
    ...(reply.iconUrl ? { icon_url: reply.iconUrl } : {}),
    ...(reply.channelExternalId ? { channel_id: reply.channelExternalId } : {}),
  }
  const r = await mm.api<unknown>({ method: 'POST', address: responseUrl, body })
  return r.error ? { error: translate(r.error, r.meta.status, r.meta.headers) } : {}
}
