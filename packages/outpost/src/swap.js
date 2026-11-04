/*
 * swap.js — putting an App's container onto a new release, for both deploy
 * paths (`FJS-D1866`).
 *
 * Outpost's `docker.deploy` and `fli deploy` over ssh each swapped by their own
 * hand, and the put-back is the branch nobody exercises until the day it
 * matters: two copies of it drift, and the drift is found mid-incident. So the
 * sequence lives here once and each caller hands in the three things that do
 * differ between a machine agent and a laptop driving a box over ssh:
 *
 *   run(argv, opts)              → { exitCode, stdout, stderr }   one command there
 *   find(name)                   → { live, replaced, next, all }  the App's containers
 *   health({ name, port, path, previous }) → { healthy, reason }  polled until it settles
 *
 * `previous` is true when the container asked about is the set-aside one put
 * back, so a caller whose port moves between releases can ask the daemon.
 * Each caller still builds its own `docker run` argv, because the two read
 * different config; the flags both must agree on are `runFlags` below.
 */

/** The stop grace a release gets when its run config states none (`FJS-D1839`,
 *  `FJS-D1841`). Handed to the container once, as `--stop-timeout` and as
 *  `FRONTIER_STOP_GRACE` for Junction to fit its budgets inside; every
 *  `docker stop` then waits that, an operator's and the daemon's too. Above
 *  15 s so the plugins' share holds Caravan's 30 s drain. */
export const DEFAULT_STOP_GRACE_S = 40

/** Under 2 s Junction has no room left for a drain once it keeps its margin. */
export function checkStopGrace(stopGrace) {
  if (stopGrace != null && !(Number.isInteger(stopGrace) && stopGrace >= 2))
    throw new Error(`stopGrace must be a whole number of seconds, at least 2 — got '${stopGrace}'`)
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

// The live container is renamed `_replaced` and stopped rather than removed,
// so a release that fails to start or to answer has something to go back to
// (`FJS-1765`). Stop-first stops it BEFORE the new one starts, for a migration
// the old release cannot run beside: SQLite takes one writer, and the new
// entrypoint opens the database to migrate. Start-first runs the new one as
// `_next` on a port Docker picks and stops the old one only once the route has
// moved, so a failure before then removes `_next` and the old one never stopped.
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

  /** Take the failed container away and start the set-aside one again. Answers
   *  the error to throw: `restored` says whether the old container is back,
   *  which is what tells a route to follow it, and `none` that there was none. */
  async function putBack({ name, held, port, path, why }) {
    const fail = (said, restored) => Object.assign(new Error(`the new container ${why}; ${said}`), { restored, none: !held })
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
    return back.healthy
      ? fail('the previous container is serving again', true)
      : fail(`the previous container is back and is not healthy either — ${back.reason}`, true)
  }

  return {
    /**
     * `argv` is the whole `docker run` line after `docker`, naming `name`.
     * `before` is a docker command run once the old container has stopped and
     * before the new one starts — Outpost's chown of the data directory, which
     * the old release still writes as its own uid. Answers `{ containerId }`;
     * throws the put-back's error, with `restored` and `none`, otherwise.
     */
    async stopFirst({ name, argv, opts, before = null, port = null, path = null }) {
      const held = await setAside(name)
      let containerId
      try {
        if (before) await docker(before)
        containerId = await docker(argv, opts)
      } catch (err) {
        // A port another process holds, a bad env value, an image the daemon
        // cannot resolve — docker's own refusals, after the old one stopped.
        throw await putBack({ name, held, port, path, why: `did not start — ${err.message}` })
      }
      const fresh = await health({ name, port, path })
      if (!fresh.healthy)
        throw await putBack({ name, held, port, path, why: `started and is not healthy — ${fresh.reason}` })
      if (held) await run(['docker', 'rm', '-f', held.replaced])
      return { containerId }
    },

    /**
     * `argv` names `<name>_next` and publishes on a port Docker picks;
     * `route(port)` moves the App's route once that one answers. The old
     * container is untouched until then, so every failure before it removes
     * `_next` and refuses the release with the old one still serving.
     * Answers `{ containerId, port }`.
     */
    async startFirst({ name, argv, opts, before = null, path = null, route }) {
      const next = `${name}_next`
      const { live, replaced, next: stale } = await find(name)
      // A `_replaced` beside a live container is a finished swap's leftover; with
      // nothing live it is the last good one, kept until this release answers.
      const leftovers = [stale, live && replaced].filter(Boolean)
      if (leftovers.length) await run(['docker', 'rm', '-f', ...new Set(leftovers)])

      const refuse = async (why) => {
        await run(['docker', 'rm', '-f', next])
        return new Error(`the new container ${why}; ${live ? 'the previous container was not touched and is still serving' : 'there was no previous container'}`)
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
      if (!port) throw await refuse('published no port for the route to follow')
      const fresh = await health({ name: next, port, path })
      if (!fresh.healthy) throw await refuse(`started and is not healthy — ${fresh.reason}`)

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
      if (live) await docker(['rename', live, `${live}_replaced`])
      await docker(['rename', next, name])
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
