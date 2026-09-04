// proxy.test.js — one listener, so a dev surface has a NAME.
//
// The names are `ports.js`'s and are a rendering of the table that already owns
// the numbers. This is the half that is not free: a name has no port.
//
// The case that decides whether any of it is usable is the UPGRADE. Junction's
// live layer and vite's HMR are both sockets, so an unproxied one is a page that
// loads and then silently stops updating — worse than a page that does not load.
// It is also the case that sent this module to the TCP layer: bun's `node:http`
// emits `upgrade`, hands over a socket that reports `writable: true`, and
// nothing written to it reaches the client.
//
// The other one worth stating is that NOTHING is rewritten. Junction reads the
// Host — `resolve subdomain` tenancy is nothing else — and vite allows
// `*.localhost` in its own rebinding guard, so a proxy that rewrote it would
// break the one and appease the other for no reason.

import { describe, test, expect, afterEach } from 'bun:test'
import { createServer } from 'http'
import { connect, createServer as netServer } from 'net'

import { hostTable, hostCollisions, hostOnly, hostOf, createProxy, listenWithFallback } from '../core/proxy.js'
import { GLOBAL } from '../core/ports.js'

const shut = []
afterEach(async () => { while (shut.length) await shut.pop()() })

/** An HTTP server that reports what it was sent, on an ephemeral port. */
async function upstream(handler) {
  const s = createServer(handler)
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  shut.push(() => new Promise(r => s.close(r)))
  return s
}

/** A RAW server, for the upgrade case — an upgrade is bytes, not a request. */
async function rawUpstream(onConnection) {
  const s = netServer(onConnection)
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  shut.push(() => new Promise(r => s.close(r)))
  return s
}

/**
 * One request, on its own connection, written by hand.
 *
 * `fetch` is not usable here and the reason is worth stating: node's strips a
 * `host` header override and sends the URL's authority, bun's honors it — so
 * the same test asserts two different things depending on the runtime. And its
 * connection POOLING is what this proxy's one documented bound is about, which
 * a test must control rather than inherit.
 */
function send(port, { host, path = '/', method = 'GET', body = '', extra = [] }) {
  return new Promise((ok, no) => {
    let buf = ''
    const s = connect(port, '127.0.0.1', () => {
      s.write([
        `${method} ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: close',
        ...extra,
        `Content-Length: ${Buffer.byteLength(body)}`,
        '', body,
      ].join('\r\n'))
    })
    s.on('data', (d) => { buf += d })
    s.on('end', () => ok(buf))
    s.on('error', no)
    setTimeout(() => { s.destroy(); no(new Error(`no answer — got ${JSON.stringify(buf)}`)) }, 4000)
  })
}

/** The body of a raw answer — everything after the blank line. */
const bodyOf = (raw) => raw.slice(raw.indexOf('\r\n\r\n') + 4)
const statusOf = (raw) => Number(raw.slice(9, 12))

/** The proxy, listening on an ephemeral port, over a table the test states. */
async function proxy(rows) {
  const server = createProxy({ table: hostTable(rows) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  shut.push(() => new Promise(r => server.close(r)))
  return server.address().port
}

const row = (over) => ({ id: 'surface:x/web', name: 'web', ...over })

describe('the host', () => {

  test('a port the browser appended is not part of the name', () => {
    // The proxy answers on 8504 when 80 needs a privileged bind, so every Host
    // it sees carries a port that is the PROXY's and never the target's.
    expect(hostOnly('example.localhost:8504')).toBe('example.localhost')
    expect(hostOnly('example.localhost')).toBe('example.localhost')
  })

  test('and it is matched case-insensitively, because a Host is', () => {
    expect(hostOnly('Example.LOCALHOST:80')).toBe('example.localhost')
  })

  test('an IPv6 literal keeps its brackets', () => {
    expect(hostOnly('[::1]:8504')).toBe('[::1]')
  })

  test('no Host header at all is an empty name, not a crash', () => {
    expect(hostOnly(undefined)).toBe('')
  })

  test('a line in the BODY that looks like a header is not one', () => {
    // The buffer the router reads is whatever arrived, which is the head AND
    // however much of the body came with it — so a scan that does not stop at
    // the blank line lets a caller choose the target by writing one line of
    // POST body.
    const head = [
      'POST /x HTTP/1.1', 'Host: real.localhost', 'Content-Length: 22', '',
      'Host: evil.localhost',
    ].join('\r\n')
    expect(hostOf(head)).toBe('real.localhost')

    // And the case the boundary actually decides: with no Host in the head at
    // all, a scan that runs on takes the target from the body — so a caller
    // that sends no Host picks the app.
    const headless = ['POST /x HTTP/1.1', 'Content-Length: 22', '', 'Host: evil.localhost'].join('\r\n')
    expect(hostOf(headless)).toBe('')
  })

  test('and a request with no Host at all names nothing', () => {
    expect(hostOf('GET / HTTP/1.1\r\n\r\n')).toBe('')
  })

})

describe('the table', () => {

  test('a row with no name or no port is not in it', () => {
    const t = hostTable([
      row({ host: 'a.localhost', port: 1 }),
      row({ host: null, port: 2 }),
      row({ host: 'c.localhost', port: null }),
    ])
    expect([...t.keys()]).toEqual(['a.localhost'])
  })

  test('the proxy`s own row is dropped, because serving it is a loop', () => {
    const t = hostTable([row({ host: 'proxy.fli.localhost', port: GLOBAL.proxy })])
    expect(t.size).toBe(0)
  })

  test('two rows wanting one name is reported rather than resolved', () => {
    // A collision is a bug in the ports table, and picking a winner at runtime
    // is how it stays one: whichever app started first would work.
    const bad = hostCollisions([
      row({ id: 'surface:a/web', host: 'x.localhost', port: 8010 }),
      row({ id: 'surface:b/web', host: 'x.localhost', port: 8020 }),
    ])
    expect(bad).toHaveLength(1)
    expect(bad[0].ids).toEqual(['surface:a/web', 'surface:b/web'])
  })

  test('and two rows agreeing on the same port are not a collision', () => {
    expect(hostCollisions([
      row({ id: 'a', host: 'x.localhost', port: 8010 }),
      row({ id: 'b', host: 'x.localhost', port: 8010 }),
    ])).toEqual([])
  })

})

describe('proxying a request', () => {

  test('the Host decides the port', async () => {
    const a = (await upstream((_, res) => res.end('A'))).address().port
    const b = (await upstream((_, res) => res.end('B'))).address().port
    const p = await proxy([
      row({ host: 'a.localhost', port: a }),
      row({ host: 'b.localhost', port: b, id: 'surface:y/web' }),
    ])

    expect(bodyOf(await send(p, { host: 'a.localhost' }))).toBe('A')
    expect(bodyOf(await send(p, { host: 'b.localhost' }))).toBe('B')
  })

  test('and it is decided once per CONNECTION, which is the one bound here', async () => {
    // Stated rather than discovered. Routing per request would mean parsing
    // every request on a keep-alive connection — bodies, chunked encoding, the
    // lot — and no real client reaches this: a Host is derived from the URL, and
    // a browser pools per ORIGIN, so two names are two connections. A client
    // that overrides Host on a pooled socket is the only way in.
    // Distinctive tokens, not `A` and `B`: a response's own headers carry both
    // letters (`Keep-Alive`), so counting single characters counts the wrong
    // thing and reads as the routing being wrong.
    const a = (await upstream((_, res) => res.end('FROM-ONE'))).address().port
    const b = (await upstream((_, res) => res.end('FROM-TWO'))).address().port
    const p = await proxy([
      row({ host: 'a.localhost', port: a }),
      row({ host: 'b.localhost', port: b, id: 'surface:y/web' }),
    ])

    const both = await new Promise((ok, no) => {
      let buf = ''
      const s = connect(p, '127.0.0.1', () => {
        s.write('GET / HTTP/1.1\r\nHost: a.localhost\r\n\r\n')
        setTimeout(() => s.write('GET / HTTP/1.1\r\nHost: b.localhost\r\nConnection: close\r\n\r\n'), 150)
      })
      s.on('data', (d) => { buf += d })
      s.on('end', () => ok(buf))
      s.on('error', no)
      setTimeout(() => { s.destroy(); ok(buf) }, 2500)
    })
    expect(both.match(/FROM-ONE/g)?.length).toBe(2)
    expect(both).not.toMatch(/FROM-TWO/)
  })

  test('the path, the method and the body all survive', async () => {
    const port = (await upstream((req, res) => {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => res.end(JSON.stringify({ url: req.url, method: req.method, body })))
    })).address().port
    const p = await proxy([row({ host: 'a.localhost', port })])

    const raw = await send(p, { host: 'a.localhost', path: '/orders?x=1', method: 'POST', body: 'hello' })
    expect(JSON.parse(bodyOf(raw))).toEqual({ url: '/orders?x=1', method: 'POST', body: 'hello' })
  })

  test('the Host reaches the app exactly as the browser sent it', async () => {
    // Junction READS it — `resolve subdomain` tenancy is nothing but the host —
    // so a proxy that rewrote it would make every tenant the same tenant. The
    // reason to consider rewriting was vite, and vite allows `*.localhost` in
    // its own rebinding guard, so there is nothing to appease.
    const port = (await upstream((req, res) => res.end(req.headers.host))).address().port
    const p = await proxy([row({ host: 'api.a.localhost', port })])
    expect(bodyOf(await send(p, { host: 'api.a.localhost' }))).toBe('api.a.localhost')
  })

  test('a name nothing claims answers with the names that exist', async () => {
    const p   = await proxy([row({ host: 'a.localhost', port: 1 })])
    const raw = await send(p, { host: 'nope.localhost' })
    expect(statusOf(raw)).toBe(404)
    expect(raw).toMatch(/no dev surface is named nope.localhost/)
    expect(raw).toMatch(/a\.localhost/)
  })

  test('a name whose app is not running says which app and which port', async () => {
    // A browser's own connection-refused page names the proxy, not the thing
    // that is down — which sends somebody to look at the wrong process.
    const p   = await proxy([row({ host: 'a.localhost', port: 1, name: 'API' })])
    const raw = await send(p, { host: 'a.localhost' })
    expect(statusOf(raw)).toBe(502)
    expect(raw).toMatch(/a\.localhost is API on :1, and nothing is answering/)
  })

})

describe('proxying an upgrade', () => {

  test('a WebSocket handshake reaches the app and the bytes flow both ways', async () => {
    // The case that decides whether this is usable at all: junction's live layer
    // and vite's HMR are both sockets, and an unproxied upgrade is a page that
    // loads and then silently stops updating.
    // A RAW upstream, and not a `node:http` one with an `upgrade` handler: bun
    // cannot ANSWER an upgrade through `node:http` either, so a fake built on
    // one fails for the runtime's reason rather than the proxy's — which is how
    // this test spent an afternoon accusing the wrong module.
    const server = await rawUpstream((sock) => {
      sock.once('data', (head) => {
        const host = String(head).match(/host:\s*(.+)/i)?.[1]?.trim() ?? ''
        sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n' +
                   `x-saw-host: ${host}\r\n\r\n`)
        sock.on('data', (d) => sock.write(`echo:${d}`))
      })
    })
    const port = server.address().port

    const p = await proxy([row({ host: 'a.localhost', port })])

    const seen = await new Promise((ok, no) => {
      const s = connect(p, '127.0.0.1', () => {
        s.write('GET /ws HTTP/1.1\r\nHost: a.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      })
      let buf = ''
      s.on('data', (d) => {
        buf += d
        if (buf.includes('101') && !buf.includes('echo:')) s.write('ping')
        if (buf.includes('echo:ping')) { s.destroy(); ok(buf) }
      })
      s.on('error', no)
      setTimeout(() => { s.destroy(); no(new Error(`no echo — got ${JSON.stringify(buf)}`)) }, 3000)
    })

    expect(seen).toMatch(/101 Switching Protocols/)
    expect(seen).toMatch(/x-saw-host: a\.localhost/)
    expect(seen).toMatch(/echo:ping/)
  })

  test('an upgrade to a name nothing claims is dropped rather than proxied somewhere', async () => {
    const p = await proxy([row({ host: 'a.localhost', port: 1 })])
    const closed = await new Promise((ok) => {
      const s = connect(p, '127.0.0.1', () => {
        s.write('GET /ws HTTP/1.1\r\nHost: nope.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      })
      s.on('close', () => ok(true))
      s.on('error', () => ok(true))
      setTimeout(() => { s.destroy(); ok(false) }, 2000)
    })
    expect(closed).toBe(true)
  })

})

describe('where it listens', () => {

  test('falls back to the reserved slot when the first port is taken', async () => {
    // 80 is a privileged bind on a project whose whole pitch is that everything
    // runs as a plain user process, so the failure is EXPECTED — and the
    // fallback is a number from the ports table rather than a convention.
    const taken = createServer(() => {})
    await new Promise(r => taken.listen(0, '127.0.0.1', r))
    const first = taken.address().port
    shut.push(() => new Promise(r => taken.close(r)))

    const server = createProxy({ table: new Map() })
    shut.push(() => new Promise(r => server.close(r)))

    const spare = createServer(() => {})
    await new Promise(r => spare.listen(0, '127.0.0.1', r))
    const free = spare.address().port
    await new Promise(r => spare.close(r))

    const bound = await listenWithFallback(server, { port: first, fallback: free, host: '127.0.0.1' })
    expect(bound.port).toBe(free)
    expect(bound.privileged).toBe(false)
  })

  test('and says when it got the one it wanted', async () => {
    const spare = createServer(() => {})
    await new Promise(r => spare.listen(0, '127.0.0.1', r))
    const free = spare.address().port
    await new Promise(r => spare.close(r))

    const server = createProxy({ table: new Map() })
    shut.push(() => new Promise(r => server.close(r)))

    const bound = await listenWithFallback(server, { port: free, fallback: 1, host: '127.0.0.1' })
    expect(bound).toEqual({ port: free, privileged: true })
  })

})
