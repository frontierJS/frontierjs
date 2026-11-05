// @frontierjs/conduit-slack — Slack over conduit, both directions.
//
// Two targets from one builder, `slackTargets()`, because Slack has two ways in and they share
// nothing: a BOT TOKEN spends against `https://slack.com/api/*` and names the
// channel per message; an INCOMING WEBHOOK is a URL that IS the credential and
// names its channel itself. The first is an ordinary bearer target. The second
// is `address_from: 'request'` with `auth: none` (`FJS-1667`): the URL lives in
// the app's row, never in the registry, and conduit grades it against private
// and loopback addresses before every attempt.
//
// Slack says *failed* inside a 200 (`{ ok: false, error }`), so every Web API
// call carries `okEnvelope` (C4). A post is never keyed and never replayable:
// Slack collapses nothing, and a second attempt is a second message in the
// channel. A 429, a 5xx and a lost response come back to the caller with
// `retryable` and `retryAfterMs`; there is no read that says whether a lost
// post landed short of `conversations.history`, which is out of scope here.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { okEnvelope, translate, type SlackFailure } from './errors.ts'
import { assertBlocks } from './blocks.ts'
import type { Message, PostedMessage, WebhookMessage } from './types.ts'

export * from './types.ts'
export * from './blocks.ts'
export * from './errors.ts'
export * from './verify.ts'

export const SLACK_TARGET         = 'provider:slack'
export const SLACK_ADDRESS        = 'https://slack.com'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
/** One Send per way in. Every call below takes this and picks its own. */
export interface SlackSend { api: Send; webhook: Send }

export interface SlackTargets { api: TargetDescriptor; webhook: TargetDescriptor }

/**
 * `api` is the bot-token target: bearer, JSON on the wire with the charset
 * stated, which Slack requires or it reads the body as form data and answers
 * `invalid_form_data`. `id` is its id, one per WORKSPACE where the token is a
 * tenant's (`provider:slack:<teamId>`), one per process where it is the app's
 * own; the webhook's is `<id>:webhook`.
 *
 * `webhook` is the incoming-webhook target. `address` is empty and each send
 * names its URL, which is the credential, so `auth` is `none`.
 * `destinations` is OFF in production: a pasted URL that resolves to a private
 * or loopback address is the SSRF primitive, and the grade runs before every
 * attempt. A drive with its sink on localhost passes
 * `{ allowHttp: true, allowPrivate: true }` and says so; nothing else does.
 */
export function slackTargets(opts: { ref?: string; address?: string; id?: string; webhookDestinations?: { allowHttp?: boolean; allowPrivate?: boolean } } = {}): SlackTargets {
  const id = opts.id ?? SLACK_TARGET
  return {
    api: {
      id,
      kind:          'provider',
      protocol:      'http',
      address:       (opts.address ?? SLACK_ADDRESS).replace(/\/$/, ''),
      auth:          { type: 'bearer', ref: opts.ref ?? 'SLACK_BOT_TOKEN' },
      registered_at: Date.now(),
      last_seen_at:  null,
    },
    webhook: {
      id:            `${id}:webhook`,
      kind:          'provider',
      protocol:      'http',
      address:       '',
      address_from:  'request',
      auth:          { type: 'none' },
      ...(opts.webhookDestinations ? { destinations: opts.webhookDestinations } : {}),
      registered_at: Date.now(),
      last_seen_at:  null,
    },
  }
}

export function bindSlack(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, targets: SlackTargets | { api: { id: string }; webhook: { id: string } } = slackTargets()): SlackSend {
  return {
    api:     req => conduit.send({ target: targets.api.id, ...req }),
    webhook: req => conduit.send({ target: targets.webhook.id, ...req }),
  }
}

function assertSaysSomething(msg: { text?: string; blocks?: unknown[] }): void {
  if (!msg.text && !msg.blocks?.length) throw new TypeError('slack: a message needs text or blocks; Slack answers no_text for neither')
  assertBlocks(msg.blocks as never)
}

/**
 * `POST /api/chat.postMessage`. `thread_ts` replies in a thread. Unkeyed and
 * not replayable: Slack posts every request it receives, so a retry here is a
 * duplicate in the channel, and a 429's wait is handed back for the caller.
 */
export async function postMessage(slack: SlackSend, msg: Message): Promise<{ posted?: PostedMessage; error?: SlackFailure }> {
  if (!msg.channel) throw new TypeError('slack: a message needs a channel')
  assertSaysSomething(msg)
  const body: Record<string, unknown> = { channel: msg.channel }
  if (msg.text !== undefined)      body.text = msg.text
  if (msg.blocks !== undefined)    body.blocks = msg.blocks
  if (msg.thread_ts !== undefined) body.thread_ts = msg.thread_ts
  const r = await slack.api<PostedMessage>({ method: 'POST', path: '/api/chat.postMessage', body, validate: okEnvelope })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { posted: r.data }
}

/**
 * `POST <url>` to an incoming webhook. Slack answers `text/plain: ok` on
 * success, which conduit hands over as the string. A 404 `no_service` is the
 * webhook deleted at Slack — the app's row is dead, `kind: 'gone'`.
 */
export async function postWebhook(slack: SlackSend, url: string, msg: WebhookMessage): Promise<{ ok: true; error?: undefined } | { ok: false; error: SlackFailure }> {
  if (!/^https?:\/\//.test(url)) throw new TypeError('slack: a webhook URL must be absolute http(s)')
  assertSaysSomething(msg)
  const body: Record<string, unknown> = {}
  if (msg.text !== undefined)   body.text = msg.text
  if (msg.blocks !== undefined) body.blocks = msg.blocks
  const r = await slack.webhook<string>({ method: 'POST', address: url, body })
  if (r.error) return { ok: false, error: translate(r.error, r.meta.status) }
  if (r.data !== 'ok') return { ok: false, error: { kind: 'invalid_response', message: `Slack webhook answered '${String(r.data).slice(0, 64)}' rather than ok`, retryable: false } }
  return { ok: true }
}
