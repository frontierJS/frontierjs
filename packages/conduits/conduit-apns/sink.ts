// sink.ts -- APNs, standing in for Apple.
//
// It generates its own key at start and hands it out the way the developer
// portal does: `p8` + `keyId` + `teamId`. It then VERIFIES the ES256 provider
// token on every `/3/device/*` with `node:crypto` (`ieee-p1363`), never with
// the connector's own WebCrypto code, so a drift in the minting is a 403 here
// rather than an agreement.
//
// HTTP/1.1. Real APNs is HTTP/2-only; whether Bun's fetch negotiates h2 to
// Apple is not something this listener can say (PROJECT_STATE.md).
//
// Device tokens: `...0000` is `BadDeviceToken`, `...4100` is `Unregistered`
// with a timestamp. A topic ending `.forbidden` is `TopicDisallowed`.
// Chaos under `/_sink/arm`: `lost`, `rateLimit: { retryAfter }`, `failNext`,
// `expireProviderToken` (next call 403 once).

import { generateKeyPairSync, verify as verifySig } from 'node:crypto'

export interface ApnsSinkOptions { port?: number; keyId?: string; teamId?: string }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (reason: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json({ reason, ...extra }, status, headers)

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString()) as Record<string, unknown>

/** Checks a compact ES256 JWS with the given public key; the halves when it verifies, else the reason. */
function checkJws(token: string, key: ReturnType<typeof generateKeyPairSync<'ec'>>['publicKey']): { header: Record<string, unknown>; payload: Record<string, unknown> } | string {
  const parts = token.split('.')
  if (parts.length !== 3) return 'not three segments'
  let header: Record<string, unknown>, payload: Record<string, unknown>
  try { header = b64json(parts[0]); payload = b64json(parts[1]) } catch { return 'segments are not JSON' }
  if (header.alg !== 'ES256') return `alg is ${String(header.alg)}, wanted ES256`
  const ok = verifySig('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))
  return ok ? { header, payload } : 'signature does not verify'
}

export function startApnsSink(opts: ApnsSinkOptions = {}) {
  const KEY_ID = opts.keyId ?? 'ABC123DEFG', TEAM_ID = opts.teamId ?? 'TEAM000001'
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  const seen: { method: string; path: string; headers: Record<string, string>; body: string; at: number }[] = []
  const pushes: { id: string; to: string; body: string }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, expireProviderToken: false }
  const hanging: Array<() => void> = []

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url  = new URL(req.url)
      const path = url.pathname

      if (path === '/_sink/seen')  return json({ requests: seen, pushes })
      if (path === '/_sink/reset') { seen.length = 0; pushes.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, expireProviderToken: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }

      const text = req.method === 'POST' ? await req.text() : ''
      seen.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body: text, at: Date.now() })

      const device = path.match(/^\/3\/device\/([^/]+)$/)
      if (device && req.method === 'POST') {
        const apnsId = req.headers.get('apns-id') ?? crypto.randomUUID()
        const echo = { 'apns-id': apnsId }
        const auth = req.headers.get('authorization') ?? ''
        if (!/^bearer /i.test(auth)) return refuse('MissingProviderToken', 403, {}, echo)
        const jws = checkJws(auth.slice(7), ec.publicKey)
        if (typeof jws === 'string' || jws.header.kid !== KEY_ID || jws.payload.iss !== TEAM_ID) return refuse('InvalidProviderToken', 403, {}, echo)
        const iat = jws.payload.iat
        if (typeof iat !== 'number' || Math.abs(Date.now() / 1000 - iat) > 3600) return refuse('ExpiredProviderToken', 403, {}, echo)
        if (armed.expireProviderToken) { armed.expireProviderToken = false; return refuse('ExpiredProviderToken', 403, {}, echo) }

        if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return refuse('TooManyRequests', 429, {}, { ...echo, 'retry-after': String(retryAfter) }) }
        if (armed.failNext) { armed.failNext = false; return refuse('InternalServerError', 500, {}, echo) }

        if (!req.headers.get('apns-topic')) return refuse('MissingTopic', 400, {}, echo)
        if (req.headers.get('apns-topic')?.endsWith('.forbidden')) return refuse('TopicDisallowed', 400, {}, echo)
        if (!text) return refuse('PayloadEmpty', 400, {}, echo)
        if (Buffer.byteLength(text) > 4096) return refuse('PayloadTooLarge', 413, {}, echo)
        const token = device[1]
        if (!/^[0-9a-f]+$/i.test(token) || token.endsWith('0000')) return refuse('BadDeviceToken', 400, {}, echo)
        if (token.endsWith('4100')) return refuse('Unregistered', 410, { timestamp: Date.now() - 86_400_000 }, echo)

        // The same apns-id twice is one notification; the second answer is the same 200.
        if (!pushes.some(p => p.id === apnsId)) pushes.push({ id: apnsId, to: token, body: text })
        if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)) }
        return new Response(null, { status: 200, headers: echo })
      }

      return json({ reason: 'BadPath', message: `no route ${req.method} ${path}` }, 404)
    },
  })

  return {
    port: server.port,
    url:  `http://127.0.0.1:${server.port}`,
    apns: { keyId: KEY_ID, teamId: TEAM_ID, p8: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) {
  const s = startApnsSink({ port: Number(process.env.APNS_SINK_PORT ?? 0) })
  console.log(`[apns-sink] ${s.url}`)
}
