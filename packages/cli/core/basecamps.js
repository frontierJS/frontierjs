// ─── basecamps.js — the index of Basecamps this machine can reach ────────────
//
// `basecamps.json` beside the global env: an object keyed by the ssh Host name
// `basecamp:create` writes to `~/.ssh/config` (so no new noun), each entry
//   { url, host?, cloud?, boxId?, apiKey, scopedKey?, peerKeyId?, runs? }
// `url` is the API origin; `host` is optional because the reserved name `dev`
// is the local dev Basecamp and a CI machine has no ssh config. `scopedKey`
// is the narrow key `ws:deps --push` and `db` use beside the admin `apiKey`.
// `peerKeyId` is the id Basecamp's "Add a peer" form answers for Workbench's
// public key; Workbench's preview peer signs with it.
// `runs: true` marks the one Basecamp Charter runs go to; a run's App is named
// by its ingress name there, so the entry carries no zone (`FJS-D1899`).
//
// The file holds admin keys, so it is written 0600 and the directory is
// whatever `global-env.js` owns, never a second spelling of it.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { globalEnvPath } from './global-env.js'

export const DEV_BASECAMP = 'dev'

export const basecampsPath = (home) => join(dirname(globalEnvPath(home)), 'basecamps.json')

/** Every entry, `{}` when there is no file. A file that is not a JSON object throws naming the path. */
export function readBasecamps({ home } = {}) {
  const file = basecampsPath(home)
  if (!existsSync(file)) return {}
  let parsed
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must hold an object keyed by Basecamp name`)
  return parsed
}

// A partial write that left a world-readable file would leak admin keys, so the
// mode is set after the write too: `writeFileSync`'s `mode` only applies to a new file.
function save(all, home) {
  const file = basecampsPath(home)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

const clean = (entry) => Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== null && v !== ''))

/**
 * Set `name`'s entry, replacing any there. `runs: true` moves the designation
 * here from whichever entry held it, so there is never two. Answers the file.
 */
export function writeBasecamp(name, entry, { home } = {}) {
  if (!name || typeof name !== 'string') throw new Error('A Basecamp needs a name')
  if (!entry?.url) throw new Error(`Basecamp "${name}" needs a url, its API origin`)
  const all  = readBasecamps({ home })
  const next = clean({ ...entry, url: entry.url.replace(/\/+$/, '') })
  if (next.runs !== true) delete next.runs
  else for (const other of Object.values(all)) delete other.runs
  all[name] = next
  return save(all, home)
}

/** Drop `name`. Answers whether it was there. */
export function removeBasecamp(name, { home } = {}) {
  const all = readBasecamps({ home })
  if (!(name in all)) return false
  delete all[name]
  save(all, home)
  return true
}

const named = (all) => Object.keys(all).join(', ')

/**
 * The entry for `name` as `{ name, ...entry }`. With no name: the only entry,
 * or a refusal that lists the names when there are several, or when there are none.
 */
export function resolveBasecamp(name, { home } = {}) {
  const all = readBasecamps({ home })
  if (name) {
    if (!Object.hasOwn(all, name)) {
      throw new Error(`No Basecamp named "${name}"${Object.keys(all).length ? ` — known: ${named(all)}` : ''} (${basecampsPath(home)})`)
    }
    return { name, ...all[name] }
  }
  const names = Object.keys(all)
  if (names.length === 0) throw new Error(`No Basecamps are known (${basecampsPath(home)}) — fli basecamp:create adds one`)
  if (names.length > 1) throw new Error(`Which Basecamp? Pass --basecamp <name>: ${names.join(', ')}`)
  return { name: names[0], ...all[names[0]] }
}

/** The entry marked `runs: true`, or a throw saying none is, or that more than one is. */
export function designatedBasecamp({ home } = {}) {
  const all   = readBasecamps({ home })
  const found = Object.keys(all).filter(n => all[n].runs === true)
  if (found.length === 0) throw new Error(`No Basecamp is designated for runs${Object.keys(all).length ? ` — known: ${named(all)}` : ''}`)
  if (found.length > 1) throw new Error(`More than one Basecamp is designated for runs: ${found.join(', ')}`)
  return { name: found[0], ...all[found[0]] }
}

/**
 * `resolveBasecamp` for a reader that can do without: `{ entry }`, or `{ error }`
 * saying why there is none (unknown, ambiguous, empty), so it can carry on and
 * say so rather than refuse. `scoped` picks the narrow key when the entry holds
 * one, the admin key otherwise.
 */
export function lookupBasecamp(name, { home, scoped = false } = {}) {
  try {
    const entry = resolveBasecamp(name || undefined, { home })
    const key   = scoped ? entry.scopedKey ?? entry.apiKey : entry.apiKey
    if (!key) return { error: `Basecamp "${entry.name}" has no API key — fli basecamp:key --server ${entry.host ?? '<box>'} files one` }
    return { entry: { ...entry, key } }
  } catch (err) { return { error: err.message } }
}

/**
 * The entry a command talks to, or null after printing the refusal and setting
 * the exit code. An environment variable never stands in for the name, since a
 * stale one would send a key to the wrong Basecamp. Answers `{ name, url, key, ... }`.
 */
export function reachBasecamp(name, log, opts) {
  const got = lookupBasecamp(name, opts)
  if (got.entry) return got.entry
  log.error(got.error)
  process.exitCode = 1
  return null
}

/**
 * `lookupBasecamp` for a command holding an App id: with several entries and no
 * name, the one Basecamp that answers `/apps/<id>`, asked with each entry's own
 * key at its own url (`FJS-4065`). App ids are uuids, so two yeses are two
 * entries for one Basecamp, and which key to use is the operator's to say.
 * An entry that did not answer is named in the refusal, or a holder that is
 * down reads as no holder at all.
 */
export async function lookupBasecampFor(name, appId, { home, scoped = false, fetcher = fetch, timeout = 3000 } = {}) {
  const all = readBasecamps({ home })
  if (name || !appId || Object.keys(all).length < 2) return lookupBasecamp(name, { home, scoped })
  const keyed = Object.keys(all).filter(n => all[n].apiKey)
  const asked = await Promise.all(keyed.map(async n => ({ name: n, ...(await holdsApp(all[n], appId, { fetcher, timeout })) })))
  const yes   = asked.filter(a => a.holds).map(a => a.name)
  if (yes.length === 1) return lookupBasecamp(yes[0], { home, scoped })
  if (yes.length > 1) return { error: `App ${appId} is on ${yes.join(' and ')} — pass --basecamp <name>` }
  const down = asked.filter(a => a.why).map(a => `${a.name} (${a.why})`)
  return { error: `No Basecamp holds App ${appId} — asked ${keyed.join(', ') || 'none, no entry has an API key'}` +
    (down.length ? `; no answer from ${down.join(', ')}` : '') + '. Pass --basecamp <name>, or take BASECAMP_APP_ID out of .env and run fli basecamp:app' }
}

/** `reachBasecamp` over `lookupBasecampFor`. */
export async function reachBasecampFor(name, appId, log, opts) {
  const got = await lookupBasecampFor(name, appId, opts)
  if (got.entry) return got.entry
  log.error(got.error)
  process.exitCode = 1
  return null
}

// A 404 is the one answer that means *not here*; anything else is a Basecamp
// that did not say, which the refusal names.
async function holdsApp(entry, appId, { fetcher, timeout }) {
  try {
    const res = await fetcher(`${entry.url}/apps/${encodeURIComponent(appId)}`, {
      signal:  AbortSignal.timeout(timeout),
      headers: { accept: 'application/json', authorization: `Bearer ${entry.apiKey}` },
    })
    if (res.status === 404) return { holds: false }
    if (!res.headers.get('content-type')?.includes('json')) return { holds: false, why: 'not the API' }
    return res.ok ? { holds: true } : { holds: false, why: `HTTP ${res.status}` }
  } catch (err) {
    return { holds: false, why: err?.name === 'TimeoutError' ? `no answer in ${timeout / 1000} s` : 'unreachable' }
  }
}

/**
 * Whether the Basecamp at `entry.url` answers: one unsigned GET of its `/health`,
 * given up on after `timeout` ms. Answers `{ ok: true, ms }` or `{ ok: false, why }`.
 * A proxy that routes `/health` nowhere hands back the SPA's HTML with a 200, so
 * only JSON counts, or a dead API behind a live file server would read as up.
 */
export async function pingBasecamp(entry, { timeout = 3000, fetcher = fetch } = {}) {
  const began = Date.now()
  try {
    const res = await fetcher(`${entry.url}/health`, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } })
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
    if (!res.headers.get('content-type')?.includes('json')) return { ok: false, why: 'not the API' }
    return { ok: true, ms: Date.now() - began }
  } catch (err) {
    return { ok: false, why: err?.name === 'TimeoutError' ? `no answer in ${timeout / 1000} s` : 'unreachable' }
  }
}
