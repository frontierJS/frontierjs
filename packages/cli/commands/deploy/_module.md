---
namespace: deploy
description: Deploy FrontierJS apps to a server via SSH + Docker + Caddy
defaults:
  flags:
    server:
      type: string
      description: "An ssh destination for this run: an alias from ~/.ssh/config, or user@host. Replaces every configured server and user"
      defaultValue: ''
    domain:
      type: string
      description: "The web hostname for this run. Replaces deploy.web.domain"
      defaultValue: ''
---

<script>
const { loadFrontierConfig, dockerfileScripts } = await import(new URL('file://' + global.fliRoot + '/core/utils.js'))
const { vendorApp, linkedDeps, GENERATED_DIR } = await import(new URL('file://' + global.fliRoot + '/core/vendor.js'))
const { createMachine, shQuote } = await import(new URL('file://' + global.fliRoot + '/core/machine.js'))
const { dockerLogArgs } = await import(new URL('file://' + global.fliRoot + '/core/docker-logging.js'))
const { apiContainerName } = await import(new URL('file://' + global.fliRoot + '/core/ports.js'))
const { appUser, appUserIds } = await import(new URL('file://' + global.fliRoot + '/core/deploy-image.js'))
const { EDGE_HOPS, edgeNames: edgeNamesOf } = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
const { crossOrigins } = await import(new URL('file://' + global.fliRoot + '/core/shell-origins.js'))
const { installOutpost, SUDO } = await import(new URL('file://' + global.fliRoot + '/core/basecamp.js'))

// The origins the API admits besides its own, for `swapContainer`'s
// `corsOrigins`. Asked by the forward swap and the revert alike, so a revert
// does not restart the container without the list the deploy gave it.
const derivedOrigins = ($, deployConf) => crossOrigins(edgeNamesOf(deployConf), $.paths.root)

// The container this deploy's API runs in. One reading of the name, shared by
// the pipeline and by every standalone command that has to find it again —
// `deploy:logs`, `deploy:status`, `deploy:run`, the revert and the rollback.
// Nine hand-written copies is how the name came to ignore the port tier.
const apiContainer = (appId, deployConf) => apiContainerName(appId, deployConf?.api?.port)

// The API's database directory, env file and secrets directory on the target.
// The swap mounts them, setup creates them, and the box's Outpost grades their
// modes, so a default restated in one step would grade a different path from the
// one mounted.
const apiFiles = (deployConf, serverPath) => ({
  dbDir:      deployConf?.db?.path ?? `${serverPath}/db`,
  envFile:    deployConf?.api?.env ?? `${serverPath}/.env.production`,
  secretsDir: `${serverPath}/secrets`,
})

// The `--user` an app's container starts with: its own user on a box
// (`FJS-D1484`), made by `deploy:setup`, and nothing on localhost, where the
// image's user runs. Asked before any container is touched, so a box set up
// before the user existed is refused while the running release still serves.
const runAs = (machine, appId) => {
  if (machine.local) return []
  const user = appUser(appId)
  const ids  = String(machine.capture(appUserIds(user)) ?? '').trim()
  if (!/^\d+:\d+$/.test(ids)) throw new Error(
    `${user} is not a user on this box, so the API has no uid of its own to run as -- run fli deploy:setup, which makes it and hands it ${appId}'s db directory, then deploy again`)
  return [`--user ${ids}`]
}

// Where the API container sees the secrets directory: Docker's own path for a
// secret, which `<KEY>_FILE` then names.
const CONTAINER_SECRETS_DIR = '/run/secrets'

// ─── secretNames ──────────────────────────────────────────────────────────────
// The keys the target's secrets directory holds, one file per key named for it.
// A name that is not an env key is left out and said, because it goes into a
// `docker run` line. A directory that exists and cannot be listed is a throw: an
// empty answer there would start the API without its keys.
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const secretNames = (machine, secretsDir, log) => {
  const out = machine.capture(`if [ -d ${secretsDir} ]; then
  ls -1A ${secretsDir} 2>/dev/null || sudo -n ls -1A ${secretsDir} 2>/dev/null || echo '?unreadable'
fi`)
  const names = String(out ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  if (names.includes('?unreadable'))
    throw new Error(`${secretsDir} exists and this login cannot list it — run the deploy as root or as a login with sudo`)
  for (const n of names.filter(n => !SECRET_NAME.test(n)))
    log.warn(`  ${secretsDir}/${n} is not named like an env key — not passed to the container`)
  return names.filter(n => SECRET_NAME.test(n))
}

// Where the API container sees the target's database directory. The only path
// inside a container that outlives a swap: a database anywhere else is in the
// container's own layer and the next deploy starts an empty one (FJS-1095).
const CONTAINER_DB_DIR = '/db'

// ─── machineFor ───────────────────────────────────────────────────────────────
// The one way a step reaches the box. Every command a deploy runs goes through
// `machine.run(script)`, which pipes the script to `sh -s` there — see
// `core/machine.js` for what that replaced and why it is not negotiable.
//
// `deploy.transport` is the escape hatch and is read here rather than in the
// module, so the whole pipeline agrees about one machine per host.
const machineFor = ($, host, path = null, transport = null) => createMachine({
  host, path,
  exec:      $.exec,
  transport: transport ?? $.config?.deployConf?.transport ?? null,
})

// ─── enrollOutpost ────────────────────────────────────────────────────────────
// The API's box joined to the app's own fleet (`FJS-D1191`), for a deploy block
// saying `outpost: true`. Two callers: `08b-outpost` after a release, and
// `deploy:outpost` alone, which `fli basecamp:install` runs once `/setup` has
// made the workspace — the deploy step meets an empty database on a fresh box
// and answers `skip`.
//
// The app's `api/src/domain/host/enroll-host.ts`, run in the serving container, finds or
// makes the host's Server row and mints its token; the install command it
// answers runs on the host. Then, installed now or enrolled before, the box's
// `outpost.env` names the database directory, the env file and the
// ENCRYPTION_KEY this deploy mounts, which `hub.db-mode` and `hub.env-mode`
// grade (`FJS-D1241`). An enrolled box never reruns `install.sh`, so this is the
// one place they are written, and the Outpost restarts only when a line changed.
//
// Every failure warns: a release is live by now. Answers
// `{ outcome: 'installed' | 'enrolled' | 'skip' | 'failed', reason? }`.
const enrollOutpost = (machine, { appId, deployConf, path, host, log }) => {
  // The script's last stdout line is its whole answer. A failed exec carries it
  // in the error's stdout, and an image older than the script answers nothing.
  const lastJson = (out) => {
    try { return JSON.parse(String(out ?? '').trim().split('\n').pop()) } catch { return null }
  }

  // The address this ssh session reached the box at is the third field sshd
  // sets, and the only one a self box has: no vendor reports it, and a Server
  // row with none is a machine no ingress record can name (`FJS-3515`).
  const enroll = [
    `IP=$(printf '%s' "$SSH_CONNECTION" | cut -d' ' -f3)`,
    `docker exec ${apiContainer(appId, deployConf)} bun api/src/domain/host/enroll-host.ts "{\\"ip\\":\\"$IP\\"}"`,
  ].join('\n')

  let answer
  try {
    answer = lastJson(machine.capture(enroll))
  } catch (err) {
    answer = lastJson(err.stdout) ?? { error: err.message.split('\n')[0] }
  }

  let result
  if (!answer) {
    log.warn('Outpost not enrolled: api/src/domain/host/enroll-host.ts answered nothing — pass --no-outpost to stop trying')
    return { outcome: 'failed', reason: 'enroll-host.ts answered nothing' }
  }
  if (answer.error) { log.warn(`Outpost not enrolled: ${answer.error}`); return { outcome: 'failed', reason: answer.error } }
  if (answer.skip)  { log.info(`Outpost not enrolled: ${answer.skip}`);  return { outcome: 'skip', reason: answer.skip } }
  if (answer.enrolled) {
    log.info('Outpost: this box is in the fleet already')
    result = { outcome: 'enrolled' }
  } else {
    result = installOutpost(machine, answer.command, { host, log })
    if (result.outcome === 'failed') return result
  }

  const files = apiFiles(deployConf, path)
  const sq    = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`
  const lines = [
    `OUTPOST_HOST_DB_PATH=${files.dbDir}`,
    `OUTPOST_HOST_ENV_PATH=${files.envFile}`,
    `OUTPOST_HOST_KEY_PATH=${files.secretsDir}/ENCRYPTION_KEY`,
  ]
  // basecamp-litestream.service writes only the app volumes, so the hub's own
  // replica (the Outpost's `host` entry) needs this directory too; ProtectHome
  // hides a /home or /root one entirely and read-only is what a ReadWritePaths
  // under it can lift. Written before the `unchanged` exit: a box enrolled
  // after its first deploy has the lines and not the drop-in.
  const dropIn = ['[Service]', `ReadWritePaths=${files.dbDir}`,
    ...(/^\/(home|root)(\/|$)/.test(files.dbDir) ? ['ProtectHome=read-only'] : [])]
  // Prints `unchanged`, `written` or `no-env` last; the lines are always
  // written in this order, so the grep is compared as one string.
  const script = [
    SUDO,
    'F=/etc/basecamp/outpost.env',
    'sudo test -f "$F" || { echo no-env; exit 0; }',
    'D=/etc/systemd/system/basecamp-litestream.service.d',
    'if sudo test -f /etc/systemd/system/basecamp-litestream.service; then',
    `  WANTD=$(printf '%s\\n' ${dropIn.map(sq).join(' ')})`,
    '  HAVED=$(sudo cat "$D/host.conf" 2>/dev/null || true)',
    '  if [ "$WANTD" != "$HAVED" ]; then',
    '    sudo mkdir -p "$D"',
    `    printf '%s\\n' ${dropIn.map(sq).join(' ')} | sudo tee "$D/host.conf" >/dev/null`,
    '    sudo systemctl daemon-reload',
    '    sudo systemctl try-restart basecamp-litestream.service',
    '    echo litestream-written',
    '  fi',
    'fi',
    `WANT=$(printf '%s\\n' ${lines.map(sq).join(' ')})`,
    `HAVE=$(sudo grep -E '^OUTPOST_HOST_(DB|ENV|KEY)_PATH=' "$F" || true)`,
    '[ "$WANT" = "$HAVE" ] && { echo unchanged; exit 0; }',
    `sudo sed -i -E '/^OUTPOST_HOST_(DB|ENV|KEY)_PATH=/d' "$F"`,
    `printf '%s\\n' ${lines.map(sq).join(' ')} | sudo tee -a "$F" >/dev/null`,
    'sudo systemctl restart outpost.service',
    'echo written',
  ].join('\n')
  try {
    const out  = String(machine.capture(script) ?? '').trim().split('\n')
    const said = out.at(-1)
    if (out.includes('litestream-written')) log.info(`Litestream: may now replicate ${files.dbDir}, and restarted`)
    if (said === 'written')     log.info('Outpost: told where the database and env file are, and restarted')
    else if (said === 'no-env') log.warn('Outpost: no /etc/basecamp/outpost.env on this box — /hub/security/ cannot grade its database or env file')
  } catch (err) {
    log.warn(`Outpost: the database and env file paths were not written — ${err.message.split('\n')[0]}`)
  }
  return result
}

// ─── resolveTarget ────────────────────────────────────────────────────────────
// Resolves the deploy target from flags and git branch.
// Priority: --production > --stage > branch name > dev
//
// Usage in any deploy command:
//   const target = resolveTarget(flag, $.git)
const resolveTarget = (flag, git) => {
  if (flag.production) return 'production'
  const branch = git?.branch?.() ?? ''
  if (flag.stage || ['stage', 'staging'].includes(branch)) return 'stage'
  return 'dev'
}

// ─── deployConfFor ────────────────────────────────────────────────────────────
// The deploy block as this run sees it: `frontier.config.js` § deploy, with
// `--server` and `--domain` applied. Every deploy command reads the block
// through here, so an override cannot reach one command and miss the next.
//
// `--server` is a WHOLE ssh destination — an alias, or `user@host` — and so it
// replaces every server and user the block names, per target and per side. A
// configured `user` left in place would be prefixed onto the alias, and
// `deploy@myvps` overrides the `User` line of the alias it names.
//
// The scaffold's placeholder is refused here, because nothing else would: it is
// a real domain, and `ssh your-server.com` is a connection to somebody's box.
const PLACEHOLDER_SERVER = 'your-server.com'
const ADDRESS_KEYS = ['server', 'user']

// What an unset server is told. The buy stays in `server:create` (FJS-D1612) —
// a command without `confirm: human` may not bill a cloud account on a `y` —
// so the refusal names the two commands and, with no cloud token stored, where
// one comes from.
const { CLOUDS, storedClouds } = await import(new URL('file://' + global.fliRoot + '/core/cloud.js'))
const noServerHint = (deployConf) => {
  const name  = appIdOf(deployConf) ?? '<name>'
  const lines = [`No box yet? fli server:create --name ${name} buys one, then fli deploy:setup --server ${name} --auto-install readies it`]
  if (!storedClouds().length)
    lines.push(`A cloud token first: ${Object.values(CLOUDS).map(c => `${c.key} (${c.url})`).join(' or ')}, via fli eset ME <KEY> <token>`)
  return lines
}

const deployConfFor = async ($, flag, log) => {
  const file = await loadFrontierConfig($.paths.root)
  // Every caller's refusal says "no deploy block", which sends a run from the
  // wrong directory off to write one into a root with no app in it.
  if (!file) log?.error(`No frontier.config.js in ${$.paths.root} — run this from the app's directory`)
  const loaded = file?.deploy
  if (!loaded) return null
  const deployConf = flag?.domain ? { ...loaded, web: { ...(loaded.web || {}), domain: flag.domain } } : loaded
  if (flag?.server) return withServer(deployConf, flag.server)
  if (deployConf.server === PLACEHOLDER_SERVER) {
    log?.error(`deploy.server is still the placeholder '${PLACEHOLDER_SERVER}'. Set it, or pass --server <ssh alias>`)
    const { server, ...rest } = deployConf
    return rest
  }
  return deployConf
}

const withServer = (deployConf, server) => {
  const strip = (block) => {
    if (!block || typeof block !== 'object') return block
    const out = { ...block }
    for (const k of ADDRESS_KEYS) delete out[k]
    for (const side of ['api', 'web', 'builder'])
      if (out[side] && typeof out[side] === 'object') out[side] = strip(out[side])
    return out
  }
  const out = strip(deployConf)
  for (const target of ['dev', 'stage', 'production']) if (out[target]) out[target] = strip(out[target])
  return { ...out, server }
}

// ─── sshHost ──────────────────────────────────────────────────────────────────
// What `ssh` is handed. With no user stated it is the bare server, so an alias in
// ~/.ssh/config supplies User, Port, IdentityFile and ProxyJump; a stated user
// is prefixed, and wins over the alias's own.
const sshHost = (user, server) => user ? `${user}@${server}` : server

// ─── resolveDeployConf ────────────────────────────────────────────────────────
// Extracts the resolved server/user/path for a given target from the deploy
// block, applying per-target overrides over the top-level values.
//
// Returns null if the required fields are missing — callers should check and
// set $.config.abort = true before returning.
//
// `abort` is a REFUSAL and fails the command: the runtime exits non-zero on it
// even when nothing threw, which is what stops a refusal reading as success
// (`FJS-589`). A deliberate early exit that SUCCEEDED — `--plan` prints a plan
// and stops — sets `$.config.stop` instead. Both skip every later step;
// they differ only in the outcome, and `abort` is the fail-closed default.
//
// Usage:
//   const conf = resolveDeployConf(deployConf, target)
//   if (!conf) { log.error('...'); $.config.abort = true; return }
const resolveDeployConf = (deployConf, target) => {
  if (!deployConf?.server) return null
  const targetConf = deployConf[target] ?? {}
  const server = targetConf.server ?? deployConf.server
  const user   = targetConf.user   ?? deployConf.user ?? null
  const path   = targetConf.path   ?? deployConf.path
  if (!server || !path) return null
  return { server, user, path, host: sshHost(user, server) }
}

// ─── resolveSide ──────────────────────────────────────────────────────────────
// The same resolution, per SIDE — 'api' or 'web' — so the two halves of an app
// can live on different machines. A split is the ordinary shape once the API is
// its own origin (api.myapp.com), and the transport already assumes nothing
// about co-location: the browser client takes an absolute url and /ws is
// registered beneath the router, so it never carries apiPrefix either.
//
// Most specific wins, and a side that says nothing inherits the shared value —
// so an unsplit config keeps behaving exactly as it did:
//
//   deploy[target][side]  →  deploy[side]  →  deploy[target]  →  deploy
//
// `deploy.web` already carries domain/keep_releases/ssl and `deploy.api` carries
// port/health/dockerfile, so server/user/path join blocks that exist rather than
// introducing a shape.
//
// Returns null when the side cannot be resolved; callers abort by name.
const resolveSide = (deployConf, target, side) => {
  if (!deployConf) return null
  const t     = deployConf[target] ?? {}
  const ts    = t[side] ?? {}
  const s     = deployConf[side] ?? {}
  const server = ts.server ?? s.server ?? t.server ?? deployConf.server
  const user   = ts.user   ?? s.user   ?? t.user   ?? deployConf.user ?? null
  const path   = ts.path   ?? s.path   ?? t.path   ?? deployConf.path
  if (!server || !path) return null
  return { server, user, path, host: sshHost(user, server) }
}

// ─── appIdOf ──────────────────────────────────────────────────────────────────
// `deploy.app_id`, and nothing derived. It names the container and the Release
// the journal records, so a reading taken from `path` named a different
// container than the deploy made as soon as a target overrode `path`.
const appIdOf = (deployConf) => deployConf?.app_id ?? null

// ─── deployTargetFor ──────────────────────────────────────────────────────────
// The head every deploy command opens with: the target, the deploy block as
// this run sees it, its app id, and where one side lives. `side` is 'api',
// 'web', a list tried in order, or null for the unsplit resolution.
//
// Returns null after naming the refusal and setting `$.config.abort`, so a
// caller's whole head is:
//
//   const head = await deployTargetFor($, flag, log, { side: 'api' })
//   if (!head) return
//
// `why` finishes the no-block sentence with what this command needed it for.
const deployTargetFor = async ($, flag, log, { side = null, why = '' } = {}) => {
  const refuse = (msg) => { log.error(msg); $.config.abort = true; return null }

  const target     = resolveTarget(flag, $.git)
  const deployConf = await deployConfFor($, flag, log)
  if (!deployConf)
    return refuse(`No deploy block in frontier.config.js${why ? ` — ${why}` : ''}`)
  if (!deployConf.server) {
    for (const line of noServerHint(deployConf)) log.info(line)
    return refuse('deploy.server is not set. Set it, or pass --server <ssh alias>')
  }

  const appId = appIdOf(deployConf)
  if (!appId) return refuse('deploy.app_id is not set in frontier.config.js')

  const sides    = side == null ? [null] : [].concat(side)
  const resolved = sides.map(s => s ? resolveSide(deployConf, target, s) : resolveDeployConf(deployConf, target))
                        .find(Boolean)
  if (!resolved)
    return refuse(side == null
      ? `deploy.server or deploy.path is not set for target: ${target}`
      : `Cannot resolve a server and path for the ${sides.join(' or ')} side on target: ${target}`)

  return { target, deployConf, resolved, appId }
}

// ─── litestreamStatus ─────────────────────────────────────────────────────────
// `pgrep -x litestream` answers *is a process by that name alive*, which is not
// *is a supported version replicating anything*. Three commands asked the first
// and reported the second (`FJS-243`).
//
// litestream 0.3.x cannot parse the STRICT tables litestone emits. Pointed at a
// litestone database it starts, prints `replicating to:`, and then loops forever
// on `malformed database schema … near "STRICT": syntax error` **without ever
// exiting** — so the process table says healthy, every check here agreed, and
// the replica stayed empty. Demonstrated, not theorised: v0.3.4 does exactly
// this today.
//
// The floor, the pinned build and its install are litestone's, which this
// package depends on for them: Basecamp's fleet install puts the same build on
// every machine it enrolls.
//
// `run` takes a shell script and returns its stdout as a string — pass
// `machine.capture`, so this stays a question about litestream rather than about
// how a command reaches the box.
const { LITESTREAM_MIN, litestreamInstall } = await import('@frontierjs/litestone/replicate')

const litestreamStatus = (run) => {
  const pid = (run(`pgrep -x litestream 2>/dev/null || echo ''`) ?? '').trim()
  if (!pid) return { running: false }

  const raw = (run(`litestream version 2>/dev/null || echo ''`) ?? '').trim()
  const m   = raw.match(/v?(\d+)\.(\d+)\.(\d+)/)

  // A version we cannot read is UNKNOWN, not fine. Saying so is the whole point:
  // the failure this replaces was a check that assumed.
  if (!m) return { running: true, pid, version: null, supported: null }

  const major = Number(m[1])
  const minor = Number(m[2])
  const supported =
    major > LITESTREAM_MIN.major ||
    (major === LITESTREAM_MIN.major && minor >= LITESTREAM_MIN.minor)

  return { running: true, pid, version: m[0], supported }
}

const LITESTREAM_MIN_LABEL = `v${LITESTREAM_MIN.major}.${LITESTREAM_MIN.minor}`

// ─── aptIdle ──────────────────────────────────────────────────────────────────
// A fresh droplet answers ssh while cloud-init and then unattended-upgrades are
// still running apt, one after the other, so every apt install 02-install-deps
// starts in those minutes dies on the dpkg lock — and get.docker.com's own
// apt-get with it. Waiting out cloud-init is not enough: the second holder
// starts after it. So this waits until nothing holds a lock, then leaves
// DPkg::Lock::Timeout behind so an apt-get that loses a later race waits rather
// than failing. Prints how long it waited, or nothing. No single quote, for the
// same `sudo sh -c '…'` as litestreamInstall. Without fuser it only writes the
// timeout.
const aptIdle = ({ limit = 600, step = 3, confDir = '/etc/apt/apt.conf.d' } = {}) => [
  'if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null 2>&1 || true; fi',
  'w=0',
  `while fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; do [ $w -ge ${limit} ] && { echo "apt is still busy after ${limit}s: ps -C apt-get,dpkg,unattended-upgr names who holds it" >&2; exit 1; }; sleep ${step}; w=$((w+${step})); done`,
  'if [ $w -gt 0 ]; then echo "$w"; fi',
  `if [ -d ${confDir} ]; then echo "DPkg::Lock::Timeout \\"${limit}\\";" > ${confDir}/90frontier-lock-wait; fi`,
].join('; ')

// ─── distinctHosts ────────────────────────────────────────────────────────────
// The machines a run touches, deduplicated by host AND path — the SSH check, the
// deploy lock, the ship and the cleanup are per machine, not per side, and
// the common case is one machine wearing both hats. Deduplicating on the pair
// matters: two apps sharing a host but not a path are two locks, and one app
// split across two hosts is two ships.
const distinctHosts = (sides) => {
  const seen = new Map()
  for (const side of sides) {
    if (!side) continue
    const key = `${side.host}:${side.path}`
    if (!seen.has(key)) seen.set(key, { host: side.host, path: side.path })
  }
  return [...seen.values()]
}

// ─── deployPlan ───────────────────────────────────────────────────────────────
// Phase 1d. The journal rows a transition WOULD write, built from a minted
// Release and from the REAL step list — `_steps-docker/`, read with the runner's
// own filter and sort, so a plan cannot describe a pipeline that has moved.
//
// One helper rather than two call sites, because `fli deploy --plan` and
// `fli deploy:plan` must print the same document: a plan is a thing people read
// to decide, and two implementations of it is the failure mode the whole Release
// design is arranged against.
//
// It mints rather than being handed a Release, so `--plan` needs no separate
// `release:mint` run and cannot disagree with one.
const deployPlan = async ($, flag, { target, deployConf, doApi, doWeb, digest = null }) => {
  const core = (name) => import(new URL('file://' + global.fliRoot + '/core/' + name))
  const { readdirSync, readFileSync } = await import('fs')

  const { configurationSet, schemaSurfaceHash, mintRelease, ConfigurationError } = await core('release.js')
  const { stepFilesIn, stepNameOf, planSteps, planTransition, formatPlan } = await core('deploy-plan.js')
  const { extractFrontmatter } = await core('compiler.js')

  let configuration
  try { configuration = configurationSet(deployConf, target) }
  catch (e) {
    if (!(e instanceof ConfigurationError)) throw e
    return { error: e.message }
  }

  const schema = schemaSurfaceHash($.paths.db)

  // The pivot is litestone's answer, asked rather than re-derived — the same
  // walk `fli release:check` prints. No baseline answers unknown, which counts
  // as a contract.
  let pivot = 'unknown', findings = []
  if (!schema.missing) {
    const out = $.exec({
      command: `${$.bin('litestone')} release --schema ${$.paths.db}/schema.lite --json`,
      cwd:     $.paths.root,
      stdio:   'pipe', allowFailure: true,
    })
    try {
      // Both paths in one read: on success `out` is the child's output, and on
      // a non-zero exit `allowFailure` hands back the error, which carries the
      // same bytes on `stdout`.
      const verdict = JSON.parse(String(out?.stdout ?? out ?? '').trim())
      pivot    = verdict.verdict  ?? 'unknown'
      findings = verdict.findings ?? []
    } catch {}
  }

  const release = mintRelease({
    app:           appIdOf(deployConf),
    environment:   target,
    // The bytes, where they exist. `--plan` runs no build and has none, so the
    // id it prints is provisional and says so; the deploy passes what step 04
    // produced, which is what makes the Release name an artefact at all (2.3f).
    digest:        digest ?? flag.digest ?? null,
    configurationHash: configuration.hash,
    schemaHash:    schema.hash,
    pivot,
    pivotFindings: findings,
    createdBy:     $.git.user?.() ?? null,
  })

  // The steps, off disk. `skip:` is evaluated against the same shape the runner
  // hands a predicate, so a step shown as skipped is one that will be skipped.
  const dir   = new URL('file://' + global.fliRoot + '/commands/deploy/_steps-docker').pathname
  const files = stepFilesIn(readdirSync(dir))
  const metas = files.map(f => {
    const fm = extractFrontmatter(readFileSync(`${dir}/${f}`, 'utf8')) ?? {}
    return { name: stepNameOf(f), title: fm.title, skip: fm.skip, runOnAbort: fm.runOnAbort }
  })

  // The context a skip predicate is evaluated against has to be the SHAPE the
  // runner passes — `(config.flag, config)` — so `$.flag.dry` and
  // `$.config.doApi` both resolve. Without `flag` here, `04c-journal`'s
  // predicate threw and the plan could not grade the journal step itself.
  const steps = planSteps(metas, {
    flag,
    $: { flag, config: { doApi, doWeb, deployConf, target } },
  })

  const plan = planTransition({ release, steps, actor: release.createdBy })
  return { ...plan, release, configuration, findings, schema, text: formatPlan({ ...plan, release, configuration, findings }) }
}

// ─── the deploy lock ──────────────────────────────────────────────────────────
// One lock per machine+path pair, and ONE definition of it, because a deploy and
// a revert have to be able to see each other's: two writers on one journal is
// two answers to what is serving, which is the state the whole Release design
// exists to make impossible. Two copies of this script that had drifted on the
// file name or the format would each hold a lock the other could not read.
//
// The format, the scripts and the reading of one are `core/lock.js`, where the
// tests are; this is the wiring. The lock answers *is another run working in this
// directory*; the journal answers *what state did the last run leave*. Two
// questions, not two answers to one — `FJS-D156`, which is also why nothing here
// settles a transition when a lock is dropped.
//
// The failure mode being bought off is a stranded lock: a second machine
// refusing after the first accepted must release the first, or the next deploy
// is blocked by a run that never happened.
const lockCore = () => import(new URL('file://' + global.fliRoot + '/core/lock.js'))

const releaseLocks = async ($, hosts = []) => {
  const { lockPath, releaseScript } = await lockCore()
  for (const h of hosts) {
    try { machineFor($, h.host, h.path).run(releaseScript(lockPath(h.path))) } catch {}
  }
}

const acquireLock = async ($, { hosts, target, takeover = false }) => {
  const { lockPath, acquireScript, parseLock } = await lockCore()
  const { randomUUID } = await import('crypto')

  const run = $.config.lockRun ??= {
    run:     randomUUID().slice(0, 8),
    actor:   $.config.deployConf?.actor ?? process.env.USER ?? 'unknown',
    target,
    started: new Date().toISOString(),
  }

  const locked = []
  for (const h of hosts) {
    const lockFile = lockPath(h.path)
    const machine  = machineFor($, h.host, h.path)
    try {
      const out = machine.capture(acquireScript(lockFile, run, { takeover }))
      const took = /^TOOK: (.*)$/m.exec(out)
      if (took) $.config.lockTookOver = took[1].replace(/;+$/, '').replace(/;/g, ' · ')
      locked.push(h)
    } catch (err) {
      // The refusal carries the lock's own body on STDOUT — reading the file a
      // second time is a second answer, and the run that holds it may have moved
      // on between them. `attribute` folds stderr into the message and leaves
      // stdout where it is, which is where the script wrote this.
      const stdout = String(err?.stdout ?? '')
      const body = /HELD\n([\s\S]*)/.exec(stdout)
      await releaseLocks($, locked)
      if (/^MISSING$/m.test(stdout)) return { ok: false, host: h.host, lockFile, missing: h.path }
      return { ok: false, host: h.host, lockFile, held: parseLock(body?.[1] ?? '') }
    }
  }
  $.config.lockHosts  = hosts
  // The step runner's one reader. Installed here rather than by the step, so a
  // run that never took a lock never refreshes one.
  $.config.beforeStep = (step) => refreshLock($, step)
  return { ok: true }
}

// ─── refreshLock ──────────────────────────────────────────────────────────────
// Say which step the run is inside.
//
// The step runner calls this before every step, which is the only place it can
// be called from: the build is the longest thing a deploy does and it runs
// BEFORE the journal opens (`04c-journal`), so for the window where *is this
// alive* is asked most, the journal has nothing to say. `fli` cannot heartbeat
// on a timer either — `execSync` blocks the loop for the whole of a step — so a
// step boundary is the finest grain there is.
//
// It is a fact for a person to weigh, never one anything here decides on: the
// time recorded is when a step STARTED, so a fresh one is as consistent with a
// run three seconds into a five-minute build as with one killed three seconds
// into it. What it buys is that a duration means something beside a step name —
// four minutes in `04-build-api` reads differently from four minutes in
// `06-swap`.
const refreshLock = async ($, step) => {
  const run   = $.config.lockRun
  const hosts = $.config.lockHosts
  if (!run || !hosts?.length) return

  const { lockPath, refreshScript } = await lockCore()
  const fields = { ...run, step, stepAt: new Date().toISOString() }

  for (const h of hosts) {
    try {
      const out = machineFor($, h.host, h.path).capture(refreshScript(lockPath(h.path), fields))
      if (/stolen/.test(out) && !$.config.lockStolen) {
        $.config.lockStolen = true
        $.log?.warn?.(`  The deploy lock on ${h.host} is now held by another run — this one no longer owns it.`)
      }
    } catch {}
  }
}

// ─── lockRefusal ──────────────────────────────────────────────────────────────
// What an operator reads when the lock refuses them.
//
// It reports and never judges, because the fact that would settle it — is that
// other `fli` still running — is on a machine this one cannot see. So it prints
// what is known and names both ways out, and the two are not the same choice:
// `--resume` continues what the journal is holding, which is safe because a
// succeeded step replays into a no-op and a step is claimed compare-and-set;
// `deploy:unlock` drops the lock and deploys fresh.
const lockRefusal = async (lock, { verb = 'deploy' } = {}) => {
  if (lock.missing) return [
    ['error', `${lock.missing} does not exist on ${lock.host} — this server has not been set up`],
    ['info', `    fli deploy:setup --server ${lock.host}`],
  ]
  const { describeLock } = await lockCore()
  const d = describeLock(lock.held)
  // A revert takes the same lock and cannot resume — `j.attempt` gives it an
  // attempt number and it opens a new transition either way — so pointing its
  // operator at `--resume` would be advice for a command they are not running.
  // What they can do is drop the lock, which is why `unlock` settles nothing.
  const resume = verb === 'deploy'
    ? '    fli deploy --resume    continue it — the journal knows how far it got'
    : '    fli deploy --resume    continue it, if what died was a deploy'
  return [
    ['error', `A deploy is already in progress on ${lock.host}`],
    ...d.lines.map(line => ['error', `  ${line}`]),
    ['info', ''],
    ['info', '  If that run is dead:'],
    ['info', resume],
    ['info', `    fli deploy:unlock      drop the lock and ${verb === 'deploy' ? 'start over' : verb} (${lock.lockFile})`],
  ]
}

// ─── swapContainer ────────────────────────────────────────────────────────────
// Put a named container onto a given image, keeping the one it replaced under
// `_replaced` so there is a handle to go back to.
//
// Two callers — `_steps-docker/06-swap` deploying forward and
// `_steps-revert/03-swap` going back — and it is one function because the going-
// back path is the one nobody exercises until the day it matters. A copy of this
// that had drifted would be discovered mid-incident.
//
// **Stopping `_replaced` before starting the new one is required by SQLite**, not
// a tidy-up: only one writer at a time, and the new container's entrypoint opens
// the database to migrate. That costs a 3–10s gap and it is the correct trade.
// Litestream is unaffected — it checkpoints the WAL when `_replaced` stops.
// `deployConf` is an OPTION rather than a read off `$.config`, like every
// other value here — and it was neither for as long as this function existed:
// `dockerLogArgs(deployConf)` below named a variable in no scope it can see, so
// every real deploy threw `ReferenceError: deployConf is not defined` while
// building the `docker run` line. By then the running container had been renamed
// to `_replaced` and stopped, and the new one was never started (`FJS-726`).
//
// A key in `secretsDir` is mounted read-only and passed as `<KEY>_FILE`, so
// `docker inspect` shows a path where it showed the value. The same key also in
// the env file or the configuration set is refused by the app at boot, which
// here would stop the running container and then restore it, so it is refused
// before anything is touched.
const swapContainer = ($, { host, appId, container, image, apiPort, dbPath, envFile, secretsDir = null, build, deployConf, configuration = {}, corsOrigins = [], log }) => {
  const machine  = machineFor($, host)
  const replaced = `${container}_replaced`

  const user    = runAs(machine, appId)
  const secrets = secretsDir ? secretNames(machine, secretsDir, log) : []
  if (secrets.length) {
    const inEnv = machine.capture(`for k in ${secrets.join(' ')}; do grep -qs "^$k=" ${envFile} && echo "$k"; done; true`)
    const both  = [...new Set([
      ...String(inEnv ?? '').split('\n').map(l => l.trim()).filter(k => secrets.includes(k)),
      ...secrets.filter(k => k in configuration),
    ])]
    if (both.length) throw new Error(
      `${both.join(', ')} ${both.length === 1 ? 'is' : 'are'} in ${secretsDir} and also in ${envFile} or deploy.configuration — ` +
      `the app refuses both at boot. Delete it from one of them -- ${both.map(k => `sed -i '/^${k}=/d' ${envFile}`).join('; ')} -- then deploy again`)
  }

  log.info('Renaming current container to _replaced...')
  machine.run(`if docker inspect ${container} > /dev/null 2>&1; then
  docker rename ${container} ${replaced}
fi`)

  log.info('Stopping _replaced container...')
  // `-t`, not `--time`: docker deprecated the long form in favor of `--timeout`
  // and prints a warning on every deploy, while the short form means the same
  // thing in both and is not deprecated in either.
  machine.run(`if docker inspect ${replaced} > /dev/null 2>&1; then
  docker stop -t 10 ${replaced}
fi`)

  log.info(`Starting ${image}...`)
  const runCmd = [
    'docker run -d',
    `--name ${container}`,
    '--restart unless-stopped',
    ...user,
    `-p 127.0.0.1:${apiPort}:3000`,
    `--volume ${dbPath}:${CONTAINER_DB_DIR}`,
    `--env-file ${envFile}`,
    ...(secrets.length ? [`--volume ${secretsDir}:${CONTAINER_SECRETS_DIR}:ro`] : []),
    ...secrets.map(k => `--env ${k}_FILE=${CONTAINER_SECRETS_DIR}/${k}`),
    // The Release's plain configuration values, AFTER --env-file so a declared
    // value beats a stale line in the operator's file. Nothing is written on the
    // target (FJS-D1186); secrets stay in that file and never travel this way,
    // because these show in docker inspect (FJS-D1029).
    ...Object.entries(configuration).map(([k, v]) => `--env ${k}=${shQuote(v)}`),
    // AFTER --env-file and the values above so it wins: the mapping above targets 3000 inside the
    // container, and junction binds FRONTIER_PORT_BE before anything else. A port
    // in .env.production otherwise leaves the container listening where nothing
    // forwards, which the health step then reports as a sick application.
    `--env FRONTIER_PORT_BE=3000`,
    `--env NODE_ENV=production`,
    // The proxy this deploy wrote into Caddy. Absent, every caller arrives from
    // the proxy's address and shares one rate-limit bucket, so one caller's
    // failed logins lock out the site (`FJS-1841`). A trustProxy the app
    // declares still wins.
    `--env FRONTIER_TRUST_PROXY=${EDGE_HOPS}`,
    // The web domain and a wrapped shell's schemes, which the API's cors and
    // csrf lists would otherwise each have to spell by hand (`FJS-D912`).
    ...(corsOrigins.length ? [`--env FRONTIER_CORS_ORIGINS=${shQuote(corsOrigins.join(','))}`] : []),
    // Docker's default json-file driver caps nothing, so a chatty container
    // fills the disk and the database stops writing before anybody reads a log.
    // `deploy.logs` is the escape for a daemon already pointed somewhere.
    ...dockerLogArgs(deployConf),
    // What this process states on every response, so a browser holding the
    // previous build can tell (`FJS-D160`). The same value the web build was
    // stamped with — one deploy is one build on both sides of the wire.
    ...(build ? [`--env FJS_BUILD=${build}`] : []),
    image,
  ].join(' ')

  machine.run(runCmd)
  return { container, replaced }
}

// ─── showContainerTail ────────────────────────────────────────────────────────
// Print the last lines a container wrote, when a health check has just failed.
//
// Separate from healthOrRestore because the REVERT path shares that function and
// wants this too: a revert whose health check fails is a target with no working
// release on it, which is the worst moment to be told only that a URL did not
// answer.
//
// Never throws. This runs on a path that is already failing, and a deploy that
// fell over because the log tail could not be read would be a worse bug than
// the one it was trying to explain.
const showContainerTail = (machine, container, log, lines = 40) => {
  let out = ''
  try {
    out = machine.capture(`docker logs --tail ${lines} ${container} 2>&1 || true`)
  } catch {
    return
  }
  const body = String(out ?? '').trimEnd()
  if (!body) {
    log.info(`  ${container} wrote nothing — it may have failed before the app started`)
    return
  }
  log.info('')
  log.info(`  last ${lines} lines from ${container} — the app's own words:`)
  for (const line of body.split('\n')) log.info(`  │ ${line}`)
  log.info('')
}

// ─── healthOrRestore ──────────────────────────────────────────────────────────
// Poll the health endpoint and, if it never answers, put `_replaced` back.
//
// Shared by `_steps-docker/07-health` and `_steps-revert/04-health` for the same
// reason `swapContainer` is: the restore branch is the one nobody exercises until
// the day it matters, and a revert whose own safety net had drifted from the
// deploy's would be discovered at the worst moment.
//
// A container that answers but holds a database outside CONTAINER_DB_DIR is
// put back too: it works until the next swap, which starts that database empty.
//
// Answers `{ healthy, restored, none, unbound }` and throws nothing — `none` is a
// first deploy, with no `_replaced` to put back. The caller decides
// what a failure means, because for a deploy it is a rollback and for a revert it
// is a revert that could not land.
const pauseCore = () => import(new URL('file://' + global.fliRoot + '/core/pause.js'))

const healthOrRestore = async ($, { host, container, replaced, apiPort, healthPath, log, attempts = 10, intervalS = 2 }) => {
  const machine = machineFor($, host)
  log.info(`Waiting for ${healthPath} (up to ${attempts * intervalS}s)...`)

  // Every `$` and every nested quote below is the TARGET's — the script is piped
  // to its shell rather than interpolated into a command line, which is what
  // stops `$(curl …)` running here and polling the operator's own machine.
  const healthCmd = `for i in $(seq 1 ${attempts}); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${apiPort}${healthPath} 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "ok"
    exit 0
  fi
  sleep ${intervalS}
done
echo "fail"
exit 1`

  const answers = () => { try { machine.run(healthCmd); return true } catch { return false } }

  const answered = answers()
  let unbound = []
  if (answered) {
    const { openFilesScript, unboundDatabases } = await pauseCore()
    unbound = unboundDatabases({ output: machine.capture(openFilesScript(container)), volume: CONTAINER_DB_DIR })
    if (!unbound.length) {
      log.success('Health check passed')
      return { healthy: true, restored: false, unbound }
    }
    log.error(`${container} answers ${healthPath} but has a database open outside ${CONTAINER_DB_DIR}, the one directory a swap keeps:`)
    for (const path of unbound) log.error(`  ${path}`)
    log.info(`  the next swap would start each one empty — point its path under ${CONTAINER_DB_DIR} (DATABASE_URL, AUDIT_PATH, caravan({ db }))`)
  } else {
    // Name the URL. The most common cause is not a sick app but a health path that
    // omits the app's apiPrefix — health() registers through app.get(), which
    // moves with the prefix, so an app serving /api/health polls 404 here and a
    // working release gets taken down. Without the URL in the message that reads as
    // the app's fault.
    log.error(`Health check failed after ${attempts * intervalS}s`)
    log.error(`  polled: http://localhost:${apiPort}${healthPath}`)
    log.info(`  if the API is healthy, check deploy.api.health includes your apiPrefix`)

    // ── The container's own last words ──────────────────────────────────────────
    //
    // An app that REFUSED to start says why, clearly, in its own output — an
    // attachment nobody configured, a bad encryption key, a port already taken —
    // and until this the operator saw none of it. All they got was "health check
    // failed", a rollback, and a message about apiPrefix that is wrong whenever
    // the app never came up at all. The refusal was sitting in `docker logs`,
    // where nobody looks at 3am because nothing said to.
    //
    // Tailed rather than dumped: an app that started and is merely unwell has
    // written thousands of lines, and burying the one that matters is the same
    // failure one layer along. A stopped container still answers, which is the
    // case that matters most — it is the one that exited.
    showContainerTail(machine, container, log)
  }

  const restoreCmd = `docker stop ${container} || true
docker rm   ${container} || true
if docker inspect ${replaced} > /dev/null 2>&1; then
  docker rename ${replaced} ${container}
  docker start  ${container}
  echo "restored"
else
  echo "no previous container to restore"
fi`

  let restoreOut
  try {
    restoreOut = machine.capture(restoreCmd)
  } catch (err) {
    log.error('Restore also failed: ' + err.message)
    return { healthy: false, restored: false, none: false, unbound }
  }

  // Polled, a first deploy reports a put-back that never happened and shows
  // "No such container" as that container's logs (FJS-3586).
  if (restoreOut.includes('no previous container to restore')) {
    log.info(`${container} removed — this was its first deploy here, so there was no previous release to put back`)
    return { healthy: false, restored: false, none: true, unbound }
  }

  // `docker start` returns while the app is still migrating, so a put-back
  // release is restored when it ANSWERS — the caller tells the operator the
  // previous release is serving again, and a slow machine made that a lie.
  if (!answers()) {
    log.error(`The previous container was put back and does not answer ${healthPath} either`)
    showContainerTail(machine, container, log)
    return { healthy: false, restored: false, none: false, unbound }
  }
  log.warn('Restored the previous container, and it answers')
  return { healthy: false, restored: true, none: false, unbound }
}

// ─── edgeRoutesFor / writeEdge ────────────────────────────────────────────────
// Two callers: `_steps-setup/05-caddy` writes the routes first, and
// `_steps-docker/07b-edge` rewrites them on every deploy, because the API's
// paths come off the app's surface snapshot and a service added since setup is
// a path the edge would hand the SPA.
//
// `{ routes, plain, paths }`, or `{ error }` for an EdgeError. `plain` is the
// :80 refusals for the API's paths. `paths` null means no
// snapshot, and the routes fall back to `/api/`. `html` is every page the route
// will serve, prerendered ones included, read off the target: its inline scripts
// and `style=` values are hashed into the CSP, and a page whose hash is missing
// has its theme and service worker, or that style, refused.
const edgeRoutesFor = async ({ root, appId, serverPath, apiPort, edge, html = '' }) => {
  const { edgeRoutes, plainRoutes, apiPaths, inlineScriptHashes, inlineStyleHashes, EdgeError } = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
  const { readAppSnapshot } = await import(new URL('file://' + global.fliRoot + '/core/app-entry.js'))
  const paths   = apiPaths(readAppSnapshot(root))
  const scripts = inlineScriptHashes(html)
  const styles  = inlineStyleHashes(html)
  try {
    return {
      routes: edgeRoutes({ appId, serverPath, apiPort, web: edge.web, api: edge.api, paths, scripts, styles }),
      plain:  plainRoutes({ appId, web: edge.web, api: edge.api, paths }),
      paths,
    }
  }
  catch (e) { if (e instanceof EdgeError) return { error: e.message }; throw e }
}

// Read, merge, write back with If-Match. Outpost writes to the same Caddy, so a
// write between the read and this one is a 412 and a second read, never a
// route of its lost. `ifPresent` leaves a machine whose routes setup never wrote
// alone, a Caddy that does not answer included — setup also writes the pause
// page the guard serves.
//
// Answers 'written' | 'unchanged' | 'absent', or `{ error }`.
const writeEdge = async (machine, { appId, routes, plain = [], ifPresent = false }) => {
  const { routeId, applyEdge, readConfigScript, parseConfigRead, writeConfigScript, parseConfigWrite, INGRESS_SERVER, EdgeError } =
    await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
  for (let attempt = 1; attempt <= 3; attempt++) {
    let read, next
    try {
      read = parseConfigRead(machine.capture(readConfigScript()))
      const present = (read.config?.apps?.http?.servers?.[INGRESS_SERVER]?.routes ?? []).some(r => r['@id'] === routeId(appId))
      if (ifPresent && !present) return 'absent'
      next = applyEdge(read.config, { appId, routes, plain })
    } catch (e) {
      if (!(e instanceof EdgeError)) throw e
      return ifPresent ? 'absent' : { error: e.message }
    }
    if (JSON.stringify(next) === JSON.stringify(read.config)) return 'unchanged'

    const result = parseConfigWrite(machine.capture(writeConfigScript(next, read.etag)))
    if (result.ok) return 'written'
    if (!result.stale) return { error: result.error }
  }
  return { error: 'Caddy\'s config kept changing under the write — three reads, three 412s.' }
}

// ─── connectJournal ───────────────────────────────────────────────────────────
// Copy the runner to the target and hand back a client pointed at its journal.
// Two callers — the deploy that writes one and `deploy:journal` that reads it —
// because a reader that resolved the path or shipped the runner a second way is
// a reader that can be pointed at a different file than the writer.
//
// `bun` is what the far side needs and `deploy:setup` installs it. `bun:sqlite`
// is built in, so there is nothing to resolve on a checkout that has no
// node_modules — which a deploy target does not, since the build is in Docker.
const connectJournal = async ($, { host, serverPath, deployConf }) => {
  const { journalClient, machineIdentity, MACHINE_IDENTITY } = await import(new URL('file://' + global.fliRoot + '/core/journal.js'))
  const { readFileSync }  = await import('fs')

  const runnerLocal  = new URL('file://' + global.fliRoot + '/core/journal-runner.mjs').pathname
  const runnerRemote = `${serverPath}/.fli/journal-runner.mjs`
  const dbRemote     = deployConf?.journal?.path ?? `${serverPath}/.fli/deploy.db`

  const machine = machineFor($, host, serverPath)
  machine.run(`mkdir -p ${serverPath}/.fli`)
  machine.send(runnerLocal, runnerRemote)

  // The journal is claimed by the machine, not by `host`: an ssh alias and the
  // box's reserved IP are two destinations, and one of them read as a copied disk.
  // A target that prints neither is refused by `open()`, inside each caller's catch.
  const identity = machineIdentity(machine.capture(MACHINE_IDENTITY))

  // The runner reads one JSON object on stdin, so it cannot go through
  // `machine.run` — that channel is already carrying the script. `machine.pipe`
  // is the verb for it, which is what keeps the local backend working here.
  const ddl = readFileSync(new URL('file://' + global.fliRoot + '/db/ddl.snapshot.sql').pathname, 'utf8')

  return journalClient({
    db: dbRemote, ddl, machine: identity,
    exec: (stdin) => machine.pipe(`bun ${runnerRemote}`, stdin),
  })
}

// ─── noteForJournal ───────────────────────────────────────────────────────────
// One line a step leaves for the journal, keyed by the step's own name.
//
// Keyed rather than a single slot, because since `04c-journal` the build runs
// BEFORE the journal opens: there is no `afterStep` to read an unkeyed value and
// the note is simply lost — which is exactly what a revert reads to find a
// startable image. The bag is drained by whichever reader gets there: the
// journal's open, for the steps that already ran, and `afterStep` for the rest.
const noteForJournal = ($, step, value) => {
  $.config.journalNotes ??= {}
  $.config.journalNotes[step] = typeof value === 'string' ? value : JSON.stringify(value)
}

const takeNote = ($, step) => {
  const bag = $.config.journalNotes
  if (!bag || !(step in bag)) return null
  const v = bag[step]
  delete bag[step]
  return v
}

// ─── restoreStepNote ──────────────────────────────────────────────────────────
// Put a replayed step's recorded output back onto the run.
//
// A resume skips steps that already succeeded, so their side effects on
// `$.config` never happen — and one of those side effects is load-bearing:
// `04-build-api` records which bytes it built and `06-swap` starts them. A
// resumed deploy therefore ran `docker run … undefined`.
//
// The note is JSON (`04-build-api`, `_steps-revert/03-swap`). A row an older fli
// wrote is prose and restores nothing rather than being scraped — running the
// wrong bytes is worse than refusing, and `06-swap` falls back to the tag, which
// it already says out loud.
const restoreStepNote = ($, output) => {
  if (!output) return
  let note
  try { note = JSON.parse(output) } catch { return }
  if (!note || typeof note !== 'object') return
  if (note.image) {
    $.config.imageAddress  = note.image
    $.config.imageIdentity = note.scope ? { scope: note.scope } : null
  }
}

// ─── openDeployJournal ────────────────────────────────────────────────────────
// Phase 1e. Turns the plan 1d prints into rows on the TARGET, and hands the step
// runner a recorder so the existing `_steps-docker` list becomes journal rows
// with no step file learning to write one.
//
// Everything it needs on the far side is `bun`, which `deploy:setup` installs.
// `core/journal-runner.mjs` is copied over and given JSON on stdin; every rule
// about what a deploy may do lives in `core/journal.js` on THIS machine, where
// the tests are.
//
// It refuses rather than reconciles. A journal belonging to another app or
// another host, and a precondition that moved between planning and running, both
// stop the deploy by name — the two answers were produced by two intents and
// picking one is a guess about which person was right.
const openDeployJournal = async ($, flag, opts) => {
  const core = (name) => import(new URL('file://' + global.fliRoot + '/core/' + name))
  const { JournalError, preconditionVerdict, formatDrift, resumeDecision } = await core('journal.js')
  const { planTransition } = await core('deploy-plan.js')
  const { occurrenceKey } = await import('@frontierjs/toolbelt/history')

  const { host, serverPath, log } = opts
  const plan = await deployPlan($, flag, opts)
  if (plan.error) return { error: plan.error }

  const j = await connectJournal($, opts)

  try {
    await j.open({ app: plan.release.app, host })

    // What is actually serving, which is what the plan could only guess at.
    const state  = await j.state({ app: plan.release.app, environment: plan.release.environment })

    // ── `--resume` adopts what is open rather than recomputing it ────────────
    // The Release id carries the image digest, and a local image id is not a
    // content address: an unchanged tree rebuilt without a full cache hit mints a
    // different Release, so the attempt lookup — which keys on `releaseId` —
    // missed the row it was standing on and opened a second transition every
    // time. All the resume machinery below (skip a succeeded step, replay the
    // image it recorded) was therefore unreachable in the one case it exists for
    // (`FJS-595`). Only under the flag: an ordinary deploy of genuinely different
    // bytes must still open its own transition.
    const held = flag.resume
      ? await j.live({ kind: 'deploy', app: plan.release.app, environment: plan.release.environment })
      : null

    // The Release is adopted WITH the transition. Resuming the old transition
    // against the bytes this run just built is the two halves disagreeing, and
    // `06-swap` would start an image the journal never named.
    const release = held?.release ?? plan.release
    const intent = {
      kind: 'deploy', app: release.app, environment: release.environment,
      fromReleaseId: held?.transition.fromReleaseId ?? state.serving,
      releaseId: release.id,
      generation: held?.transition.generation ?? state.generation ?? 1,
    }
    const { attempt, resume } = await j.attempt(intent)

    // Rebuilt against the real serving state and attempt number — the two terms
    // `--plan` states as provisional.
    const real = planTransition({
      release, steps: plan.steps.map((s, i) => ({ ...s, ordinal: i + 1 })),
      fromReleaseId: intent.fromReleaseId, generation: intent.generation, attempt,
      actor: release.createdBy,
    })

    const verdict = preconditionVerdict(
      { serving: state.serving, generation: intent.generation },
      { serving: state.serving, generation: state.generation ?? intent.generation })
    if (!verdict.ok) return { error: formatDrift(verdict.drift) }

    const begun = await j.begin({
      release,
      configuration: {
        app: release.app, environment: release.environment,
        generation: intent.generation, hash: release.configurationHash,
        values: plan.configuration.values, secretRefs: plan.configuration.secretRefs,
        createdBy: release.createdBy,
      },
      transition: real.transition,
      steps: real.steps,
    })

    const byName = new Map(begun.steps.map(r => [r.name, r]))
    const idFor  = (name) => occurrenceKey('deploy', real.transition.id, name)

    // The steps that already ran are marked done here, because the journal opens
    // AFTER the build now (`04c-journal`) and nothing else will ever claim them.
    // Left alone they sit `pending` forever, which reads as a pipeline that
    // stopped rather than one that had not started recording yet — the same
    // thing `_steps-revert/02-decide` does for the two steps ahead of it.
    //
    // Their PLANNED status is used rather than `succeeded`, so a step its own
    // predicate skipped is not recorded as having run.
    const self = real.steps.find(st => /journal/.test(st.name))?.ordinal ?? 0
    for (const st of real.steps) {
      if (st.ordinal >= self) continue
      // An adopted transition already recorded these steps, and its record wins
      // over what this run just did: `04-build-api` ran again before the journal
      // opened, and a rebuild that is not a full cache hit is another image.
      // Left on the run, `06-swap` started the rebuild while the transition named
      // the first build — so a revert-of-revert restored bytes that had never
      // served (`FJS-937`).
      if (byName.get(st.name)?.status !== 'pending') {
        const d = resumeDecision(byName.get(st.name))
        if (d.action === 'skip') { takeNote($, st.name); restoreStepNote($, d.output) }
        continue
      }
      // Their notes too — `04-build-api` records which bytes it built, and that
      // is what a revert reads to find a startable image.
      await j.finish({
        id:     idFor(st.name),
        status: st.status === 'skipped' ? 'skipped' : 'succeeded',
        output: takeNote($, st.name),
      })
    }

    return {
      journal: j,
      transition: real.transition,
      release,
      // A transition adopted by `--resume` IS a resume, whatever the insert did:
      // `begun.resumed` reads the OR IGNORE changes count, which is 0 for a row
      // that was already there and also 0 for nothing at all.
      resumed: begun.resumed || !!held,
      adopted: !!held && held.release.id !== plan.release.id,
      attempt,
      serving: state.serving,
      // The recorder the step runner calls. It knows step NAMES, because that is
      // what the runner has — the ordinal it is handed is the file's position and
      // the id is derived from the name, which is stable when a step is inserted.
      recorder: {
        async beforeStep(name) {
          const d = resumeDecision(byName.get(name))
          if (d.action === 'skip') {
            // A replayed step's own contribution to `$.config` never
            // happens, so what it RECORDED has to be put back. The one such
            // contribution is the image `04-build-api` built, which `06-swap`
            // starts — without this a resumed deploy ran `docker run … undefined`
            // and died, which is the resume failing in the one case it is for.
            restoreStepNote($, d.output)
            return { run: false, note: d.note }
          }
          await j.claim({ id: idFor(name) })
          return { run: true, note: d.note }
        },
        async afterStep(name, _ordinal, { status, durationMs, output } = {}) {
          // A step may leave one line for the journal, keyed by its own name.
          // Read here rather than passed through the runner, which knows nothing
          // about deploys.
          await j.finish({ id: idFor(name), status, durationMs, output: output ?? takeNote($, name) })
        },
        // Called by 09-cleanup on both paths. A deploy that aborted must leave a
        // `failed` transition and not a `running` one, or the next run reads it
        // as a crash and tries to resume something nobody started.
        async settle(status) {
          await j.settle({ id: real.transition.id, status })
        },
      },
    }
  } catch (err) {
    if (err instanceof JournalError) return { error: `deploy journal: ${err.message}` }
    throw err
  }
}

// ─── openPauseJournal ─────────────────────────────────────────────────────────
// Phase 3b. A pause is a transition, so it is recorded the way every other one
// is — and it is much smaller than a deploy's, because it mints nothing.
//
// A pause names the Release ALREADY SERVING. There are no bytes to build, no
// configuration to record and no pivot to classify: what moves is whether the bound
// Release is answering, which is the kind on the row and never a column. So
// `begin` is handed a null release and `crossesPivot` is stated false rather
// than derived, or an `unknown` pivot on the serving Release would record a
// crossing that nothing crossed.
//
// It refuses on an empty journal rather than opening one. A pause with no
// history behind it cannot name a Release, and a transition with no Release is
// not a thing this schema can hold — which is the honest answer: an app that has
// never deployed through the journal has nothing to pause.
const openPauseJournal = async ($, flag, opts) => {
  const core = (name) => import(new URL('file://' + global.fliRoot + '/core/' + name))
  const { readdirSync, readFileSync } = await import('fs')
  const { JournalError, resumeDecision } = await core('journal.js')
  const { stepFilesIn, stepNameOf, planSteps, planTransition } = await core('deploy-plan.js')
  const { extractFrontmatter } = await core('compiler.js')
  const { occurrenceKey } = await import('@frontierjs/toolbelt/history')

  const { kind, host, serverPath, deployConf, target, stepsDir, log,
          edgeHasGuard, filePresent } = opts
  const { pauseRefusals } = await core('pause.js')
  const app = appIdOf(deployConf)

  const j = await connectJournal($, opts)

  try {
    const opened = await j.open({ app, host })
    if (opened.migrated)
      log.info(`  journal migrated ${opened.migrated.from} → ${opened.migrated.to}`)

    const state = await j.state({ app, environment: target })

    // Graded BEFORE a transition is opened. A refused pause that had already
    // written a row would settle `failed`, and a journal reading *four failed
    // pauses* for four people who each typed it twice is a history of the
    // command rather than of the app.
    const held = state.serving ? await j.live({ kind: 'deploy', app, environment: target }) : null
    const refused = pauseRefusals({
      want: kind, edgeHasGuard, journalOpen: !!state.serving,
      inFlight: held ? `${held.transition.id} is still open — fli deploy --resume finishes it` : null,
      journalPaused: state.paused, filePresent,
    })
    if (refused.length) return { refused, state }

    const release = await j.release(state.serving)
    if (!release)
      return { error: `the journal names ${state.serving} as serving and holds no Release row for it` }

    // The steps, off disk, with the runner's own filter and sort — the same rule
    // `deployPlan` follows, so a pause cannot describe a pipeline that has moved.
    const dir   = new URL('file://' + global.fliRoot + '/commands/deploy/' + stepsDir).pathname
    const metas = stepFilesIn(readdirSync(dir)).map(f => {
      const fm = extractFrontmatter(readFileSync(`${dir}/${f}`, 'utf8')) ?? {}
      return { name: stepNameOf(f), title: fm.title, skip: fm.skip, runOnAbort: fm.runOnAbort }
    })
    const steps = planSteps(metas, { flag, $: $.config })

    const intent = {
      kind, app, environment: target,
      fromReleaseId: state.serving, releaseId: state.serving,
      generation: state.generation ?? 1,
    }
    const { attempt } = await j.attempt(intent)

    const real = planTransition({
      kind, release, steps,
      fromReleaseId: intent.fromReleaseId,
      generation:    intent.generation,
      attempt,
      crossesPivot:  false,
      actor:         $.git.user?.() ?? null,
    })

    const begun = await j.begin({ release: null, configuration: null, transition: real.transition, steps: real.steps })
    const byName = new Map(begun.steps.map(r => [r.name, r]))
    const idFor  = (name) => occurrenceKey(kind, real.transition.id, name)

    return {
      journal: j,
      transition: real.transition,
      state,
      attempt,
      recorder: {
        async beforeStep(name) {
          const d = resumeDecision(byName.get(name))
          if (d.action === 'skip') return { run: false, note: d.note }
          await j.claim({ id: idFor(name) })
          return { run: true, note: d.note }
        },
        async afterStep(name, _ordinal, { status, durationMs, output } = {}) {
          await j.finish({ id: idFor(name), status, durationMs, output: output ?? null })
        },
        async settle(status) {
          await j.settle({ id: real.transition.id, status })
        },
      },
    }
  } catch (err) {
    if (err instanceof JournalError) return { error: `deploy journal: ${err.message}` }
    throw err
  }
}
</script>

## Overview

The `deploy:` commands deploy FrontierJS apps to a Linux server using SSH,
Docker, and Caddy. Configuration lives in `frontier.config.js` — no external
platform required.

The server is named by `deploy.server`, or per run by `--server`, which takes an
alias from `~/.ssh/config` or `user@host` and replaces every configured server
and user. With no `user`, ssh is handed the bare name, so the alias's own User,
Port and IdentityFile apply. `--domain` is the same for `deploy.web.domain`: one
run's hostname, the config left as it is.

Caddy is the edge, run as the `caddy-api` unit and configured through its admin
API — the same front door a fleet machine has (`FJS-D564`), so the box that
Basecamp is installed on can also be enrolled. Routes carry `@id`s starting
`fli-`, and a hostname another route already names is refused.

```
fli make:deploy         ← scaffold Dockerfile, deploy config, and health endpoint

fli deploy:local        ← build + run + health check locally (no server needed)

fli deploy              ← deploy to dev (or auto-detected from branch)
fli deploy --production ← deploy to production
fli deploy --stage      ← deploy to staging
fli deploy --api        ← API only  (see § Splitting, below)
fli deploy --web        ← web only

fli deploy:pause        ← take the app down on purpose (the edge refuses; the app keeps running)
fli deploy:unpause      ← serve again
fli deploy:status       ← check what's running on the server
fli deploy:logs         ← stream or show API container logs
fli deploy:run <cmd>    ← run a one-off command inside the running container
fli deploy:rollback     ← roll back to the previous release
fli deploy:setup        ← first-time server setup walkthrough
fli deploy:retire       ← take the app off its server — routes, Outpost, container, images, files
```

An app Basecamp runs is released with `fli basecamp:deploy --app <id>` instead.

## Getting started

If this is a new project, run `fli make:deploy` first. It scaffolds the
Dockerfile, `.dockerignore`, and `deploy` block in `frontier.config.js`, and
walks you through what still needs to be done:

```
fli make:deploy
fli make:deploy --server myapp.com --domain myapp.com
```

Then test the container locally before touching a server:

```
fli deploy:local
```

Once that passes, set up the server and deploy:

```
fli deploy:setup
fli deploy
```

## Prerequisites

**On your machine:**
- SSH access to the server (`ssh <server>` must work without a password prompt)
- Docker (for `fli deploy:local`)
- A `frontier.config.js` with a `deploy` block in your project root

**On the server:**
- Ubuntu 20.04+ (or any Debian-based Linux)
- Docker, Caddy (the `caddy-api` unit), git, Bun — nothing else on 80/443

Run `fli deploy:setup` to check and install what's missing.

### Build once, promote a digest

`deploy.builder` names the machine the image is BUILT on. Absent, it is the api
target — dev, stage and production each build their own bytes, and no two of them
can be shown to be one artefact:

```
deploy: {
  server: 'prod.your-app.com',
  builder: { server: 'build.your-app.com', path: '/apps/shop' },
}
```

Declared, the image is built there once and shipped with
`docker save | docker load`, which preserves the image ID — so the digest the
Release names is the digest that starts. No registry; `IDEAS/deploy-plane.md`
keeps three distribution strategies open and this is the one that needs no
infrastructure.

**The digest is a term of the Release id**, so an unchanged redeploy is the same
Release and a changed one is a different Release. That is what `fli deploy:revert`
reads to tell two deploys apart.

### The machine can be this one

Every command a deploy runs goes through `core/machine.js`, which pipes the
script to `sh -s` — with an `ssh <host>` in front of it, or without. So a
`server` of `localhost` (or `local`, `127.0.0.1`, `::1`) runs the same pipeline
against this machine: same scripts, same Docker daemon, same journal. It is not
a dry run and it is not a simulation; the only thing it does not exercise is ssh.

That is what CI uses to run `fli deploy` at all. `transport: 'ssh'` in the deploy
block overrides the inference, for testing sshd on your own box.

## frontier.config.js

The `deploy` block is the single source of truth for all deploy commands:

<!-- Illustrative config, not command code — a ```js fence is compiled INTO the
     command body, and an `export default` there is a syntax error. Every other
     fence in this file is a plain one for the same reason. -->

```
export default {
  deploy: {
    server: 'myapp.com',
    user:   'deploy',          // absent: the bare server, so ~/.ssh/config's User applies
    path:   '/apps/myapp',
    app_id: 'myapp',           // required: names the container and the Release

    api: {
      port:       3000,        // default: 3000
      health:     '/health',    // must match the app: health() serves
                                // `{apiPrefix}/health`, and Junction's default
                                // apiPrefix is '' — so this is '/health' unless
                                // the app sets one. make:deploy reads it for you.
      dockerfile: 'deploy/Dockerfile',   // the path make:deploy writes
      env:        '/apps/myapp/.env.production',

      // Validate server env against .env.example before deploying
      // Aborts with a clear list of missing keys if any are not set
      envCheck:   true,        // default: false
    },

    web: {
      domain:        'myapp.com',
      keep_releases: 3,        // default: 3
      // No ssl key: Caddy fetches the certificate for every domain it routes.
    },

    db: {
      path:         '/apps/myapp/db',   // default: {path}/db
      file:         'production.db',    // default: production.db
      keep_backups: 5,                  // default: 5
    },

    // What the container does with its own stdout. Omit it and the log is
    // capped at 10m x 5 — Docker's own default caps nothing at all. Set
    // `logs: false` where the daemon is already pointed at a shipper, or name
    // a driver to hand over the whole decision.
    logs: {
      max_size:  '10m',               // default: 10m
      max_files: 5,                   // default: 5
      // driver:  'journald',         // instead of the two above
      // options: { 'loki-url': '…' },// a named driver's own options
    },

    // Per-target overrides — server/user/path only
    production: { server: 'prod.myapp.com' },
    stage:      { server: 'stg.myapp.com'  },
  },
}
```

### The API on a domain of its own

`api.domain` gives the API its own origin — `api.myapp.com` beside `web.domain`. Unset, the
web domain proxies the API's paths and `/ws` and the page and the API share an origin. The
paths are read off `app.snapshot.md`; with no `apiPrefix`, a request asking for HTML is
served the page and anything else the API. Every deploy rewrites the routes when they moved.

```
    web: { domain: 'app.myapp.com' },
    api: { domain: 'api.myapp.com', port: 3000 },
```

`fli deploy:setup` writes two Caddy routes, each with the pause guard, and `fli deploy`
builds the web surface with `FRONTIER_PUBLIC_API_URL=https://api.myapp.com` — refusing when the bundle
does not contain it, which is what a `sierra.config.js` that never reads the variable
produces. Sign-in with a Bearer token works across the two names with the scaffold's CORS
default. A cookie session across them needs the web origin in the API's cors and csrf lists, which the
deploy hands the container as `FRONTIER_CORS_ORIGINS`: `https://<web.domain>` under two origins, plus
`tauri://localhost` and `http://tauri.localhost` when the app has a `desktop/` surface. The API
merges it into whatever `junction.config.js` declares; `cors.credentials` stays the app's to set.

### Splitting the API and the web onto different machines

`api` and `web` may each carry their own `server` / `user` / `path`. A side that
says nothing inherits the shared value, so the config above keeps behaving
exactly as it did — the split is opt-in per side.

```
export default {
  deploy: {
    server: 'myapp.com',            // still the default for anything unstated
    path:   '/apps/myapp',

    api: {
      server: 'api.myapp.com',      // ← the API lives on its own box
      path:   '/apps/myapp-api',
      port:   3000,
      health: '/health',
    },

    web: {
      domain: 'myapp.com',          // web stays on the shared server above
    },

    production: {
      api: { server: 'api-prod.myapp.com' },   // per target AND per side
    },
  },
}
```

Resolution, most specific first:

```
deploy[target][side]  →  deploy[side]  →  deploy[target]  →  deploy
```

Splitting is the ordinary shape once the API has its own origin, and nothing in
the transport assumes co-location: the browser client takes an absolute `url`,
and `/ws` is registered beneath the router so it never carries `apiPrefix`. What
a split *does* need is CORS — Junction's default is `origins: []`, deliberately —
and the WebSocket upgrade is an HTTP request, so it needs the same allowance.

Deploy one side at a time:

```
fli deploy              → both halves
fli deploy --api        → API only
fli deploy --web        → web only
fli deploy --api --production
```

The same `--web` / `--api` filters `deploy:rollback` has always had.

**Each machine gets its own lock, keyed by host AND path**, so two apps sharing a
server are two locks and one app split across two servers is two. A run that
cannot take the second lock releases the first rather than stranding it. Both
hosts are SSH-checked before anything moves, and **a split whose hosts are on
different commits is refused** — shipping two versions under one release name is
the failure this is most likely to cause.

## How a deploy works

```
01-preflight   → SSH check, deploy lock, Litestream detection
01b-env-check  → validate server env against .env.example (if envCheck: true)
02-ship        → git archive of HEAD at the app's directory + vendored deps → <path>/src
03-build-web   → bun build on server, create versioned release
04-build-api   → docker build on server (no registry needed)
05-backup      → hot backup of the database before any changes
06-swap        → stop old container, start new (migrations run in entrypoint)
07-health      → poll deploy.api.health — rolls back to previous container on failure
08-release-web → atomic symlink swap; Caddy reads the root per request
08b-outpost    → enroll the API's box in the app's fleet (if outpost: true; --no-outpost skips)
09-cleanup     → remove _replaced, prune images, release deploy lock
```

Migrations run inside the new container's entrypoint before it starts serving
traffic. If migrations fail, the container exits non-zero, the health check
fails, and the previous container is automatically restored.

## Deploy targets

```
fli deploy                    → dev (default)
fli deploy --stage            → stage (or if branch is 'stage'/'staging')
fli deploy --production       → production
```

Without a `deploy` block in `frontier.config.js`, `fli deploy` refuses.

## Logs and one-off commands

```
fli deploy:logs                     → last 50 lines from the API container
fli deploy:logs --follow            → stream live (Ctrl+C to stop)
fli deploy:logs --tail 200 --production

fli deploy:run "bun run db:seed"           → run a command in the container
fli deploy:run --production "bun repl"     → interactive (tty forwarded)
```

## Testing locally

Before deploying to a server, validate the Docker image locally:

```
fli deploy:local           → build, run, health check on :3001
fli deploy:local --clean   → stop any existing test container first
```

`deploy:local` uses the same Dockerfile and runs the same entrypoint
(migrations → server start) as a real deploy. If the health check passes
locally, `fli deploy` will pass on the server.

## Rollback

```
fli deploy:rollback            → roll back both web and API
fli deploy:rollback --web      → web only (previous release symlink)
fli deploy:rollback --api      → API only (restore _replaced container)
fli deploy:rollback --production
```

Web rollback points the `current` symlink at the second-most-recent release.
API rollback restores the `_replaced` container if present, otherwise prompts
to select from available image tags.

## Litestream

If Litestream is running on the server, `fli deploy` detects it and notes it in
the preflight step. Do not stop Litestream during a deploy — it runs throughout
and checkpoints the WAL naturally when the old container stops. The deploy
pipeline is designed around this: old container stops cleanly, Litestream
checkpoints, new container starts and runs migrations, Litestream continues.

```
fli deploy:status   → shows Litestream pid and replica URL
```
