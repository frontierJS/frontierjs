// sink.ts — GitHub, standing in for GitHub.
//
// A separate listener on `port: 0` for the reason the DigitalOcean sink gives:
// the token really is read off an `Authorization` header conduit wrote. A
// bearer token, no path prefix, bare JSON bodies, and the refusals a connect
// can trip on — 401 for a token it does not know, 403 for one not given
// Webhooks, 404 for a repository the token cannot see or a file it does not
// hold, 422 for a deploy key already on another repository (GitHub refuses it
// across every account). State is per instance, so two listeners never share a
// repository's keys. Every answer carries `x-ratelimit-*` headers, counting
// down, as GitHub's do: a missing-grant 403 has `remaining` above zero, and
// that is the only thing that tells it from a limit.
//
// Chaos, under `/_sink/arm`, each answering once: `{ lost }` applies the write
// and never answers; `{ failNext }` a 500; `{ rateLimit: { retryAfter } }` the
// SECONDARY limit, a 429 with `retry-after`; `{ primaryLimit: { resetInSeconds } }`
// the PRIMARY one as measured on api.github.com, a 403 with
// `x-ratelimit-remaining: 0`, a reset and no `retry-after`.

export interface GhSinkOptions {
  /** Default 0: the OS picks one. Basecamp's dev sink asks for 8126. */
  port?:          number
  /** The token that opens everything. Default `github_pat_devtoken`. */
  token?:         string
  /** A token given Administration and not Webhooks: a key can be written and a hook cannot. Default `NO_HOOKS_TOKEN`. */
  noHooksToken?:  string
  /** The repositories the tokens open; any other name is a 404. */
  repos?:         string[]
  /** What each repository holds on every ref, by path. A path under another is a directory. */
  files?:         Record<string, Record<string, string>>
}

export const DEV_TOKEN = 'github_pat_devtoken'
export const NO_HOOKS_TOKEN = 'github_pat_nohooks'
export const SINK_REPOS = ['sink-owner/app', 'sink-owner/other']
export const SINK_FILES: Record<string, Record<string, string>> = {
  'sink-owner/app': { Dockerfile: 'FROM oven/bun:1\nEXPOSE 3000\n' },
}
/** A file over this answers no content, as the contents API does. */
const INLINE_LIMIT = 1_000_000
const LIMIT = 5000

type Rec = Record<string, unknown>

export function startGhSink(opts: GhSinkOptions = {}) {
  const TOKEN = opts.token ?? DEV_TOKEN
  const NO_HOOKS = opts.noHooksToken ?? NO_HOOKS_TOKEN
  const repos = opts.repos ?? SINK_REPOS
  const files = opts.files ?? SINK_FILES
  const keys:  Record<string, Rec[]> = Object.fromEntries(repos.map(r => [r, []]))
  const hooks: Record<string, Rec[]> = Object.fromEntries(repos.map(r => [r, []]))
  let made = 0, used = 0
  const seen: { method: string; path: string; status: number; userAgent: string | null; apiVersion: string | null; accept: string | null }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, primaryLimit: null as null | { resetInSeconds: number } }
  const hanging: Array<() => void> = []

  const rate = (remaining = LIMIT - used, reset = Math.floor(Date.now() / 1000) + 3600) => ({
    'x-ratelimit-limit': String(LIMIT), 'x-ratelimit-remaining': String(Math.max(0, remaining)),
    'x-ratelimit-used': String(used), 'x-ratelimit-resource': 'core', 'x-ratelimit-reset': String(reset),
  })
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...rate(), ...headers } })
  const fail = (status: number, message: string, errors?: Rec[], headers: Record<string, string> = {}) =>
    json({ message, ...(errors ? { errors } : {}), documentation_url: 'https://docs.github.com/rest', status: String(status) }, status, headers)

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/_sink/seen')  return Response.json({ requests: seen, keys, hooks })
      if (url.pathname === '/_sink/reset') { seen.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, primaryLimit: null }); return Response.json({ ok: true }) }
      if (url.pathname === '/_sink/arm')   { Object.assign(armed, await req.json()); return Response.json({ ok: true }) }

      const entry = { method: req.method, path: url.pathname + url.search, status: 0,
        userAgent: req.headers.get('user-agent'), apiVersion: req.headers.get('x-github-api-version'), accept: req.headers.get('accept') }
      seen.push(entry)
      used++
      const record = async (r: Response) => { if (armed.lost && req.method !== 'GET') { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }

      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${NO_HOOKS}`) return record(fail(401, 'Bad credentials'))
      // GitHub answers 403 to a request with no User-Agent before it reads
      // anything else, so a descriptor that dropped the header fails here too.
      if (!req.headers.get('user-agent')) return record(fail(403, 'Request forbidden by administrative rules. Please make sure your request has a User-Agent header'))

      if (armed.primaryLimit) {
        const { resetInSeconds } = armed.primaryLimit; armed.primaryLimit = null
        return record(fail(403, 'API rate limit exceeded for 203.0.113.7. (But here\'s the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)', undefined,
          rate(0, Math.floor(Date.now() / 1000) + resetInSeconds)))
      }
      if (armed.rateLimit) {
        const { retryAfter } = armed.rateLimit; armed.rateLimit = null
        return record(fail(429, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.', undefined, { 'retry-after': String(retryAfter) }))
      }
      if (armed.failNext) { armed.failNext = false; return record(fail(500, 'Server Error')) }

      if (url.pathname === '/user' && req.method === 'GET') return record(json({ login: 'sink-owner', id: 1 }))

      const r = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.+))?$/)
      if (r && req.method === 'GET') {
        const full = `${decodeURIComponent(r[1])}/${decodeURIComponent(r[2])}`
        if (!repos.includes(full)) return record(fail(404, 'Not Found'))
        if (!r[3]) return record(json({ full_name: full, private: true, default_branch: 'main' }))
        const path = r[3].split('/').map(decodeURIComponent).join('/')
        const held = files[full] ?? {}
        const content = held[path]
        if (content === undefined) {
          const children = Object.keys(held).filter(p => p.startsWith(`${path}/`))
          if (!children.length) return record(fail(404, 'Not Found'))
          return record(json(children.map(p => ({ type: 'file', name: p.split('/').pop(), path: p }))))
        }
        if (Buffer.byteLength(content) > INLINE_LIMIT) return record(json({ type: 'file', encoding: 'none', path, size: Buffer.byteLength(content), content: '' }))
        return record(json({ type: 'file', encoding: 'base64', path, content: Buffer.from(content).toString('base64') }))
      }

      const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(keys|hooks)(?:\/([^/]+))?$/)
      if (!m) return record(fail(404, 'Not Found'))
      const repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`
      if (!repos.includes(repo)) return record(fail(404, 'Not Found'))
      const body = req.method === 'GET' ? null : await req.json().catch(() => null) as Rec | null
      if (req.method !== 'GET' && !body) return record(fail(400, 'Problems parsing JSON'))

      if (m[3] === 'keys') {
        if (m[4]) return record(fail(404, 'Not Found'))
        if (req.method === 'GET') return record(json(keys[repo]))
        if (req.method !== 'POST') return record(fail(404, 'Not Found'))
        const key = String(body!.key ?? '').trim().split(/\s+/).slice(0, 2).join(' ')
        if (Object.values(keys).some(l => l.some(k => k.key === key)))
          return record(fail(422, 'Validation Failed', [{ resource: 'PublicKey', code: 'custom', field: 'key', message: 'key is already in use' }]))
        const row = { id: ++made, key, title: body!.title, read_only: body!.read_only === true, verified: true }
        keys[repo].push(row)
        return record(json(row, 201))
      }

      if (auth === `Bearer ${NO_HOOKS}`) return record(fail(403, 'Resource not accessible by personal access token'))
      // A hook's secret is answered masked, as GitHub does, so a caller cannot
      // tell a current secret from a stale one by reading it.
      const shown = (h: Rec) => ({ ...h, config: { ...(h.config as Rec), ...((h.config as Rec).secret ? { secret: '********' } : {}) } })
      if (!m[4]) {
        if (req.method === 'GET') return record(json(hooks[repo].map(shown)))
        if (req.method !== 'POST') return record(fail(404, 'Not Found'))
        const row = { id: ++made, name: body!.name, active: body!.active !== false, events: body!.events ?? ['push'], config: body!.config ?? {} }
        hooks[repo].push(row)
        return record(json(shown(row), 201))
      }
      const hook = hooks[repo].find(h => String(h.id) === decodeURIComponent(m[4]))
      if (!hook) return record(fail(404, 'Not Found'))
      if (req.method !== 'PATCH') return record(fail(404, 'Not Found'))
      Object.assign(hook, { ...body, config: { ...(hook.config as Rec), ...(body!.config as Rec ?? {}) } })
      return record(json(shown(hook)))
    },
  })
  return {
    port: server.port,
    url:  `http://127.0.0.1:${server.port}`,
    /** A repository's hooks as stored, secret and all — what a test reads to prove a secret was rewritten, which GitHub never answers. */
    hooksOf: (repo: string) => hooks[repo] ?? [],
    keysOf:  (repo: string) => keys[repo] ?? [],
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) {
  const sink = startGhSink({ port: Number(process.env.GH_SINK_PORT ?? 0), token: process.env.GH_SINK_TOKEN })
  console.log(`[gh-sink] GitHub stand-in on ${sink.url}`)
}
