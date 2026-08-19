// web/config/api-paths.js
// The paths the API answers, as ONE list with two readers.
//
// Basecamp mounts services at /{service} with no prefix, so an API path and a
// UI path are the SAME URL: GET /projects is both the service and the page.
// Client-side navigation never notices — the router does not touch the network
// — but a hard load or a refresh of /projects/ has to be told apart from a
// service call, and the only thing that tells them apart is `Accept`.
//
// Two things need this list, and until 2026-08-14 only one of them had it:
//
//   web/config/vite.config.js   the dev proxy
//   deploy/build.mjs            the Caddy config the container image is served
//                               behind, generated rather than hand-kept
//
// It is a hand-kept copy of the service registry and it HAS gone stale —
// `audit`, `channels`, `flags` and `api-keys` were each missing for a phase or
// more, and `invitations` after them. Nothing fails loudly, and the reason this
// comment used to give was wrong: the Junction client is configured with
// `location.origin` (web/config/sierra.config.js), so it goes through this
// proxy like everything else. What actually hides a missing path is the
// WEBSOCKET — a signed-in browser makes every service call as a frame on `/ws`,
// which is proxied by one rule that can never go stale, so the HTTP path is
// exercised only where there is no socket. Signing in is what opens it, so the
// gap is invisible until a SIGNED-OUT page calls a service, which is exactly
// what accepting an invitation is. It surfaces as a 404 from the proxy rather
// than as a refusal from the API. A SECOND copy in the deploy would have been
// the same bug one layer down, which is why this file exists rather than a
// second array.
//
// The durable fix is still to give the API an apiPrefix ('/api') and match it
// in sierra.config.js — one rule, no ambiguity, no list. The prefix was removed
// deliberately; this is the cost of that, written down and now owned once.
//
// ADD THE PATH WHEN YOU ADD THE SERVICE.

export const API_PATHS = [
  // `/account` and `/sessions` are @frontierjs/auth's, registered by its plugin
  // rather than by this app — a service this app never wrote still answers on
  // this origin, so it still needs a line here.
  '/auth', '/account', '/sessions',
  '/setup', '/health', '/metrics', '/conduit-targets',
  '/workspaces', '/projects', '/environments', '/apps',
  '/servers', '/deployments', '/jobs', '/portal',
  '/alerts', '/networks', '/secrets', '/domains',
  '/audit', '/channels', '/flags', '/api-keys',
  '/volumes', '/dashboards', '/recipes', '/cleanup',
  // The one service a SIGNED-OUT page calls, which is why its absence was
  // visible at all: with a session the browser client is on the WebSocket and
  // never touches this list, so a missing path is silent until something asks
  // over HTTP. Accepting an invitation is exactly that — no session, no socket.
  '/invitations',
  '/hub',
]

/** The WebSocket. No HTML ambiguity to resolve — always proxied, never served. */
export const WS_PATH = '/ws'
