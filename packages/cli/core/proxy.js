// ─── proxy.js — one listener, so a dev surface has a NAME ────────────────────
//
// `example.localhost` rather than `localhost:8010`. The names are `ports.js`'s —
// a rendering of the table that is already the source of truth for the numbers —
// and this is the half that is not free: a name has no port, so something has to
// map Host to one.
//
// ── Strictly additive ───────────────────────────────────────────────────────
//
// Every number keeps working and nothing may come to depend on this being up.
// `FLI_PORT_FE`/`FLI_PORT_BE`, `strictPort`, every drive and the ports table are
// the mechanism; a name is a second way to reach the same port. A DX nicety that
// becomes load-bearing is a worse trade than the tax it removes, so a row's
// `open` stays the number and a name is offered BESIDE it.
//
// ── Why this is TCP and not `node:http` ─────────────────────────────────────
//
// The first cut was an http server piping to an upstream request, with the
// `upgrade` event piping raw sockets. It works under node and **is silently
// broken under bun**, which is what `fli` runs on: bun's `node:http` server
// emits `upgrade` and hands over a socket that reports `writable: true`, and
// nothing written to it ever reaches the client. Measured — a 101 is written,
// the upstream sees the handshake, and the browser waits forever.
//
// That failure is exactly the one worth avoiding: junction's live layer and
// vite's HMR are both sockets, so a page would load and then silently stop
// updating, which is worse than a page that does not load.
//
// At the TCP layer there is nothing to be compatible about. Read the first
// request's head, pick the target from its Host, then pipe bytes. An upgrade is
// not a special case — it is a request whose answer happens to switch protocols,
// and after the head it is bytes either way.
//
// ── Why nothing is rewritten ────────────────────────────────────────────────
//
// The Host is forwarded untouched. Junction READS it — `resolve subdomain`
// tenancy is nothing but the host — so rewriting would make every tenant the
// same tenant; and vite, which was the reason to consider rewriting, allows
// `*.localhost` in its own DNS-rebinding guard (`hostname.endsWith('.localhost')`,
// checked in the 5.x and 8.x this workspace resolves). So there is nothing to
// rewrite, which is also what makes the TCP approach sound: rewriting a header
// on a keep-alive connection would mean parsing every request on it.
//
// The target is chosen from the FIRST request on a connection and kept. A
// browser opens a connection per origin, so every request on one carries the
// same Host.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbours.

import { createServer, connect } from 'node:net'

import { GLOBAL } from './ports.js'

/** Give up on a client that opens a connection and sends nothing. */
const HEAD_TIMEOUT = 10_000

/** A head bigger than this is not a request anybody here is making. */
const HEAD_MAX = 64 * 1024

/**
 * Host → the row it names.
 *
 * The proxy's own row is dropped: it is a name for this listener, and serving it
 * would be a loop with a plausible-looking first hop.
 */
export function hostTable(rows, { self = GLOBAL.proxy } = {}) {
  const table = new Map()
  for (const r of rows) {
    if (!r.host || typeof r.port !== 'number') continue
    if (r.port === self) continue
    // First wins. Two rows claiming one name is a bug in the ports table, so it
    // is reported by `hostCollisions` rather than silently resolved here.
    if (!table.has(r.host)) table.set(r.host, { host: r.host, port: r.port, id: r.id, name: r.name })
  }
  return table
}

/** Two rows that want one name — a ports-table bug, never a runtime choice. */
export function hostCollisions(rows) {
  const seen = new Map()
  const bad  = []
  for (const r of rows) {
    if (!r.host) continue
    const prev = seen.get(r.host)
    if (prev && prev.port !== r.port) bad.push({ host: r.host, ids: [prev.id, r.id] })
    else if (!prev) seen.set(r.host, r)
  }
  return bad
}

/** The host, without the port a browser appends when the proxy is not on 80. */
export function hostOnly(header) {
  const h = String(header ?? '').trim().toLowerCase()
  // An IPv6 literal is bracketed; everything else splits on the last colon.
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1)
  const i = h.lastIndexOf(':')
  return i === -1 ? h : h.slice(0, i)
}

/**
 * The `Host:` of a request head, or `''`.
 *
 * Only the head is looked at, and only up to the blank line — a body may contain
 * anything, including something that reads like a header.
 */
export function hostOf(head) {
  for (const line of String(head).split('\r\n')) {
    if (!line) break
    const m = line.match(/^host:\s*(.+)$/i)
    if (m) return hostOnly(m[1])
  }
  return ''
}

/**
 * A listener that maps Host to port.
 *
 * @param {Map} o.table  from `hostTable`
 */
export function createProxy({ table, target = '127.0.0.1' } = {}) {
  return createServer((client) => {
    let head    = ''
    let settled = false

    const give = () => { clearTimeout(timer); client.off('data', onData) }
    const timer = setTimeout(() => { if (!settled) { give(); client.destroy() } }, HEAD_TIMEOUT)

    const onData = (chunk) => {
      head += chunk
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) {
        if (head.length > HEAD_MAX) { give(); client.destroy() }
        return
      }

      settled = true
      give()

      const row = table.get(hostOf(head))
      if (!row) return refuse(client, hostOf(head), table)

      const up = connect(row.port, target, () => {
        up.write(head)
        client.pipe(up)
        up.pipe(client)
      })

      // The app is not running. Said as ITSELF, because a browser's own
      // connection-refused page names the proxy and not the thing that is down,
      // which sends somebody to look at the wrong process.
      up.on('error', (err) => {
        writeText(client, 502,
          `${row.host} is ${row.name} on :${row.port}, and nothing is answering there.\n${err.message}\n`)
      })
      client.on('error', () => up.destroy())
    }

    client.on('data', onData)
    client.on('error', () => { give(); client.destroy() })
  })
}

/** A name nothing claims, answered with the ones that exist. */
function refuse(client, asked, table) {
  const names = [...table.values()].sort((a, b) => a.host.localeCompare(b.host))
  writeText(client, 404,
    `no dev surface is named ${asked || '(no Host header)'}\n\n` +
    names.map(r => `  ${r.host.padEnd(34)} :${r.port}  ${r.name}`).join('\n') +
    '\n\nThese are derived from packages/cli/core/ports.js — a name is a rendering of that table.\n')
}

/** One plain-text answer, written by hand because this side speaks TCP. */
function writeText(socket, status, body) {
  const reason = status === 404 ? 'Not Found' : 'Bad Gateway'
  const bytes  = Buffer.byteLength(body)
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
      'content-type: text/plain; charset=utf-8\r\n' +
      `content-length: ${bytes}\r\n` +
      'connection: close\r\n\r\n' + body)
    socket.end()
  } catch { socket.destroy() }
}

/**
 * Listen on 80, falling back to the reserved slot.
 *
 * 80 is a privileged bind on a project whose whole pitch is that everything runs
 * as a plain user process, so the failure is EXPECTED rather than an error — and
 * the fallback is a number from the ports table rather than a convention,
 * because a tool somebody types from memory cannot take a number from an app's
 * row.
 */
export async function listenWithFallback(server, { port = 80, fallback = GLOBAL.proxy, host = '0.0.0.0' } = {}) {
  for (const p of [port, fallback]) {
    try {
      await new Promise((ok, no) => {
        const fail = (err) => { server.removeListener('listening', done); no(err) }
        const done = () => { server.removeListener('error', fail); ok() }
        server.once('error', fail)
        server.once('listening', done)
        server.listen(p, host)
      })
      return { port: p, privileged: p === port }
    } catch (err) {
      if (p === fallback) throw err
    }
  }
}
