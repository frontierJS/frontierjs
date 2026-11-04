// ─── api-tunnel.js — `fli dev --api`, the local surfaces against a remote API ─
// A deployed API listens on the box's loopback only (`deploy` publishes
// `127.0.0.1:<api.port>:3000`), so the one way in from a laptop that opens no
// port is an ssh forward. The forward binds THIS app's own API port, where the
// API surface would have listened: every surface's proxy already points there
// (`FRONTIER_PORT_BE`), so nothing else is told about it.
//
// The target is a deploy target — `production` or `stage`, resolved off the
// deploy block exactly as `fli deploy` resolves it — or an ssh destination
// (an alias or `user@host`), with an optional `:port`. A named target wins over
// an alias spelled the same.
//
// An App Basecamp placed (`BASECAMP_APP_ID`) publishes the host port Basecamp
// allocated it, from 10000 up, and nothing on the box reads `deploy.api.port`:
// forwarding to that one reached an empty port (`FJS-3938`). A named target on
// such an App takes its port and health path off the App.

import { spawn } from 'child_process'
import { resolveSide, sshHost } from './deploy-target.js'

export const TARGETS = { production: 'production', prod: 'production', stage: 'stage', staging: 'stage' }

// A named target as Basecamp's `EnvironmentTier` spells it.
const TIERS = { production: 'production', stage: 'staging' }

const DEFAULT_PORT   = 3000
const DEFAULT_HEALTH = '/health'

/**
 * What `--api <value>` names: where ssh connects, which port on the box, and
 * the health path to ask through it.
 *
 * @param {string} value
 * @param {object|null} deployConf  the app's `deploy` block, or null
 * @param {object|null} [app]       the Basecamp App `BASECAMP_APP_ID` names, or null
 * @returns {{ ok: true, host: string, port: number, health: string, target: string|null, sshPort?: number }
 *         | { ok: false, reason: string }}
 */
export function resolveApiTarget(value, deployConf, app = null) {
  const raw    = String(value ?? '').trim()
  const port   = Number(deployConf?.api?.port ?? DEFAULT_PORT)
  const health = deployConf?.api?.health ?? DEFAULT_HEALTH
  // A bare `--api` arrives as `true`, or its string from the flag parser.
  if (value === true || raw === 'true' || !raw) return { ok: false, reason: '--api needs a target: production, stage, or an ssh destination' }

  const target = TARGETS[raw.toLowerCase()]
  if (target && app) return appTarget(raw, target, app, deployConf)
  if (target) {
    if (!deployConf) return { ok: false, reason: `--api ${raw} reads the deploy block, and frontier.config.js has none — pass an ssh destination instead` }
    const side = resolveSide(deployConf, target, 'api')
    if (!side) return { ok: false, reason: `the deploy block names no server for ${target}` }
    return { ok: true, host: side.host, port, health, target }
  }

  // `host:port` — the last colon, so `user@host:3001` splits on the port.
  const m = raw.match(/^(.+?)(?::(\d+))?$/)
  const host = m[1]
  if (!/^[\w.@-]+$/.test(host)) return { ok: false, reason: `'${raw}' is not an ssh destination` }
  return { ok: true, host, port: m[2] ? Number(m[2]) : port, health, target: null }
}

/**
 * A named target on an App Basecamp placed. The machine is the deploy block's
 * ssh destination where it names one, since that is the alias this laptop holds
 * a key for; otherwise the machine Basecamp placed the App on. One App is one
 * environment, so a target in another is refused, as `fli deploy` refuses it.
 */
function appTarget(raw, target, app, deployConf) {
  const tier = app.environment?.tier
  if (tier && tier !== TIERS[target])
    return { ok: false, reason: `BASECAMP_APP_ID names App '${app.name}' in ${tier}, and --api ${raw} is ${TIERS[target]} — another environment is another App: run BASECAMP_APP_ID=<id> fli dev --api ${raw}` }
  if (app.port == null)
    return { ok: false, reason: `App '${app.name}' publishes no port on its machine, so there is nothing to forward to` }

  const health = app.healthCheck ?? deployConf?.api?.health ?? DEFAULT_HEALTH
  const side   = deployConf ? resolveSide(deployConf, target, 'api') : null
  if (side) return { ok: true, host: side.host, port: app.port, health, target }

  const placed = (app.placement ?? []).find(p => p.status === 'running') ?? app.placement?.[0]
  const server = placed?.server
  if (!server) return { ok: false, reason: `App '${app.name}' is placed on no machine — pass an ssh destination instead` }
  const host = sshHost(server.sshUser, server.ipAddress ?? server.name)
  return { ok: true, host, port: app.port, health, target, ...(server.sshPort && server.sshPort !== 22 ? { sshPort: server.sshPort } : {}) }
}

/**
 * The ssh arguments for the forward. `-n` because the forward reads nothing,
 * and a prompt (a passphrase, an unknown host key) still reaches the person on
 * /dev/tty. `ExitOnForwardFailure` turns a taken local port into an exit rather
 * than a connection with no forward.
 */
export function sshArgs({ host, port, localPort, sshPort }) {
  return [
    '-N', '-n',
    ...(sshPort ? ['-p', String(sshPort)] : []),
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${port}`,
    host,
  ]
}

/**
 * Open the forward and wait for the API to answer through it.
 *
 * Resolves `{ child, status }` once a request to the health path is answered
 * with any status — a 404 still proves the forward reaches a server — or
 * rejects with what ssh said when it exits first, or on the timeout.
 */
export async function openTunnel({ host, port, localPort, sshPort, health, timeoutMs = 20000, spawnImpl = spawn, fetchImpl = fetch }) {
  const child = spawnImpl('ssh', sshArgs({ host, port, localPort, sshPort }), { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', d => { stderr += d })
  let exited = null
  child.on('error', err => { exited = err.message })
  child.on('close', code => { exited ??= stderr.trim() || `ssh exited with code ${code}` })

  const url = `http://127.0.0.1:${localPort}${health}`
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (exited) throw new Error(exited)
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) })
      return { child, status: res.status }
    } catch { /* not forwarding yet, or nothing listening on the box */ }
    await new Promise(r => setTimeout(r, 300))
  }
  child.kill()
  throw new Error(exited ?? `no answer from ${host}:${port} through the tunnel in ${timeoutMs / 1000}s — is the API running there?`)
}
