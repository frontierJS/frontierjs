// ─── live-view.js — the console's app panes: the running app, through devtools ─
//
// Devtools (junction's plugin) runs inside the app's process on the reserved
// tooling slot and owns every reading: the call feed, the event bus, the
// sockets, the queue, readiness and metrics. This file only carries them to
// the console. The console is not on devtools' origin, and a browser refuses
// to read an answer devtools never allowed it, which reads exactly like the
// app being down; so the server reads devtools and the pane reads the server,
// in both targets.
//
// What may be reached is this file's list, matched by shape and rebuilt with
// each caller-supplied segment encoded, never a path joined onto the target.
//
// The stream is devtools' WebSocket relayed as one JSON frame per line. The
// relay adds two frames of its own, `open` and `closed`, so a pane can tell
// an app that is quiet from one that is not there.

import { GLOBAL } from './ports.js'

// `fli gui --devtools-port` sets it, for an app that moved devtools off the
// reserved slot — a test tier, or `devtools({ port })`.
const HOST = `127.0.0.1:${parseInt(process.env.FLI_DEVTOOLS_PORT, 10) || GLOBAL.devtools}`

const notRunning = (err) => ({
  status: 503,
  body: {
    down:  true,
    at:    HOST,
    error: `nothing answers on ${HOST} (${err?.cause?.code ?? err?.message ?? 'refused'}) — devtools runs inside an app: app.configure(devtools()), then start it`,
  },
})

async function ask(path, init) {
  let res
  try { res = await fetch(`http://${HOST}${path}`, init) } catch (err) { return notRunning(err) }
  const body = await res.json().catch(() => ({ error: `${path} answered ${res.status} with no JSON` }))
  return { status: res.status, body }
}

const JOB_QUERY  = ['queue', 'status', 'limit', 'offset']
const DATA_QUERY = ['as', 'tenant', 'limit', 'offset']

const carried = (search, keys) => {
  const q = new URLSearchParams()
  for (const k of keys) if (search.get(k)) q.set(k, search.get(k))
  return q.size ? `?${q}` : ''
}

// ─── :ask ─────────────────────────────────────────────────────────────────
//
// The agent speaks MCP to devtools' `/api/mcp`, which the app's own `mcp()`
// answers as the principal `?as=` names (`FJS-D1428`). The agent is a process
// of this server's, not a page, so it is handed this URL directly; the pane
// reads the same URL here for the tools that standing is offered.

/** Where `:ask`'s agent is pointed, as `as` in `tenant`. */
export const agentUrl = (search) => `http://${HOST}/api/mcp${carried(search, ['as', 'tenant'])}`

async function offered(search) {
  let res
  try {
    res = await fetch(agentUrl(search), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
  } catch (err) { return notRunning(err) }
  const body = await res.json().catch(() => null)
  if (!res.ok) return { status: res.status, body: body ?? { error: `/api/mcp answered ${res.status} with no JSON` } }
  if (!body?.result) return { status: 502, body: { error: body?.error?.message ?? 'tools/list answered no result' } }
  return { status: 200, body: { tools: (body.result.tools ?? []).map(t => ({ name: t.name, description: t.description ?? '' })) } }
}

/** One read: `health`, `metrics` (the metrics half of devtools' state),
 *  `call` (what `:call` may name, per service), `ask` (the tools `:ask`'s
 *  agent is offered as somebody), `jobs`, or `data` (the schema's models)
 *  and `data/<Model>` (a page of its rows as somebody, for `:data`), whose
 *  query is carried by name. `{ status, body }`. */
export async function readLive(what, search = new URLSearchParams()) {
  if (what === 'health') return ask('/api/health')
  if (what === 'call')   return ask('/api/call')
  if (what === 'metrics') {
    const out = await ask('/api/state')
    return out.status === 200 ? { status: 200, body: out.body.metrics ?? {} } : out
  }
  if (what === 'ask')  return offered(search)
  if (what === 'jobs') return ask(`/api/jobs${carried(search, JOB_QUERY)}`)
  if (what === 'data') return ask(`/api/data${carried(search, ['tenant'])}`)
  const rows = /^data\/([^/]+)$/.exec(what)
  if (rows) return ask(`/api/data/${encodeURIComponent(decodeURIComponent(rows[1]))}${carried(search, DATA_QUERY)}`)
  return { status: 404, body: { error: `no live reading ${what}` } }
}

/** One act: `call`, with `{ method, args, as, tenant }` as `body` and run
 *  inside the app (`FJS-D1426`); or on the queue, `jobs/<id>/retry`,
 *  `jobs/<id>/cancel` or `jobs/run/<name>`, the last with the job's data. */
export function actLive(rest, body) {
  if (rest === 'call') {
    const { method, args, as, tenant } = body ?? {}
    return ask('/api/call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, as, tenant }),
    })
  }
  const run = /^jobs\/run\/([^/]+)$/.exec(rest)
  if (run) {
    return ask(`/api/jobs/run/${encodeURIComponent(decodeURIComponent(run[1]))}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    })
  }
  const one = /^jobs\/([^/]+)\/(retry|cancel)$/.exec(rest)
  if (one) return ask(`/api/jobs/${encodeURIComponent(decodeURIComponent(one[1]))}/${one[2]}`, { method: 'POST' })
  return Promise.resolve({ status: 404, body: { error: `no live act ${rest}` } })
}

/** Devtools' socket onto `res`, a frame a line, until either end goes. */
export function streamLive(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' })
  const line = (frame) => res.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`)

  let ended = false
  const end = (reason) => {
    if (ended) return
    ended = true
    line({ type: 'closed', at: HOST, reason })
    res.end()
  }

  let ws, opened = false
  const gone = () => opened ? `devtools on ${HOST} went away` : `nothing answers on ${HOST}`
  try { ws = new WebSocket(`ws://${HOST}/ws`) } catch (err) { return end(err.message) }
  ws.addEventListener('open', () => { opened = true; line({ type: 'open', at: HOST }) })
  ws.addEventListener('message', (e) => { if (!ended) line(String(e.data)) })
  // A failed socket reports `error` and then `close`, in that order, and the
  // first of the two ends the stream.
  ws.addEventListener('error', () => end(gone()))
  ws.addEventListener('close', (e) => end(e.reason || gone()))
  // The response's close, not the request's: a GET's request closes once its
  // empty body is read, which would drop the socket on arrival.
  res.on('close', () => { ended = true; try { ws.close() } catch {} })
}
