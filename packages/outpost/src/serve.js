/*
 * serve.js — the origin an inline app answers on.
 *
 * A second listener, on a port of its own, serving the files `static.js` wrote.
 * It shares no port, no route table and no signature with the command half.
 *
 * SEPARATE ORIGIN IS THE WHOLE REASON IT IS A SECOND SERVER. The pages here are
 * written by whoever can edit an app — arbitrary script, from a paste box — so
 * anything they can reach as same-origin is theirs. On the command port that
 * would be the signed protocol this machine runs containers with; on Basecamp's
 * own it would be the operator's session. A port is an origin, so one listener
 * carrying both would hand every prototype the fleet.
 *
 * Nothing here is signed and nothing here is authenticated: it is a web server
 * for public files, and the only reads it can perform are inside one directory.
 * That containment is asserted twice — the publish side allows only plain file
 * names, and every request path is resolved and checked against the root here,
 * because this is the half that takes its input from the world.
 */

import fsp                from 'node:fs/promises'
import { basename, join, resolve, extname } from 'node:path'
import { contentTypeFor } from '@frontierjs/toolbelt/mime'

const NOT_FOUND = (message) => new Response(`${message}\n`, {
  status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' },
})

/** The label an app is reached by, off the Host header.
 *
 *  A single-label host is the MACHINE's name, not an app's: `localhost`, or
 *  whatever a laptop calls itself. Only a name with a dot in it can carry an
 *  app label in front of a domain — which includes `shop.localhost`, the way
 *  this workspace reaches every other surface without DNS. */
function labelFromHost(host) {
  if (!host) return null
  const name = host.split(':')[0].toLowerCase()
  if (/^[0-9.]+$/.test(name) || !name.includes('.')) return null
  const label = name.split('.')[0]
  return /^[a-z0-9][a-z0-9-]*$/.test(label) ? label : null
}

export function createStaticServer({ staticDir = '/var/lib/outpost/static' } = {}, { log = console } = {}) {

  const root     = resolve(staticDir)
  const hostsDir = join(root, 'hosts')

  /**
   * Which app this request is for, and what is left of the path once the label
   * has been taken off it.
   *
   * Both readings are listed, in order, rather than one being chosen: a
   * machine reached at `outpost.internal` would otherwise have every request
   * read as app `outpost` and a path route would never be tried, which is a
   * whole port that works until somebody gives the box a domain name. The
   * host reading is final only when its label IS an app (`handle`), so a
   * label that names nothing still falls through to the path.
   */
  function candidates(url, host) {
    // `%E0` is a path no file has, and the port has no authentication in front
    // of it: a malformed escape is the caller's mistake, answered as one
    // rather than thrown out of `handle` as a 500 and a stack (`FJS-1856`).
    let segments
    try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) }
    catch { return null }
    const byHost   = labelFromHost(host)
    const out      = []
    if (byHost)          out.push({ label: byHost,      rest: segments, byHost: true })
    if (segments.length) out.push({ label: segments[0], rest: segments.slice(1) })
    return out
  }

  /**
   * Resolve a file inside one app's live release, or null.
   *
   * `realpath` rather than string arithmetic on the joined path: `current` is a
   * symlink and so is the host entry, so the string a caller reasons about and
   * the file the kernel opens are two different things — and the second one is
   * what a traversal escapes through.
   */
  async function locate(label, rest) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(label ?? '')) return null

    const base = await fsp.realpath(join(hostsDir, label)).catch(() => null)
    if (!base || !base.startsWith(root)) return null

    const wanted = rest.length ? rest : ['index.html']
    const direct = await settle(base, wanted)
    if (direct) return direct

    // A path with no extension is a client route, not a missing file: an app
    // built around the History API asks for `/orders/7` and the server that
    // 404s it turns every refresh into a broken page. A request that names a
    // file — `app.js`, `logo.png` — is answered with the truth instead.
    if (!extname(wanted[wanted.length - 1])) return settle(base, ['index.html'])
    return null
  }

  /** Whether a label has an app published under it — a `hosts/` entry that resolves inside the root. */
  async function isApp(label) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(label ?? '')) return false
    const base = await fsp.realpath(join(hostsDir, label)).catch(() => null)
    return !!base && base.startsWith(root)
  }

  async function settle(base, segments) {
    const target = resolve(base, ...segments)
    if (target !== base && !target.startsWith(base + '/')) return null

    const stat = await fsp.stat(target).catch(() => null)
    if (stat?.isDirectory()) return settle(base, [...segments, 'index.html'])
    if (!stat?.isFile())     return null

    // The arithmetic above is over the path a caller NAMED; this is over the
    // file the kernel would open. A symlink sitting inside a release directory
    // passes the first check and reads whatever it points at — `/etc/passwd`
    // through a 200, on a port with no authentication in front of it. Publish
    // writes only regular files, so this is the case where something else put
    // it there, which is exactly when the check has to hold.
    const real = await fsp.realpath(target).catch(() => null)
    if (!real || (real !== base && !real.startsWith(base + '/'))) return null

    return { path: real, size: stat.size, base }
  }

  async function handle(req) {
    // Read-only, and said so: a prototype that accepts a POST because the
    // server never refused one is a shape somebody will build against.
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD' } })

    const url   = new URL(req.url)
    const tries = candidates(url, req.headers.get('host'))
    if (!tries)
      return new Response('malformed percent-encoding in the path\n', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    if (!tries.length)
      return NOT_FOUND('no app named here — reach one by hostname, or by /<slug>/ on this port')

    let file = null
    for (const t of tries) {
      if ((file = await locate(t.label, t.rest))) break
      // A port is an origin (`FJS-D345`, `FJS-D618`): a host that names an app
      // makes that app's origin, so a request that app cannot answer is a 404
      // rather than a second try at another app's files under its hostname.
      if (t.byHost && await isApp(t.label)) break
    }
    if (!file) return NOT_FOUND(`nothing published at ${url.pathname} for '${tries[0].label}'`)

    // The release's own digest, which is the directory holding the file. Two
    // publishes of the same bytes carry the same tag and a browser re-uses what
    // it has; one byte different and every URL is new, with no path to purge.
    const digest = basename(file.base)
    const etag   = `"${digest}:${file.path.slice(file.base.length)}"`
    if (req.headers.get('if-none-match') === etag)
      return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } })

    const headers = {
      etag,
      // Revalidate rather than expire. A prototype is republished while
      // somebody watches the tab, and a max-age here is a person being shown
      // the release before last with no way to tell.
      'cache-control':          'no-cache',
      'content-type':           contentTypeFor(file.path, { charset: true }),
      // The type is the one the extension declares and the bytes are a
      // stranger's, so a `.txt` full of markup must stay a `.txt`.
      'x-content-type-options': 'nosniff',
    }
    if (req.method === 'HEAD')
      return new Response(null, { status: 200, headers: { ...headers, 'content-length': String(file.size) } })

    try {
      return new Response(await fsp.readFile(file.path), { status: 200, headers })
    } catch (err) {
      log.error?.(`outpost: static read failed — ${err.message}`)
      return new Response('could not read that file\n', { status: 500 })
    }
  }

  return { handle, root }
}
