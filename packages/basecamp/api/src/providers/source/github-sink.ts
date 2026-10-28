// src/providers/source/github-sink.ts — GitHub, standing in for GitHub.
//
// A dev listener speaking the real thing's shape: a bearer token, no path
// prefix, bare JSON bodies, and the refusals a connect can trip on — 401 for a
// token it does not know, 403 for one not given Webhooks, 404 for a repository
// the token cannot see or a file it does not hold, and 422 for a deploy key already on another
// repository, which GitHub refuses across every account. A SEPARATE LISTENER
// for the reason `compute/digitalocean-sink.ts` gives: the token really is read
// off an `Authorization` header conduit wrote, from a `Secret` that was
// decrypted. Each listener holds its own repositories.
//
//   bun api/src/providers/source/github-sink.ts
//   GITHUB_URL=http://localhost:8126
//
// Port 8126 — project 2 (basecamp), backend (`docs/PORTS.md`).

const PORT = Number(process.env.GH_SINK_PORT ?? 8126)

/** What this stand-in accepts, in a fine-grained token's spelling. */
const TOKEN = process.env.GH_SINK_TOKEN ?? 'github_pat_devtoken'

/** A token given Administration and not Webhooks: a key can be written and a
 *  hook cannot, which is the half-connect the refusal has to name. */
export const NO_HOOKS_TOKEN = 'github_pat_nohooks'

/** The repositories the tokens open. A third name is a 404. */
export const SINK_REPOS = ['sink-owner/app', 'sink-owner/other']

/** The files each repository holds on every ref: `app` has a root
 *  Dockerfile and no `deploy/Dockerfile`, `other` has neither. */
export const SINK_FILES: Record<string, Record<string, string>> = {
  'sink-owner/app': { Dockerfile: 'FROM oven/bun:1\nEXPOSE 3000\n' },
}

type Rec = Record<string, unknown>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const fail = (status: number, message: string, errors?: Rec[]) =>
  json({ message, ...(errors ? { errors } : {}), documentation_url: 'https://docs.github.com/rest', status: String(status) }, status)

export function startGhSink(port = PORT) {
  const keys:  Record<string, Rec[]> = Object.fromEntries(SINK_REPOS.map(r => [r, []]))
  const hooks: Record<string, Rec[]> = Object.fromEntries(SINK_REPOS.map(r => [r, []]))
  let made = 0

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url  = new URL(req.url)
      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${NO_HOOKS_TOKEN}`) {
        console.error(`[gh-sink] refused ${req.method} ${url.pathname}`)
        return fail(401, 'Bad credentials')
      }
      // GitHub answers 403 to a request with no User-Agent before it reads
      // anything else, so a descriptor that dropped the header fails here too.
      if (!req.headers.get('user-agent')) return fail(403, 'Request forbidden by administrative rules. Please make sure your request has a User-Agent header')

      if (url.pathname === '/user' && req.method === 'GET') return json({ login: 'sink-owner', id: 1 })

      const r = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.+))?$/)
      if (r && req.method === 'GET') {
        const full = `${decodeURIComponent(r[1])}/${decodeURIComponent(r[2])}`
        if (!SINK_REPOS.includes(full)) return fail(404, 'Not Found')
        if (!r[3]) return json({ full_name: full, private: true, default_branch: 'main' })
        const content = SINK_FILES[full]?.[r[3].split('/').map(decodeURIComponent).join('/')]
        if (content === undefined) return fail(404, 'Not Found')
        return json({ type: 'file', encoding: 'base64', path: r[3], content: Buffer.from(content).toString('base64') })
      }

      const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(keys|hooks)(?:\/([^/]+))?$/)
      if (!m) return fail(404, 'Not Found')
      const repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`
      if (!SINK_REPOS.includes(repo)) return fail(404, 'Not Found')
      const body = req.method === 'GET' ? null : await req.json().catch(() => null) as Rec | null
      if (req.method !== 'GET' && !body) return fail(400, 'Problems parsing JSON')

      if (m[3] === 'keys') {
        if (m[4]) return fail(404, 'Not Found')
        if (req.method === 'GET') return json(keys[repo])
        if (req.method !== 'POST') return fail(404, 'Not Found')
        const key = String(body!.key ?? '').trim().split(/\s+/).slice(0, 2).join(' ')
        if (Object.values(keys).some(list => list.some(k => k.key === key)))
          return fail(422, 'Validation Failed', [{ resource: 'PublicKey', code: 'custom', field: 'key', message: 'key is already in use' }])
        const row = { id: ++made, key, title: body!.title, read_only: body!.read_only === true, verified: true }
        keys[repo].push(row)
        return json(row, 201)
      }

      if (auth === `Bearer ${NO_HOOKS_TOKEN}`) return fail(403, 'Resource not accessible by personal access token')
      // A hook's secret is answered masked, as GitHub does, so a caller cannot
      // tell a current secret from a stale one by reading it.
      const shown = (h: Rec) => ({ ...h, config: { ...(h.config as Rec), ...((h.config as Rec).secret ? { secret: '********' } : {}) } })
      if (!m[4]) {
        if (req.method === 'GET') return json(hooks[repo].map(shown))
        if (req.method !== 'POST') return fail(404, 'Not Found')
        const row = { id: ++made, name: body!.name, active: body!.active !== false, events: body!.events ?? ['push'], config: body!.config ?? {} }
        hooks[repo].push(row)
        return json(shown(row), 201)
      }
      const hook = hooks[repo].find(h => String(h.id) === decodeURIComponent(m[4]))
      if (!hook) return fail(404, 'Not Found')
      if (req.method !== 'PATCH') return fail(404, 'Not Found')
      Object.assign(hook, { ...body, config: { ...(hook.config as Rec), ...(body!.config as Rec ?? {}) } })
      return json(shown(hook))
    },
  })
  // A repository's hooks as stored, secret and all — what a test reads to
  // prove a secret was rewritten, which GitHub never answers.
  return Object.assign(server, { hooksOf: (repo: string) => hooks[repo] ?? [] })
}

if (import.meta.main) {
  const server = startGhSink()
  console.log(`[gh-sink] GitHub stand-in on http://localhost:${server.port} — token ${TOKEN}`)
}
