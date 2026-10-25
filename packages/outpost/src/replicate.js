/*
 * replicate.js — the machine's Litestream config, a projection of Basecamp's
 * list (`IDEAS/backups.md` 2.2, `FJS-D1486`).
 *
 * One `basecamp-litestream.service` per machine replicates every app on it,
 * each with its own key (`FJS-D1505`), so revoking or moving one app leaves the
 * rest. The whole file is rewritten from the list on every call and never
 * patched: an entry Basecamp no longer sends is a key that must stop working
 * here, and a merge would keep it.
 *
 * Basecamp's own box also replicates Basecamp's database, sent as `host`
 * beside the list (2.4, `FJS-D1486`): the same unit and file, pointed at
 * `OUTPOST_HOST_DB_PATH`, which only `fli deploy` writes. Any other machine
 * answers it skipped, so a host entry sent to the wrong row replicates nothing.
 *
 * The YAML is litestone's (`buildYaml`), the one spelling of what Litestream
 * v0.5 reads — a key on the wrong level is dropped in silence (`FJS-1396`).
 */

import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildYaml } from '@frontierjs/litestone/replicate'
import { spawnRun } from './docker.js'

const APP_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
// A database's path names its app: `apply` points every entry at the
// `fjs-<app>-data` volume's mountpoint.
const VOLUME_DB = /\/fjs-([a-zA-Z0-9][a-zA-Z0-9._-]*)-data\/_data\//
const FIELDS = ['bucket', 'path', 'endpoint', 'region', 'access_key_id', 'secret_access_key']

const toReplica = (r) => ({
  bucket: r.bucket, path: r.path, endpoint: r.endpoint, region: r.region,
  accessKeyId: r.access_key_id, secretAccessKey: r.secret_access_key,
})

export function createReplicator({
  run        = spawnRun,
  configPath = '/etc/basecamp/litestream.yml',
  // Outside every volume, so a `/backup` tar does not carry `.<db>-litestream`
  // and a restore does not hand Litestream a stale position. The unit's
  // StateDirectory, so it exists and is writable under its sandbox.
  metaDir    = '/var/lib/litestream',
  unit       = 'basecamp-litestream.service',
  socketPath = '/run/litestream/litestream.sock',
  // `config.hostFiles.db`: Basecamp's database directory, on its own box only.
  hostDb     = null,
  fetch: doFetch = fetch,
  statusTimeoutMs = 3_000,
} = {}) {

  function checkFields(r, name) {
    for (const f of FIELDS)
      if (typeof r[f] !== 'string' || !r[f]) throw new Error(`${name}: ${f} is required`)
    let endpoint
    try { endpoint = new URL(r.endpoint) } catch { throw new Error(`${name}: endpoint is not a URL`) }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:')
      throw new Error(`${name}: endpoint is ${endpoint.protocol}, not http(s)`)
  }

  function check(replicas, host) {
    if (!Array.isArray(replicas)) throw new Error('replicas must be a list — an empty one stops every replica here')
    const seen = new Set()
    for (const r of replicas) {
      if (typeof r?.app_id !== 'string' || !APP_ID.test(r.app_id))
        throw new Error(`app_id '${r?.app_id}' is not a plain name`)
      if (seen.has(r.app_id)) throw new Error(`app_id '${r.app_id}' is listed twice`)
      seen.add(r.app_id)
      checkFields(r, r.app_id)
    }
    if (host != null) {
      if (typeof host !== 'object' || Array.isArray(host)) throw new Error('host must be one entry')
      checkFields(host, 'host')
    }
  }

  // Litestream will not watch a directory that is not there, and under the
  // unit's ProtectHome a directory in /home is not there for it either.
  async function hostTarget(host) {
    if (!hostDb) return { reason: 'this machine is not a Basecamp host (no OUTPOST_HOST_DB_PATH)' }
    const dir = await stat(hostDb).then(s => s.isDirectory(), () => false)
    if (!dir) return { reason: `${hostDb} is not a directory this process can see` }
    return { target: { dir: hostDb, pattern: '*.db', metaDir: `${metaDir}/_host`, replica: toReplica(host) } }
  }

  return {
    /** Replace this machine's replica list with `replicas` and restart the
     *  unit. An app with no volume here yet is answered in `skipped`, not
     *  refused: Litestream will not watch a directory that is not there, and
     *  the other apps' entries are still owed. */
    async apply({ replicas, host = null }) {
      check(replicas, host)

      const targets = []
      const skipped = []
      for (const r of replicas) {
        const volume = `fjs-${r.app_id}-data`
        const found  = await run(['docker', 'volume', 'inspect', '--format', '{{.Mountpoint}}', volume])
        const dir    = found.exitCode === 0 ? found.stdout.trim() : ''
        if (!dir) { skipped.push({ app_id: r.app_id, reason: `${volume} does not exist on this machine` }); continue }
        targets.push({ dir, pattern: '*.db', metaDir: `${metaDir}/${r.app_id}`, replica: toReplica(r) })
      }
      // `_host` cannot be an app's: APP_ID starts alphanumeric.
      let hostSaid
      if (host) {
        const { target, reason } = await hostTarget(host)
        if (target) { targets.push(target); hostSaid = 'replicating' }
        else        { skipped.push({ host: true, reason }); hostSaid = 'skipped' }
      }

      const replicating = replicas.map(r => r.app_id).filter(id => !skipped.some(s => s.app_id === id))
      const said = hostSaid ? { replicating, skipped, host: hostSaid } : { replicating, skipped }
      const yaml = buildYaml(targets, { socket: socketPath })

      // Every release resends the list. A restart is a gap in every app's
      // replication, so a list already in force is left running; a unit that
      // is not active is restarted anyway, or a restart that failed once
      // would never be retried.
      const held = await readFile(configPath, 'utf8').catch(() => null)
      if (held === yaml && (await run(['systemctl', 'is-active', '--quiet', unit])).exitCode === 0)
        return { ...said, unchanged: true }

      // Every app's key is in this file.
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
      await writeFile(`${configPath}.partial`, yaml, { mode: 0o600 })
      await rename(`${configPath}.partial`, configPath)

      // Litestream 0.5 reads its config at start and at no other time.
      const restarted = await run(['systemctl', 'restart', unit], { timeoutMs: 60_000 })
      if (restarted.exitCode !== 0) {
        const said = (restarted.stderr || restarted.stdout || '').trim().split('\n').slice(-3).join(' ')
        throw new Error(`${configPath} is written but ${unit} did not restart (exit ${restarted.exitCode}): ${said}`)
      }
      return said
    },

    /** How far each app's bucket is, as Litestream itself reports it:
     *  `last_sync_at` per app, the oldest of its databases, and `host` the
     *  same for Basecamp's own when this box replicates it. Never throws — a
     *  heartbeat carries `error` instead, and Basecamp's reading of every app
     *  here then stops moving, which is the lag growing.
     *
     *  The socket answers nothing at all while any one database's bucket was
     *  unreachable when the unit started, so one app's outage blinds the
     *  machine's reading; it errs toward lag, never toward a clean answer. */
    async status() {
      let body
      try {
        const res = await doFetch('http://litestream/list', { unix: socketPath, signal: AbortSignal.timeout(statusTimeoutMs) })
        if (!res.ok) return { error: `${unit}'s control socket answered ${res.status}` }
        body = await res.json()
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED' || err?.code === 'FailedToOpenSocket')
          return { error: `${unit} is not running (no control socket at ${socketPath})` }
        if (err?.name === 'TimeoutError') return { error: `${unit}'s control socket did not answer in ${statusTimeoutMs / 1000}s` }
        return { error: `${unit}'s control socket: ${err?.message ?? err}` }
      }

      const apps = new Map()
      const hostDir = hostDb ? `${hostDb.replace(/\/+$/, '')}/` : null
      for (const d of Array.isArray(body?.databases) ? body.databases : []) {
        const path = String(d?.path ?? '')
        const key  = hostDir && path.startsWith(hostDir) ? '' : VOLUME_DB.exec(path)?.[1]
        if (key === undefined) continue
        const at   = typeof d.last_sync_at === 'string' && Number.isFinite(Date.parse(d.last_sync_at)) ? d.last_sync_at : null
        const prev = apps.get(key)
        if (!prev) { apps.set(key, { app_id: key, status: d.status ?? null, last_sync_at: at, databases: 1 }); continue }
        prev.databases++
        if (prev.status === 'replicating' && d.status !== 'replicating') prev.status = d.status ?? null
        // An app is as far behind as its furthest database, and one never
        // synced is further than any.
        if (prev.last_sync_at !== null && (at === null || Date.parse(at) < Date.parse(prev.last_sync_at))) prev.last_sync_at = at
      }
      const host = apps.get('')
      apps.delete('')
      if (!host) return { apps: [...apps.values()] }
      const { app_id, ...reading } = host
      return { apps: [...apps.values()], host: reading }
    },
  }
}
