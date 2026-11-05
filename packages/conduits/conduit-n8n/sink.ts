// sink.ts — n8n, standing in for n8n. Two listeners on one port, as the real
// thing: `/api/v1/*` behind `X-N8N-API-KEY` (workflows, executions, paged by
// an opaque cursor, 250 a page); `/webhook/<path>` and `/webhook-test/<path>`
// with no key, answered only for an ACTIVE workflow holding a Webhook node on
// that path and method, refusing with n8n's own `{ code, message, hint }`
// when none does. A Webhook node set to `headerAuth` asks for the sink's hook
// header; one set to `basicAuth` asks for the sink's `user:password`, both
// refused as n8n refuses them. Every trigger records an execution, so the C6
// read can find it. A run ends as its nodes say: a Stop and Error node is
// `error`, a Wait node is `waiting` until its seconds pass and then `success`.
// Stop, retry and tags answer n8n's own 409 sentences.
// The vendor's own *not now*: the first DELETE after a deactivate is refused
// with n8n's "still being unpublished" sentence, as the real one does while
// it tears the webhooks down. Chaos: `{ lost }`, `{ rateLimit: { retryAfter } }`, `{ failNext }`.

import { WEBHOOK_NODE, type N8nExecution, type N8nTag, type N8nWorkflow, type N8nWorkflowDefinition } from './src/types.ts'

export interface N8nSinkOptions { port?: number; key?: string; hookHeader?: string; hookKey?: string; hookBasic?: string }
export const STOP_AND_ERROR_NODE = 'n8n-nodes-base.stopAndError'
export const WAIT_NODE = 'n8n-nodes-base.wait'
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
const NO_TRIGGER = 'Workflow has no node to start the workflow - at least one trigger, poller or webhook node is required'
const UNPUBLISHING = 'Workflow is still being unpublished. Please try again in a few moments.'
const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ offset })).toString('base64')
const decodeCursor = (c: string | null) => { if (!c) return 0; try { return Number(JSON.parse(Buffer.from(c, 'base64').toString()).offset) || 0 } catch { return 0 } }

export function startN8nSink(opts: N8nSinkOptions = {}) {
  const KEY = opts.key ?? 'n8n_api_dev', HOOK_HEADER = (opts.hookHeader ?? 'X-Hook-Key').toLowerCase(), HOOK_KEY = opts.hookKey ?? 'hook_dev'
  const HOOK_BASIC = opts.hookBasic ?? 'hookuser:hook:pass%1'
  const seen: { method: string; path: string; status: number; keyed: boolean }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number } }
  const hanging: Array<() => void> = []
  const workflows = new Map<string, N8nWorkflow>()
  const executions: N8nExecution[] = []
  const unpublishing = new Set<string>()
  const tagRows = new Map<string, N8nTag>()
  let nextId = 1
  // A run as its nodes end it. Read through `settle`, so a Wait node's pause
  // ends when its seconds have passed, as the real one resumes on its own.
  const run = (w: N8nWorkflow, mode: N8nExecution['mode'], retryOf: string | null = null): N8nExecution => {
    const now = new Date().toISOString(), wait = w.nodes.find(n => n.type === WAIT_NODE)
    const status = w.nodes.some(n => n.type === STOP_AND_ERROR_NODE) ? 'error' : wait ? 'waiting' : 'success'
    const e: N8nExecution = { id: String(nextId++), workflowId: w.id, status, mode, finished: status === 'success', retryOf, retrySuccessId: null, startedAt: now, stoppedAt: now,
      waitTill: wait ? new Date(Date.now() + Number(wait.parameters?.amount ?? 1) * 1000).toISOString() : null }
    executions.unshift(e)
    return e
  }
  const settle = (e: N8nExecution) => {
    if (e.status === 'waiting' && e.waitTill && Date.parse(e.waitTill) <= Date.now()) Object.assign(e, { status: 'success', finished: true, stoppedAt: new Date().toISOString(), waitTill: null })
    return e
  }
  const page = <T>(rows: T[], url: URL) => {
    const limit = Number(url.searchParams.get('limit') ?? 100)
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) return json({ message: 'request/query/limit must be <= 250' }, 400)
    const offset = decodeCursor(url.searchParams.get('cursor'))
    const data = rows.slice(offset, offset + limit)
    return json({ data, nextCursor: offset + limit < rows.length ? encodeCursor(offset + limit) : null })
  }
  const hasTrigger = (w: N8nWorkflowDefinition) => w.nodes.some(n => n.type === WEBHOOK_NODE || /trigger$/i.test(n.type))

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), method = req.method
      if (url.pathname === '/_sink/seen')  return json({ requests: seen })
      if (url.pathname === '/_sink/reset') { seen.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null }); return json({ ok: true }) }
      if (url.pathname === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      if (url.pathname === '/healthz')     return json({ status: 'ok' })
      const text = await req.text()
      const body = text ? (() => { try { return JSON.parse(text) } catch { return text } })() : undefined
      const entry = { method, path: url.pathname, status: 0, keyed: req.headers.has("x-n8n-api-key") }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(json({ message: 'Too many requests' }, 429, { 'retry-after': String(retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(json({ message: 'Internal server error' }, 500)) }

      // ── the webhook listener: no API key, the node's own auth ──
      const hook = url.pathname.match(/^\/webhook(-test)?\/(.+)$/)
      if (hook) {
        const path = hook[2]
        const live = [...workflows.values()].find(w => w.active && w.nodes.some(n => n.type === WEBHOOK_NODE && n.parameters?.path === path && ((n.parameters?.httpMethod as string) ?? 'POST') === method))
        if (!live) return record(json({ code: 404, message: `The requested webhook "${method} ${path}" is not registered.`, hint: 'The workflow must be active for a production URL to run successfully. You can activate the workflow using the toggle in the top-right of the editor.' }, 404))
        const node = live.nodes.find(n => n.type === WEBHOOK_NODE && n.parameters?.path === path)!
        if (node.parameters?.authentication === 'headerAuth' && req.headers.get(HOOK_HEADER) !== HOOK_KEY) return record(json({ code: 403, message: 'Authorization data is wrong!' }, 403))
        if (node.parameters?.authentication === 'basicAuth') {
          const given = req.headers.get('authorization'), challenge = { 'www-authenticate': 'Basic realm="Webhook"' }
          if (!given) return record(json({ code: 401, message: 'Authorization is required!' }, 401, challenge))
          if (given !== `Basic ${Buffer.from(HOOK_BASIC).toString('base64')}`) return record(json({ code: 401, message: 'Authentication data is wrong!' }, 401, challenge))
        }
        run(live, 'webhook')
        if (node.parameters?.responseMode === 'lastNode') return record(json({ received: body ?? null, path }))
        return record(json({ message: 'Workflow was started' }))
      }

      // ── the public API ──
      if (!url.pathname.startsWith('/api/v1/')) return record(json({ message: 'Not Found' }, 404))
      if (req.headers.get('x-n8n-api-key') !== KEY) return record(json({ message: 'unauthorized' }, 401))
      const rest = url.pathname.slice('/api/v1/'.length).split('/')
      if (rest[0] === 'workflows') {
        const [, id, verb] = rest
        if (!id) {
          if (method === 'GET') {
            let rows = [...workflows.values()]
            const active = url.searchParams.get('active'), name = url.searchParams.get('name')
            if (active !== null) rows = rows.filter(w => String(w.active) === active)
            if (name) rows = rows.filter(w => w.name === name)
            const tagged = url.searchParams.get('tags')?.split(',')
            if (tagged) rows = rows.filter(w => tagged.every(n => w.tags?.some(t => t.name === n)))
            return record(page(rows, url))
          }
          if (method === 'POST') {
            const def = body as N8nWorkflowDefinition
            if (!def?.name || !Array.isArray(def.nodes) || !def.connections) return record(json({ message: "request/body must have required property 'name'" }, 400))
            if ('active' in (def as object)) return record(json({ message: 'request/body/active is read-only' }, 400))
            const now = new Date().toISOString()
            const w: N8nWorkflow = { id: `wf${nextId++}`, active: false, createdAt: now, updatedAt: now, name: def.name, nodes: def.nodes.map((n, i) => ({ ...n, id: n.id ?? `node-${i}` })), connections: def.connections, settings: def.settings ?? {}, tags: [] }
            workflows.set(w.id, w)
            return record(json(w))
          }
        }
        const w = id ? workflows.get(id) : undefined
        if (!w) return record(json({ message: 'Not Found' }, 404))
        if (verb === 'activate'   && method === 'POST') { if (!hasTrigger(w)) return record(json({ message: NO_TRIGGER }, 400)); w.active = true;  return record(json(w)) }
        if (verb === 'deactivate' && method === 'POST') { if (w.active) unpublishing.add(w.id); w.active = false; return record(json(w)) }
        if (verb === 'tags' && method === 'GET') return record(json(w.tags ?? []))
        if (verb === 'tags' && method === 'PUT') {
          const ids = (body as { id: string }[]).map(t => t.id)
          if (ids.some(i => !tagRows.has(i))) return record(json({ message: 'Some tags not found' }, 404))
          w.tags = ids.map(i => tagRows.get(i)!)
          return record(json(w.tags))
        }
        if (verb) return record(json({ message: 'Not Found' }, 404))
        if (method === 'GET')    return record(json(w))
        if (method === 'PUT')    { const def = body as N8nWorkflowDefinition; Object.assign(w, { name: def.name, nodes: def.nodes, connections: def.connections, settings: def.settings ?? {}, updatedAt: new Date().toISOString() }); return record(json(w)) }
        if (method === 'DELETE') { if (unpublishing.delete(w.id)) return record(json({ message: UNPUBLISHING }, 409)); workflows.delete(w.id); return record(json(w)) }
      }
      if (rest[0] === 'tags') {
        const [, id] = rest
        const taken = (name: string) => !name || name.length > 24 || [...tagRows.values()].some(t => t.name === name && t.id !== id)
        if (!id && method === 'GET') return record(page([...tagRows.values()], url))
        if (!id && method === 'POST') {
          const name = (body as { name?: string })?.name ?? ''
          if (taken(name)) return record(json({ message: 'Tag already exists' }, 409))
          const now = new Date().toISOString(), t = { id: `tag${nextId++}`, name, createdAt: now, updatedAt: now }
          tagRows.set(t.id, t)
          return record(json(t, 201))
        }
        const t = id ? tagRows.get(id) : undefined
        if (!t) return record(json({ message: 'Not Found' }, 404))
        if (method === 'GET') return record(json(t))
        if (method === 'PUT') {
          const name = (body as { name?: string })?.name ?? ''
          if (taken(name)) return record(json({ message: 'Tag already exists' }, 409))
          Object.assign(t, { name, updatedAt: new Date().toISOString() })
          return record(json({ id: t.id, name: t.name, updatedAt: t.updatedAt }))
        }
        if (method === 'DELETE') {
          tagRows.delete(t.id)
          for (const w of workflows.values()) w.tags = w.tags?.filter(x => x.id !== t.id)
          return record(json(t))
        }
      }
      if (rest[0] === 'executions') {
        const [, id, verb] = rest
        executions.forEach(settle)
        if (!id && method === 'GET') {
          let rows = executions
          const wid = url.searchParams.get('workflowId'), status = url.searchParams.get('status')
          if (wid) rows = rows.filter(e => e.workflowId === wid)
          if (status) rows = rows.filter(e => e.status === status)
          return record(page(rows, url))
        }
        const i = executions.findIndex(e => e.id === id)
        if (verb === 'stop' && method === 'POST') {
          const e = executions[i]
          if (!e) return record(json({ message: 'Failed to find execution to stop' }, 404))
          if (e.status !== 'running' && e.status !== 'waiting') return record(json({ message: `Only running or waiting executions can be stopped and ${id} is currently ${e.status}` }, 409))
          Object.assign(e, { status: 'canceled', finished: false, stoppedAt: new Date().toISOString(), waitTill: null })
          return record(json({ mode: e.mode, startedAt: e.startedAt, stoppedAt: e.stoppedAt, finished: e.finished, status: e.status }))
        }
        if (verb === 'retry' && method === 'POST') {
          const e = executions[i]
          if (!e) return record(json({ message: `The execution with the ID "${id}" does not exist.` }, 404))
          if (e.status === 'success') return record(json({ message: 'The execution succeeded, so it cannot be retried.' }, 409))
          const w = workflows.get(e.workflowId)
          if (!w) return record(json({ message: 'Not Found' }, 404))
          return record(json(run(w, 'retry', e.id)))
        }
        if (verb) return record(json({ message: 'Not Found' }, 404))
        if (i < 0) return record(json({ message: 'Not Found' }, 404))
        if (method === 'GET')    return record(json(executions[i]))
        if (method === 'DELETE') return record(json(executions.splice(i, 1)[0]))
      }
      return record(json({ message: 'Not Found' }, 404))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, key: KEY, hookHeader: opts.hookHeader ?? 'X-Hook-Key', hookKey: HOOK_KEY, hookBasic: HOOK_BASIC, stop() { for (const r of hanging) r(); server.stop(true) } }
}
if (import.meta.main) console.log(`[n8n-sink] ${startN8nSink({ port: Number(process.env.N8N_SINK_PORT ?? 0) }).url}`)
