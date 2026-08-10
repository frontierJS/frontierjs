/**
 * web/test/preview.mjs — serve the PRODUCTION build the way `bun run web`
 * serves the source: static files, SPA fallback, and the API routes proxied to
 * Junction on :3001.
 *
 * Why this rather than `vite preview`: preview does not carry `server.proxy`,
 * so the built app would talk to nothing and render plausible empty tables —
 * which looks like a working page, and is the failure mode this whole harness
 * exists to rule out.
 *
 * Basecamp mounts its services at the ROOT (`/servers`, `/auth/*`, `/setup`),
 * with no `/api` prefix — so the proxy cannot match on a prefix the way
 * `example`'s does. It forwards anything that is not a built asset and is not
 * a known SPA route, which is what the dev server's own proxy config does.
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'dist', 'client')
const API  = process.env.API_URL ?? 'http://localhost:3001'
const PORT = Number(process.env.PREVIEW_PORT ?? 5311)

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain',
  '.xml': 'application/xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

// Everything the API owns. Kept as one list rather than a prefix test because
// Basecamp has no /api prefix — a service is mounted at its own name.
const API_ROUTES = /^\/(auth|setup|session|health|metrics|manifest|conduit-targets|workspaces|projects|environments|apps|domains|servers|deployments|jobs|networks|alerts|channels|secrets|portal|audit)\b/

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  // A browser navigating to /setup/ wants the SPA; the API's POST /setup is a
  // different thing at the same name. The method and the trailing slash are
  // what separate them, which is exactly what the dev proxy relies on too.
  const isDocument = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')

  if (API_ROUTES.test(url.pathname) && !isDocument) {
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
      // Say which process is missing rather than answering with an empty 200
      // the app would render as "no rows".
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`preview: cannot reach the API at ${API} — is it up? (${e.message})`)
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
    res.end(`preview: ${url.pathname} not found — has \`bun run build:web\` been run?`)
  }
})

// WebSocket upgrade, forwarded byte for byte. Not optional: the live status
// pill and every real-time list update are fed by it.
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
