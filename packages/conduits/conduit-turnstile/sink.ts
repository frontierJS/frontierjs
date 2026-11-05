// sink.ts — Turnstile, standing in for Turnstile.
//
// Form-encoded in (the drive asserts the secret arrived in the BODY and in no
// header), JSON out, HTTP 200 for every verdict. A token is spent on first
// use; `idempotency_key` lets the same token re-verify under the same key.
// Tokens: `tok-ok-<site>` verifies for hostname `<site>.test` and action
// `login`; `tok-old` is older than 300 s; anything else is
// `invalid-input-response`. Chaos: `{ lost }`, `{ rateLimit }`, `{ failNext }`
// (an `internal-error` code on 200, which is how Turnstile reports one).

export interface TurnstileSinkOptions { port?: number; secret?: string }
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
const no = (...codes: string[]) => json({ success: false, 'error-codes': codes })

export function startTurnstileSink(opts: TurnstileSinkOptions = {}) {
  const SECRET = opts.secret ?? '0x4AAAAAAA_dev_secret'
  const spent = new Map<string, string | null>()
  const seen: { headers: Record<string, string>; body: string; status: number }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number } }
  const hanging: Array<() => void> = []
  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/_sink/seen')  return json({ requests: seen })
      if (url.pathname === '/_sink/reset') { seen.length = 0; spent.clear(); Object.assign(armed, { lost: false, failNext: false, rateLimit: null }); return json({ ok: true }) }
      if (url.pathname === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      const text = await req.text()
      const entry = { headers: Object.fromEntries(req.headers), body: text, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }
      if (url.pathname !== '/turnstile/v0/siteverify' || req.method !== 'POST') return record(json({ error: 'not found' }, 404))
      if ((req.headers.get('content-type') ?? '').split(';')[0] !== 'application/x-www-form-urlencoded') return record(no('bad-request'))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(json({ success: false, 'error-codes': ['bad-request'] }, 429, { 'retry-after': String(retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(no('internal-error')) }
      const form = new URLSearchParams(text)
      const secret = form.get('secret'), token = form.get('response'), key = form.get('idempotency_key')
      if (!secret) return record(no('missing-input-secret'))
      if (secret !== SECRET) return record(no('invalid-input-secret'))
      if (!token) return record(no('missing-input-response'))
      if (token === 'tok-old') return record(no('timeout-or-duplicate'))
      const m = token.match(/^tok-ok-([a-z]+)$/)
      if (!m) return record(no('invalid-input-response'))
      if (spent.has(token) && (!key || spent.get(token) !== key)) return record(no('timeout-or-duplicate'))
      spent.set(token, key)
      return record(json({ success: true, 'error-codes': [], challenge_ts: new Date().toISOString(), hostname: `${m[1]}.test`, action: 'login', cdata: '' }))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, secret: SECRET, stop() { for (const r of hanging) r(); server.stop(true) } }
}
if (import.meta.main) console.log(`[turnstile-sink] ${startTurnstileSink({ port: Number(process.env.TURNSTILE_SINK_PORT ?? 0) }).url}`)
