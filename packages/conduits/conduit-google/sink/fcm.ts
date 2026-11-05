// sink/fcm.ts -- Firebase Cloud Messaging (HTTP v1) and Google's token endpoint.
//
// It generates its own RSA key at start and hands it out the way the Firebase
// console does: a `serviceAccount` JSON with the private key. It then VERIFIES
// the RS256 assertion at `/token` with `node:crypto`, never with the
// connector's own WebCrypto code, so a drift in the minting is a 400
// `invalid_grant` here rather than an agreement.
//
// Device tokens: `...0000` is `UNREGISTERED`, `...9999` is `SENDER_ID_MISMATCH`.
// A module of the one Google sink (`../sink.ts`); control endpoints are
// `/fcm/_sink/{seen,arm,reset}`. Chaos under `/fcm/_sink/arm`: `lost`,
// `rateLimit: { retryAfter }`, `failNext`, `expireAccessToken` (next FCM call
// 401 once), `invalidGrant` (next `/token` 400 once), `tokenUnavailable` (every
// `/token` 503 until reset).

import { generateKeyPairSync, randomBytes, verify as verifySig } from 'node:crypto'
import type { ModuleSink } from './maps.ts'

export interface FcmSinkOptions { projectId?: string }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const fcmRefuse = (status: number, googleStatus: string, errorCode: string | null, message: string, headers: Record<string, string> = {}) =>
  json({ error: { code: status, message, status: googleStatus, details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [] } }, status, headers)

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString()) as Record<string, unknown>

/** Checks a compact RS256 JWS with the given public key; the halves when it verifies, else the reason. */
function checkJws(token: string, key: ReturnType<typeof generateKeyPairSync<'rsa'>>['publicKey']): { header: Record<string, unknown>; payload: Record<string, unknown> } | string {
  const parts = token.split('.')
  if (parts.length !== 3) return 'not three segments'
  let header: Record<string, unknown>, payload: Record<string, unknown>
  try { header = b64json(parts[0]); payload = b64json(parts[1]) } catch { return 'segments are not JSON' }
  if (header.alg !== 'RS256') return `alg is ${String(header.alg)}, wanted RS256`
  const ok = verifySig('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))
  return ok ? { header, payload } : 'signature does not verify'
}

export function fcmSink(opts: FcmSinkOptions = {}): ModuleSink & {
  projectId: string
  /** The origin-qualified `/token` URL, known once the listener has a port; it is the assertion's `aud`. */
  setTokenUrl(url: string): void
  serviceAccount(): { type: string; project_id: string; private_key_id: string; private_key: string; client_email: string; token_uri: string }
} {
  const PROJECT = opts.projectId ?? 'drive-project'
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })

  const seen: { method: string; path: string; headers: Record<string, string>; body: string; at: number }[] = []
  const pushes: { id: string; to: string; body: string }[] = []
  const issued = new Set<string>()
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, expireAccessToken: false, invalidGrant: false, tokenUnavailable: false }
  const disarm = () => Object.assign(armed, { lost: false, failNext: false, rateLimit: null, expireAccessToken: false, invalidGrant: false, tokenUnavailable: false })
  const hanging: Array<() => void> = []
  let counter = 0
  const mint = (p: string) => `${p}${(++counter).toString().padStart(4, '0')}${randomBytes(4).toString('hex')}`
  let tokenUrl = ''

  const serviceAccount = () => ({
    type:           'service_account',
    project_id:     PROJECT,
    private_key_id: 'drive-key-1',
    private_key:    rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    client_email:   `drive@${PROJECT}.iam.gserviceaccount.com`,
    token_uri:      tokenUrl,
  })

  return {
    projectId: PROJECT,
    setTokenUrl(url) { tokenUrl = url },
    serviceAccount,
    reset() { seen.length = 0; pushes.length = 0; disarm() },
    stop() { for (const r of hanging) r() },
    async handle(req) {
      const path = new URL(req.url).pathname

      if (path === '/fcm/_sink/seen')  return json({ requests: seen, pushes })
      if (path === '/fcm/_sink/reset') { seen.length = 0; pushes.length = 0; disarm(); return json({ ok: true }) }
      if (path === '/fcm/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }

      const fcm = path.match(/^\/v1\/projects\/([^/]+)\/messages:send$/)
      if (path !== '/token' && !fcm) return null

      const text = req.method === 'POST' ? await req.text() : ''
      seen.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body: text, at: Date.now() })

      // ─── OAuth: the service-account exchange ──────────────────────────
      if (path === '/token') {
        if (armed.tokenUnavailable) return json({ error: 'temporarily_unavailable' }, 503)
        const form = new URLSearchParams(text)
        if ((req.headers.get('content-type') ?? '').split(';')[0] !== 'application/x-www-form-urlencoded') return json({ error: 'invalid_request', error_description: 'form body expected' }, 400)
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return json({ error: 'unsupported_grant_type' }, 400)
        if (armed.invalidGrant) { armed.invalidGrant = false; return json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400) }
        const jws = checkJws(form.get('assertion') ?? '', rsa.publicKey)
        if (typeof jws === 'string') return json({ error: 'invalid_grant', error_description: jws }, 400)
        const now = Math.floor(Date.now() / 1000)
        if (jws.payload.iss !== serviceAccount().client_email) return json({ error: 'invalid_grant', error_description: 'iss is not a known client' }, 400)
        if (jws.payload.aud !== tokenUrl) return json({ error: 'invalid_grant', error_description: `aud is ${String(jws.payload.aud)}` }, 400)
        if (typeof jws.payload.exp !== 'number' || jws.payload.exp < now || jws.payload.exp > now + 3600 + 60) return json({ error: 'invalid_grant', error_description: 'exp out of range' }, 400)
        if (!String(jws.payload.scope ?? '').split(' ').includes('https://www.googleapis.com/auth/firebase.messaging')) return json({ error: 'invalid_scope' }, 400)
        const access = `ya29.${mint('tok')}`
        issued.add(access)
        return json({ access_token: access, token_type: 'Bearer', expires_in: 3599 })
      }

      // ─── FCM ──────────────────────────────────────────────────────────
      if (fcm && req.method === 'POST') {
        const auth = req.headers.get('authorization') ?? ''
        if (!auth.startsWith('Bearer ') || !issued.has(auth.slice(7))) return fcmRefuse(401, 'UNAUTHENTICATED', null, 'Request had invalid authentication credentials.')
        if (armed.expireAccessToken) { armed.expireAccessToken = false; issued.delete(auth.slice(7)); return fcmRefuse(401, 'UNAUTHENTICATED', null, 'Request had invalid authentication credentials. Expected OAuth 2 access token.') }
        if (fcm[1] !== PROJECT) return fcmRefuse(403, 'PERMISSION_DENIED', null, `Permission denied on project ${fcm[1]}`)
        if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return fcmRefuse(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', 'Quota exceeded', { 'retry-after': String(retryAfter) }) }
        if (armed.failNext) { armed.failNext = false; return fcmRefuse(503, 'UNAVAILABLE', 'UNAVAILABLE', 'The service is currently unavailable.') }

        let body: { message?: Record<string, unknown> }
        try { body = JSON.parse(text) } catch { return fcmRefuse(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Invalid JSON payload received.') }
        const m = body.message
        if (!m) return fcmRefuse(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'message is required')
        const targets = ['token', 'topic', 'condition'].filter(k => m[k] !== undefined)
        if (targets.length !== 1) return fcmRefuse(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Exactly one of token, topic or condition is required')
        const to = String(m[targets[0]])
        if (m.token !== undefined) {
          if (to.endsWith('0000')) return fcmRefuse(404, 'NOT_FOUND', 'UNREGISTERED', 'Requested entity was not found.')
          if (to.endsWith('9999')) return fcmRefuse(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH', 'SenderId mismatch')
        }
        const id = mint('')
        pushes.push({ id, to, body: text })
        if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)) }
        return json({ name: `projects/${PROJECT}/messages/${id}` })
      }

      return fcmRefuse(404, 'NOT_FOUND', null, `no route ${req.method} ${path}`)
    },
  }
}
