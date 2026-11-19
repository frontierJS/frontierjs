/**
 * plausible-proxy.js — the same-origin Plausible proxy, as host functions
 *
 * `analytics.proxy: true` points the tag at the site's own origin, where an ad
 * blocker that drops `plausible.io` lets the script and its events through
 * (`FJS-D1037`). The build writes these routes into the functions entry from
 * `proxiedPaths`, which owns the paths and their upstreams.
 *
 * Imports nothing: the Cloudflare Worker bundles it beside
 * `function-handler.js`, under the same rule.
 */

// The visitor's request headers the vendor reads. A cookie is never one of
// them: it is the site's session, and forwarding the request whole hands it
// to a third party. X-Forwarded-For and CF-Connecting-IP carry the visitor's
// address, which Plausible counts unique visitors by.
const FORWARD = ['content-type', 'user-agent', 'x-forwarded-for', 'cf-connecting-ip']

// The upstream's response headers a visitor gets back; a Set-Cookie from the
// vendor would land on the site's own origin.
const RETURN = ['content-type', 'cache-control', 'etag', 'last-modified']

const pick = (headers, names) => {
  const out = new Headers()
  for (const name of names) {
    const value = headers.get(name)
    if (value !== null) out.set(name, value)
  }
  return out
}

/**
 * @param {Record<string, string>} upstreams  same-origin path → the URL it forwards to
 * @returns {Record<string, (request: Request) => Promise<Response>>}
 */
export function plausibleProxy(upstreams) {
  return Object.fromEntries(Object.entries(upstreams).map(([path, url]) => [path, async (request) => {
    const bodiless = request.method === 'GET' || request.method === 'HEAD'
    const answer = await fetch(url, {
      method:  request.method,
      headers: pick(request.headers, FORWARD),
      body:    bodiless ? undefined : await request.arrayBuffer(),
    })
    return new Response(answer.body, { status: answer.status, headers: pick(answer.headers, RETURN) })
  }]))
}
