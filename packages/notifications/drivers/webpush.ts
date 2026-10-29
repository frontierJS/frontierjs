import {
  createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign,
} from 'node:crypto'
import { gradePublicUrl, pinTo } from '@frontierjs/junction/public-url'
import type { App, NotificationDriver, PushMessage, Recipient } from '../types.ts'
import { stateOf } from '../state.ts'

/**
 * Web Push transport driver: RFC 8291 (aes128gcm over ECDH-ES), RFC 8188 (the
 * body framing) and RFC 8292 (VAPID), over a plain `fetch`. A push service is
 * ordinary HTTPS, so there is no SDK and no account.
 *
 * ── Why this is a driver and not a recipe ───────────────────────────────
 * Every mistake in the cryptography fails the same way: the push service does
 * not hold the key, cannot tell a bad derivation from a good one, and answers
 * `201 Created`. A wrong build is indistinguishable from a phone in a tunnel.
 * The test therefore decrypts what this encrypts with the device's private key
 * -- a length check passes on garbage.
 *
 * ── What the driver does not own ────────────────────────────────────────
 * The SUBSCRIPTION. It is the app's row (`PushSubscription` in its own
 * `db/schema.lite`, keys `@encrypted`, gate stated there) and arrives through
 * `subscriptions`, a two-method store. Its TEXT is this package's
 * (`FJS-D1442`): it ships in `db/notification.lite` beside `Notification`,
 * appended by `notifications:install` and graded by `package-model-drift`.
 * With no store given, the driver reads that model off the plugin's `db`; an
 * app whose row lives elsewhere passes its own. Either way the keys are read
 * through `asSystem()` -- so the driver has full visibility BY CONSTRUCTION and
 * cannot be where `@guarded` columns are kept out of a payload. That check
 * belongs where the payload is built: the notification's `push:` formatter.
 *
 * ── Fan-out and pruning ─────────────────────────────────────────────────
 * One recipient is N devices, each with its own key pair and its own 410.
 * Every device is sent independently; an endpoint answering 404 or 410 is gone
 * for good and is handed to `subscriptions.remove`, which is the only signal a
 * subscription ever gives that it expired. Any other refusal (429, 5xx, a
 * rejected `fetch`) is collected and thrown AFTER every device was tried, so
 * one dead phone does not hold back the others and a retry is not a silent
 * success.
 *
 * ── A tab on screen ─────────────────────────────────────────────────────
 * A recipient with a visible tab of the app is skipped: the page has just
 * shown the in-app frame, and a phone buzzing for it is a duplicate
 * (`FJS-D1627`). The answer is junction's channel manager, so it covers this
 * process's sockets only; with no `channels()` configured nobody is visible.
 */

// ─── Public shapes ──────────────────────────────────────────────────────────

/** A browser's PushSubscription, as `subscription.toJSON()` states it. */
export interface PushSubscription {
  endpoint: string
  /** The device's public key, base64url, 65 bytes uncompressed. */
  p256dh:   string
  /** The device's 16-byte auth secret, base64url. */
  auth:     string
}

export interface PushSubscriptions {
  /** Every live device of the recipient. */
  list(recipient: Recipient): Promise<PushSubscription[]>
  /** The endpoint answered 404 or 410: it is retired and will not come back. */
  remove(subscription: PushSubscription, recipient: Recipient): Promise<void>
}

/** The request a push service receives, built completely. */
export interface PushRequest {
  url:     string
  method:  'POST'
  headers: Record<string, string>
  body:    Uint8Array
}

export interface VapidKeys {
  /** base64url, 65 bytes uncompressed -- what the browser's `applicationServerKey` takes. */
  publicKey:  string
  /** base64url, 32 bytes. */
  privateKey: string
  /** A `mailto:` or `https:` contact the push service can reach. */
  subject:    string
}

export interface WebPushOptions {
  vapid:          VapidKeys
  /** Default: the installed `PushSubscription` model on the plugin's `db`. */
  subscriptions?: PushSubscriptions
  /** Sends a built request. Default `fetch`; a test or a proxy substitutes. */
  deliver?:       (req: PushRequest) => Promise<{ status: number }>
}

// ─── Encoding helpers ───────────────────────────────────────────────────────

const b64u   = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url')
const unb64u = (s: string) => Buffer.from(s, 'base64url')
const utf8   = (s: string) => Buffer.from(s, 'utf8')

const RECORD_SIZE = 4096
// The body is one record: 16 bytes of tag and the 0x02 delimiter come out of
// RECORD_SIZE, as does the header, and a service refuses a body over 4096.
const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1 - (16 + 4 + 1 + 65)

// ─── VAPID keys ─────────────────────────────────────────────────────────────

const freshKey = () => {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return ecdh
}

/** A fresh VAPID key pair, to be kept beside the app's other secrets. */
export function generateVapidKeys(subject: string): VapidKeys {
  const ecdh = freshKey()
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()), subject }
}

/**
 * RFC 8292 `Authorization`. The JWT is signed ES256 with the signature as raw
 * `r‖s`: node emits ASN.1 DER unless told `ieee-p1363`, and a service rejects
 * the DER form (or, worse, a lenient one accepts it from you and not from the
 * next).
 */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()): string {
  const pub = unb64u(vapid.publicKey)
  const key = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)),
    },
  })
  const claims = {
    aud: new URL(endpoint).origin,
    // Inside the 24 hours RFC 8292 allows, with the margin a clock skew needs.
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: vapid.subject,
  }
  const input = `${b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${b64u(utf8(JSON.stringify(claims)))}`
  const sig = sign('sha256', utf8(input), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${input}.${b64u(sig)}, k=${vapid.publicKey}`
}

// ─── The encrypted body ─────────────────────────────────────────────────────

/**
 * Why these keys cannot be encrypted to, or null. One check for the subscribe
 * route and the send, so a bad row is refused at the door rather than found by
 * the first notification.
 */
export function subscriptionKeyProblem(sub: { p256dh?: unknown, auth?: unknown }): string | null {
  if (typeof sub.p256dh !== 'string') return 'push subscription p256dh is missing.'
  if (typeof sub.auth !== 'string')   return 'push subscription auth is missing.'
  const uaPublic = unb64u(sub.p256dh)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) return 'push subscription p256dh is not an uncompressed P-256 point.'
  if (unb64u(sub.auth).length !== 16) return 'push subscription auth is not 16 bytes.'
  return null
}

/**
 * RFC 8291 + RFC 8188: the aes128gcm body for one device.
 *
 * `hkdfSync` is extract-then-expand, so each call below is the RFC's
 * `HKDF(salt, IKM, info, L)`. The `info` strings are byte-exact, trailing NUL
 * included. `ephemeral` and `salt` are parameters only so a test can fix them.
 */
export function encryptPayload(
  sub:       Pick<PushSubscription, 'p256dh' | 'auth'>,
  plaintext: Uint8Array,
  ephemeral = freshKey(),
  salt      = randomBytes(16),
): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) {
    throw new Error(
      `[notifications] push payload is ${plaintext.length} bytes; a push service takes ${MAX_PLAINTEXT} ` +
      'after the encryption header. Send an id the service worker fetches the rest by.'
    )
  }
  const problem = subscriptionKeyProblem(sub)
  if (problem) throw new Error(`[notifications] ${problem}`)
  const uaPublic = unb64u(sub.p256dh)
  const authSecret = unb64u(sub.auth)

  const asPublic = ephemeral.getPublicKey()
  const shared = ephemeral.computeSecret(uaPublic)

  const keyInfo = Buffer.concat([utf8('WebPush: info\0'), uaPublic, asPublic])
  const ikm   = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const cek   = Buffer.from(hkdfSync('sha256', ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, utf8('Content-Encoding: nonce\0'), 12))

  // The last (here only) record ends in 0x02.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, body])
}

/** Everything a push service is sent for one device, ready to hand to `deliver`. */
export function buildPushRequest(
  sub: PushSubscription, message: PushMessage, vapid: VapidKeys, now = Date.now(),
): PushRequest {
  // priority, tags and actions are ntfy's; the worker never reads them and the body has a 3.9 KB ceiling.
  const { ttl, urgency, priority: _p, tags: _t, actions: _a, ...payload } = message
  const headers: Record<string, string> = {
    'Authorization':    vapidAuthorization(sub.endpoint, vapid, now),
    'Content-Encoding': 'aes128gcm',
    'Content-Type':     'application/octet-stream',
    'TTL':              String(ttl ?? 86400),
  }
  if (urgency)       headers.Urgency = urgency
  if (payload.topic) headers.Topic = payload.topic
  return { url: sub.endpoint, method: 'POST', headers, body: encryptPayload(sub, utf8(JSON.stringify(payload))) }
}

// ─── The driver ─────────────────────────────────────────────────────────────

const GONE = new Set([404, 410])

// The endpoint is a URL the browser chose, fetched from inside the network, so
// it is graded before every send as a webhook is (`FJS-681`): a name public at
// subscribe time can resolve to loopback later. The connect goes to the graded
// address, and a redirect is a destination nobody graded.
const viaFetch = async (req: PushRequest) => {
  const graded = await gradePublicUrl(req.url)
  const pin = graded.address ? pinTo(graded.url, graded.address) : null
  const res = await fetch(pin?.url ?? req.url, {
    method:   req.method,
    headers:  { ...req.headers, ...pin?.headers },
    body:     req.body as BodyInit,
    redirect: 'manual',
    ...(pin?.tls && { tls: pin.tls }),
  } as RequestInit)
  return { status: res.status }
}

type SubscriptionRows = {
  findMany(opts: { where: Record<string, unknown>, select: Record<string, true> }): Promise<PushSubscription[]>
  removeMany(opts: { where: Record<string, unknown> }): Promise<{ count: number }>
}

/**
 * The store over the installed fragment. `removeMany`, not `remove`: two sends
 * in flight both see the 410, and the second finds the row already retired.
 */
function installedSubscriptions(db: unknown): PushSubscriptions {
  const client = db as { $softDelete: Record<string, boolean>, asSystem(): { pushSubscription: SubscriptionRows } }
  const rows = () => {
    // The client throws on an accessor it has no table for, naming the table
    // and not the command that adds it.
    if (!('PushSubscription' in client.$softDelete)) {
      throw new Error(
        '[notifications] webPush() has no subscriptions store and the db has no PushSubscription model. ' +
        'Run `fli notifications:install` to append it, or pass `subscriptions` for a row that lives elsewhere.'
      )
    }
    return client.asSystem().pushSubscription
  }
  return {
    async list(recipient) {
      if (recipient.id == null) {
        throw new Error('[notifications] push recipient has no id, so it has no PushSubscription rows to find.')
      }
      return rows().findMany({
        where:  { userId: String(recipient.id) },
        select: { endpoint: true, p256dh: true, auth: true },
      })
    },
    async remove(sub) {
      await rows().removeMany({ where: { endpoint: sub.endpoint } })
    },
  }
}

export function webPush(opts: WebPushOptions): NotificationDriver & { vapidPublicKey: string } {
  const deliver = opts.deliver ?? viaFetch
  return {
    transport: 'push',
    // Read by the plugin, which serves it at GET /push-subscriptions/key.
    vapidPublicKey: opts.vapid.publicKey,
    async send(recipient: Recipient, message: unknown, app: App): Promise<void> {
      const msg = message as PushMessage
      if (recipient.id != null && 'channels' in app && app.channels?.hasVisibleConnection(recipient.id)) return
      const store = opts.subscriptions ?? installedSubscriptions(stateOf(app).db)
      const subs = await store.list(recipient)
      const failures: string[] = []

      await Promise.all(subs.map(async sub => {
        try {
          const { status } = await deliver(buildPushRequest(sub, msg, opts.vapid))
          if (GONE.has(status)) await store.remove(sub, recipient)
          else if (status < 200 || status >= 300) failures.push(`${sub.endpoint} answered ${status}`)
        } catch (err) {
          failures.push(`${sub.endpoint}: ${(err as Error).message}`)
        }
      }))

      if (failures.length) {
        throw new Error(`[notifications] push to ${failures.length} of ${subs.length} device(s) failed: ${failures.join('; ')}`)
      }
    },
  }
}
