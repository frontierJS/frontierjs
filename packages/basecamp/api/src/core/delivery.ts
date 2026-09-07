// src/core/delivery.ts — how a NotificationChannel is actually reached.
//
// ONE OWNER, and it has two callers: `channels.test` (a person pressing the
// button) and the alert evaluator (a cron, at 3am, with nobody watching). The
// per-kind table below decides where a request goes, what credential it
// carries and what the body looks like, and copying it into the second caller
// is the failure Invariant 4 names — a kind added to one table and not the
// other is a channel that tests green and never delivers.
//
// It takes its client and its conduit as ARGUMENTS rather than reading `$`.
// The ambient call context is a request's; a job has none, and a module that
// reached for `$.db` would work from the service and throw from the cron.
//
// ─── The credential is never here ────────────────────────────────────────
//
// A Slack webhook URL and a PagerDuty routing key are bearer credentials. They
// live in a `Secret` (`@encrypted`), are read at send time, and a target's
// stored ADDRESS is the origin only — never the full URL, because the secret
// part of a Slack webhook is its path and a target address is echoed by
// `GET /conduit-targets`.

import { secretRef } from './credentials.ts'

// ─── What a caller says ──────────────────────────────────────────────────

/** One message, in this app's own words. Each kind renders it its own way. */
export interface Message {
  title:    string
  text:     string
  severity: 'info' | 'warning' | 'critical'
  /** `trigger` opens, `resolve` closes, `test` is neither and must stay
   *  distinguishable from both ON THE WIRE — a receiver that cannot tell a
   *  button press from a page-out will page somebody for a button press. Each
   *  kind maps the three its own way, which is why the verb is on the message
   *  rather than a second function per kind. */
  action:   'trigger' | 'resolve' | 'test'
  /** What PagerDuty deduplicates on, so a re-fire updates the incident it
   *  already opened instead of opening a second one, and a resolve closes the
   *  right incident. Absent for a test, which opens nothing. */
  dedupKey?: string
  /** Extra fields a webhook receiver gets. Ignored by every other kind. */
  data?:    Record<string, unknown>
}

export interface Delivered { ok: true }
export interface Failed    { ok: false; error: string }
export type DeliveryResult = Delivered | Failed

// ─── Per-kind delivery shape ─────────────────────────────────────────────
// `secretField` is the key inside the Secret's JSON document. `host` is the
// conduit target's address — null means the address comes from `config.url`.

export interface KindSpec {
  label:       string
  secretField: string | null
  host:        string | null
  render:      (msg: Message, config: Record<string, unknown>) => Record<string, unknown>
  describe:    (config: Record<string, unknown>) => string
}

/** A webhook receiver routes on this, so the three verbs are three names. */
const WEBHOOK_EVENT = {
  trigger: 'basecamp.alert',
  resolve: 'basecamp.resolved',
  test:    'basecamp.test',
} as const

export const KINDS: Record<string, KindSpec> = {
  slack: {
    label:       'Slack',
    secretField: 'webhookUrl',
    host:        'https://hooks.slack.com',
    render:      (m) => ({ text: m.text ? `${m.title}\n${m.text}` : m.title }),
    describe:    (c) => (c.channel as string) ?? 'the webhook’s default channel',
  },
  pagerduty: {
    label:       'PagerDuty',
    secretField: 'integrationKey',
    host:        'https://events.pagerduty.com',
    // PagerDuty knows two verbs, so a test is a trigger — and carries no
    // dedup key, which is what keeps it from touching an incident.
    render:      (m) => ({
      event_action: m.action === 'resolve' ? 'resolve' : 'trigger',
      ...(m.dedupKey ? { dedup_key: m.dedupKey } : {}),
      // Events API v2 takes no payload on a resolve, and sending one is
      // rejected rather than ignored.
      ...(m.action === 'resolve' ? {} : {
        payload: { summary: m.title, source: 'basecamp', severity: m.severity },
      }),
    }),
    describe:    () => 'Events API v2',
  },
  email: {
    label:       'Email',
    secretField: null,
    host:        null,
    render:      (m) => ({ subject: m.title, body: m.text }),
    describe:    (c) => ((c.to as string[]) ?? []).join(', ') || 'no recipients',
  },
  webhook: {
    label:       'Webhook',
    secretField: 'token',             // optional — a bare webhook needs none
    host:        null,
    render:      (m) => ({
      event:    WEBHOOK_EVENT[m.action],
      title:    m.title,
      text:     m.text,
      severity: m.severity,
      ...(m.dedupKey ? { key: m.dedupKey } : {}),
      ...(m.data ?? {}),
    }),
    describe:    (c) => (c.url as string) ?? 'no URL',
  },
}

/** A test post, in the shape `channels.test` has always sent. Kept as a message
 *  rather than a fourth `testBody` column, so a kind gains a renderer once. */
export function testMessage(channelName: string): Message {
  return {
    title:    `Basecamp test notification from channel “${channelName}”.`,
    text:     '',
    severity: 'info',
    action:   'test',
  }
}

// ─── Sending ─────────────────────────────────────────────────────────────

export interface DeliveryDeps {
  /** `app.conduit`, or undefined on a Basecamp built without the plugin. */
  conduit: { register: (t: unknown) => Promise<unknown>
             send: (r: unknown) => Promise<{ error?: { kind: string; message: string } }> } | undefined
  /** A SYSTEM client. `Secret.data` is `@encrypted`: the column is absent from
   *  the row a scoped client produces, so a scoped read here returns a channel
   *  with no credential and reports it as *rotate your credential*. */
  sys: () => any
}

/**
 * Deliver one message to one channel.
 *
 * Answers rather than throws. The service turns a failure into a 400 and the
 * job records it against the alert — a rejected page-out that reached the cron
 * as an exception would abandon every rule after it in the same pass.
 */
export async function deliverToChannel(
  deps:    DeliveryDeps,
  channel: Record<string, any>,
  msg:     Message,
): Promise<DeliveryResult> {
  const kind = channel.kind as string
  const spec = KINDS[kind]
  if (!spec) return { ok: false, error: `Unknown channel kind '${kind}'` }

  if (kind === 'email')
    return { ok: false, error:
      'Email delivery needs a mailer, and this app has none configured. ' +
      'The channel is saved; it cannot deliver yet.' }

  if (!deps.conduit)
    return { ok: false, error: 'Outbound delivery is not configured on this server — no conduit plugin' }

  const config = (channel.config ?? {}) as Record<string, unknown>
  let address  = spec.host
  let path     = '/v2/enqueue'          // PagerDuty's Events API v2; overwritten below
  let auth: Record<string, unknown> = { type: 'none' }
  let body     = spec.render(msg, config)

  if (kind === 'slack') {
    const url = await readCredential(deps.sys, channel.secretId, 'webhookUrl')
    if (!url) return { ok: false, error: 'This channel has no webhook URL stored — rotate its credential' }
    const parsed = safeUrl(url)
    if (!parsed) return { ok: false, error: 'The stored webhook URL is not a URL' }
    address = parsed.origin
    path    = parsed.pathname + parsed.search
    if (config.channel) body = { ...body, channel: config.channel }
  } else if (kind === 'pagerduty') {
    const key = await readCredential(deps.sys, channel.secretId, 'integrationKey')
    if (!key) return { ok: false, error: 'This channel has no integration key stored — rotate its credential' }
    body = { ...body, routing_key: key }
  } else {
    const parsed = safeUrl(config.url)
    if (!parsed) return { ok: false, error: 'This webhook channel has no valid `url` in its config' }
    address = parsed.origin
    path    = parsed.pathname + parsed.search
    if (channel.secretId)
      auth = { type: 'api_key', ref: secretRef(channel.secretId as string, 'token'), header: 'X-Basecamp-Token' }
  }

  const target = `channel:${channel.id}`
  // Re-registered on every send rather than once at boot: the address changes
  // under a rotation, and conduit's register is an upsert.
  await deps.conduit.register({
    id:            target,
    kind:          'provider',
    protocol:      'http',
    address:       address as string,
    auth,
    registered_at: Date.now(),
    last_seen_at:  null,
  })

  const res = await deps.conduit.send({ target, method: 'POST', path, body })
  if (res.error) return { ok: false, error: `Delivery failed (${res.error.kind}): ${res.error.message}` }
  return { ok: true }
}

/** Read one field out of a channel's Secret. asSystem() because `@encrypted`
 *  values are absent from a scoped read — not redacted, absent. */
async function readCredential(
  sys:      () => any,
  secretId: string | null | undefined,
  field:    string,
): Promise<string | null> {
  if (!secretId) return null
  const secret = await sys().secret.findFirst({ where: { id: secretId } })
  if (!secret?.data) return null
  try { return JSON.parse(secret.data as string)?.[field] ?? null } catch { return null }
}

/** A URL, or null. `new URL()` throws on anything unparseable, and a throw out
 *  of a config read reaches the caller as a 500 rather than as the 400 it is. */
export function safeUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch { return null }
}
