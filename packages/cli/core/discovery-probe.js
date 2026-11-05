// ─── discovery-probe.js — is the OAuth discovery document reachable? ──────────
//
// RFC 8414 puts the authorization-server document at the ROOT of the issuer's
// origin, outside `apiPrefix`. `fli deploy`'s own Caddy routes proxy
// `/.well-known/oauth-*` to the API (`OAUTH_WELL_KNOWN`); a hand-written
// Caddyfile or another front door does not, and answers the path with the SPA
// shell. The App boots fine and a connector fails at its first request, so the
// deploy asks the public origin once, after the edge is written (`FJS-D1946`).

/** The path auth's OAuth server mounts at the root, and the one probed. */
export const DISCOVERY_PATH = '/.well-known/oauth-authorization-server'

/** One timeout for the whole probe: a deploy that is already serving never waits longer. */
export const PROBE_TIMEOUT_MS = 10_000

/**
 * Whether the App mounts the document. The route itself is the signal, not
 * `/auth/`: an App with `auth()` and no OAuth server lists no such path, and a
 * probe there would warn about a document nothing serves.
 */
export function mountsDiscovery(snapshot) {
  return Boolean(snapshot?.routes?.some(r => r.path === DISCOVERY_PATH))
}

/** The origin a connector reaches the API at: the API domain under two origins, the web domain under one. */
export function publicOrigin(names) {
  const domain = names?.api?.domain || names?.web?.domain
  return domain ? `https://${domain}` : null
}

const SAYS = 'the root /.well-known path must reach the API, so a hand-written Caddyfile or other front door needs ' +
  'the /.well-known/oauth-* proxy that `fli deploy`\'s edge writes'

/**
 * Probe the public origin. Answers `{ probed: false }` when there is nothing to
 * ask, else `{ probed: true, url, warning }` with `warning` null when the
 * document came back as JSON naming this origin as its issuer. Never throws:
 * a refused connection is a warning like any other answer.
 */
export async function checkDiscovery({ snapshot, names, fetch: doFetch = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  const origin = publicOrigin(names)
  if (!origin || !mountsDiscovery(snapshot)) return { probed: false }

  const url  = origin + DISCOVERY_PATH
  const warn = (seen) => ({ probed: true, url, warning: `${url} ${seen} — ${SAYS}` })

  let res
  try { res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } }) }
  catch (e) { return warn(`did not answer (${e?.name === 'TimeoutError' ? `no reply in ${timeoutMs / 1000}s` : e?.message ?? e})`) }

  if (res.status !== 200) return warn(`answered ${res.status}`)

  let doc
  try { doc = await res.json() }
  catch { return warn('answered 200 but not JSON (the SPA shell, most likely)') }

  const issuer = typeof doc?.issuer === 'string' ? doc.issuer.replace(/\/$/, '') : null
  if (issuer !== origin) return warn(`answered 200 with issuer ${JSON.stringify(doc?.issuer ?? null)}, not ${origin}`)
  return { probed: true, url, warning: null }
}
