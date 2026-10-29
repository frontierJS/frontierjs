import type { App, NotificationDriver, PushMessage, Recipient } from '../types.ts'

/**
 * ntfy transport driver: one authenticated POST per message, the body as the
 * text and the metadata as headers. There is no SDK to wrap -- the driver is a
 * formatter, and unlike a web push service ntfy answers 4xx/5xx honestly.
 *
 * ── What the driver does not own ────────────────────────────────────────
 * The TOPIC. It is an address on the recipient (`recipient.pushTopic`), not a
 * device, and who hears it is decided in the ntfy app by subscribing. A
 * recipient without one is refused by name rather than published to `undefined`,
 * a topic anyone may read on a public server. Which server, and with what token,
 * is the app's ladder to resolve once at boot (Basecamp: `api/src/push.ts`).
 *
 * ── What is on the wire ─────────────────────────────────────────────────
 * Title, Priority, Tags, Click and Actions headers; `data`, `ttl`, `urgency`
 * and `topic` are web push's and are dropped here. A payload carries titles and
 * links, never a secret -- the `push:` formatter is where `@guarded` columns are
 * kept out, as it is for `webPush()`.
 */

export interface NtfyOptions {
  /** `https://ntfy.acme.test` -- the blueprint's NTFY_BASE_URL, or `https://ntfy.sh`. */
  url:      string
  /** A sender token from NTFY_AUTH_TOKENS. Absent on a public server. */
  token?:   string | (() => Promise<string>)
  /** A second server tried once when the first answers 4xx/5xx or the fetch
   *  throws. Basecamp passes public ntfy.sh here when its own ntfy App is the
   *  primary: the ping that says the box is down must not die with the box. */
  fallback?: { url: string; token?: string | (() => Promise<string>) }
  /** The test seam, as `WebPushOptions.deliver` is. */
  deliver?: typeof fetch
}

type Token = string | (() => Promise<string>) | undefined

async function resolveToken(token: Token): Promise<string | undefined> {
  return typeof token === 'function' ? await token() : token
}

/** A header value is bytes: `fetch` refuses an em dash, so the ping never
 *  leaves, and sends an accent as one Latin-1 byte ntfy reads as garbage. ntfy
 *  decodes RFC 2047 on every header, which is how its own clients send one, so
 *  every header built from message text goes through here. */
export function headerValue(text: string): string {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/** ntfy stores a body of 4096 bytes or more as a file attachment, and a server
 *  with attachments off refuses it, so a long failure reason arrived as a .txt
 *  on the fallback or not at all. Cut on a character boundary, under the limit. */
const BODY_MAX = 4095

export function fitBody(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= BODY_MAX) return text
  let cut = BODY_MAX - 3
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
  return bytes.subarray(0, cut).toString('utf8') + '…'
}

/** ntfy refuses a publish with more than three buttons. */
const ACTIONS_MAX = 3

export function ntfy(options: NtfyOptions): NotificationDriver {
  const deliver = options.deliver ?? fetch
  const servers = [options, ...(options.fallback ? [options.fallback] : [])]
    .map(s => ({ base: s.url.replace(/\/+$/, ''), token: s.token as Token }))

  async function publish(server: { base: string; token: Token }, topic: string, m: PushMessage) {
    const token = await resolveToken(server.token)
    const headers: Record<string, string> = { Priority: String(m.priority ?? 3) }
    if (token)             headers.Authorization = `Bearer ${token}`
    if (m.title)           headers.Title   = headerValue(m.title)
    if (m.tags?.length)    headers.Tags    = headerValue(m.tags.join(','))
    if (m.url)             headers.Click   = headerValue(m.url)
    // JSON, not ntfy's comma-and-semicolon shorthand: a label with a comma or
    // a quote in it mis-parsed there and the publish was refused.
    if (m.actions?.length) headers.Actions = headerValue(JSON.stringify(
      m.actions.slice(0, ACTIONS_MAX).map(a => ({ action: 'view', label: a.label, url: a.url })),
    ))

    const res = await deliver(`${server.base}/${encodeURIComponent(topic)}`, {
      method: 'POST', headers, body: fitBody(m.body ?? ''),
    })
    if (!res.ok) throw new Error(`[notifications] push: ntfy at ${server.base} answered ${res.status} for topic ${topic}`)
    const answer = await res.json().catch(() => ({})) as { id?: string }
    return answer.id
  }

  return {
    transport: 'push',
    async send(recipient: Recipient, message: unknown, _app: App): Promise<string | undefined> {
      const topic = recipient.pushTopic
      if (typeof topic !== 'string' || topic === '') {
        throw new Error('[notifications] push: the recipient names no pushTopic')
      }
      const m = message as PushMessage
      // One retry on the fallback, and the failure carries BOTH answers: a
      // ping that reached nobody must say which server refused and why.
      const failures: string[] = []
      for (const server of servers) {
        try { return await publish(server, topic, m) }
        catch (err) { failures.push((err as Error).message) }
      }
      throw new Error(failures.join(' -- then '))
    },
  }
}
