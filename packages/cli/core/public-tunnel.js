/**
 * core/public-tunnel.js — a local port on a public HTTPS URL, through
 * cloudflared, in one of two shapes.
 *
 * A QUICK tunnel needs no account and gets a random `*.trycloudflare.com` name
 * each run. A NAMED tunnel serves a fixed `https://<label>.<domain>` on a zone
 * the person's `cf` login reaches: `prepareNamedTunnel` finds or makes the
 * tunnel `fli-<host>` and its proxied CNAME through `core/cloudflare.js`, and
 * `openNamedTunnel` runs cloudflared with the tunnel's token. `tunnelHost`
 * picks the shape, and a set domain or a given host never falls back to a
 * quick tunnel: a person who asked for `example.awe.dev` and is handed a
 * random name would share the wrong URL without knowing.
 *
 * Cloudflare's edge appends the visitor's address to `X-Forwarded-For` in both
 * shapes, so the API behind it is right under `FRONTIER_TRUST_PROXY=1` and
 * wrong without it: every visitor keys as 127.0.0.1 and one stranger's failed
 * logins lock out everyone (`FJS-1841`, `IDEAS/tunnel.md`). `fli dev --tunnel`
 * starts the two together for that reason.
 *
 * cloudflared prints a quick tunnel's URL on stderr before its connection
 * registers, and nothing machine-readable, so the URL is matched out of its
 * log; a named tunnel's URL is known, and `Registered tunnel connection` is
 * what says it is up. The named tunnel's token rides the env: argv shows in `ps`.
 */
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as realCloudflare from './cloudflare.js'

// A quick tunnel's name is hyphenated words; `api.trycloudflare.com` also
// appears in its log, in the error a failed request prints.
export const QUICK_URL = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/

const REGISTERED = /Registered tunnel connection/
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const WAIT_MS = 30_000

export function quickTunnelArgs(port) {
  return ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`]
}

export function namedTunnelArgs(port) {
  return ['tunnel', '--no-autoupdate', 'run', '--url', `http://localhost:${port}`]
}

export function hasCloudflared() {
  return !spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).error
}

// ─── Which tunnel ─────────────────────────────────────────────────────────

/** A package name as one DNS label: `@acme/My App` → `my-app`. */
export function tunnelLabel(packageName) {
  const label = String(packageName ?? '')
    .replace(/^@[^/]*\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!label) throw new Error(`package name '${packageName ?? ''}' makes no hostname label; pass --tunnel=<host>`)
  if (label.length > 63) throw new Error(`package name '${packageName}' is ${label.length} characters as a hostname label, over DNS's 63; pass --tunnel=<host>`)
  return label
}

function checkedHost(host, from) {
  if (!HOSTNAME.test(host)) throw new Error(`${from} '${host}' is not a hostname like app.example.com — no scheme, port or path`)
  return host
}

/**
 * What a run shares through. `flag` is the raw `--tunnel` / `--host` value: a
 * hostname, `true` or `'true'` for a bare `--tunnel`, empty for off. Null is
 * off; `{ mode: 'named', host }` or `{ mode: 'quick' }` otherwise. Only a bare
 * flag with no domain set is quick — an explicit host or a domain that cannot
 * make a host throws rather than fall back.
 */
export function tunnelHost({ flag, domain, packageName }) {
  if (flag === undefined || flag === null || flag === false || flag === '' || flag === 'false') return null
  if (flag !== true && flag !== 'true') return { mode: 'named', host: checkedHost(String(flag).trim().toLowerCase(), '--tunnel') }
  const base = String(domain ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '')
  if (!base) return { mode: 'quick' }
  return { mode: 'named', host: checkedHost(`${tunnelLabel(packageName)}.${base}`, 'FLI_TUNNEL_DOMAIN') }
}

/** The tunnel's name in Cloudflare: one per hostname. */
export const tunnelName = (host) => `fli-${host.replaceAll('.', '-')}`

// ─── Named: make it, then run it ──────────────────────────────────────────

/**
 * Finds or makes the tunnel and the DNS record for `host`, writing only what
 * is missing. A record already on the name that is not this tunnel's CNAME
 * stops the run: it is somebody's site, and fli never replaces one.
 * @returns {Promise<{ host: string, url: string, token: string, tunnelId: string, created: { tunnel: boolean, record: boolean } }>}
 */
export async function prepareNamedTunnel(host, { cloudflare = realCloudflare } = {}) {
  try {
    const profile = cloudflare.profileFor()
    const zone = await cloudflare.findZone(profile, host)
    if (!zone) throw new Error(`no Cloudflare zone the cf login reaches owns ${host}`)
    const accountId = zone.account?.id
    if (!accountId) throw new Error(`zone ${zone.name} names no account`)

    const name = tunnelName(host)
    // The name is checked before anything is written: a refusal after the
    // create would leave an orphan tunnel on the account.
    let tunnel = (await cloudflare.tunnels(profile, accountId)).find(t => t.name === name)
    const held = (await cloudflare.records(profile, zone.id)).filter(r => String(r.name).toLowerCase() === host)
    const ours = r => tunnel && r.type === 'CNAME' && r.content === `${tunnel.id}.cfargotunnel.com`
    const foreign = held.find(r => !ours(r))
    if (foreign) throw new Error(`${foreign.type} ${foreign.name} → ${foreign.content} already holds that name, and fli will not replace it`)

    const madeTunnel = !tunnel
    if (!tunnel) tunnel = await cloudflare.createTunnel(profile, accountId, name, randomBytes(32).toString('base64'))
    const token = (madeTunnel && tunnel.token) || await cloudflare.tunnelToken(profile, accountId, tunnel.id)
    if (typeof token !== 'string' || !token) throw new Error(`cf gave no run token for tunnel ${name}`)

    const target = `${tunnel.id}.cfargotunnel.com`
    if (!held.length) {
      await cloudflare.createRecord(profile, zone.id, { type: 'CNAME', name: host, content: target, proxied: true, comment: 'fli tunnel' })
    }
    return { host, url: `https://${host}`, token, tunnelId: tunnel.id, created: { tunnel: madeTunnel, record: !held.length } }
  } catch (err) {
    throw new Error(`named tunnel for ${host}: ${err.message}`, { cause: err })
  }
}

/**
 * Runs the prepared tunnel and resolves once cloudflared registers a connection.
 * @param {number} port
 * @param {{ host: string, url: string, token: string }} prepared
 * @param {{ spawn?: Function, waitMs?: number }} [opts]
 * @returns {Promise<{ url: string, host: string, child: import('node:child_process').ChildProcess, log: string[] }>}
 */
export function openNamedTunnel(port, prepared, { spawn = nodeSpawn, waitMs = WAIT_MS } = {}) {
  const child = spawn('cloudflared', namedTunnelArgs(port), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TUNNEL_TOKEN: prepared.token },
  })
  return whenUp(child, {
    found: text => REGISTERED.test(text) && { url: prepared.url, host: prepared.host },
    exitedBefore: 'registering a connection',
    noneIn: 'registered no connection',
    waitMs,
  })
}

// ─── Quick ────────────────────────────────────────────────────────────────

/**
 * Starts the tunnel and resolves once cloudflared names its URL.
 * @param {number} port
 * @param {{ spawn?: Function, waitMs?: number }} [opts]
 * @returns {Promise<{ url: string, host: string, child: import('node:child_process').ChildProcess, log: string[] }>}
 */
export function openQuickTunnel(port, { spawn = nodeSpawn, waitMs = WAIT_MS } = {}) {
  // Its own process group would survive the terminal's Ctrl-C; this one does not.
  const child = spawn('cloudflared', quickTunnelArgs(port), { stdio: ['ignore', 'pipe', 'pipe'] })
  return whenUp(child, {
    found: text => {
      const url = text.match(QUICK_URL)?.[0]
      return url && { url, host: new URL(url).host }
    },
    exitedBefore: 'naming a URL',
    noneIn: 'named no URL',
    waitMs,
  })
}

// ─── Shared ───────────────────────────────────────────────────────────────

// Resolves with `found(text)`'s answer plus the child and its log, or rejects
// with cloudflared's own last error when it exits or says nothing in `waitMs`.
function whenUp(child, { found, exitedBefore, noneIn, waitMs }) {
  const log = []
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value) } }
    const read = chunk => {
      const text = String(chunk)
      for (const line of text.split('\n')) if (line.trim()) log.push(line)
      const up = found(text)
      if (up) settle(resolve, { ...up, child, log })
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('error', err => settle(reject, err))
    child.on('close', code => settle(reject, new Error(`cloudflared exited (${code}) before ${exitedBefore}${lastError(log)}`)))
    const timer = setTimeout(() => {
      child.kill()
      settle(reject, new Error(`cloudflared ${noneIn} in ${waitMs / 1000}s${lastError(log)}`))
    }, waitMs)
  })
}

// cloudflared logs every line at a level; the last ERR is what the person needs.
function lastError(log) {
  const err = [...log].reverse().find(l => /\bERR\b/.test(l))
  return err ? ` — ${err.replace(/^\S+\s+ERR\s+/, '')}` : ''
}
