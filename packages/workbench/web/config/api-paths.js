// web/config/api-paths.js
// The paths the API answers -- DERIVED from `app.snapshot.md`, not listed.
//
// Workbench mounts services at /{service} with no prefix, so an API path and a
// UI path are the SAME URL: GET /workbench is both the service and the page.
// Client-side navigation never notices, but a hard load or a refresh of
// /workbench/ has to be told apart from a service call, and only `Accept` does
// it (vite.config.js).
//
// A hand-kept copy of the service registry went stale six times in Basecamp, so
// the list is parsed out of the committed snapshot: adding a service and
// regenerating it (`junction app --app api/src/app.ts`) updates the proxy.
//
// What this canNOT see is the WebSocket: the channels plugin upgrades in the
// transport rather than mounting a route, so `/ws` is stated below.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.snapshot.md')
const REGEN    = 'junction app --app api/src/app.ts'

function readSnapshot() {
  try {
    return readFileSync(SNAPSHOT, 'utf8')
  } catch {
    throw new Error(
      `[api-paths] ${SNAPSHOT} is not there, and the dev proxy is derived from it. ` +
      `Regenerate it from the app root:\n  ${REGEN}`
    )
  }
}

// Mounted but NOT proxied: `/` is static serving, `/*` the CORS preflight
// catch-all (it would swallow the whole origin as a proxy key), and a path
// STARTING templated (`/{service}`) names every service at once.
const isMountedButNotProxied = (path) => path === '/' || path.includes('*') || path.startsWith('/{')

/** The one segment a path is proxied by; the readers append their own `/*`. */
const rootSegment = (path) => '/' + path.split('/')[1]

function derive(md) {
  // `0 services · 16 routes · 3 plugins · prefix (none)`
  const prefix = md.match(/·\s*prefix\s+(\S+)/)?.[1]
  if (!prefix) throw new Error(
    `[api-paths] no summary line in app.snapshot.md -- junction's output shape ` +
    `changed and this parse is stale. Regenerate and reconcile:\n  ${REGEN}`
  )
  if (prefix !== '(none)') return [prefix]

  // A service heading is `### \`name\` · model \`Model\``; a kebab spelling is
  // an alias under it.
  const services = [
    ...[...md.matchAll(/^### `([^`]+)`/gm)].map(m => '/' + m[1]),
    ...[...md.matchAll(/^- \*\*also answers to\*\* — (.+)$/gm)]
      .flatMap(m => [...m[1].matchAll(/`([^`]+)`/g)].map(a => '/' + a[1])),
  ]

  // Every hand-registered or plugin-registered route -- `| GET | \`/health\` | raw |`.
  const raw = [...md.matchAll(/^\| \S+ \| `([^`]+)` \| raw \|$/gm)]
    .map(m => m[1])
    .filter(p => !isMountedButNotProxied(p))
    .map(rootSegment)

  const paths = [...new Set([...services, ...raw])].sort()
  if (!paths.length) throw new Error(
    `[api-paths] app.snapshot.md named no services and no routes. It is either ` +
    `empty or junction's output shape changed:\n  ${REGEN}`
  )
  return paths
}

export const API_PATHS = derive(readSnapshot())

/** The socket: one rule that never changes. */
export const WS_PATH = '/ws'
