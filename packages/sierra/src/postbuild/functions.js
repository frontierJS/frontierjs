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

/** Where the entry lands, relative to the project root. `.sierra/` is gitignored. */
export const FUNCTIONS_ENTRY = join('.sierra', 'functions.js')

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
 * Write the entry: `export const routes = { '/api/event': handler, … }`.
 *
 * @param {object} opts
 * @param {string} opts.root  project root
 * @param {string} opts.dir   the functions directory, relative to `root`
 * @returns {Promise<string>} the entry's absolute path
 */
export async function writeFunctionsEntry({ root, dir }) {
  const routes = functionRoutes(resolve(root, dir))
  const entry  = join(root, FUNCTIONS_ENTRY)

  const lines = [
    '// functions.js — written by Sierra; edit the functions directory instead',
    ...routes.map((r, i) => `import f${i} from ${JSON.stringify(r.file)}`),
    '',
    'export const routes = {',
    ...routes.map((r, i) => `  ${JSON.stringify(r.path)}: f${i},`),
    '}',
    '',
  ]
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, lines.join('\n'), 'utf8')
  return entry
}

/** The build step: nothing without a `functions` key. */
export async function generateFunctions(config, root) {
  if (!config.functions) return null
  await writeFunctionsEntry({ root, dir: config.functions })
  const count = functionRoutes(resolve(root, config.functions)).length
  return `${FUNCTIONS_ENTRY} (${count} function${count === 1 ? '' : 's'})`
}

/** A function's `env`: the strings of whatever the host process holds. */
export function stringEnv(env = {}) {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string'))
}

/**
 * The handler a host runs in front of its static answers.
 *
 * `/api/event` and `/api/event/` are one path, as a static host serves a page
 * either way.
 *
 * @param {Record<string, Function>} routes  an entry's `routes`
 * @param {Record<string, unknown>} [env]
 * @returns {{ has: (path: string) => boolean, handle: (request: Request) => Promise<Response> }}
 */
export function functionHandler(routes, env) {
  const strings = stringEnv(env)
  const keyOf   = (path) => path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

  return {
    has: (path) => Object.hasOwn(routes, keyOf(path)),
    async handle(request) {
      const fn = routes[keyOf(new URL(request.url).pathname)]
      const response = await fn(request, strings)
      if (!(response instanceof Response)) {
        throw new Error(`[Sierra] functions: ${new URL(request.url).pathname} returned ${typeof response}, not a Response`)
      }
      return response
    },
  }
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
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method:  req.method,
    headers: req.headers,
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
