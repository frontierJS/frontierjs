// src/fcm/index.ts -- Firebase Cloud Messaging (HTTP v1) over conduit: the targets, the token, the send.
//
// FCM takes a Google OAuth access token, which is bought with a service
// account: an RS256 assertion exchanged at the token endpoint for a bearer
// token good for an hour. The exchange is a send through its own `auth: none`
// target (`FJS-D933`), so Google's token endpoint has a breaker, an observer
// and a timeout of its own, and an outage there answers the FCM send
// `auth_failed, retryable: true` with the endpoint named, never a permanent
// `auth_failed` (`MintError`, `FJS-2722`). `withCache({ ttl_ms })` around the
// resolver is the token's life; a 401 from FCM forgets it through
// `invalidate` and the send is replayed once on a fresh one.

import { MintError, type ConduitRequest, type ConduitResult, type CredentialResolver, type Signer, type TargetDescriptor } from '@frontierjs/conduit'
import { importPrivateKey, signJwt } from './jwt.ts'
import { translate, type FcmFailure } from './errors.ts'
import type { FcmMessage, FcmResult, FcmSendResponse, ServiceAccount } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export { decodeJwt } from './jwt.ts'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

export const FCM_ADDRESS   = 'https://fcm.googleapis.com'
export const FCM_SCOPE     = 'https://www.googleapis.com/auth/firebase.messaging'
export const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const BEARER_SIGNER = 'bearer'

/** Google's `expires_in` is 3600; fifty-five minutes leaves a send begun at the edge inside it. */
export const FCM_TOKEN_TTL_MS = 55 * 60_000

export const FCM_TOKEN_TARGET = 'provider:google-oauth'

/** One Send per role. `sendFcm` takes this and picks `api`; `fcmTokenResolver` takes `token`. */
export interface FcmSend { api: Send; token: Send }

export interface FcmTargets { api: TargetDescriptor; token: TargetDescriptor }

export interface FcmTargetsOptions {
  projectId: string
  /** The resolver's ref for the project's access token; the `api` target's alone. */
  ref:       string
  /** The FCM API's address; the token target's is `tokenUrl`'s origin. */
  address?:  string
  /** Google's token endpoint. Also the assertion's `aud`, so `fcmTokenResolver` takes the same value. */
  tokenUrl?: string
  /** The `api` target's id; the token target's is `FCM_TOKEN_TARGET`. */
  id?:       string
}

/**
 * `api` is one target per Firebase project: the service account is the
 * project's. `token` is Google's token endpoint as its own target: no
 * credential of ours rides it (the assertion is the body), and the body is a
 * form. Its id is the same for every project, so it is registered once per
 * process however many bundles the app builds.
 */
export function fcmTargets(opts: FcmTargetsOptions): FcmTargets {
  const base = { kind: 'provider', protocol: 'http', registered_at: Date.now(), last_seen_at: null } as const
  return {
    api: {
      ...base,
      id:      opts.id ?? `provider:fcm:${opts.projectId}`,
      address: opts.address ?? FCM_ADDRESS,
      auth:    { type: 'signed', signer: BEARER_SIGNER, ref: opts.ref },
    },
    token: {
      ...base,
      id:       FCM_TOKEN_TARGET,
      address:  new URL(opts.tokenUrl ?? FCM_TOKEN_URL).origin,
      auth:     { type: 'none' },
      encoding: 'form',
    },
  }
}

export function bindFcm(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, targets: FcmTargets | { api: { id: string }; token: { id: string } }): FcmSend {
  return {
    api:   req => conduit.send({ target: targets.api.id, ...req }),
    token: req => conduit.send({ target: targets.token.id, ...req }),
  }
}

/** `Authorization: Bearer <secret>` — conduit's own `bearer` auth type, as a signer, so a minted token can ride the `signed` seam. */
export const bearerSigner: Signer = ({ secret }) => ({ headers: { authorization: `Bearer ${secret}` } })

export class TokenExchangeError extends Error {
  constructor(readonly status: number, readonly code: string, description?: string) {
    super(`fcm: token exchange refused ${status} ${code}${description ? `: ${description}` : ''}`)
    this.name = 'TokenExchangeError'
  }
}

/**
 * Mints an access token on every `get()`, whatever the ref, by sending the
 * assertion through `send` — the bundle's `token` role, whose address is
 * `tokenUrl`'s origin. `tokenUrl` is also the assertion's `aud`, so the two
 * take the same value. `serviceAccount.token_uri` is ignored: a key file is
 * data from a download, and a URL in data is a place to send a signed
 * assertion to.
 */
export function fcmTokenResolver(serviceAccount: ServiceAccount, opts: { send: Send; tokenUrl?: string; now?: () => number }): CredentialResolver & { exchanges: () => number; lastRefusal: () => TokenExchangeError | null } {
  const tokenUrl = opts.tokenUrl ?? FCM_TOKEN_URL
  const path     = new URL(tokenUrl).pathname
  const now      = opts.now ?? Date.now
  let imported: Promise<CryptoKey> | null = null
  let exchanges = 0
  let lastRefusal: TokenExchangeError | null = null
  return {
    exchanges:   () => exchanges,
    lastRefusal: () => lastRefusal,
    async get() {
      imported ??= importPrivateKey(serviceAccount.private_key)
      const iat = Math.floor(now() / 1000)
      const assertion = await signJwt(
        { typ: 'JWT', ...(serviceAccount.private_key_id ? { kid: serviceAccount.private_key_id } : {}) },
        { iss: serviceAccount.client_email, scope: FCM_SCOPE, aud: tokenUrl, iat, exp: iat + 3600 },
        await imported,
      )
      exchanges++
      // Replayable: a second exchange of one assertion mints a second token
      // and moves nothing.
      const r = await opts.send<{ access_token?: string }>({
        method:     'POST',
        path,
        body:       { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion },
        replayable: true,
      })
      if (r.error) {
        const body = parseRefusal(r.error.raw)
        lastRefusal = new TokenExchangeError(r.meta.status ?? 0, body.error ?? r.error.kind, body.error_description)
        throw new MintError(r.error)
      }
      if (!r.data?.access_token) {
        lastRefusal = new TokenExchangeError(r.meta.status ?? 0, 'no_access_token')
        throw lastRefusal
      }
      lastRefusal = null
      return r.data.access_token
    },
  }
}

function parseRefusal(raw: unknown): { error?: string; error_description?: string } {
  if (typeof raw !== 'string') return (raw ?? {}) as { error?: string }
  try { return JSON.parse(raw) } catch { return {} }
}

/**
 * `POST /v1/projects/{p}/messages:send`. Unkeyed, not replayable: FCM has no
 * idempotency header and a retried send is a second notification. A lost
 * response is `indeterminate` with no read to resolve it.
 */
export async function sendFcm(fcm: FcmSend, projectId: string, message: FcmMessage, opts: { validateOnly?: boolean } = {}): Promise<{ result?: FcmResult; error?: FcmFailure }> {
  const recipients = ['token', 'topic', 'condition'].filter(k => (message as Record<string, unknown>)[k] !== undefined)
  if (recipients.length !== 1)
    throw new TypeError(`fcm: a message names exactly one of token, topic, condition; got ${recipients.length ? recipients.join(', ') : 'none'}. FCM answers 400 INVALID_ARGUMENT after the round trip.`)
  for (const [k, v] of Object.entries(message.data ?? {}))
    if (typeof v !== 'string') throw new TypeError(`fcm: data.${k} must be a string; FCM refuses a nested value`)

  const r = await fcm.api<FcmSendResponse>({
    method: 'POST',
    path:   `/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    body:   { message, ...(opts.validateOnly ? { validate_only: true } : {}) },
  })
  if (r.error) return { error: translate(r.error) }
  return { result: { id: r.data?.name?.split('/').pop() ?? '' } }
}

/** Spread into `createConduit({ signers })`. */
export const fcmSigners = { [BEARER_SIGNER]: bearerSigner }

/**
 * Drops the access token the cache currently holds, so the next send exchanges
 * again. The cache forgets by value and the app does not hold the value, so it
 * is read back first. An expired token is conduit's to forget on a 401; this is
 * for the app that rotates the service account.
 */
export async function forgetAccessToken(resolver: CredentialResolver, ref: string): Promise<boolean> {
  if (!resolver.invalidate) return false
  const held = await resolver.get(ref)
  if (!held) return false
  resolver.invalidate(ref, held)
  return true
}
