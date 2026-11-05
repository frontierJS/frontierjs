// @frontierjs/conduit-apns -- Apple Push Notification service over conduit: the target, the token, the send.
//
// Apple's provider token is a JWT the provider signs with its own ES256 key and
// Apple accepts for between twenty and sixty minutes. It is minted by the
// RESOLVER and not the signer: a signer runs on every attempt and holds no
// state, so a token minted there is a fresh signature per request, and Apple
// refuses a provider that mints more often than once in twenty minutes
// (`TooManyProviderTokenUpdates`). `withCache({ ttl_ms: 50 min })` around
// `apnsTokenResolver` is the token's life; the signer only places it.
//
// APNs refuses an expired token with a 403, which conduit otherwise reads as
// the credential accepted. The signer's `refused` names `ExpiredProviderToken`,
// so conduit forgets the cached token and replays once on a fresh one
// (FJS-2721). `InvalidProviderToken` is left out: it is a wrong key or team,
// a fresh token is just as invalid, and each remint spends one of Apple's
// token updates.

import type { ConduitRequest, ConduitResult, CredentialResolver, Signer, TargetDescriptor } from '@frontierjs/conduit'
import { importPrivateKey, signJwt } from './jwt.ts'
import { translate, type ApnsFailure } from './errors.ts'
import type { ApnsPayload, ApnsPushType, ApnsResult } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export { decodeJwt } from './jwt.ts'

export const APNS_TARGET          = 'provider:apns'
export const APNS_ADDRESS         = 'https://api.push.apple.com'
export const APNS_SANDBOX_ADDRESS = 'https://api.sandbox.push.apple.com'
export const APNS_SIGNER          = 'apns-jwt'

/** Apple's limit for an ordinary notification; VoIP allows 5120 and is not special-cased here. */
export const APNS_MAX_PAYLOAD_BYTES = 4096

/** Fifty minutes: inside Apple's sixty, with room for a send that began before the edge. */
export const APNS_TOKEN_TTL_MS = 50 * 60_000

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

/** APNs is one target, so one Send. */
export function bindApns(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string = APNS_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

export function apnsTarget(opts: { ref: string; address?: string; id?: string }): TargetDescriptor {
  return {
    id:            opts.id ?? APNS_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       opts.address ?? APNS_ADDRESS,
    auth:          { type: 'signed', signer: APNS_SIGNER, ref: opts.ref },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

/** Places the minted token. Apple documents the scheme lowercase, `bearer`. */
export const apnsJwtSigner: Signer = Object.assign(
  ({ secret }: { secret: string }) => ({ headers: { authorization: `bearer ${secret}` } }),
  { refused: ({ status, body }: { status: number; body: string }) => status === 403 && /"reason"\s*:\s*"ExpiredProviderToken"/.test(body) },
)

/** Spread into `createConduit({ signers })`. */
export const apnsSigners = { [APNS_SIGNER]: apnsJwtSigner }

export interface ApnsKey {
  /** The ten-character id of the `.p8` key, from the developer portal. */
  keyId:  string
  teamId: string
  /** The `.p8` file's text, PKCS8 PEM. */
  p8:     string
}

/**
 * Mints a provider token on every `get()`, whatever the ref — the app wraps it
 * in `withCache` and routes a ref to it. `iat` is seconds; a millisecond value
 * is `InvalidProviderToken` for a token that looks fine.
 */
export function apnsTokenResolver(key: ApnsKey, opts: { now?: () => number } = {}): CredentialResolver & { mints: () => number } {
  const now = opts.now ?? Date.now
  let imported: Promise<CryptoKey> | null = null
  let mints = 0
  return {
    mints: () => mints,
    async get() {
      imported ??= importPrivateKey(key.p8)
      mints++
      return signJwt({ kid: key.keyId }, { iss: key.teamId, iat: Math.floor(now() / 1000) }, await imported)
    },
  }
}

/**
 * Drops the token the cache currently holds, so the next send mints. The cache
 * forgets by value and the app does not hold the value, so it is read back first.
 * An expired token is conduit's to forget; this is for a `remint` that survived
 * conduit's one replay, or an `InvalidProviderToken` after the key is fixed.
 */
export async function forgetProviderToken(resolver: CredentialResolver, ref: string): Promise<boolean> {
  if (!resolver.invalidate) return false
  const held = await resolver.get(ref)
  if (!held) return false
  resolver.invalidate(ref, held)
  return true
}

export interface ApnsSend {
  deviceToken: string
  /** The app's bundle id; `.voip`, `.complication` etc. suffixes per push type. */
  topic:       string
  pushType:    ApnsPushType
  payload:     ApnsPayload
  /** The caller's uuid for the notification; APNs echoes it as `apns-id` and mints one otherwise. */
  id?:         string
  /** Unix seconds; `0` means deliver now or never. */
  expiration?: number
  priority?:   10 | 5 | 1
  collapseId?: string
}

export function payloadBytes(payload: ApnsPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

/**
 * `POST /3/device/{token}`. Unkeyed and not `replayable`: APNs collapses
 * nothing, so a lost response is `indeterminate` and the device may have
 * buzzed. There is no read that resolves it — APNs keeps no record a
 * provider can fetch — so the app decides from its own side (a `sentAt`
 * stamp on the row) whether to send again.
 */
export async function sendApns(send: Send, req: ApnsSend): Promise<{ result?: ApnsResult; error?: ApnsFailure }> {
  const bytes = payloadBytes(req.payload)
  if (bytes > APNS_MAX_PAYLOAD_BYTES)
    throw new TypeError(`apns: payload is ${bytes} bytes, limit is ${APNS_MAX_PAYLOAD_BYTES}. APNs would answer 413 PayloadTooLarge after the round trip.`)
  if (!req.topic) throw new TypeError('apns: topic is required (the bundle id); APNs answers 400 MissingTopic')
  if (!/^[0-9a-fA-F]+$/.test(req.deviceToken)) throw new TypeError('apns: a device token is hex')

  const r = await send<null>({
    method:  'POST',
    path:    `/3/device/${req.deviceToken}`,
    body:    req.payload,
    headers: {
      'apns-topic':     req.topic,
      'apns-push-type': req.pushType,
      ...(req.id         !== undefined ? { 'apns-id': req.id } : {}),
      ...(req.expiration !== undefined ? { 'apns-expiration': String(req.expiration) } : {}),
      ...(req.priority   !== undefined ? { 'apns-priority': String(req.priority) } : {}),
      ...(req.collapseId !== undefined ? { 'apns-collapse-id': req.collapseId } : {}),
    },
  })
  if (r.error) return { error: translate(r.error) }
  return { result: { id: r.meta.headers?.['apns-id'] ?? req.id ?? '' } }
}
