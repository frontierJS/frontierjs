// doors.js — which deploy door installed what Caddy routes on a box.
//
// An app reaches a box through one of two doors: Basecamp, whose Outpost
// writes `fjs-<app id>` routes (`ingress.js`), or `fli deploy` over SSH, which
// writes `fli-<appId>` ones (the cli's `core/edge.js`). Both write the one
// `ingress` server, and nothing else they keep is shared: each holds its own
// database and its own `ENCRYPTION_KEY`. An app installed through both serves
// whichever door wrote last, so a box holds one door's install per app
// (`FJS-D1967`). The hostname is the only name the two installs share, so it
// is what both doors' preflights ask here.

const SERVER = 'ingress'

const PREFIX = { basecamp: 'fjs-', ssh: 'fli-' }

/** The door that wrote a route, read off its `@id`; null for a hand edit. */
export function doorOf(id) {
  for (const [door, prefix] of Object.entries(PREFIX))
    if (typeof id === 'string' && id.startsWith(prefix)) return door
  return null
}

/** The command that moves an app's install to `door`, keeping its rows and key (`FJS-D1970`). */
export const moveTo = (door) => `fli deploy:move --to=${door}`

/**
 * The routes `door` wrote in `config`'s ingress server that name any of
 * `hosts`, as `[{ id, hosts }]`. A path route counts: under it the other door
 * still answers part of the hostname.
 */
export function heldBy(config, door, hosts) {
  const wanted = new Set((hosts ?? []).filter(Boolean).map(h => String(h).toLowerCase()))
  if (!wanted.size) return []
  const out = []
  for (const r of config?.apps?.http?.servers?.[SERVER]?.routes ?? []) {
    if (doorOf(r['@id']) !== door) continue
    const taken = [...new Set((r.match ?? []).flatMap(m => m.host ?? []).map(h => String(h).toLowerCase()))]
      .filter(h => wanted.has(h))
    if (taken.length) out.push({ id: r['@id'], hosts: taken })
  }
  return out
}

const NAMED = { basecamp: 'a Basecamp App', ssh: '`fli deploy` over SSH' }

/**
 * Why `door` refuses a release whose hostnames `held` (from `heldBy` over the
 * other door) already serve, and the command that moves the install across.
 */
export function doorRefusal(door, held) {
  const other = door === 'ssh' ? 'basecamp' : 'ssh'
  const hosts = [...new Set(held.flatMap(h => h.hosts))].join(', ')
  return `${hosts} is served on this box by ${NAMED[other]} (${held.map(h => h.id).join(', ')}). ` +
    `A box holds one door's install of an app, since each door keeps its own database and ENCRYPTION_KEY. ` +
    `To release it through ${door === 'ssh' ? '`fli deploy` over SSH' : 'Basecamp'}, move the install first: ${moveTo(door)}`
}
