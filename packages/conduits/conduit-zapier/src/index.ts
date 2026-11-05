// @frontierjs/conduit-zapier — Zapier over conduit.
//
// Zapier reaches an app two ways and both are a URL the app HOLDS: a Catch
// Hook (Webhooks by Zapier) pasted into a form's integrations field, and a
// REST Hook `target_url` Zapier sends when a Zap subscribes to one of the
// app's own triggers. Neither carries a credential beyond the URL, so the
// target is `address_from: 'request'` with `auth: none`, the shape slack's
// incoming webhook settled: the URL lives in the app's row, never in the
// registry, and conduit grades it against private and loopback addresses
// before every attempt. The host is not pinned, because the same form field
// takes an IFTTT or Make URL beside a Zapier one. What is Zapier's here is
// how the answer is read — 404 is the Zap off, 410 is the hook unsubscribed
// — plus the reverse unsubscribe and the subscribe body's reader, which DOES
// pin the host: a forged subscribe naming a LAN address would have the app
// post inside its own network on every trigger.
//
// Where an app only needs to tell a counterparty that signed up for events
// something happened, junction's `plugins/webhooks` is the tool — signed,
// retried, a subscription row the counterparty owns. A Zapier hook is
// unsigned and the row is the app's, which is why it is a conduit target and
// not a webhooks subscriber (`FJS-D1528`).

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { hookEnvelope, translate, type ZapierFailure } from './errors.ts'
import { MAX_PAYLOAD_BYTES, MAX_URL_LENGTH, ZAPIER_HOOK_HOST, ZAPIER_TARGET, type HookPayload, type HookReceipt, type SubscriptionRead } from './types.ts'

export * from './types.ts'
export * from './errors.ts'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

export interface ZapierTargetOptions {
  id?: string
  /**
   * OFF in production: a pasted URL that resolves to a private or loopback
   * address is the SSRF primitive, and conduit's grade runs before every
   * attempt. A drive with its sink on localhost passes
   * `{ allowHttp: true, allowPrivate: true }` and says so; nothing else does.
   */
  destinations?: { allowHttp?: boolean; allowPrivate?: boolean }
}

/** One per process: the URL is the credential and rides each send, so there is nothing per account to hold. */
export function zapierTarget(opts: ZapierTargetOptions = {}): TargetDescriptor {
  return {
    id:            opts.id ?? ZAPIER_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       '',
    address_from:  'request',
    auth:          { type: 'none' },
    ...(opts.destinations ? { destinations: opts.destinations } : {}),
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = ZAPIER_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

type Outcome<T> = { result?: T; error?: ZapierFailure }
const refuse = (message: string): { error: ZapierFailure } => ({ error: { kind: 'refused', message, retryable: false } })

/** What C9 can say about a hook URL before the send; what it may REACH is conduit's grade. */
const checkUrl = (url: unknown): string | null => {
  if (typeof url !== 'string' || !url) return 'a hook URL is required'
  if (url.length > MAX_URL_LENGTH) return `a hook URL is at most ${MAX_URL_LENGTH} characters`
  let u: URL
  try { u = new URL(url) } catch { return 'a hook URL is absolute' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `a hook URL is http(s), not ${u.protocol}`
  if (u.username || u.password) return 'a hook URL carries no credentials; the URL is the credential'
  return null
}

/**
 * `POST <url>` with the payload as JSON. Unkeyed and unreplayable (C5):
 * Zapier runs the Zap once per request it takes and collapses nothing, so a
 * second attempt is a second run. A 429, a 5xx and a lost response come back
 * with `retryable` and `retryAfterMs`; a lost one is `indeterminate` and
 * nothing resolves it — Zap history has no API (C6, slack's amendment).
 *
 * A 404 is `off`: the Zap is turned off or deleted, and Zapier keeps
 * answering 200 for hours after the switch, so the app learns late. A 410 is
 * `gone`: the REST Hook was unsubscribed and the subscription row is dead.
 */
export async function postHook(send: Send, url: string, payload: HookPayload, opts: { headers?: Record<string, string> } = {}): Promise<Outcome<HookReceipt>> {
  const bad = checkUrl(url); if (bad) return refuse(bad)
  if (!payload || typeof payload !== 'object') return refuse('a payload is an object or an array; Zapier reads its keys as fields')
  const bytes = Buffer.byteLength(JSON.stringify(payload))
  if (bytes > MAX_PAYLOAD_BYTES) return refuse(`payload is ${bytes} bytes; Zapier takes ${MAX_PAYLOAD_BYTES}`)
  const r = await send<Omit<HookReceipt, 'status'> | null>({ method: 'POST', address: url, body: payload, headers: opts.headers, validate: hookEnvelope })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { result: { status: r.meta.status ?? 200, ...(r.data ?? { silent: true }) } }
}

/**
 * The reverse unsubscribe Zapier documents: `DELETE <target_url>` pauses the
 * Zap, for an app that stops delivering after repeated refusals. Idempotent
 * at Zapier, so `replayable: true` and conduit retries a lost one. A hook
 * already gone (410) or a Zap already off (404) is the state asked for, and
 * answers `already: true`.
 */
export async function unsubscribe(send: Send, targetUrl: string): Promise<Outcome<{ already: boolean }>> {
  const bad = checkUrl(targetUrl); if (bad) return refuse(bad)
  const r = await send<unknown>({ method: 'DELETE', address: targetUrl, replayable: true })
  if (!r.error) return { result: { already: false } }
  const failure = translate(r.error, r.meta.status)
  if (failure.kind === 'gone' || failure.kind === 'off') return { result: { already: true } }
  return { error: failure }
}

/**
 * Reads a REST Hook subscribe as Zapier sends it, before the app writes the
 * row. Here the host IS pinned where `postHook`'s is not: Zapier only ever
 * sends `hooks.zapier.com`, and a forged subscribe naming a LAN host would
 * have the app post its events inside its own network on every trigger.
 * `hosts` widens it for a sink and nothing else; under the default, https is
 * required too.
 */
export function subscriptionFrom(body: unknown, opts: { hosts?: string[] } = {}): SubscriptionRead {
  const hosts = opts.hosts ?? [ZAPIER_HOOK_HOST]
  if (!body || typeof body !== 'object') return { ok: false, reason: 'a subscribe body is an object' }
  const o = body as Record<string, unknown>
  const raw = o.targetUrl ?? o.target_url ?? o.hookUrl ?? o.hook_url
  if (typeof raw !== 'string' || !raw) return { ok: false, reason: 'no target_url' }
  const bad = checkUrl(raw); if (bad) return { ok: false, reason: bad }
  const u = new URL(raw)
  if (!hosts.includes(u.host)) return { ok: false, reason: `target_url host ${u.host} is not Zapier's` }
  if (!opts.hosts && u.protocol !== 'https:') return { ok: false, reason: 'target_url is https' }
  return { ok: true, subscription: { targetUrl: raw, ...(typeof o.event === 'string' && o.event ? { event: o.event } : {}) } }
}
