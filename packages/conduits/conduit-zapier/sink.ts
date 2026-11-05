// sink.ts — hooks.zapier.com, standing in for Zapier.
//
// One listener answering a Catch Hook (`/hooks/catch/<user>/<zap>[,<zap>]/`,
// `/silent/` after it answering an empty 200) and a REST Hook `target_url`
// (`/hooks/standard/<user>/<key>/`), graded by status as Zapier grades them:
// 200 with `{ status: 'success', attempt, id, request_id }` — the body a live
// Catch Hook answers and Zapier's docs leave unwritten — 404 for a Zap turned
// off, 410 for a REST Hook unsubscribed, and `DELETE` on a standard hook
// unsubscribing it as the reverse unsubscribe does. The JSON is parsed by hand
// and kept per hook, so the drive reads back what arrived rather than what
// conduit says it sent. Chaos under `/_sink/arm`: `{ lost }` applies and never
// answers, `{ rateLimit: { retryAfter } }` is one 429 with `Retry-After`,
// `{ failNext }` is one 500. Zapier sends this package no events, so there is
// no duplicate to arm.

export interface ZapierSinkOptions {
  port?:         number
  /** The Zapier user id every URL carries. */
  user?:         string
  /** Catch Hook keys that are live. */
  zaps?:         string[]
  /** A Catch Hook key whose Zap is turned off. */
  offZap?:       string
  /** REST Hook keys that are subscribed at start. */
  standardKeys?: string[]
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })

export function startZapierSink(opts: ZapierSinkOptions = {}) {
  const USER = opts.user ?? '123456', ZAPS = opts.zaps ?? ['zbB61', 'kzXC4'], OFF = opts.offZap ?? 'off000'
  const KEYS = opts.standardKeys ?? ['stdkey', 'second']
  const seen: { method: string; path: string; headers: Record<string, string>; body: string; at: number }[] = []
  const hooks: { hook: string; payload: unknown; silent: boolean }[] = []
  const subscribed = new Set(KEYS)
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number } }
  const hanging: Array<() => void> = []
  const disarm = () => Object.assign(armed, { lost: false, failNext: false, rateLimit: null })
  let counter = 0
  const ulid = () => `01J${(++counter).toString(36).toUpperCase().padStart(23, '0')}`
  const receipt = () => json({ attempt: ulid(), id: ulid(), request_id: ulid(), status: 'success' })

  function route(method: string, path: string, raw: string, ct: string): Response {
    const parse = () => { if (ct !== 'application/json') return raw; try { return JSON.parse(raw) } catch { return raw } }
    const take = (hook: string, silent: boolean) => { hooks.push({ hook, payload: parse(), silent }); return silent ? new Response(null, { status: 200 }) : receipt() }

    const catchHook = path.match(/^\/hooks\/catch\/(\d+)\/([^/]+)(\/silent)?\/?$/)
    if (catchHook) {
      if (catchHook[1] !== USER) return text('Not Found', 404)
      const keys = catchHook[2].split(',')
      if (keys.some(k => k === OFF || !ZAPS.includes(k))) return text('Not Found', 404)
      if (method !== 'POST' && method !== 'PUT' && method !== 'GET') return text('Method Not Allowed', 405)
      return take(keys.join(','), !!catchHook[3])
    }
    const standard = path.match(/^\/hooks\/standard\/(\d+)\/([^/]+)\/?$/)
    if (standard) {
      const key = standard[2]
      if (standard[1] !== USER || !KEYS.includes(key)) return text('Not Found', 404)
      if (method === 'DELETE') return subscribed.delete(key) ? new Response(null, { status: 200 }) : text('Gone', 410)
      if (!subscribed.has(key)) return text('Gone', 410)
      if (method !== 'POST') return text('Method Not Allowed', 405)
      return take(`standard:${key}`, false)
    }
    return text('Not Found', 404)
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/_sink/seen')  return json({ requests: seen, hooks, subscribed: [...subscribed] })
      if (path === '/_sink/reset') { seen.length = 0; disarm(); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }

      const raw = await req.text()
      seen.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body: raw, at: Date.now() })
      const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim()

      let answer: Response
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; answer = json({ status: 'error', error: 'rate limit exceeded' }, 429, { 'retry-after': String(retryAfter) }) }
      else if (armed.failNext) { armed.failNext = false; answer = text('Internal Server Error', 500) }
      else answer = route(req.method, path, raw, ct)

      // A lost response: the hook is TAKEN and the answer never leaves. Zapier
      // runs the Zap either way, which is why a replay here is a second run.
      if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)) }
      return answer
    },
  })

  const url = `http://127.0.0.1:${server.port}`
  return {
    port: server.port,
    url,
    host:        `127.0.0.1:${server.port}`,
    catchUrl:    `${url}/hooks/catch/${USER}/${ZAPS[0]}/`,
    silentUrl:   `${url}/hooks/catch/${USER}/${ZAPS[0]}/silent/`,
    multiUrl:    `${url}/hooks/catch/${USER}/${ZAPS.join(',')}/`,
    offUrl:      `${url}/hooks/catch/${USER}/${OFF}/`,
    standardUrl: `${url}/hooks/standard/${USER}/${KEYS[0]}/`,
    standardUrlFor: (key: string) => `${url}/hooks/standard/${USER}/${key}/`,
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) console.log(`[zapier-sink] ${startZapierSink({ port: Number(process.env.ZAPIER_SINK_PORT ?? 0) }).url}`)
