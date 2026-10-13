/*
 * docker.js — the one place this process runs a command on the machine.
 *
 * Every route in `server.js` goes through here, which is what makes the whole
 * of the Outpost testable without a daemon: `createDocker({ run })` takes the
 * runner, and the tests hand it one that records argv and answers canned
 * output. A route that shelled out on its own would be a second answer to
 * *what did we ask this machine to do*, and the only thing that could see it
 * would be a real Docker.
 *
 * Nothing here interpolates caller-supplied text into a shell string. Every
 * command is an argv array handed to the runner, so a container name with a
 * space in it is one argument rather than two — the same rule this repo states
 * about SQL (Invariant 8), for the same reason.
 */

import { stripVTControlCharacters } from 'node:util'
import { validRelativePath } from './static.js'

/** A digest is `sha256:` and 64 hex characters. Anything else is not an
 *  identity and Basecamp refuses to record it, so this refuses to report it. */
const DIGEST = /^sha256:[0-9a-f]{64}$/

// The most lines `POST /logs` will read off a container in one answer. A cap
// rather than a default, because the caller is on another machine and the cost
// of an unbounded read is paid here.
const MAX_LOG_LINES = 5000

export function isDigest(value) {
  return typeof value === 'string' && DIGEST.test(value)
}

/** The default runner: Bun's own spawn, argv only, never a shell. */
export async function spawnRun(argv, { timeoutMs = 600_000, cwd } = {}) {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', cwd })

  // A command with no bound is a queue that stalls forever on one wedged pull
  // — the same failure caravan names for a job with no timeout. So 0, null and
  // NaN are not "no timer": a bound that can be switched off by a number on the
  // wire is not one (`FJS-1857`).
  const bound = timeoutMs > 0 ? timeoutMs : 600_000
  const timer = setTimeout(() => { try { proc.kill() } catch {} }, bound)

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)

  return { exitCode, stdout, stderr }
}

// ─── logArgs ─────────────────────────────────────────────────────────────────
// The `--log-*` flags for a started container. Mirrors the CLI's
// `core/docker-logging.js`; see the note at its call site for why it is a copy.
/**
 * The run config `deploy` would refuse, refused without touching the machine.
 * `/deploy` asks this before it re-points Caddy: a refusal after the route has
 * moved to the new port leaves the old container running behind a route that
 * dials nothing.
 */
export function checkRunConfig(config = {}) {
  if (config.volumePath != null && !/^\/[^:,]*$/.test(String(config.volumePath)))
    throw new Error(`volumePath must be an absolute path with no ':' or ',' — got '${config.volumePath}'`)
  if (config.cpuLimit != null && !(Number(config.cpuLimit) > 0))
    throw new Error(`cpuLimit must be a number of CPUs above 0 — got '${config.cpuLimit}'`)
  if (config.memLimitMb != null && !(Number.isInteger(Number(config.memLimitMb)) && Number(config.memLimitMb) >= 6))
    throw new Error(`memLimitMb must be a whole number of MiB, at least 6 — got '${config.memLimitMb}'`)
}

function logArgs(logs) {
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

/** How long `deploy` waits for a new container before putting the old one back.
 *  Basecamp's own health step polls the same ten times three seconds, and its
 *  `/deploy` send is given the room for it. */
const HEALTH = { attempts: 10, intervalMs: 3_000 }

/** The host port an app declared reachable from outside (`FJS-D930`), on its
 *  container. The install's `inet basecamp` table drops every other one. */
const EXPOSED_LABEL = 'fjs.exposed-port'
const EXPOSED_SET   = 'inet basecamp exposed'

export function createDocker({
  run = spawnRun, fetch: fetchFn = globalThis.fetch, workDir = '/var/lib/outpost/apps', health = HEALTH,
} = {}) {

  /** Run a docker command, or throw with what the machine actually said. A
   *  route turns that into an error the caller reads; swallowing it here is
   *  how a deploy reports success having done nothing (`FJS-257`). */
  async function docker(args, opts) {
    const result = await run(['docker', ...args], opts)
    if (result.exitCode !== 0) {
      const said = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ')
      throw new Error(`docker ${args[0]} failed (exit ${result.exitCode}): ${said}`)
    }
    return result.stdout.trim()
  }

  /** Run git, or throw with what it said. A clone that failed and was ignored
   *  built whatever the work directory last held, or nothing, and reported the
   *  release as built. */
  async function git(args) {
    const result = await run(['git', ...args], { timeoutMs: 600_000 })
    if (result.exitCode !== 0) {
      const said = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ')
      const verb = args[0] === '-C' ? args[2] : args[0]
      throw new Error(`git ${verb} failed (exit ${result.exitCode}): ${said}`)
    }
    return result.stdout
  }

  /** How to name the bytes on the command line.
   *
   *  `name@sha256:…` is a REPO digest — what a registry answered when the image
   *  was pushed or pulled. An image built on this machine has never been
   *  pushed, so `digestOf` reports its Id instead, and `name@<id>` is a
   *  reference no daemon can resolve: docker reads it as a pull, and a release
   *  that had just built successfully failed with *pull access denied for
   *  <name>*. Every V1 build-on-the-machine deploy did this, and nothing ran
   *  the path — basecamp's own drive injects a fake docker (`FJS-919`).
   *
   *  A bare id IS a reference the daemon takes, so the local case addresses the
   *  bytes directly and the registry case keeps `name@digest`. Asked of the
   *  daemon rather than guessed at: both are `sha256:…` and nothing in the
   *  string says which one this is. */
  async function reference(image, digest) {
    if (!isDigest(digest)) return image
    const local = await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', digest])
    return local.exitCode === 0 ? digest : `${image}@${digest}`
  }

  /** The bytes of a local image. `Id` rather than `RepoDigests[0]`: an image
   *  built here has never been pushed, so it has no repo digest at all — and
   *  the id IS a sha256 over the config, which is the identity this reports. */
  async function digestOf(image) {
    const id = await docker(['image', 'inspect', '--format', '{{.Id}}', image])
    return isDigest(id) ? id : null
  }

  /**
   * Where the running container answers on this machine: its published port
   * and whether that port is bound to loopback, read off the daemon. `null`
   * when there is no container. A route pushed between releases dials this,
   * because the port the last release published is the one that is live, and
   * the app row's port may have been edited since.
   */
  async function published({ appId }) {
    const result = await run(['docker', 'inspect', '--format', '{{json .HostConfig.PortBindings}}', `fjs-${appId}`])
    if (result.exitCode !== 0) {
      if (/No such (object|container)/i.test(result.stderr ?? '')) return null
      throw new Error(result.stderr?.trim() || `docker inspect exited ${result.exitCode}`)
    }
    let bindings = null
    try { bindings = JSON.parse(result.stdout) } catch {}
    // `deploy` publishes one port at most, so the first binding is the app's.
    const first = Object.values(bindings ?? {}).flat()[0]
    if (!first?.HostPort) return { port: null, loopback: false }
    return { port: Number(first.HostPort), loopback: first.HostIp === '127.0.0.1' }
  }

  /** Running, and — where the app names a path — answering it on the port
   *  this machine published. A process that is up and serving 502s is the
   *  release a running-only check calls healthy. `State.Running` is asked of
   *  the daemon rather than inferred from the fact that `docker run` returned. */
  async function healthCheck({ appId, port, path }) {
    const name = `fjs-${appId}`
    const result = await run(['docker', 'inspect', '--format', '{{.State.Running}}', name])
    if (!(result.exitCode === 0 && result.stdout.trim() === 'true')) return { healthy: false, reason: 'not running' }
    if (path == null) return { healthy: true }
    if (!port || !/^\/[^ ]*$/.test(String(path)))
      return { healthy: false, reason: `a health path needs a published port and a path beginning with '/' — got port ${port}, path '${path}'` }
    const url = `http://127.0.0.1:${port}${path}`
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(3_000) })
      return res.ok ? { healthy: true } : { healthy: false, reason: `${url} answered ${res.status}` }
    } catch (err) {
      return { healthy: false, reason: `${url} did not answer: ${err.message}` }
    }
  }

  async function untilHealthy(target) {
    let last
    for (let i = 0; i < health.attempts; i++) {
      if (i) await Bun.sleep(health.intervalMs)
      last = await healthCheck(target)
      if (last.healthy) break
    }
    return last
  }

  // ─── the swap ────────────────────────────────────────────────────────────────
  // The live container is renamed `_replaced` and stopped rather than removed,
  // so a release that fails to start or to answer has something to go back to
  // (`FJS-1765`) — the same handle `fli deploy`'s `swapContainer` keeps.
  // Stopped BEFORE the new one starts: a SQLite volume takes one writer, and
  // the new entrypoint opens it to migrate.

  const exists = async (name) =>
    (await run(['docker', 'container', 'inspect', '--format', '{{.Id}}', name])).exitCode === 0

  /** Set the live container aside. Answers whether there is one to go back to.
   *  A `_replaced` with nothing live beside it is the last good container of a
   *  swap this process did not finish, so it is kept rather than cleared. */
  async function setAside(name, replaced) {
    if (await exists(name)) {
      await run(['docker', 'rm', '-f', replaced])
      await docker(['rename', name, replaced])
    } else if (!await exists(replaced)) {
      return false
    }
    try {
      await docker(['stop', '-t', '10', replaced])
    } catch (err) {
      await run(['docker', 'rename', replaced, name])
      throw err
    }
    return true
  }

  /** Take the failed container away and start the set-aside one again. Answers
   *  the error `/deploy` throws: `restored` says whether the old container is
   *  back, which is what tells the route to follow it to its own port. */
  async function putBack({ appId, name, replaced, held, path, why }) {
    const fail = (said, restored) => Object.assign(new Error(`the new container ${why}; ${said}`), { restored })
    await run(['docker', 'rm', '-f', name])
    if (!held) return fail('there was no previous container to put back', false)
    try {
      await docker(['rename', replaced, name])
      await docker(['start', name])
    } catch (err) {
      return fail(`putting the previous container back failed too: ${err.message}`, false)
    }
    // `docker start` returns while the app is still booting, so the old release
    // is back when it ANSWERS — saying so sooner is what a slow machine makes a lie.
    const back = await untilHealthy({ appId, port: (await published({ appId }).catch(() => null))?.port, path })
    return back.healthy
      ? fail('the previous container is serving again', true)
      : fail(`the previous container is back and is not healthy either — ${back.reason}`, true)
  }

  return {
    digestOf,

    /** Pull an image that already exists somewhere else. A release that names
     *  a digest this machine holds has nothing to fetch: an image built or
     *  loaded here has no registry, and pulling its tag fails with *pull access
     *  denied* (`FJS-2645`). A tag names no bytes, so it always pulls. */
    async pull({ image, digest }) {
      if (!image) throw new Error('pull needs an image')
      if (isDigest(digest)) {
        const held = await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', digest])
        if (held.exitCode === 0) return { digest }
      }
      await docker(['pull', image], { timeoutMs: 900_000 })
      return { digest: await digestOf(image) }
    },

    /**
     * Build from a git source on this machine — V1's answer to *where do the
     * bytes come from*. Build-once-promote-a-digest is the end state and needs
     * a builder and somewhere to put the artefact (`IDEAS/deploy-plane.md`);
     * with the Outpost co-resident with Basecamp there is exactly one machine,
     * so building here is honest rather than a compromise.
     */
    async build({ appId, source, image }) {
      // The path is caller text that joins the build context: the allow-list
      // /static/publish uses, checked before a clone is spent on it.
      if (source.path != null) {
        const bad = validRelativePath(source.path)
        if (bad) throw new Error(`source path: ${bad}`)
      }
      const dir = `${workDir}/${appId}`
      await run(['mkdir', '-p', dir])

      // Clone or update. `git -C` rather than a cd, so nothing depends on this
      // process's working directory.
      const exists = await run(['test', '-d', `${dir}/.git`])
      if (exists.exitCode === 0) {
        await git(['-C', dir, 'fetch', '--depth', '1', 'origin', source.branch ?? 'main'])
        await git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD'])
      } else {
        // `--` so a repo that begins with a dash is a repository and never an option.
        await git(['clone', '--depth', '1', '--branch', source.branch ?? 'main', '--', source.repo, dir])
      }

      const sha = (await git(['-C', dir, 'rev-parse', 'HEAD'])).trim()
      await docker(['build', '-t', image, source.path != null ? `${dir}/${source.path}` : dir], { timeoutMs: 1_800_000 })
      return { digest: await digestOf(image), commitSha: sha }
    },

    /**
     * Start the new container, and answer only once it is healthy. It takes
     * the old one's name, because a machine that accumulates `app-1`, `app-2`
     * is one nothing can address by name afterwards; the old one waits as
     * `_replaced` until then, and comes back if the new one does not start or
     * does not answer.
     */
    async deploy({ appId, image, digest, config = {}, port, loopback = false, exposesPort = false }) {
      const name     = `fjs-${appId}`
      const replaced = `${name}_replaced`
      checkRunConfig(config)

      const argv = ['run', '-d', '--name', name, '--restart', 'unless-stopped']
      // Docker's default json-file driver caps nothing, so an app that logs per
      // request fills the machine's disk and stops every OTHER app on it — which
      // is the fleet version of the failure and the reason this is not left to
      // whoever calls /deploy. `config.logs: false` is for a daemon already
      // pointed at a shipper; a named driver takes its own options, since
      // max-size is json-file's spelling and journald refuses it.
      //
      // Same defaults as the CLI's `core/docker-logging.js`, restated rather
      // than imported: outpost is a plain Bun service and depends on no
      // framework package. Two copies of three constants, and the alternative
      // is a dependency edge from a machine agent to the CLI.
      argv.push(...logArgs(config.logs))
      // A loopback app answers only through Caddy, one hop the app must be told
      // about or every caller shares Caddy's address in its rate limiter
      // (`FJS-D617`, `FJS-1841`). Before the caller's env, so a stated value wins.
      if (loopback) argv.push('-e', 'FJS_TRUST_PROXY=1')
      for (const [key, value] of Object.entries(config.env ?? {})) argv.push('-e', `${key}=${value}`)
      // An app Caddy fronts answers only through Caddy (`FJS-D565`): its port
      // on every interface is the same app over plain HTTP, around the
      // certificate. An app with no hostname keeps it, or nothing reaches it.
      if (port) argv.push('-p', `${loopback ? '127.0.0.1:' : ''}${port}:${config.containerPort ?? port}`)
      // The host firewall drops a forwarded connection to any published port
      // not in its exposed set, and `syncExposed` builds that set from this
      // label, so the declaration lives and dies with the container.
      if (port && exposesPort && !loopback) argv.push('--label', `${EXPOSED_LABEL}=${port}`)
      // The data a container keeps, on a NAMED volume that outlives it. Every
      // release replaces the container, so a database started without one
      // comes back empty after its next release. Named for the app, so the
      // next container is handed the same one; a path docker would read as
      // anything but a mount point was refused above, before the old container
      // was touched.
      if (config.volumePath != null) argv.push('-v', `${name}-data:${config.volumePath}`)
      if (config.cpuLimit   != null) argv.push('--cpus', String(config.cpuLimit))
      if (config.memLimitMb != null) argv.push('--memory', `${config.memLimitMb}m`)
      // Addressed by digest where one is known — the tag is a name and two
      // builds share it. This is the half `Deployment.builtImage` records.
      argv.push(await reference(image, digest))

      const held = await setAside(name, replaced)
      const path = config.healthCheck ?? null
      let containerId
      try {
        containerId = await docker(argv)
      } catch (err) {
        // A port another process holds, a bad env value, an image the daemon
        // cannot resolve — docker's own refusals, which come after the old
        // container has stopped.
        throw await putBack({ appId, name, replaced, held, path, why: `did not start — ${err.message}` })
      }
      const fresh = await untilHealthy({ appId, port, path })
      if (!fresh.healthy)
        throw await putBack({ appId, name, replaced, held, path, why: `started and is not healthy — ${fresh.reason}` })

      if (held) await run(['docker', 'rm', '-f', replaced])
      return { containerId, digest: digest ?? await digestOf(image) }
    },

    /**
     * The container's log, back to the operator.
     *
     * The gap this closes is `basecamp/web/src/routes/apps/[id]/index.mesa`,
     * which carries a comment saying its logs tab is absent because *nothing
     * stores or streams a log line* — true of the whole fleet, not of that
     * screen. `fli deploy:logs` answers the same question over ssh for one app
     * an operator is already sitting next to; this answers it for a fleet from
     * a console.
     *
     * **Bounded, and the bound is not advice.** `docker logs` on a container
     * that has been up for a month is however many gigabytes the driver kept,
     * read into this process's memory by the runner before anything can trim
     * it — so `tail` is clamped rather than defaulted, and the clamp is here
     * rather than in the caller, which is on another machine.
     *
     * stdout and stderr come back separately because that is how the container
     * wrote them and joining them here would invent an interleaving that is not
     * the one that happened.
     */
    async logs({ appId, tail = 200, since = null } = {}) {
      const name  = `fjs-${appId}`
      // A caller-supplied count reaches an argv array rather than a shell, so
      // this is a resource bound and not an injection guard.
      const lines = Math.min(Math.max(Number.parseInt(tail, 10) || 200, 1), MAX_LOG_LINES)
      const argv  = ['docker', 'logs', '--tail', String(lines)]
      // Docker's own vocabulary — an RFC3339 stamp or a duration like `10m`.
      // Anything else is refused BY DOCKER, whose message is more use than a
      // second grammar maintained here.
      if (since != null && String(since).trim() !== '') argv.push('--since', String(since))
      argv.push(name)

      const result = await run(argv)
      // A container that is not there is a 404-shaped answer rather than a
      // failure: basecamp asks this about an app it believes is deployed, and
      // *no such container* is the useful sentence.
      if (result.exitCode !== 0 && /No such container/i.test(result.stderr ?? ''))
        return { running: false, tail: lines, since, stdout: '', stderr: '', error: 'no such container' }
      if (result.exitCode !== 0)
        throw new Error(result.stderr?.trim() || `docker logs exited ${result.exitCode}`)

      return { running: true, tail: lines, since, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },

    async stop({ appId }) {
      const name = `fjs-${appId}`
      const result = await run(['docker', 'rm', '-f', name])
      // A `_replaced` left by a swap that never finished goes too: kept, the
      // app's next release would bring it back as the last good container of
      // an app somebody removed, and it holds the data volume in the meantime.
      await run(['docker', 'rm', '-f', `${name}_replaced`])
      // Not an error: a first deploy has no previous container, and Basecamp
      // treats this step as non-fatal for exactly that reason.
      return { stopped: result.exitCode === 0 }
    },

    /**
     * Refill the firewall's exposed set from the containers that declare a
     * port, whole and in one nft transaction, so a port an app stopped
     * declaring leaves with the next sync. Stopped containers count: after a
     * reboot the firewall unit reloads an empty set before Docker has restarted
     * anything, and an exposed app would stay dropped until its next release.
     * A `_replaced` is never served, so its port does not count.
     *
     * A machine with no basecamp table answers `synced: false` rather than
     * throwing: nothing there drops a forwarded port, and the posture report
     * grades that. A failure fails closed, since a port missing from the set
     * is dropped.
     */
    async syncExposed() {
      const listed = await run(['docker', 'ps', '-a', '--filter', `label=${EXPOSED_LABEL}`, '--format', `{{.Names}} {{.Label "${EXPOSED_LABEL}"}}`])
      if (listed.exitCode !== 0) throw new Error(`docker ps failed (exit ${listed.exitCode}): ${(listed.stderr ?? '').trim()}`)
      const ports = [...new Set(String(listed.stdout ?? '').split('\n')
        .map(line => line.trim().split(/\s+/))
        .filter(([name]) => name && !name.endsWith('_replaced'))
        .map(([, port]) => Number(port))
        .filter(port => Number.isInteger(port) && port > 0 && port < 65536))].sort((a, b) => a - b)

      const fill   = ports.length ? ` ; add element ${EXPOSED_SET} { ${ports.join(', ')} }` : ''
      const result = await run(['nft', `flush set ${EXPOSED_SET}${fill}`])
        .catch(err => { if (err?.code === 'ENOENT') return null; throw err })
      if (!result || (result.exitCode !== 0 && /No such file or directory/i.test(result.stderr ?? '')))
        return { synced: false, exposed: ports, reason: 'no basecamp firewall on this machine' }
      if (result.exitCode !== 0) throw new Error(`nft failed (exit ${result.exitCode}): ${(result.stderr ?? '').trim()}`)
      return { synced: true, exposed: ports }
    },

    published,
    healthCheck,

    /** An operator's script, run as this process's user. There is no sandbox
     *  and Basecamp says so on the screen that submits one. */
    async exec({ command, timeoutSeconds }) {
      if (!command) throw new Error('exec needs a command')
      // `timeout_s` is the caller's number, and `0` or `null` from a Job saved
      // that way must not reach `run` as "never kill" (`FJS-1857`).
      if (!(timeoutSeconds > 0)) timeoutSeconds = 300
      const result = await run(['sh', '-c', command], { timeoutMs: timeoutSeconds * 1_000 })
      return { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    },
  }
}

/*
 * ─── posture ─────────────────────────────────────────────────────────────────
 *
 * What the machine's defenses look like, as FACTS: Basecamp grades them against
 * what it knows the box should run (`IDEAS/server-posture.md`), so a verdict
 * here would be a second owner of that and a stale one until this is upgraded.
 *
 * A reading whose command fails is `null` — unknown, which is neither absent
 * nor passing. Every key is always present, and one tool missing from the box
 * must cost its own reading and nothing else.
 *
 * The argv here is the table `test/fixtures/posture/capture.mjs` records, and
 * the replay test refuses any argv the capture does not hold, so the two move
 * together.
 */

const UNATTENDED_LOG = '/var/log/unattended-upgrades/unattended-upgrades.log'

const POSTURE = {
  os:              ['cat', '/etc/os-release'],
  kernelRunning:   ['uname', '-r'],
  // The status column, because `-W` also lists every kernel removed with its
  // config left behind (`rc`), which outnumber the installed ones by fifty.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query's own format language, not a JavaScript placeholder
  kernelInstalled: ['dpkg-query', '-W', '-f', '${db:Status-Abbrev} ${Package}\n', 'linux-image-[0-9]*'],
  rebootRequired:  ['stat', '-c', '%Y', '/var/run/reboot-required'],
  rebootPkgs:      ['cat', '/var/run/reboot-required.pkgs'],
  aptPending:      ['apt-get', '-s', '-o', 'Debug::NoLocking=1', 'upgrade'],
  aptPeriodic:     ['apt-config', 'dump', 'APT::Periodic'],
  aptTimer:        ['systemctl', 'is-enabled', 'apt-daily-upgrade.timer'],
  aptLastRun:      ['stat', '-c', '%Y', UNATTENDED_LOG],
  dockerVersion:   ['docker', 'version', '--format', 'json'],
  caddyVersion:    ['caddy', 'version'],
  bunVersion:      ['bun', '--version'],
  listening:       ['ss', '-tlnpH'],
  containers:      ['docker', 'ps', '--format', 'json'],
  ruleset:         ['nft', '-j', 'list', 'ruleset'],
  sshd:            ['sshd', '-T'],
  rootKeys:        ['ssh-keygen', '-lf', '/root/.ssh/authorized_keys'],
  uid0:            ['awk', '-F:', '$3 == 0 { print $1 }', '/etc/passwd'],
  nopasswd:        ['grep', '-rh', 'NOPASSWD', '/etc/sudoers', '/etc/sudoers.d'],
  timeSync:        ['timedatectl', 'show'],
  timeTracking:    ['chronyc', '-c', 'tracking'],
  unitJson:        ['systemd-analyze', 'security', 'outpost', '--json=short'],
  containerIds:    ['docker', 'ps', '-q'],
  files:           ['stat', '-c', '%a %U %G %n', '/etc/basecamp', '/etc/basecamp/outpost.key', '/etc/basecamp/outpost.env'],
  cert:            ['openssl', 'x509', '-enddate', '-noout', '-in', '/etc/basecamp/outpost.crt'],
}
// systemd 249 refuses `--json`, and the text form's last line carries the
// overall score on every version. Asked only when the JSON gave none.
const UNIT_TEXT = ['systemd-analyze', 'security', '--no-pager', 'outpost']
// Privileged and the socket mount and nothing else: `docker inspect` whole
// carries every container's environment, secrets included, into this report.
const INSPECT   = ['docker', 'inspect', '--format', '{{json .Name}} {{json .HostConfig.Privileged}} {{json .Mounts}}']

// A reading is slow-moving and asked every few hours; a wedged `apt-get` must
// not hold the report for the runner's ten-minute default.
const POSTURE_TIMEOUT_MS = 60_000

const ok      = r => r?.exitCode === 0
const lines   = text => String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean)
const unbrace = ip => ip.replace(/^\[(.*)\]$/, '$1')
const epoch   = text => {
  const n = Number(String(text ?? '').trim())
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}
// The file is not there, said by the command that looked — a fact, where a
// refusal is unknown. A spawn that never ran has a null exit and says nothing,
// so ENOENT for the BINARY is never read as the file being absent.
const absent  = r => r?.exitCode != null && r.exitCode !== 0 && /No such file/i.test(r.stderr ?? '')

function readOs(r) {
  if (!ok(r)) return null
  const v = {}
  for (const line of lines(r.stdout)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line)
    if (m) v[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return { id: v.ID ?? null, version: v.VERSION_ID ?? null, codename: v.VERSION_CODENAME ?? v.UBUNTU_CODENAME ?? null }
}

function readKernel(running, installed) {
  const now = ok(running) ? running.stdout.trim() : ''
  if (!now) return null
  return {
    running:   now,
    installed: ok(installed)
      ? lines(installed.stdout).filter(l => /^ii\s/.test(l)).map(l => l.split(/\s+/).pop().replace(/^linux-image-/, ''))
      : null,
  }
}

function readReboot(stat, pkgs) {
  if (ok(stat))     return { required: true, since: epoch(stat.stdout), pkgs: ok(pkgs) ? lines(pkgs.stdout) : [] }
  if (absent(stat)) return { required: false, since: null, pkgs: [] }
  return null
}

function readUpdates(r) {
  if (!ok(r)) return null
  const inst = lines(r.stdout).filter(l => l.startsWith('Inst '))
  // The origin is the first parenthesis: `Inst pkg [old] (new Ubuntu:24.04/noble-security [amd64])`,
  // comma-joined when a version is in several pockets.
  const security = inst.filter(l => /-security\b/.test(/\(([^)]*)\)/.exec(l)?.[1] ?? ''))
  return { pending: inst.length, security: security.length }
}

function readAutoUpdates(periodic, timer, lastRun) {
  if (!ok(periodic)) return null
  // `is-enabled` exits non-zero for `disabled`, which is still an answer; no
  // output at all is the question going unasked.
  const state = timer?.exitCode == null ? '' : String(timer.stdout ?? '').trim()
  if (!state) return null
  const days = /^APT::Periodic::Unattended-Upgrade\s+"([^"]*)";/m.exec(periodic.stdout)?.[1]
  return {
    enabled:  Number(days) > 0 && state === 'enabled',
    last_run: ok(lastRun) ? epoch(lastRun.stdout) : null,
  }
}

function readVersions(docker, caddy, bun) {
  let server = null
  // `docker version` exits 1 with the daemon down and still prints the client
  // half, whose version is not the one running containers.
  try { server = JSON.parse(docker?.stdout ?? '')?.Server?.Version ?? null } catch {}
  const first = r => ok(r) ? (r.stdout.trim().split(/\s+/)[0]?.replace(/^v/, '') || null) : null
  return { docker: server, caddy: first(caddy), bun: first(bun) }
}

function readListening(r) {
  if (!ok(r)) return null
  return lines(r.stdout).map(line => {
    const local = line.split(/\s+/)[3] ?? ''
    const at    = local.lastIndexOf(':')
    let address = unbrace(local.slice(0, at)).replace(/%.*$/, '')
    // `*` is ss for an IPv6 wildcard socket that also takes IPv4 — every
    // interface, both families. A v6-only one prints `[::]`.
    if (address === '*') address = '::'
    return { address, port: Number(local.slice(at + 1)), process: /users:\(\("([^"]+)"/.exec(line)?.[1] ?? null }
  }).filter(s => s.address && Number.isInteger(s.port))
}

/** `docker ps`'s Ports column is a human string —
 *  `0.0.0.0:8090->80/tcp, [::]:8090->80/tcp` — and the IPv6 half is the same
 *  app public a second time. `80/tcp` with no arrow is exposed and published
 *  nowhere. */
function parsePorts(text) {
  const out = []
  for (const part of String(text ?? '').split(',').map(s => s.trim())) {
    const m = /^(.*):(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/(\w+)$/.exec(part)
    if (!m) continue
    const [, ip, lo, hi = lo, container, proto] = m
    for (let i = 0; i <= Number(hi) - Number(lo); i++)
      out.push({ host_ip: unbrace(ip), host_port: Number(lo) + i, container_port: Number(container) + i, proto })
  }
  return out
}

function readContainers(r) {
  if (!ok(r)) return null
  return lines(r.stdout).map(line => JSON.parse(line)).map(c => ({ name: c.Names, published: parsePorts(c.Ports) }))
}

function readFirewall(ruleset) {
  if (!ok(ruleset)) return null
  const entries = JSON.parse(ruleset.stdout).nftables ?? []
  const chains  = entries.map(e => e.chain).filter(c =>
    c?.hook === 'input' && (c.type ?? 'filter') === 'filter' && (c.family === 'inet' || c.family === 'ip'))
  // Every base chain on the hook sees the packet, so one dropping by default
  // is the box dropping by default, whatever an `accept` beside it says.
  const input_policy = !chains.length ? null : chains.some(c => c.policy === 'drop') ? 'drop' : 'accept'

  // A published port is forwarded, so the input policy never reaches it. The
  // install's forward chain drops a DNAT'd connection unless its host port is
  // in the exposed set; a box without that rule lets every published port
  // through, whatever the set holds.
  const ours    = e => e?.family === 'inet' && e.table === 'basecamp'
  const forward = entries.map(e => e.chain).find(c => ours(c) && c.hook === 'forward')
  const dnatDrop = expr => expr?.length === 2 && expr[0]?.match?.left?.ct?.key === 'status'
    && expr[0].match.right === 'dnat' && expr[1] && 'drop' in expr[1]
  const forward_drop = Boolean(forward) && entries.some(e => ours(e.rule) && e.rule.chain === forward.name && dnatDrop(e.rule.expr))
  const set     = entries.map(e => e.set).find(s => ours(s) && s.name === 'exposed')
  const exposed = (set?.elem ?? []).filter(Number.isInteger).sort((a, b) => a - b)
  return { input_policy, forward_drop, exposed }
}

function readSsh(r) {
  if (!ok(r)) return null
  const v = {}
  for (const line of lines(r.stdout)) {
    const at = line.indexOf(' ')
    if (at > 0) v[line.slice(0, at).toLowerCase()] ??= line.slice(at + 1).trim()
  }
  return {
    password_authentication: v.passwordauthentication ?? null,
    permit_root_login:       v.permitrootlogin ?? null,
    pubkey_authentication:   v.pubkeyauthentication ?? null,
    max_auth_tries:          v.maxauthtries != null ? Number(v.maxauthtries) : null,
  }
}

function readKeys(r, user) {
  if (absent(r)) return []
  if (!ok(r)) return null
  return lines(r.stdout).map(line => {
    const m = /^(\d+)\s+(\S+)\s+(.*?)\s*\(([^)]+)\)$/.exec(line)
    return m && { user, type: m[4], bits: Number(m[1]), fingerprint: m[2], comment: m[3] }
  }).filter(Boolean)
}

function readNopasswd(r) {
  // grep exits 1 for no match, which is the answer; 2 is a file it could not read.
  if (r?.exitCode === 1) return []
  if (!ok(r)) return null
  return lines(r.stdout).filter(l => !l.startsWith('#'))
}

function readTime(sync, tracking) {
  if (!ok(sync)) return null
  // `chronyc -c tracking`, field 5: the system clock's offset in seconds.
  const offset = ok(tracking) ? Number(tracking.stdout.trim().split(',')[4]) : NaN
  return { synced: /^NTPSynchronized=yes$/m.test(sync.stdout), offset_s: Number.isFinite(offset) ? offset : null }
}

function unitFromJson(r) {
  if (!ok(r)) return null
  let rows = null
  try { rows = JSON.parse(r.stdout) } catch { return null }
  // Only the overview table names a unit; the per-unit table is its settings.
  const row = Array.isArray(rows) ? rows.find(x => /^outpost(\.service)?$/.test(x?.unit ?? '')) : null
  const exposure = Number(row?.exposure)
  return row && Number.isFinite(exposure) ? { exposure, predicate: row.predicate ?? null } : null
}

function unitFromText(r) {
  if (!ok(r)) return null
  const m = /Overall exposure level for \S+:\s*([\d.]+)\s+([A-Z]+)/.exec(stripVTControlCharacters(r.stdout))
  return m ? { exposure: Number(m[1]), predicate: m[2] } : null
}

function readInspect(r) {
  if (!ok(r)) return null
  return lines(r.stdout).map(line => {
    const m = /^("(?:[^"\\]|\\.)*")\s+(true|false)\s+(.*)$/.exec(line)
    if (!m) return null
    const sock = p => /(^|\/)docker\.sock$/.test(p ?? '')
    return {
      name:        JSON.parse(m[1]).replace(/^\//, ''),
      privileged:  m[2] === 'true',
      docker_sock: (JSON.parse(m[3]) ?? []).some(x => sock(x.Source) || sock(x.Destination)),
    }
  }).filter(Boolean)
}

function readFiles(r) {
  if (!ok(r)) return null
  return lines(r.stdout).map(line => {
    const [mode, owner, group, ...path] = line.split(' ')
    return { path: path.join(' '), mode, owner, group }
  })
}

function readCert(r) {
  if (!ok(r)) return null
  const m = /notAfter=(.+)/.exec(r.stdout)
  const at = m ? new Date(m[1].trim()) : null
  return at && !Number.isNaN(at.getTime()) ? { expires_at: at.toISOString() } : null
}

/*
 * ─── What the machine has on it ──────────────────────────────────────────────
 *
 * Two questions basecamp asks and one it is told: the volume list and the disk
 * picture are PUSHED here on a timer (`volumes.report`, `cleanup.report`),
 * because a control plane polling fifty machines is fifty requests a minute for
 * data that changes hourly. `/system/prune` and the volume routes are the pull
 * direction — an operator pressing a button.
 *
 * The shapes are basecamp's, snake_case, and they are the same shapes the
 * services already parse: `volumes.report` reads `name/driver/mountpoint/
 * size_bytes/in_use/containers`, and `cleanup.report` reads three groups of
 * byte counts. They are wire contracts, not model fields.
 */

export function createInspector({ run = spawnRun } = {}) {
  const json = async (argv) => {
    const { exitCode, stdout } = await run(argv)
    if (exitCode !== 0) return []
    // `--format json` answers one object per LINE, not an array — except
    // `volume inspect`, which answers an array on one line. Flattened, or the
    // caller holds the array and reads `.Mountpoint` off it as undefined.
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean).flat()
  }

  const bytes = (value) => {
    // Docker's own human sizes — `4.13GB`, `927MB`, `12.3kB`, `0B`. Parsed
    // rather than asked for in bytes because `docker system df` has no byte
    // mode, and they are DECIMAL: a real daemon prints 13,808,647,133 bytes as
    // `13.81GB`, which a 1024 scale reads 7% large.
    const m = /^([\d.]+)\s*([KMGTP]?)B?$/i.exec(String(value ?? '').trim())
    if (!m) return 0
    const scale = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }
    return Math.round(Number(m[1]) * (scale[m[2].toUpperCase()] ?? 1))
  }

  return {
    async volumes() {
      const rows = await json(['docker', 'volume', 'ls', '--format', 'json'])
      // `volume ls` answers `Size: "N/A"` — it never computes one, so reading
      // it reported every volume as empty. `system df -v` is the command that
      // walks them, and one call answers every volume.
      const [usage] = await json(['docker', 'system', 'df', '-v', '--format', 'json'])
      const sizeOf  = new Map((usage?.Volumes ?? []).map(v => [v.Name, bytes(v.Size)]))
      const out  = []
      for (const row of rows) {
        const name = row.Name
        if (!name) continue
        const [detail] = await json(['docker', 'volume', 'inspect', name, '--format', 'json'])
        // Which containers hold it. A volume in use must never be reported as
        // free: basecamp's refusal to delete one NAMES them, and a wrong answer
        // here is how somebody deletes a database.
        const { stdout: users } = await run([
          'docker', 'ps', '-a', '--filter', `volume=${name}`, '--format', '{{.Names}}',
        ])
        const containers = users.trim().split('\n').filter(Boolean)
        out.push({
          name,
          driver:      detail?.Driver ?? row.Driver ?? 'local',
          mountpoint:  detail?.Mountpoint ?? null,
          size_bytes:  sizeOf.get(name) ?? bytes(row.Size),
          in_use:      containers.length > 0,
          containers,
          created_at:  detail?.CreatedAt ?? null,
        })
      }
      return out
    },

    async disk() {
      const rows = await json(['docker', 'system', 'df', '--format', 'json'])
      const by   = type => rows.find(r => (r.Type ?? '').toLowerCase().startsWith(type)) ?? {}
      const images = by('image'), containers = by('container'), cache = by('build')
      return {
        images: {
          total:             Number(images.TotalCount ?? 0),
          unused:            Number(images.TotalCount ?? 0) - Number(images.Active ?? 0),
          dangling:          0,
          size_bytes:        bytes(images.Size),
          reclaimable_bytes: bytes(String(images.Reclaimable ?? '').split(' ')[0]),
        },
        containers: {
          running:           Number(containers.Active ?? 0),
          stopped:           Number(containers.TotalCount ?? 0) - Number(containers.Active ?? 0),
          reclaimable_bytes: bytes(String(containers.Reclaimable ?? '').split(' ')[0]),
        },
        build_cache: {
          size_bytes:        bytes(cache.Size),
          reclaimable_bytes: bytes(String(cache.Reclaimable ?? '').split(' ')[0]),
        },
      }
    },

    /** A reclaim sweep. Answers what it FREED and what it removed, and
     *  basecamp forgets exactly the volumes named here — never the ones it
     *  asked about, because a partial sweep leaves the rest on disk. */
    async prune({ targets = [], keepImages = 0 } = {}) {
      const removed = { images: 0, containers: 0, build_cache_bytes: 0 }
      let freed = 0
      const volumes = []

      const sweep = async (argv) => {
        const { exitCode, stdout } = await run(argv)
        if (exitCode !== 0) return ''
        const m = /Total reclaimed space:\s*(.+)$/im.exec(stdout)
        if (m) freed += bytes(m[1])
        return stdout
      }

      if (targets.includes('stopped_containers')) {
        const out = await sweep(['docker', 'container', 'prune', '-f'])
        removed.containers = (out.match(/^[0-9a-f]{12,}$/gm) ?? []).length
      }
      if (targets.includes('dangling_images') || targets.includes('unused_images')) {
        const argv = ['docker', 'image', 'prune', '-f']
        if (targets.includes('unused_images')) argv.push('-a')
        const out = await sweep(argv)
        removed.images = (out.match(/^deleted:/gim) ?? []).length
      }
      if (targets.includes('build_cache')) {
        const before = freed
        await sweep(['docker', 'builder', 'prune', '-f'])
        removed.build_cache_bytes = freed - before
      }
      if (targets.includes('unused_volumes')) {
        // `volume prune` takes no `--format`: asked for one it exits 125 having
        // removed nothing. The names are the block under `Deleted Volumes:`,
        // ended by the blank line before the total.
        const out = await sweep(['docker', 'volume', 'prune', '-f'])
        const block = /(?:^|\n)Deleted Volumes:\n([\s\S]*?)(?:\n\s*\n|$)/.exec(out)
        if (block) volumes.push(...block[1].split('\n').map(s => s.trim()).filter(Boolean))
      }

      return { freed_bytes: freed, removed, volumes }
    },

    async removeVolume(name) {
      const { exitCode, stderr } = await run(['docker', 'volume', 'rm', name])
      if (exitCode !== 0) throw new Error(stderr.trim() || `could not remove volume '${name}'`)
      return { removed: [name] }
    },

    async pruneVolumes(names = []) {
      const removed = []
      for (const name of names) {
        const { exitCode } = await run(['docker', 'volume', 'rm', name])
        // Exactly what was removed. A volume still held by a container fails
        // here and must not appear in the answer, or basecamp forgets a row for
        // a disk that is still full.
        if (exitCode === 0) removed.push(name)
      }
      return { removed }
    },

    /** The box's defenses, read and not graded — see § posture above. */
    async posture() {
      // Bun.spawn THROWS on a missing binary rather than exiting 127, so an
      // uncaught one is a box without caddy failing the whole report.
      const read = async (argv) => {
        try { return await run(argv, { timeoutMs: POSTURE_TIMEOUT_MS }) }
        catch { return { exitCode: null, stdout: '', stderr: '' } }
      }
      // A parser surprised by what a machine printed is unknown, the same as
      // a command that failed.
      const guard = async (fn) => { try { return (await fn()) ?? null } catch { return null } }

      const keys = Object.keys(POSTURE)
      const r    = Object.fromEntries(await Promise.all(keys.map(async k => [k, await read(POSTURE[k])])))

      const readings = {
        os:           await guard(() => readOs(r.os)),
        kernel:       await guard(() => readKernel(r.kernelRunning, r.kernelInstalled)),
        reboot:       await guard(() => readReboot(r.rebootRequired, r.rebootPkgs)),
        updates:      await guard(() => readUpdates(r.aptPending)),
        auto_updates: await guard(() => readAutoUpdates(r.aptPeriodic, r.aptTimer, r.aptLastRun)),
        versions:     await guard(() => readVersions(r.dockerVersion, r.caddyVersion, r.bunVersion)),
        listening:    await guard(() => readListening(r.listening)),
        containers:   await guard(() => readContainers(r.containers)),
        firewall:     await guard(() => readFirewall(r.ruleset)),
        ssh:          await guard(() => readSsh(r.sshd)),
        ssh_keys:     await guard(() => readKeys(r.rootKeys, 'root')),
        uid0:         await guard(() => ok(r.uid0) ? lines(r.uid0.stdout) : null),
        nopasswd:     await guard(() => readNopasswd(r.nopasswd)),
        time:         await guard(() => readTime(r.timeSync, r.timeTracking)),
        outpost_unit: await guard(async () => unitFromJson(r.unitJson) ?? unitFromText(await read(UNIT_TEXT))),
        privileged:   await guard(async () => {
          if (!ok(r.containerIds)) return null
          const ids = lines(r.containerIds.stdout)
          return ids.length ? readInspect(await read([...INSPECT, ...ids])) : []
        }),
        files:        await guard(() => readFiles(r.files)),
        cert:         await guard(() => readCert(r.cert)),
      }
      // Each version is its own unknown, so the group is never null as a whole.
      readings.versions ??= { docker: null, caddy: null, bun: null }

      return { at: new Date().toISOString(), readings }
    },
  }
}
