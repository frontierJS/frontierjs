// client.ts — @frontierjs/notifications/client: the browser half of a subscription.
//
//   import { getClient } from '@frontierjs/sierra/resource'
//   import { subscribeToPush, unsubscribeFromPush } from '@frontierjs/notifications/client'
//
//   const service = getClient().service('push-subscriptions')
//   button.onclick = () => subscribeToPush({ service })
//
// Plain functions, not a signal (`FJS-D1625`). The caller hands over the
// service proxy, so the name an app renamed the door to on the server
// (`notifications({ services: { pushSubscriptions } })`) is stated once, by
// the app, and the junction client stays the one owner of transport, token and
// envelope. Registers no worker: Sierra writes `sw.js` under `push: true`.
//
// Browser-only. Nothing here may import the package root, which is server code.

/** The slice of a junction ServiceProxy these two calls use. */
export interface PushSubscriptionsService {
  find(query?: Record<string, unknown>): Promise<{ data: Array<{ id: number | string, endpoint: string }> }>
  get(id: 'key'): Promise<unknown>
  create(data: Record<string, unknown>): Promise<unknown>
  remove(id: number | string): Promise<unknown>
}

export interface SubscribeToPushOptions {
  /** `getClient().service('push-subscriptions')`, or whatever the app renamed it to. */
  service:        PushSubscriptionsService
  /** The VAPID public key, base64url, 65 bytes uncompressed. Default: read from the service. */
  vapidPublicKey?: string
}

/**
 * Subscribe this browser and record it under the signed-in caller. Call it
 * from a click: Safari and Firefox refuse the permission prompt without one.
 * Answers what the service answered — the row, without its keys.
 */
export async function subscribeToPush({ service, vapidPublicKey }: SubscribeToPushOptions): Promise<unknown> {
  assertService(service, 'subscribeToPush')
  const passed = vapidPublicKey === undefined ? undefined : vapidKeyBytes(vapidPublicKey)
  const registration = await pushRegistration()

  if (Notification.permission === 'default') await Notification.requestPermission()
  if (Notification.permission !== 'granted') {
    throw new Error(`Notifications are ${Notification.permission === 'denied' ? 'blocked for this site in the browser\'s settings' : 'not permitted'}`)
  }
  // Read after the prompt: a round trip before it can outlast the click's
  // user activation, and Safari and Firefox then refuse to ask.
  const applicationServerKey = passed ?? vapidKeyBytes(((await service.get('key')) as { publicKey?: unknown } | null)?.publicKey as string)

  // A subscription made under a rotated key refuses a second subscribe() with
  // a different one (InvalidStateError), and pushes to it fail VAPID for good.
  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !sameBytes(subscription.options.applicationServerKey, applicationServerKey)) {
    await retire(service, subscription)
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })

  // Posted again when it already existed: the upsert is what moves a browser
  // profile to whoever signed in on it, and what refreshes `lastSeenAt`.
  return service.create(subscription.toJSON() as Record<string, unknown>)
}

export interface UnsubscribeFromPushOptions {
  service: PushSubscriptionsService
}

/**
 * Retire this browser's row, then its subscription. Answers false when the
 * browser held none. The row goes first: a browser unsubscribed with its row
 * still standing is pushed to until the push service answers 410.
 */
export async function unsubscribeFromPush({ service }: UnsubscribeFromPushOptions): Promise<boolean> {
  assertService(service, 'unsubscribeFromPush')
  const registration = await pushRegistration()
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return false
  await retire(service, subscription)
  return true
}

// ─── Internals ──────────────────────────────────────────────────────────────

async function retire(service: PushSubscriptionsService, subscription: PushSubscription): Promise<void> {
  const { data } = await service.find({ endpoint: subscription.endpoint })
  for (const row of data) await service.remove(row.id)
  await subscription.unsubscribe()
}

function assertService(service: unknown, fn: string): asserts service is PushSubscriptionsService {
  const s = service as Partial<PushSubscriptionsService> | null
  if (!s || typeof s.create !== 'function' || typeof s.find !== 'function' || typeof s.get !== 'function' || typeof s.remove !== 'function') {
    throw new TypeError(`${fn}({ service }) takes a service proxy — getClient().service('push-subscriptions'), not the client itself`)
  }
}

// `serviceWorker.ready` never settles on a page with no worker, so a missing
// `push: true` would hang the click with nothing on screen.
async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof PushManager === 'undefined' || typeof Notification === 'undefined') {
    throw new Error('This browser does not support Web Push (on iOS, only an installed web app does)')
  }
  if (!await navigator.serviceWorker.getRegistration()) {
    throw new Error('No service worker is registered for this page — set push: true in sierra.config.js')
  }
  return navigator.serviceWorker.ready
}

// Safari refuses a string applicationServerKey; Chrome accepts one, so a
// string passes every test run in Chromium and fails on an iPhone.
function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  if (typeof key !== 'string' || !key) throw new TypeError('vapidPublicKey is required — the base64url public half of the VAPID pair')
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/')
  let raw: string
  try { raw = atob(b64 + '='.repeat((4 - b64.length % 4) % 4)) }
  catch { throw new TypeError('vapidPublicKey is not base64url') }
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0))
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new TypeError(`vapidPublicKey must be an uncompressed P-256 point (65 bytes, leading 0x04); this one is ${bytes.length} bytes`)
  }
  return bytes
}

function sameBytes(held: ArrayBuffer | null, want: Uint8Array): boolean {
  if (!held || held.byteLength !== want.length) return false
  const a = new Uint8Array(held)
  return a.every((b, i) => b === want[i])
}
