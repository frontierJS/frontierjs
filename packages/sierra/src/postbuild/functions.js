/**
 * functions.js — host functions: the dynamic answers a static site still owes
 *
 * A file under the functions directory answers its own path, as on Cloudflare
 * Pages: `functions/api/event.js` is `/api/event`, `functions/ping/index.js` is
 * `/ping`. A function is the web's handler, `export default (request, env) =>
 * Response` (`FJS-D919`), so no host adapter rewrites one.
 *
 * The build writes ONE entry module naming every function, and a host mounts
 * that entry: `serveSite` does, and a host adapter bundles it. A function that
 * reached for a host's own API would pass every drive here and fail only on the
 * host it was written for, so the build refuses it by name.
 *
 * `env` carries strings only. A binding (KV, D1, a Durable Object) is dropped
 * before a function sees it, which is what keeps site code off one host.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { proxiedPaths } from '../analytics/tag.js'
import { refusal } from '../build/refusal.js'

/** Where the entry lands, relative to the project root. `.sierra/` is gitignored. */
export const FUNCTIONS_ENTRY = join('.sierra', 'functions.js')

const PROXY = fileURLToPath(new URL('./plausible-proxy.js', import.meta.url))

const SOURCE = /\.(?:[cm]?js|ts)$/

// A host-only module specifier, static or dynamic. `cloudflare:workers` and
// `cloudflare:sockets` are the ones a Pages function reaches for.
const HOST_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](cloudflare:[^'"]*)['"]/

/**
 * Every function under `dir`, with the path each answers.
 *
 * @param {string} dir  absolute functions directory
 * @returns {Array<{ path: string, file: string }>}
 */
export function functionRoutes(dir) {
  const found = new Map()

  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      // A dotfile is never a route: the dev server's fresh-import copy sits
      // beside its original under one.
      if (name.startsWith('.')) continue
      const file = join(current, name)
      if (statSync(file).isDirectory()) { walk(file); continue }
      if (!SOURCE.test(name)) continue

      const rel = relative(dir, file)
      // Pages' `[id].js` and `[[path]].js` are parameterised routes; one that
      // answered the literal text `[id]` would be a function nothing calls.
      if (/[[\]]/.test(rel)) {
        throw new Error(`[Sierra] functions: ${rel} names a path parameter, which a host function does not support — answer the path and read the rest from the request URL`)
      }

      const hit = HOST_IMPORT.exec(readFileSync(file, 'utf8'))
      if (hit) {
        throw new Error(`[Sierra] functions: ${rel} imports ${hit[1]}, which only one host provides — read configuration from env and call other services with fetch`)
      }

      const path = routeFor(rel)
      if (found.has(path)) {
        throw new Error(`[Sierra] functions: ${rel} and ${relative(dir, found.get(path))} both answer ${path}`)
      }
      found.set(path, file)
    }
  }
  walk(dir)

  return [...found].map(([path, file]) => ({ path, file }))
}

function routeFor(rel) {
  const parts = rel.split(sep)
  parts[parts.length - 1] = parts[parts.length - 1].replace(SOURCE, '')
  if (parts[parts.length - 1] === 'index') parts.pop()
  return '/' + parts.join('/')
}

/**
 * Every path the site's functions answer: the functions directory's files, then
 * the paths `analytics.proxy` derives (`FJS-D1037`). A file at a proxied path is
 * refused rather than either one winning in silence.
 *
 * @param {{ functions?: string, analytics?: object }} config
 * @param {string} root  project root
 * @returns {Array<{ path: string, file?: string, upstream?: string }>}
 */
export function siteFunctionRoutes(config, root) {
  const files   = config.functions ? functionRoutes(resolve(root, config.functions)) : []
  const proxied = Object.entries(proxiedPaths(config.analytics) ?? {})
  for (const [path] of proxied) {
    const mine = files.find(r => r.path === path)
    if (mine) {
      throw refusal(`[Sierra] functions: ${relative(root, mine.file)} answers ${path}, which analytics.proxy answers — delete the file, or drop proxy`)
    }
  }
  return [...files, ...proxied.map(([path, upstream]) => ({ path, upstream }))]
}

/** Whether the build writes a functions entry, so a host has one to mount. */
export function hasFunctions(config) {
  return !!config.functions || !!proxiedPaths(config.analytics)
}

/**
 * Write the entry: `export const routes = { '/api/event': handler, … }`.
 *
 * @param {object} opts
 * @param {string} opts.root  project root
 * @param {string} [opts.dir]   the functions directory, relative to `root`
 * @param {object} [opts.analytics]  `analytics` from the config, for its proxy
 * @returns {Promise<string>} the entry's absolute path
 */
export async function writeFunctionsEntry({ root, dir, analytics }) {
  const routes  = siteFunctionRoutes({ functions: dir, analytics }, root)
  const files   = routes.filter(r => r.file)
  const proxied = routes.filter(r => r.upstream)
  const entry   = join(root, FUNCTIONS_ENTRY)

  const lines = [
    '// functions.js — written by Sierra; edit the functions directory instead',
    ...files.map((r, i) => `import f${i} from ${JSON.stringify(r.file)}`),
    ...(proxied.length ? [`import { plausibleProxy } from ${JSON.stringify(PROXY)}`] : []),
    '',
    'export const routes = {',
    ...files.map((r, i) => `  ${JSON.stringify(r.path)}: f${i},`),
    ...(proxied.length
      ? [`  ...plausibleProxy(${JSON.stringify(Object.fromEntries(proxied.map(r => [r.path, r.upstream])))}),`]
      : []),
    '}',
    '',
  ]
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, lines.join('\n'), 'utf8')
  return entry
}

/** The build step: nothing without a `functions` key or `analytics.proxy`. */
export async function generateFunctions(config, root) {
  if (!hasFunctions(config)) return null
  await writeFunctionsEntry({ root, dir: config.functions, analytics: config.analytics })
  const count = siteFunctionRoutes(config, root).length
  return `${FUNCTIONS_ENTRY} (${count} function${count === 1 ? '' : 's'})`
}

// A function's request body: a beacon or a form post, never an upload. The cap
// is what stops an open origin buffering whatever it is sent.
const MAX_BODY = 1024 * 1024

/** A node request as the web's `Request` a function takes. */
export async function requestFrom(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const bodiless = req.method === 'GET' || req.method === 'HEAD'
  // With nothing fronting the server, the socket is the only record of the
  // visitor; a function forwarding to a vendor (the Plausible proxy) would
  // otherwise report the server's own address. A front proxy's header stands.
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  if (!headers.has('x-forwarded-for') && req.socket?.remoteAddress) headers.set('x-forwarded-for', req.socket.remoteAddress)
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method:  req.method,
    headers,
    body:    bodiless ? undefined : Buffer.concat(chunks),
  })
}

/** A function's `Response` written to a node response; `extra` headers go first and lose. */
export async function sendResponse(req, res, response, extra = {}) {
  res.writeHead(response.status, {
    ...extra,
    ...Object.fromEntries(response.headers),
    ...(response.headers.getSetCookie().length && { 'Set-Cookie': response.headers.getSetCookie() }),
  })
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()))
}
