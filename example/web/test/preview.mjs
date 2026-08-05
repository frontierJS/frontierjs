/**
 * web/test/preview.mjs — serve the PRODUCTION build the way `bun run web`
 * serves the source: static files, SPA fallback, and `/api` `/auth` `/session`
 * `/ws` proxied to Junction on :3600.
 *
 *   bun run build
 *   node web/test/preview.mjs &            # :5310
 *   UI_URL=http://localhost:5310 node web/test/verify.mjs
 *
 * `bun run verify:build` does all three.
 *
 * Why this exists rather than `vite preview`: preview does not carry
 * `server.proxy`, so the built app would talk to nothing and render plausible
 * empty tables. And the built page needs driving at all because it was inert
 * for the life of this app — Vite injected the entry script inside an HTML
 * comment (see web/index.html) and no console error said so.
 *
 * `/ws` is not optional. Leave it out and 36 of the 37 assertions still pass:
 * the one that fails is the delete, because the row leaves the table on the
 * real-time event rather than on the response.
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'dist', 'client')
const API  = process.env.API_URL ?? 'http://localhost:3600'
const PORT = Number(process.env.PREVIEW_PORT ?? 5310)

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain',
  '.xml': 'application/xml', '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (/^\/(api|auth|session)\b/.test(url.pathname)) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
    try {
      const upstream = await fetch(API + url.pathname + url.search, {
        method: req.method,
        headers: { ...req.headers, host: new URL(API).host },
        body,
      })
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers))
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (e) {
      // Same contract as the dev proxy: say which process is missing rather
      // than answering with an empty 200 the app would render as "no rows".
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`preview: cannot reach the API at ${API} — is \`bun run api\` up? (${e.message})`)
    }
    return
  }

  let path = join(ROOT, url.pathname)
  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html')
  } catch {
    path = join(ROOT, 'index.html')   // SPA fallback — the router owns the path
  }

  try {
    const file = await readFile(path)
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
    res.end(file)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(`preview: ${url.pathname} not found — has \`bun run build\` been run?`)
  }
})

// WebSocket upgrade, forwarded byte for byte.
server.on('upgrade', (req, socket, head) => {
  const { hostname, port } = new URL(API)
  const upstream = connect(Number(port), hostname, () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') +
      '\r\n'
    )
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(PORT, () => {
  console.log(`  preview  http://localhost:${PORT}  (dist/client, API → ${API})`)
})

/** Collect a request body so it can be forwarded to the API. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}
