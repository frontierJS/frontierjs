// sink.ts — DataForSEO, standing in for DataForSEO.
//
// HTTP Basic per account, the `{ status_code, status_message, cost, tasks }`
// envelope with HTTP 200 for most refusals, task_post taking up to 100 tasks
// and answering each with its own id and cost, task_get answering 40602 until
// `readyAfterMs` has passed, tasks_ready listing what is done and uncollected,
// and live endpoints answering one task's result in the same response. Read
// against docs.dataforseo.com; no live account was used, so the payloads are
// the documented shape rather than a capture. Chaos: `{ lost }`,
// `{ rateLimit }` (429 beside 40202), `{ failNext }`, `{ refuseWith }` (a 200
// whose envelope fails — the C4 case), `{ failTasks }` (n tasks of an accepted
// post refused one by one), `{ noFunds }`.

export interface DataforseoSinkOptions { port?: number; /** login → password */ accounts?: Record<string, string>; readyAfterMs?: number; costUsd?: number }

const OK = 20000, CREATED = 20100
const env = (status_code: number, status_message: string, tasks: unknown[] = [], cost = 0, http = 200) =>
  new Response(JSON.stringify({ version: '0.1.20250101', status_code, status_message, time: '0.01 sec.', cost, tasks_count: tasks.length, tasks_error: tasks.filter((t: any) => t.status_code !== OK && t.status_code !== CREATED).length, tasks }), { status: http, headers: { 'content-type': 'application/json' } })
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

let counter = 0
const id = () => `${Date.now().toString().slice(-8)}-${(++counter).toString().padStart(4, '0')}-0000`

export function startDataforseoSink(opts: DataforseoSinkOptions = {}) {
  const accounts = opts.accounts ?? { 'login@agency.test': 'secret' }
  const cost = opts.costUsd ?? 0.0006
  const seen: { method: string; path: string; login: string | null; tasks: number; status: number }[] = []
  const tasks = new Map<string, { id: string; login: string; path: string; data: Record<string, unknown>; readyAt: number; collected: boolean }>()
  const armed = { lost: false, failNext: false, rateLimit: false, refuseWith: null as null | number, failTasks: 0, noFunds: false }
  const hanging: Array<() => void> = []

  const login = (req: Request): string | null => {
    const h = req.headers.get('authorization') ?? ''
    if (!h.startsWith('Basic ')) return null
    const [l, p] = Buffer.from(h.slice(6), 'base64').toString().split(':')
    return l && accounts[l] === p ? l : null
  }
  const result = (data: Record<string, unknown>) => [{ keyword: data.keyword ?? data.target ?? '', check_url: 'https://www.google.com/search?q=' + encodeURIComponent(String(data.keyword ?? '')), items_count: 3, items: [1, 2, 3].map(rank_group => ({ type: 'organic', rank_group, rank_absolute: rank_group, domain: `site${rank_group}.test`, url: `https://site${rank_group}.test/`, title: `Result ${rank_group}` })) }]

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, tasks: [...tasks.values()].map(t => ({ id: t.id, tag: t.data.tag, collected: t.collected })) })
      if (path === '/_sink/reset') { seen.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: false, refuseWith: null, failTasks: 0, noFunds: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }

      const text = req.method === 'POST' ? await req.text() : ''
      const posted = text ? (JSON.parse(text) as Record<string, unknown>[]) : []
      const who = login(req)
      const entry = { method: req.method, path, login: who, tasks: posted.length, status: 0 }; seen.push(entry)
      const record = (r: Response) => { entry.status = r.status; return r }

      if (!who)            return record(env(40100, 'You are not authorized to access this resource.', [], 0, 401))
      if (armed.rateLimit) { armed.rateLimit = false; return record(env(40202, 'Too many requests.', [], 0, 429)) }
      if (armed.failNext)  { armed.failNext = false; return record(env(50000, 'Internal Error.', [], 0, 500)) }
      if (armed.refuseWith !== null) { const c = armed.refuseWith; armed.refuseWith = null; return record(env(c, c === 40200 ? 'Payment Required.' : 'Refused.', [], 0, 200)) }

      const m = path.match(/^\/v3\/(.+?)\/(task_post|tasks_ready|live(?:\/\w+)?|task_get\/\w+\/([^/]+))$/)
      if (!m) return record(env(40400, 'Not Found.', [], 0, 404))
      const [, endpoint, verb, taskId] = m
      let answer: Response

      if (verb === 'task_post' && req.method === 'POST') {
        if (posted.length > 100) answer = env(40006, 'Maximum number of tasks exceeded.', [], 0, 200)
        else if (armed.noFunds) { armed.noFunds = false; answer = env(40210, 'Not enough money. Your account balance is insufficient.', [], 0, 200) }
        else {
          let fail = armed.failTasks; armed.failTasks = 0
          const out = posted.map(data => {
            const tid = id()
            if (fail-- > 0) return { id: tid, status_code: 40501, status_message: 'Invalid Field: keyword.', cost: 0, data, result: null }
            tasks.set(tid, { id: tid, login: who, path: endpoint, data, readyAt: Date.now() + (opts.readyAfterMs ?? 40), collected: false })
            return { id: tid, status_code: CREATED, status_message: 'Task Created.', cost, data, result: null }
          })
          answer = env(OK, 'Ok.', out, out.filter(t => t.status_code === CREATED).length * cost)
        }
      } else if (verb.startsWith('live') && req.method === 'POST') {
        if (posted.length !== 1) answer = env(40006, 'Maximum number of tasks exceeded.', [], 0, 200)
        else answer = env(OK, 'Ok.', [{ id: id(), status_code: OK, status_message: 'Ok.', cost, data: posted[0], result: result(posted[0]) }], cost)
      } else if (verb === 'tasks_ready' && req.method === 'GET') {
        const ready = [...tasks.values()].filter(t => t.login === who && t.path === endpoint && !t.collected && t.readyAt <= Date.now()).map(t => ({ id: t.id, se: 'google', tag: t.data.tag ?? null, date_posted: new Date().toISOString(), endpoint_advanced: `/v3/${endpoint}/task_get/advanced/${t.id}` }))
        answer = env(OK, 'Ok.', [{ id: id(), status_code: OK, status_message: 'Ok.', cost: 0, result_count: ready.length, result: ready }], 0)
      } else if (verb.startsWith('task_get/') && req.method === 'GET') {
        const t = tasks.get(decodeURIComponent(taskId))
        if (!t || t.login !== who) answer = env(OK, 'Ok.', [{ id: taskId, status_code: 40400, status_message: 'Task Not Found.', cost: 0, result: null }], 0)
        else if (t.readyAt > Date.now()) answer = env(OK, 'Ok.', [{ id: t.id, status_code: 40602, status_message: 'Task In Queue.', cost: 0, data: t.data, result: null }], 0)
        else { t.collected = true; answer = env(OK, 'Ok.', [{ id: t.id, status_code: OK, status_message: 'Ok.', cost: 0, data: t.data, result: result(t.data) }], 0) }
      } else answer = env(40400, 'Not Found.', [], 0, 404)

      if (armed.lost) { armed.lost = false; await new Promise<void>(r => hanging.push(r)) }
      return record(answer)
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, stop() { for (const r of hanging) r(); server.stop(true) } }
}

if (import.meta.main) { const s = startDataforseoSink({ port: Number(process.env.DATAFORSEO_SINK_PORT ?? 0) }); console.log(`[dataforseo-sink] ${s.url}`) }
