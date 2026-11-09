/*
 * swap.js — putting an App's container onto a new release, for both deploy
 * paths (`FJS-D1866`).
 *
 * Outpost's `docker.deploy` and `fli deploy` over ssh each swapped by their own
 * hand, and the put-back is the branch nobody exercises until the day it
 * matters: two copies of it drift, and the drift is found mid-incident. So the
 * sequence lives here once and each caller hands in the things that do
 * differ between a machine agent and a laptop driving a box over ssh:
 *
 *   run(argv, opts)              → { exitCode, stdout, stderr }   one command there
 *   find(name)                   → { live, replaced, next, all }  the App's containers
 *   health({ name, port, path, previous }) → { healthy, reason }  polled until it settles
 *   route(port)                  → moves the App's route; per swap, below
 *   routed()                     → the ports the App's route dials; per swap
 *
 * `previous` is true when the container asked about is the set-aside one put
 * back, so a caller whose port moves between releases can ask the daemon.
 * The route moves here and nowhere else (`FJS-4018`): after a start-first the
 * live container is on a port Docker picked, so a caller that moved the route
 * to the App's port before a stop-first sent its traffic to nothing while the
 * old release was still up.
 * Each caller still builds its own `docker run` argv, because the two read
 * different config; the flags both must agree on are `runFlags` below.
 */

import { randomBytes } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'

/** The stop grace a release gets when its run config states none (`FJS-D1839`,
 *  `FJS-D1841`). Handed to the container once, as `--stop-timeout` and as
 *  `FRONTIER_STOP_GRACE` for Junction to fit its budgets inside; every
 *  `docker stop` then waits that, an operator's and the daemon's too. Above
 *  46 s: the HTTP drain takes a third of the shutdown and the plugins'
 *  two thirds must hold Caravan's 30 s drain. */
export const DEFAULT_STOP_GRACE_S = 50

/** Under 2 s Junction has no room left for a drain once it keeps its margin. */
export function checkStopGrace(stopGrace) {
  if (stopGrace != null && !(Number.isInteger(stopGrace) && stopGrace >= 2))
    throw new Error(`stopGrace must be a whole number of seconds, at least 2 — got '${stopGrace}'`)
}

/** How long a new release has to answer its health path before the swap puts
 *  the old one back, when its run config states none (`FJS-4015`). Kamal's
 *  `deploy_timeout` default. A migration on boot runs inside it, so an app
 *  whose expand outlives it is killed mid-run on every release: that app
 *  states its own. Stop-first is down for as long as it waits; start-first
 *  keeps the old release serving, so a long one costs nothing there. */
export const DEFAULT_HEALTH_TIMEOUT_S = 30

/** Under 5 s the first poll is the only one; over 600 s a failed release and
 *  its put-back no longer fit the 32 minutes Basecamp gives a `/deploy`. */
export function checkHealthTimeout(healthTimeout) {
  if (healthTimeout != null && !(Number.isInteger(healthTimeout) && healthTimeout >= 5 && healthTimeout <= 600))
    throw new Error(`healthTimeout must be a whole number of seconds, 5 to 600 — got '${healthTimeout}'`)
}

/** Every reverse_proxy handler either deploy path writes carries this
 *  (`FJS-4016`, `FJS-D1903`). Any write to Caddy's config reloads every
 *  handler, and an unloaded one closes its WebSockets (1001) at once, so a
 *  deploy of one app cut every app's sockets on the box. The delay postpones
 *  that close, never cancels it; a departing container still closes its own
 *  sockets at SIGTERM. Caddy 2.12's `stream_detached` replaces it. */
export const STREAM_CLOSE_DELAY = '24h'

/** One health probe for every deploy path (`FJS-4019`), Kamal's: a release is
 *  healthy when its health path answers exactly 200, asked once a second, each
 *  ask given 5 s. The paths disagreed (any 2xx in 3 s on Outpost, 200 with no
 *  limit on `fli deploy`), so one release could go live on one path and be put
 *  back on the other, and a health path that hung held `fli deploy`'s curl, and
 *  the stop-first outage with it, for as long as the app kept the socket open.
 *  `fli deploy` asks with curl over ssh, so it reads the status and the
 *  timeout as numbers rather than through `healthyStatus`. */
export const HEALTHY_STATUS = 200
export const HEALTH_INTERVAL_S = 1
export const HEALTH_CHECK_TIMEOUT_S = 5

export function healthyStatus(status) {
  return Number(status) === HEALTHY_STATUS
}

/** The seconds a new release has to answer, refused when out of range. Both
 *  deploy paths wait this on a deadline, not a count of polls: a count assumes
 *  each poll returns at once, and one that hangs costs `HEALTH_CHECK_TIMEOUT_S`
 *  plus the interval, so thirty polls ran about three minutes (`FJS-4029`). */
export function healthBudgetS(healthTimeout) {
  checkHealthTimeout(healthTimeout)
  return healthTimeout ?? DEFAULT_HEALTH_TIMEOUT_S
}

/**
 * The `--log-*` flags for a started container. Docker's default json-file
 * driver caps nothing, so an app that logs per request fills the machine's
 * disk and stops every OTHER app on it. `logs: false` is for a daemon already
 * pointed at a shipper; a named driver takes its own options, since max-size
 * is json-file's spelling and journald refuses it.
 *
 *   logs: false                       → nothing; the daemon's default stands
 *   (absent)                          → json-file, 10m × 5
 *   logs: { max_size, max_files }     → json-file, as stated
 *   logs: { driver, options }         → that driver, with only those options
 */
export function logArgs(logs) {
  if (logs === false) return []
  if (logs?.driver) {
    const out = ['--log-driver', String(logs.driver)]
    for (const [k, v] of Object.entries(logs.options ?? {})) out.push('--log-opt', `${k}=${v}`)
    return out
  }
  return [
    '--log-driver', 'json-file',
    '--log-opt', `max-size=${logs?.max_size ?? '10m'}`,
    '--log-opt', `max-file=${logs?.max_files ?? 5}`,
  ]
}

/** The `docker run` flags both deploy paths give a release: its log cap and
 *  its stop grace, the latter also told to Junction as `FRONTIER_STOP_GRACE`. */
export function runFlags({ logs, stopGrace } = {}) {
  checkStopGrace(stopGrace)
  const grace = stopGrace ?? DEFAULT_STOP_GRACE_S
  return [...logArgs(logs), '--stop-timeout', String(grace), '-e', `FRONTIER_STOP_GRACE=${grace}`]
}

/** The port a container's binding holds, or `null` with no such container. A
 *  start-first container asked for `127.0.0.1::<port>`, so its requested
 *  binding has no host port and the one Docker picked is on the running
 *  container; a stopped one has only the request. */
export async function portOf(run, container) {
  for (const field of ['.NetworkSettings.Ports', '.HostConfig.PortBindings']) {
    const result = await run(['docker', 'inspect', '--format', `{{json ${field}}}`, container])
    if (result.exitCode !== 0) {
      if (/No such (object|container)/i.test(result.stderr ?? '')) return null
      throw new Error(result.stderr?.trim() || `docker inspect exited ${result.exitCode}`)
    }
    let bindings = null
    try { bindings = JSON.parse(result.stdout) } catch {}
    // A release publishes one port at most, so the first binding is the app's.
    const first = Object.values(bindings ?? {}).flat().find(b => b?.HostPort)
    if (first) return { port: Number(first.HostPort), loopback: first.HostIp === '127.0.0.1' }
  }
  return { port: null, loopback: false }
}

const LOOPBACK_DIAL = /^127\.0\.0\.1:([0-9]+)$/

/**
 * Caddy routes with every loopback upstream moved to `port`, and what moved
 * (`FJS-D1890`). Docker hands a start-first container a new host port on every
 * restart, and a route left dialing the old one answers 502 until the next
 * deploy. A dial that is not `127.0.0.1:<n>` (the static origin's Host-keyed
 * route, a remote upstream) is not this App's container and stays as it is.
 * The input is never mutated.
 */
export function repointRoutes(routes, port) {
  const to    = Number(port)
  const moved = []
  const walk  = (handlers, id) => {
    for (const h of handlers ?? []) {
      if (h.handler === 'reverse_proxy') {
        if (h.headers?.request?.set?.Host) continue
        for (const u of h.upstreams ?? []) {
          const from = LOOPBACK_DIAL.exec(u.dial ?? '')?.[1]
          if (from == null || Number(from) === to) continue
          u.dial = `127.0.0.1:${to}`
          moved.push({ id, from: Number(from), to })
        }
      } else if (h.handler === 'subroute') {
        for (const r of h.routes ?? []) walk(r.handle, id)
      }
    }
  }
  const out = structuredClone(routes ?? [])
  for (const r of out) walk(r.handle, r['@id'] ?? null)
  return { routes: out, moved }
}

// Where the live release's `db/` is mounted for the classifier, beside the
// new image's own.
const BEFORE_MOUNT = '/fjs-before'
// Two schemas parsed and compared; a release waits on it before its swap.
const PIVOT_TIMEOUT_MS = 120_000

/**
 * Whether the release in `image` can serve beside the `live` container: the
 * new image's own `litestone release --json`, against the `db/` of the image
 * the live container runs (`FJS-D1838`). That is the schema the database was
 * migrated to, which a previous commit or a failed release is not. Both deploy
 * paths ask it, so one release gets one swap whichever deployed it. The
 * classifier is the app's copy of Litestone and the container has no network.
 *
 * Never throws: no live container, an image without the CLI or a copy that
 * failed answers `verdict: null` with the reason, which `swapFor` turns into
 * stop-first. `tag` names the throwaway volume for `docker volume ls`.
 */
export async function livePivot({ run, live, image, tag = 'app' }) {
  if (!live) return { verdict: null, reason: 'there is no live release to serve beside it' }
  const docker = async (args) => {
    const result = await run(['docker', ...args])
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout || '').trim() || `docker ${args[0]} exited ${result.exitCode}`)
    return String(result.stdout ?? '').trim()
  }
  // A volume, not a host directory: a snap docker cannot write under a
  // dotdir or /tmp, and Docker fills an EMPTY volume from the image at its
  // mount point on create, so the old image needs no copy tool. Named once
  // per call, because a volume left by a killed run is not empty and would
  // answer that run's schema.
  const volume = `fjs-before-${tag}-${randomBytes(4).toString('hex')}`
  try {
    const [liveImage, wd = ''] = (await docker(['inspect', '--format', '{{.Image}} {{.Config.WorkingDir}}', live])).split(' ')
    const held = await docker(['create', '--network', 'none', '--mount', `type=volume,src=${volume},dst=${wd.replace(/\/+$/, '')}/db`,
                               '--entrypoint', 'true', liveImage])
    await run(['docker', 'rm', '-f', held])
    const result = await run([
      'docker', 'run', '--rm', '--network', 'none', '--user', '0:0',
      '--mount', `type=volume,src=${volume},dst=${BEFORE_MOUNT},readonly`,
      '--entrypoint', 'bun', image,
      'x', 'litestone', 'release', `--from=${BEFORE_MOUNT}/schema.lite`, '--json',
    ], { timeoutMs: PIVOT_TIMEOUT_MS })
    const out  = String(result.stdout ?? '')
    const json = out.slice(out.indexOf('{'))
    let report = null
    try { report = json ? JSON.parse(json) : null } catch {}
    if (typeof report?.verdict !== 'string') {
      const said = stripVTControlCharacters(result.stderr || out || '').trim().split('\n').slice(-3).join(' ')
      return { verdict: null, reason: `the classifier did not run in ${image} (exit ${result.exitCode}): ${said}` }
    }
    // An unresolved baseline answers `unknown` with the cause in its note.
    return { verdict: report.verdict, reason: report.baseline?.resolved === false ? report.baseline.note ?? null : null }
  } catch (err) {
    return { verdict: null, reason: `the live release's schema could not be read — ${err.message}` }
  } finally {
    await run(['docker', 'volume', 'rm', '-f', volume])
  }
}

/**
 * The swap a start-first request runs, from the release's pivot (`FJS-D1838`).
 * Only an expand or an unchanged schema leaves the old release able to serve
 * beside the new one's migration; a contract, an unknown and a verdict that
 * was never reached all swap stop-first, and say why.
 */
export function swapFor({ verdict = null, reason = null } = {}) {
  if (verdict === 'expand' || verdict === 'unchanged') return { swap: 'start-first', reason: null }
  if (verdict === 'contract')
    return { swap: 'stop-first', reason: 'this release is a contract, so the live release cannot serve beside its migration — this deploy is the pivot' }
  if (verdict === 'unknown')
    return { swap: 'stop-first', reason: `the classifier cannot tell whether the live release survives this one, and unknown counts as a contract${reason ? ` — ${reason}` : ''}` }
  return { swap: 'stop-first', reason: reason ?? 'no verdict was reached' }
}

// The live container is renamed `_replaced` and stopped rather than removed,
// so a release that fails to start or to answer has something to go back to
// (`FJS-1765`). Stop-first stops it BEFORE the new one starts, for a migration
// the old release cannot run beside: SQLite takes one writer, and the new
// entrypoint opens the database to migrate. Start-first runs the new one as
// `_next` on a port Docker picks and stops the old one only once the route has
// moved, so a failure before then removes `_next` and the old one never stopped.
//
// How much of a failed release's log its error carries: a stack trace fits,
// and a deployment step stores the whole of it.
const LAST_LOG_LINES = 30
const LAST_LOG_CHARS = 4000

// Where a throwaway container sees the app's volume to read or restore a copy.
const COPY_MOUNT = '/fjs-volume'
const COPY_NAME  = /^(.+)--(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3}Z)\.db$/
const RESTORE_SCRIPT = 'set -e; cp -p "$1" "$2.restoring"; rm -f "$2-wal" "$2-shm"; mv "$2.restoring" "$2"'

/**
 * The one exact pre-migrate copy per database, from a `pre-migrate/` listing
 * (`FJS-D2042`): the oldest taken after the old container stopped. A later one
 * can hold what an earlier failed release already migrated. `stoppedAt` is the
 * daemon's own reading, on the clock the copy's name was stamped by.
 */
export function exactCopies(names, stoppedAt) {
  const since  = Date.parse(stoppedAt.replace(/(\.\d{3})\d*Z$/, '$1Z'))
  const oldest = new Map()
  for (const file of [...names].sort()) {
    const m = COPY_NAME.exec(file)
    if (!m || oldest.has(m[1])) continue
    if (Date.parse(`${m[2]}T${m[3]}:${m[4]}:${m[5]}`) > since) oldest.set(m[1], file)
  }
  return [...oldest].map(([db, file]) => ({ db, file }))
}

export function createSwap({ run, health, find }) {
  /** A docker command, or throw with what the machine actually said: swallowing
   *  it is how a deploy reports success having done nothing (`FJS-257`). */
  async function docker(args, opts) {
    const result = await run(['docker', ...args], opts)
    if (result.exitCode !== 0) {
      const said = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ')
      throw new Error(`docker ${args[0]} failed (exit ${result.exitCode}): ${said}`)
    }
    return String(result.stdout ?? '').trim()
  }

  /** The end of a failed container's log, as the block its error closes with,
   *  or `''`. Removing the container takes the log with it, and then an app
   *  that exited at boot reads only as a health path that did not answer
   *  (`FJS-4070`). Never throws, since the put-back runs next. Merged by the
   *  shell because a boot failure is on stderr, which `fli deploy`'s runner
   *  discards from a command that succeeds. */
  async function lastLog(container) {
    let read
    try { read = await run(['sh', '-c', `docker logs --tail ${LAST_LOG_LINES} "$1" 2>&1`, 'sh', container]) } catch { return '' }
    if (read.exitCode !== 0) return ''
    const said = stripVTControlCharacters(String(read.stdout ?? '')).trim()
    if (!said) return ''
    return `\n\nits log ended:\n${said.split('\n').slice(-LAST_LOG_LINES).join('\n').slice(-LAST_LOG_CHARS)}`
  }

  /** Finish a start-first swap that died after its route moved. The route
   *  dials `_next` while it is still named that, and the sequences below remove
   *  any `_next` before they start: removed then, it is the serving release that
   *  goes down. So a `_next` the route dials is named into place first, the
   *  rename a swap could not make, and the container it replaces stops. Nothing
   *  is removed while a rename can still fail. `routed()` answers the loopback
   *  ports the App's route dials, `[]` when it has none. */
  async function adoptServing({ name, routed }) {
    if (!routed) return
    const { live, replaced, next } = await find(name)
    if (!next) return
    const at = (await portOf(run, next))?.port
    if (!at || !(await routed()).includes(at)) return
    const old = live ? `${live}_replaced` : replaced
    try {
      if (live) {
        // A `_replaced` beside a live container is a finished swap's leftover.
        const leftovers = [...new Set([old, replaced].filter(Boolean))]
        await run(['docker', 'rm', '-f', ...leftovers])
        await docker(['rename', live, old])
      }
      await docker(['rename', next, name])
    } catch (err) {
      throw new Error(`${next} is the release serving (the route dials it) and could not be named ${name}, so it is left running — ${err.message}`)
    }
    if (old) {
      await run(['docker', 'stop', old])
      await run(['docker', 'rm', '-f', old])
    }
  }

  /** Set the live container aside, under whatever name it carries. Answers the
   *  handle to go back to, or `null` when there is nothing. A `_replaced` with
   *  nothing live beside it is the last good container of a swap that did not
   *  finish, so it is kept rather than cleared. */
  async function setAside(name) {
    const { live, replaced, next } = await find(name)
    // A `_next` is a start-first release that did not finish, and it holds the
    // database open.
    if (next) await run(['docker', 'rm', '-f', next])
    const held = live ? { name: live, replaced: `${live}_replaced` }
      : replaced ? { name: replaced.slice(0, -'_replaced'.length), replaced }
      : null
    if (!held) return null
    if (live) {
      // Any `_replaced` found goes too: a slug renamed since the last release
      // leaves one under a name this swap would never write.
      await run(['docker', 'rm', '-f', ...new Set([held.replaced, replaced].filter(Boolean))])
      await docker(['rename', live, held.replaced])
    }
    try {
      // No `-t`: the container carries the grace it was started with.
      await docker(['stop', held.replaced])
    } catch (err) {
      await run(['docker', 'rename', held.replaced, held.name])
      throw err
    }
    return held
  }

  /** Take the failed container away and start the set-aside one again, the
   *  route following it: one a start-first published comes back on a new port.
   *  Answers the error to throw: `restored` says whether the old container is
   *  back, and `none` that there was none. `log` is `lastLog`'s block. */
  async function putBack({ name, held, port, path, why, route, log = '' }) {
    const fail = (said, restored) => Object.assign(new Error(`the new container ${why}; ${said}${log}`), { restored, none: !held })
    await run(['docker', 'rm', '-f', name])
    if (!held) return fail('there was no previous container to put back', false)
    try {
      await docker(['rename', held.replaced, held.name])
      await docker(['start', held.name])
    } catch (err) {
      return fail(`putting the previous container back failed too: ${err.message}`, false)
    }
    // `docker start` returns while the app is still booting, so the old release
    // is back when it ANSWERS — saying so sooner is what a slow machine makes a lie.
    const back = await health({ name: held.name, port, path, previous: true })
    let unrouted = ''
    if (route) {
      try {
        const at = (await portOf(run, held.name))?.port
        if (at) await route(at)
      } catch (err) {
        unrouted = `, and moving the route back to it failed — ${err.message}`
      }
    }
    return back.healthy
      ? fail(`the previous container is serving again${unrouted}`, true)
      : fail(`the previous container is back and is not healthy either — ${back.reason}${unrouted}`, true)
  }

  /** Put the exact pre-migrate copy back over the volume. Never throws: a copy
   *  that cannot be found or restored answers why, and the caller stays down. */
  async function restoreCopy({ held, copies }) {
    if (!copies) return { restored: false, said: 'this release keeps no volume to hold a copy' }
    const inVolume = ['run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh',
                      '--mount', `type=bind,src=${copies.volume},dst=${COPY_MOUNT}`, copies.image, '-c']
    try {
      const stoppedAt = await docker(['inspect', '--format', '{{.State.FinishedAt}}', held.replaced])
      const listed    = await docker([...inVolume, `ls -1 ${COPY_MOUNT}/pre-migrate 2>/dev/null || true`])
      const picked    = exactCopies(listed.split('\n').map(l => l.trim()).filter(Boolean), stoppedAt)
      if (!picked.length) return { restored: false, said: 'no copy was taken after it stopped' }
      for (const { db, file } of picked)
        await docker([...inVolume, RESTORE_SCRIPT, 'sh', `${COPY_MOUNT}/pre-migrate/${file}`, `${COPY_MOUNT}/${db}`])
      return { restored: true, said: picked.map(p => p.file).join(', ') }
    } catch (err) {
      return { restored: false, said: `restoring the copy failed — ${err.message}` }
    }
  }

  /** A release that may have moved the database failed health, and the old
   *  container cannot be trusted on it (`FJS-D2044`). */
  function stayDown({ held, pivot, why, said, log }) {
    return Object.assign(new Error(
      `the new container ${why}; this release is ${pivot === 'contract' ? 'a contract' : 'of unknown effect'}, ` +
      `so ${held.replaced} stays stopped rather than serve a database it may not understand, and ${said}${log}`),
    { restored: false, none: false, stayedDown: true })
  }

  return {
    /**
     * `argv` is the whole `docker run` line after `docker`, naming `name`.
     * `before` is a docker command run once the old container has stopped and
     * before the new one starts — Outpost's chown of the data directory, which
     * the old release still writes as its own uid. `route(port)` moves the
     * App's route once the new one answers, and onto the old one when it is
     * put back; until then the route dials the old container, draining or
     * stopped. `routed()` says which container that is when a start-first left
     * a `_next` serving; without it no `_next` is taken for one. `pivot` is
     * this release's verdict and `copies` `{ volume, image }`: a `contract` or
     * `unknown` that started and failed health restores the exact copy or stays
     * down, and a rollback, whose migrations are recorded, states no pivot. Answers
     * `{ containerId }`; throws the put-back's error, with `restored`, `none`
     * and `stayedDown`, otherwise.
     */
    async stopFirst({ name, argv, opts, before = null, port = null, path = null, route = null, routed = null, pivot = null, copies = null }) {
      await adoptServing({ name, routed })
      const held = await setAside(name)
      let containerId
      try {
        if (before) await docker(before)
        containerId = await docker(argv, opts)
      } catch (err) {
        // A port another process holds, a bad env value, an image the daemon
        // cannot resolve — docker's own refusals, after the old one stopped.
        throw await putBack({ name, held, port, path, route, why: `did not start — ${err.message}` })
      }
      const fresh = await health({ name, port, path })
      if (!fresh.healthy) {
        const why = `started and is not healthy — ${fresh.reason}`
        const log = await lastLog(name)
        if (held && (pivot === 'contract' || pivot === 'unknown')) {
          // Before the copy goes back: the failed container holds the database open.
          await run(['docker', 'rm', '-f', name])
          const copy = await restoreCopy({ held, copies })
          if (!copy.restored) throw stayDown({ held, pivot, why, said: copy.said, log })
          throw await putBack({ name, held, port, path, route, why: `${why}, and its database is back to ${copy.said}`, log })
        }
        throw await putBack({ name, held, port, path, route, why, log })
      }
      if (route) {
        try {
          await route(port)
        } catch (err) {
          // The release is live and the route still dials the stopped one, so
          // `_replaced` stays for an operator to go back to.
          throw new Error(`the new container answers on :${port} and moving the route to it failed — ${err.message}`)
        }
      }
      if (held) await run(['docker', 'rm', '-f', held.replaced])
      return { containerId }
    },

    /**
     * `argv` names `<name>_next` and publishes on a port Docker picks;
     * `route(port)` moves the App's route once that one answers. The old
     * container is untouched until then, so every failure before it removes
     * `_next` and refuses the release with the old one still serving. A
     * failure after it leaves `_next` serving, and the next swap names it into
     * place (`routed()` tells it the route dials it). Answers
     * `{ containerId, port }`.
     */
    async startFirst({ name, argv, opts, before = null, path = null, route, routed }) {
      if (typeof routed !== 'function') throw new Error('a start-first swap needs routed(), to tell a leftover _next the route dials from one it does not')
      const next = `${name}_next`
      await adoptServing({ name, routed })
      const { live, replaced, next: stale } = await find(name)
      // A `_replaced` beside a live container is a finished swap's leftover; with
      // nothing live it is the last good one, kept until this release answers.
      const leftovers = [stale, live && replaced].filter(Boolean)
      if (leftovers.length) await run(['docker', 'rm', '-f', ...new Set(leftovers)])

      // `untouched` tells a caller the old container never stopped, apart from
      // a failure after the route moved, which leaves the new one serving.
      const refuse = async (why, log = '') => {
        await run(['docker', 'rm', '-f', next])
        return Object.assign(new Error(`the new container ${why}; ${live ? 'the previous container was not touched and is still serving' : 'there was no previous container'}${log}`),
          { untouched: true, none: !live })
      }
      let containerId
      try {
        // The old release writes as this same uid, or as root, and can after the chown either way.
        if (before) await docker(before)
        containerId = await docker(argv, opts)
      } catch (err) {
        throw await refuse(`did not start — ${err.message}`)
      }
      const port = (await portOf(run, next).catch(() => null))?.port
      if (!port) throw await refuse('published no port for the route to follow', await lastLog(next))
      const fresh = await health({ name: next, port, path })
      if (!fresh.healthy) throw await refuse(`started and is not healthy — ${fresh.reason}`, await lastLog(next))

      try {
        await route(port)
      } catch (err) {
        // A write that landed before the failure dials `_next`, which is about to go.
        const old = live ? (await portOf(run, live).catch(() => null))?.port : null
        if (old) await route(old).catch(() => {})
        throw await refuse(`answered, and moving the route to it failed — ${err.message}`)
      }

      // Renamed before the stop: a deploy that dies mid-drain leaves the routed
      // container live and the old one as `_replaced`, which the next swap clears.
      try {
        if (live) await docker(['rename', live, `${live}_replaced`])
        await docker(['rename', next, name])
      } catch (err) {
        throw new Error(`the new container answers and the route moved to it, but naming it ${name} failed — ${err.message}; it keeps serving as ${next} and the next release names it into place`)
      }
      if (live) {
        // Requests in flight finish inside the grace; new ones already reach the new release.
        await run(['docker', 'stop', `${live}_replaced`])
        await run(['docker', 'rm', '-f', `${live}_replaced`])
      } else if (replaced) {
        await run(['docker', 'rm', '-f', replaced])
      }
      return { containerId, port }
    },
  }
}
