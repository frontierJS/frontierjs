/*
 * status.js — `outpost status`: the box as this Outpost reads it, printed once.
 *
 * Run by a person at a shell on the box (`fli outpost:status` over ssh), never
 * by the unit. From outside, every route but `/health` is signed with
 * Basecamp's key, which nothing else holds, so ssh is the way in and these are
 * the readers the heartbeat and the reports use: what this prints is what
 * Basecamp is told, never a second parse of the same machine.
 *
 * Nothing listens and no timer starts. A second Outpost on the box would
 * heartbeat as the first, and one that bound the command port while the unit
 * was down would keep it.
 */

import { readFileSync }    from 'node:fs'
import { readdir, stat }   from 'node:fs/promises'
import { version }         from '../package.json' with { type: 'json' }
import { readConfig }      from './config.js'
import { layout }          from './layout.js'
import { createInspector } from './docker.js'
import { createReplicator } from './replicate.js'
import { createIngress }   from './ingress.js'
import { createVitals }    from './vitals.js'
import { createAnalytics } from './analytics.js'

/** What `fli outpost:status` checks before it renders. A change that renames
 *  or removes a key moves this; one that only adds a key does not. */
export const STATUS_SHAPE = 1

/** The unit's `EnvironmentFile`, which an ssh shell does not have. Its lines
 *  are `KEY=VALUE` with nothing quoted, written by the install. */
function envFile(path) {
  try {
    return Object.fromEntries(readFileSync(path, 'utf8').split('\n')
      .map(l => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2]]))
  } catch (err) {
    return { error: err.code === 'EACCES' ? `${path} is root's: run as root` : `${path}: ${err.code ?? err.message}` }
  }
}

/** An app's whole-host route, the one Caddy logs under (`FJS-1928`); its
 *  `-redirects` and `-path-<n>` routes have no access log of their own. */
const LOGGED_ROUTE = /^fjs-(?!.*-(?:redirects|path-\d+)$)(.+)$/

/** Requests per app over the last day, off each route's access log. A route
 *  with no log yet is left out, not counted as zero. */
async function trafficOf(routes, analytics, now) {
  const from = new Date(now - 86_400_000).toISOString()
  const out  = []
  for (const r of routes?.routes ?? []) {
    const app = LOGGED_ROUTE.exec(r.id ?? '')?.[1]
    if (!app) continue
    const report = await analytics.report({ routeId: r.id, from }).catch(() => null)
    if (report) out.push({ app_id: app, window_s: 86_400, requests: report.hosts.reduce((n, h) => n + h.requests, 0), truncated: report.truncated })
  }
  return out
}

/** The newest archive `/backup` left for each app, named `<app>-<instant>.tar.gz`
 *  by `docker.js`. An archive that was uploaded stays here too. */
async function backupsOf(dir) {
  const names = await readdir(dir).catch(err => { if (err.code === 'ENOENT') return []; throw err })
  const newest = new Map()
  for (const name of names) {
    const m = /^(.+)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.tar\.gz$/.exec(name)
    if (m && !(newest.get(m[1])?.name > name)) newest.set(m[1], { name, at: m[2] })
  }
  // The instant is the name's, put back into ISO: a copied archive's mtime is the copy's.
  const iso = (stamp) => stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
  return Promise.all([...newest].map(async ([app, { name, at }]) => {
    const info = await stat(`${dir}/${name}`).catch(() => null)
    return { app_id: app, name, size_bytes: info?.size ?? null, at: iso(at), count: names.filter(n => n.startsWith(`${app}-`)).length }
  }))
}

/**
 * Every reading, each its own unknown: a section whose reader threw is
 * `{ error }`, so a box without Caddy still reports its containers.
 */
export async function readStatus({ env = process.env } = {}) {
  const box  = layout(env)
  const file = envFile(box.envFile)
  let config = null, configError = file.error ?? null
  if (!configError) {
    try { config = readConfig({ ...file, ...env }) } catch (err) { configError = err.message.split('\n')[0] }
  }

  const appsDir    = config?.appsDir ?? box.apps
  const inspector  = createInspector({ hostFiles: config?.hostFiles ?? null, appsDir })
  const replicator = createReplicator({
    configPath: config?.litestreamConfig ?? box.litestreamConfig, appsDir,
    socketPath: config?.litestreamSocket, hostDb: config?.hostFiles?.db ?? null,
  })
  const ingress = createIngress({ admin: config?.caddyAdmin })
  const take    = async (fn) => { try { return await fn() } catch (err) { return { error: err.message } } }

  const [units, containers, routes, replication, vitals, disk, posture] = await Promise.all([
    take(() => inspector.units()),
    take(() => inspector.containers()),
    take(() => ingress.routes()),
    take(() => replicator.status()),
    take(() => createVitals().read()),
    take(() => inspector.disk()),
    take(() => inspector.posture()),
  ])

  const [traffic, backups] = await Promise.all([
    take(() => trafficOf(routes, createAnalytics(), Date.now())),
    take(() => backupsOf(config?.backupDir ?? box.backups)),
  ])

  return {
    shape: STATUS_SHAPE,
    at:    new Date().toISOString(),
    outpost: {
      version,
      server_id:    config?.serverId ?? null,
      basecamp_url: config?.basecampUrl ?? null,
      public_url:   config?.publicUrl ?? null,
      ...(configError ? { error: configError } : {}),
    },
    paths: { links: box.links, config: box.config, state: box.state, logs: box.logs },
    units, containers, routes, replication, vitals, disk, posture, traffic, backups,
  }
}
