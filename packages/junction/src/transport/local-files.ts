// transport/local-files.ts — serve a local FileStorage's directory.
//
// A File column with no provider bound keeps its bytes under <db dir>/files
// (`FJS-D1549`), and the URL a read answers names this route: without it every
// such URL is a dead link. The store is read through `db.$files`, so junction
// owns only the crossing (`FJS-D260`), and the directory is served read-only
// through the static server, marked untrusted -- these bytes came from strangers.
//
// The key is printed in every list response, so it is no secret: the route
// serves only a URL a gated read signed, until it expires (`FJS-D1703`).

import { randomBytes } from 'node:crypto'
import { serveStatic } from './static.ts'
import type { App } from '../core/app.ts'

interface LocalStore {
  localRoot: string | null
  config:    { publicBase?: string | null; signingKey?: string }
  verify(key: string, signed: { exp?: string; sig?: string }): boolean
}

export const FILES_ROUTE = '/files'

const SERVED_HEADERS = ['range', 'if-none-match', 'if-modified-since', 'accept-encoding']

/**
 * Mount `GET <apiPrefix>/files/*` over the client's local file store and tell
 * the store where it is served and what it signs with. A store whose
 * `publicBase` the deploy already named (`FILES_PUBLIC_BASE`) keeps it; the
 * route is still mounted.
 */
export function mountLocalFiles(app: App, prefix: string, port: number): void {
  // A client throws on a name it does not know, so `$files` is probed with `in`.
  const db    = app.db as { $files?: LocalStore | null } | undefined
  const store = db && '$files' in db ? db.$files : null
  const root  = store?.localRoot
  if (!store || !root) return

  const origin = (process.env.FRONTIER_APP_URL || `http://localhost:${port}`).replace(/\/+$/, '')
  store.config.publicBase ??= `${origin}${prefix}${FILES_ROUTE}`
  // One per process: a restart ends every URL already printed, and a page
  // reading the row again gets a fresh one.
  store.config.signingKey ??= randomBytes(32).toString('base64url')

  const base = `${prefix}${FILES_ROUTE}`
  app.get(`${FILES_ROUTE}/*`, async (ctx) => {
    const key = ctx.path.slice(base.length)
    // The wire reads a digit string as a number, so exp arrives as one.
    const { exp, sig } = ctx.query
    const signed = { exp: exp == null ? undefined : String(exp), sig: typeof sig === 'string' ? sig : undefined }
    if (!store.verify(decodeKey(key.replace(/^\//, '')), signed)) return ctx.text('Forbidden', 403)
    // ctx.headers is a lazy proxy that a Request cannot enumerate, so the
    // conditional and range headers the static server reads are copied by name.
    const headers = new Headers()
    for (const name of SERVED_HEADERS) {
      const value = ctx.headers[name]
      if (value) headers.set(name, value)
    }
    const req = new Request(`${ctx.protocol}://${ctx.host}${ctx.path}`, { headers })
    const res = await serveStatic(req, key, { root, untrusted: true })
    return res ?? ctx.text('Not Found', 404)
  })
}

// The store signs the key it holds and the URL carries it segment-encoded; a
// malformed escape matches no key, so it is refused like a bad signature.
function decodeKey(path: string): string {
  try { return path.split('/').map(decodeURIComponent).join('/') } catch { return '' }
}
