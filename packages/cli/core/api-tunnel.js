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

import { spawn } from 'child_process'
import { resolveSide } from './deploy-target.js'

export const TARGETS = { production: 'production', prod: 'production', stage: 'stage', staging: 'stage' }

const DEFAULT_PORT   = 3000
const DEFAULT_HEALTH = '/health'

/**
 * What `--api <value>` names: where ssh connects, which port on the box, and
 * the health path to ask through it.
 *
 * @param {string} value
 * @param {object|null} deployConf  the app's `deploy` block, or null
 * @returns {{ ok: true, host: string, port: number, health: string, target: string|null }
 *         | { ok: false, reason: string }}
 */
export function resolveApiTarget(value, deployConf) {
  const raw    = String(value ?? '').trim()
  const port   = Number(deployConf?.api?.port ?? DEFAULT_PORT)
  const health = deployConf?.api?.health ?? DEFAULT_HEALTH
  // A bare `--api` arrives as `true`, or its string from the flag parser.
  if (value === true || raw === 'true' || !raw) return { ok: false, reason: '--api needs a target: production, stage, or an ssh destination' }

  const target = TARGETS[raw.toLowerCase()]
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
 * The ssh arguments for the forward. `-n` because the forward reads nothing,
 * and a prompt (a passphrase, an unknown host key) still reaches the person on
 * /dev/tty. `ExitOnForwardFailure` turns a taken local port into an exit rather
 * than a connection with no forward.
 */
export function sshArgs({ host, port, localPort }) {
  return [
    '-N', '-n',
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
export async function openTunnel({ host, port, localPort, health, timeoutMs = 20000, spawnImpl = spawn, fetchImpl = fetch }) {
  const child = spawnImpl('ssh', sshArgs({ host, port, localPort }), { stdio: ['ignore', 'ignore', 'pipe'] })
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
