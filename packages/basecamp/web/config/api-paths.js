// web/config/api-paths.js
// The paths the API answers — DERIVED from `surface.snapshot.md`, not listed.
//
// Basecamp mounts services at /{service} with no prefix, so an API path and a
// UI path are the SAME URL: GET /projects is both the service and the page.
// Client-side navigation never notices — the router does not touch the network
// — but a hard load or a refresh of /projects/ has to be told apart from a
// service call, and the only thing that tells them apart is `Accept`.
//
// Two things need this list:
//
//   web/config/vite.config.js   the dev proxy
//   deploy/build.mjs            the Caddy config the container image is served
//                               behind, generated rather than hand-kept
//
// ─── why this is read rather than written ────────────────────────────────
//
// It was a hand-kept copy of the service registry and it went stale six times:
// `audit`, `channels`, `flags`, `api-keys`, `invitations`, and `connections`,
// which was still missing when this was rewritten. Three of those six were
// registered by a PLUGIN rather than by this app, which is the half no author
// can be expected to remember — `connections` belongs to junction's channels
// plugin, `account`/`sessions` to @frontierjs/auth, `conduit-targets` to
// conduit. Nothing here wrote them and they still answer on this origin.
//
// The failure is silent and asymmetric, which is why it kept happening: a
// SIGNED-IN browser makes every service call as a frame on `/ws`, proxied by
// one rule that can never go stale, so the HTTP path is exercised only where
// there is no socket. A missing path is invisible until something unauthenticated
// calls a service — `invitations.preview` was the first thing in the app that
// ever did, and it rendered `HTTP 404` on a screen a stranger opens.
//
// `junction surface` already reads every mounted path off the BUILT app, and
// `surface.snapshot.md` is already committed and already gated by CI's
// `snapshots` phase. So the list is parsed out of it: adding a service and
// regenerating the snapshot — which CI forces — updates the proxy, and there is
// nothing left to remember. The durable fix is still an apiPrefix, and this
// file retires itself into it (see PREFIX below) rather than standing in its way.
//
// What this canNOT see is the WebSocket: the channels plugin upgrades in the
// transport rather than mounting a route, so `/ws` appears in no router. It is
// one rule that has never changed, stated below.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'surface.snapshot.md')
const REGEN    = 'junction surface --app api/src/app.ts --services api/src/services'

function readSnapshot() {
  try {
    return readFileSync(SNAPSHOT, 'utf8')
  } catch {
    throw new Error(
      `[api-paths] ${SNAPSHOT} is not there, and the dev proxy and the deploy's ` +
      `reverse proxy are both derived from it. Regenerate it from the app root:\n` +
      `  ${REGEN}`
    )
  }
}

// Paths that are mounted and must NOT be proxied.
//
//   `/`   is `staticRoutes` serving the built SPA in production. Proxying it
//         would hand every shell request to the API.
//   `/*`  is the CORS preflight catch-all. As a proxy key it swallows the whole
//         origin; preflight is cross-origin only and neither reader is.
//
// A templated path (`/{service}`) is the CRUD handler and names every service at
// once — the service headings below already name them individually.
const isMountedButNotProxied = (path) => path === '/' || path.includes('*') || path.includes('{')

/**
 * The one segment a path is proxied by. `/auth/login` and `/auth/register` are
 * both `/auth`; the readers append their own `/*`.
 */
const rootSegment = (path) => '/' + path.split('/')[1]

function derive(md) {
  // `26 services · 27 routes · 9 plugins · prefix (none)`
  const prefix = md.match(/·\s*prefix\s+(\S+)/)?.[1]
  if (!prefix) throw new Error(
    `[api-paths] no summary line in surface.snapshot.md — junction's output shape ` +
    `changed and this parse is stale. Regenerate and reconcile:\n  ${REGEN}`
  )

  // The durable fix, if it ever lands: with a prefix every service is under one
  // path and there is no ambiguity left to resolve, so the answer is that path
  // and this parse stops mattering.
  if (prefix !== '(none)') return [prefix]

  // Every service, including the ones a plugin registered — a service heading
  // is `### \`name\` · model \`Model\``.
  const services = [...md.matchAll(/^### `([^`]+)`/gm)].map(m => '/' + m[1])

  // Every hand-registered or plugin-registered route — `| GET | \`/health\` | raw |`.
  const raw = [...md.matchAll(/^\| \S+ \| `([^`]+)` \| raw \|$/gm)]
    .map(m => m[1])
    .filter(p => !isMountedButNotProxied(p))
    .map(rootSegment)

  const paths = [...new Set([...services, ...raw])].sort()

  if (!paths.length) throw new Error(
    `[api-paths] surface.snapshot.md named no services and no routes. It is either ` +
    `empty or junction's output shape changed:\n  ${REGEN}`
  )
  return paths
}

export const API_PATHS = derive(readSnapshot())

/** The WebSocket. No HTML ambiguity to resolve — always proxied, never served. */
export const WS_PATH = '/ws'
