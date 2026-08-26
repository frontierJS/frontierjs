// site/src/api.js — where this site's islands find the shop.
//
// A storefront is its own ORIGIN. `web/` is served by Vite in dev and proxies
// `/api` to the API, so nothing the SPA does has ever crossed an origin; this
// surface deploys to a bucket and its islands call the API directly, which
// means a real preflight and a real `Access-Control-Allow-Origin` on every
// request they make. That is a property worth having under test rather than
// discovering the first time the site is served from a domain of its own.
//
// It is a build-time constant because a static page has no server to ask. Set
// `VITE_API_URL` for a deployment; the default is this app's own API port —
// dev / be / project 1 (see packages/cli/core/ports.js).
export const API_URL = import.meta.env?.VITE_API_URL ?? 'http://localhost:8110'

/**
 * What `createJunctionClient` needs, and it is TWO keys.
 *
 * `url` is the ORIGIN and defaults to `location.origin` — which for a
 * storefront is the bucket, not the shop, so leaving it out sends every call to
 * a host that has no API and answers 404. `apiPrefix` is the PATH the app
 * mounts its services under and must match the server's own.
 *
 * Getting this wrong fails as *the shop could not be reached*, which is also
 * what a genuinely unreachable shop looks like.
 */
export const clientOptions = { url: API_URL, apiPrefix: '/api' }
