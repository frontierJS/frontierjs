---
title: deploy:doctor
description: Diagnose deployment readiness — local config, project state, and (with --remote) server-side setup
examples:
  - fli deploy:doctor
  - fli deploy:doctor --remote
  - fli deploy:doctor --remote --production
flags:
  remote:
    type: boolean
    description: Also run server-side probes (requires SSH access)
    defaultValue: false
  production:
    type: boolean
    description: Target production server when running remote probes
    defaultValue: false
  stage:
    type: boolean
    description: Target staging server when running remote probes
    defaultValue: false
---

<script>
import { existsSync, readFileSync } from 'fs'
import { resolve as resolvePath, basename } from 'path'

// Status sigils — keep narrow so the checklist columns line up.
const PASS = '\x1b[32m✓\x1b[0m' // green
const FAIL = '\x1b[31m✗\x1b[0m' // red
const WARN = '\x1b[33m⚠\x1b[0m' // yellow
const INFO = '\x1b[2m·\x1b[0m'   // dim

// One row of the checklist. `name` is the human-readable label, `status` is
// 'pass' | 'fail' | 'warn' | 'info', `hint` is a one-line "fix:" message
// shown in dim text below the row when present.
const renderCheck = (name, status, hint) => {
  const sigil = status === 'pass' ? PASS
              : status === 'fail' ? FAIL
              : status === 'warn' ? WARN
              : INFO
  echo(`  ${sigil}  ${name}`)
  if (hint) echo(`     \x1b[2m${hint}\x1b[0m`)
}

const renderHeader = (text) => {
  echo('')
  echo(`\x1b[1m${text}\x1b[0m`)
}

// Heuristic file content search. Used to detect /health route, junction
// imports, db:migrate script, etc. Returns true on first match across files.
const fileContains = (paths, needle) => {
  const re = needle instanceof RegExp ? needle : new RegExp(needle)
  for (const p of paths) {
    try { if (re.test(readFileSync(p, 'utf8'))) return true } catch {}
  }
  return false
}

// Pull a key from a parsed package.json's deps + devDeps.
const hasDep = (pkg, name) => Boolean(
  pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]
)

// Read a JSON file, tolerating missing/malformed files.
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { return null }
}
</script>

Reads `frontier.config.js`, walks through every prerequisite the deploy
pipeline checks for, and reports what's ready and what isn't. Local
checks run by default — config completeness, Dockerfile presence, health
endpoint, env reference, git state. Pass `--remote` to also probe the
target server (SSH reachability, deploy directory, env file, container
state).

Junction apps get extra checks: `/ws` route presence, `@frontierjs/junction`
dependency, and a reminder about the `proxy_read_timeout` quirk with
long-lived WebSocket connections.

```js
const target = resolveTarget(flag, context.git)

// ─── Header ───────────────────────────────────────────────────────────────
const projectName = basename(context.paths.root)
echo(`\n\x1b[1m${projectName}\x1b[0m  ·  target: \x1b[1m${target}\x1b[0m\n`)

// Track failures + warnings for the final summary
let failed = 0
let warned = 0
const fail = () => failed++
const warn = () => warned++

// ─── Load frontier.config.js — everything else depends on this ────────────
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

renderHeader('Config')

if (!frontierConfig) {
  renderCheck('frontier.config.js', 'fail', 'fix: fli make:deploy')
  fail()
  echo('')
  log.error(`No frontier.config.js found in ${context.paths.root}`)
  log.info(`Run \x1b[1mfli make:deploy\x1b[0m to scaffold one.`)
  context.config.abort = true
  return
}
renderCheck('frontier.config.js exists', 'pass')

if (!deployConf) {
  renderCheck('deploy block in frontier.config.js', 'fail', 'fix: fli make:deploy')
  fail()
  echo('')
  log.error('frontier.config.js has no deploy block')
  log.info(`Run \x1b[1mfli make:deploy\x1b[0m to add one.`)
  context.config.abort = true
  return
}
renderCheck('deploy block defined', 'pass')

// ─── Required deploy fields ───────────────────────────────────────────────
const resolved = resolveDeployConf(deployConf, target)
if (!resolved) {
  renderCheck(`deploy.server / deploy.path for target=${target}`, 'fail',
    `fix: add server and path (or ${target}.server / ${target}.path) to frontier.config.js`)
  fail()
} else {
  renderCheck(`server + path resolve for target=${target}`, 'pass',
    `${resolved.user}@${resolved.server}:${resolved.path}`)
}

const appId = deployConf.app_id ?? deployConf.path?.split('/').pop()
if (appId) {
  renderCheck('app_id', 'pass', appId)
} else {
  renderCheck('app_id', 'warn', 'no app_id and no path to derive from — set deploy.app_id')
  warn()
}

// ─── Dockerfile ───────────────────────────────────────────────────────────
renderHeader('API container')

const dockerfile = deployConf.api?.dockerfile ?? 'deploy/Dockerfile'
const dockerfilePath = resolvePath(context.paths.root, dockerfile)
if (existsSync(dockerfilePath)) {
  renderCheck(`Dockerfile at ${dockerfile}`, 'pass')
} else {
  renderCheck(`Dockerfile at ${dockerfile}`, 'fail',
    `fix: fli make:deploy  (or set deploy.api.dockerfile if it lives elsewhere)`)
  fail()
}

// ─── the scripts THIS Dockerfile invokes ──────────────────────────────────────
// The app root holds the only manifest — root README § Project Structure. This
// looked in api/ and so warned "entrypoint may not work" on every app fli new
// has ever produced, while being right that the entrypoint would not work
// (FJS-232).
//
// The scripts required are READ OFF the configured Dockerfile rather than
// assumed from the template. `fli make:deploy` writes a CMD that runs
// `db:migrate` then `start`, and asserting that unconditionally makes this
// refuse an app whose Dockerfile is correct and different — `basecamp` runs its
// migrations at boot inside app.ts, on purpose, so it has no `db:migrate` and
// the deploy it was being blocked from is one that works (`FJS-417`).
//
// A hand-written Dockerfile is the normal case for an app past its first week,
// and a check that only understands the generated one is a check that gets
// turned off.
const rootPkgPath = resolvePath(context.paths.root, 'package.json')
const rootPkg     = readJson(rootPkgPath)

const dockerfileForScripts = existsSync(dockerfilePath) ? readFileSync(dockerfilePath, 'utf8') : ''
// No Dockerfile to read means the template's is what will be written.
const required = dockerfileForScripts ? dockerfileScripts(dockerfileForScripts) : ['db:migrate', 'start']

if (!rootPkg) {
  renderCheck('package.json', 'fail', 'no manifest at the app root — the image cannot install anything')
  fail()
} else if (!required.length) {
  renderCheck('Dockerfile CMD names a script', 'warn',
    `no 'bun run <script>' on a CMD or ENTRYPOINT line — nothing here can say which scripts the image needs`)
} else {
  const missing = required.filter(name => !rootPkg.scripts?.[name])
  if (missing.length) {
    renderCheck(`package.json has ${missing.map(n => `'${n}'`).join(' + ')}`, 'fail',
      `deploy/Dockerfile's entrypoint runs ${missing.map(n => `'bun run ${n}'`).join(' and ')} — ` +
      `without it the container exits non-zero on every start`)
    fail()
  } else {
    renderCheck(`package.json has ${required.map(n => `'${n}'`).join(' + ')} — every script the Dockerfile runs`, 'pass')
  }
}

// ─── The schema must be in the image ──────────────────────────────────────────
// Both the entrypoint's migration and the deploy's pre-swap backup resolve
// databases by reading the schema, so `COPY db ./db` is load-bearing.
const dockerfileSrc = existsSync(dockerfilePath) ? readFileSync(dockerfilePath, 'utf8') : ''
if (dockerfileSrc && !/^\s*COPY\s+db\b/m.test(dockerfileSrc)) {
  renderCheck('Dockerfile copies db/', 'warn',
    `no 'COPY db' — migrations and 'litestone backup' both read db/schema.lite inside the container`)
  warn()
} else if (dockerfileSrc) {
  renderCheck('Dockerfile copies db/', 'pass')
}

// ─── The migration history must build the schema ──────────────────────────────
//
// The one check that catches a deploy which builds, starts, answers /health and
// cannot serve a request. `migrate apply` replays FILES; `fli db:push` writes
// tables and no file, so a change developed with push is in the developer's
// database and in no image. It used to be found in the container, by the first
// write, as `no such table: user` (FJS-345, FJS-388).
//
// `migrate apply` refuses at container start now, which covers every deployer
// including a hand-written Dockerfile. This asks the identical question HERE,
// before the image is built, because the answer is a pure function of the repo:
// replay db/migrations/ into memory, diff against db/schema.lite. No database,
// no container, no network (FJS-D123 section 6). Same command, so there is one
// implementation of the rule and not two.
if (existsSync(resolvePath(context.paths.root, 'db/schema.lite'))) {
  // `bunx litestone` inline rather than the `litestone(context)` helper: that
  // is a hand copy in db/_module.md and release/_module.md, and a third one
  // here would be the drift those two already are.
  const probe = context.exec({
    command: `bunx litestone migrate check --schema db/schema.lite`,
    cwd: context.paths.root, stdio: 'pipe', allowFailure: true,
  })
  const code = probe?.exitCode ?? probe?.code ?? 0
  if (code !== 0) {
    renderCheck('migration history builds the schema', 'fail',
      `db/migrations/ does not build db/schema.lite — the deploy will refuse at start. ` +
      `Run 'fli db:migrate' (or 'litestone migrate check' to see the gap)`)
    fail()
  } else {
    renderCheck('migration history builds the schema', 'pass')
  }
}

// ─── The Dockerfile must install from the generated manifest ─────────────────
// An app depending on the framework by `link:`/`workspace:` cannot install those
// specs inside a build — they resolve to a workspace the image has never seen,
// and `bun install` fails once per package (FJS-241). The deploy path packs them
// into deploy/generated/ first, which only helps a Dockerfile that installs from
// there. A template predating that copies `package.json` and fails at the
// install layer, which is late and reads as a broken package rather than a stale
// Dockerfile.
// Comments are stripped first. The template EXPLAINS deploy/generated/ in its
// own header, so asking the whole source whether it mentions the path passes for
// a Dockerfile that only talks about it — the same shape as the body tag written
// inside a comment, which is a rule this repo already enforces elsewhere.
const linked = rootPkg ? linkedDeps(rootPkg) : []
const instructions = dockerfileSrc
  .split('\n')
  .filter(line => !/^\s*(#|$)/.test(line))
  .join('\n')
const installsGenerated = /deploy\/generated/.test(instructions)

if (dockerfileSrc && linked.length && !installsGenerated) {
  renderCheck('Dockerfile installs from deploy/generated/', 'fail',
    `${linked.length} dependenc(ies) are link:/workspace: (${linked.join(', ')}) and cannot install inside a build — ` +
    `fix: regenerate deploy/Dockerfile with fli make:deploy, or copy deploy/generated/app-manifest.json over package.json in it`)
  fail()
} else if (dockerfileSrc && !installsGenerated) {
  renderCheck('Dockerfile installs from deploy/generated/', 'warn',
    `it installs from package.json — fine while every dependency is published, and a fail the day one is not`)
  warn()
} else if (dockerfileSrc) {
  renderCheck('Dockerfile installs from deploy/generated/', 'pass')
}

// ─── /health route — required for auto-rollback ───────────────────────────
// Heuristic: check the API source for a /health route definition.
// Won't catch dynamic registrations but covers the common case.
// `api/src/app.ts` first, because that is where `fli new` configures the plugin
// and it is the file the layout calls the composition root. `api/index.ts` is
// the ENTRY — it starts the app and assembles nothing — but an app is free to
// configure there, and `api/src/index.*` is the shape of an app that made the
// entry and the assembly one file. `api/src/server.*` was in this list and has
// never been written by any scaffold, which is what a hedge costs: it reads as
// a layout somebody supports.
const apiSrcCandidates = [
  resolvePath(context.paths.root, 'api/src/app.ts'),
  resolvePath(context.paths.root, 'api/src/app.js'),
  resolvePath(context.paths.root, 'api/index.ts'),
  resolvePath(context.paths.root, 'api/index.js'),
  resolvePath(context.paths.root, 'api/src/index.ts'),
  resolvePath(context.paths.root, 'api/src/index.js'),
]
const healthPath = deployConf.api?.health ?? '/health'
// healthPlugin() registers /health without the path ever appearing as a literal,
// so a plugin-wired app would fail a string search while answering correctly.
// The plugin serves `{apiPrefix}/health`, so ANY configured path ending in
// /health is satisfied by it — testing for the bare '/health' instead reported a
// missing route on every app that sets a prefix, which is the recommended shape.
const hasHealth  = fileContains(apiSrcCandidates, new RegExp(`['"\`]${healthPath.replace(/\//g, '\\/')}['"\`]`))
  || (healthPath.endsWith('/health') && fileContains(apiSrcCandidates, /healthPlugin\s*\(/))
if (hasHealth) {
  renderCheck(`${healthPath} route in api source`, 'pass')
} else {
  renderCheck(`${healthPath} route in api source`, 'warn',
    `couldn't find a literal "${healthPath}" string — auto-rollback needs a 200 response here`)
  warn()
}

// ─── envCheck setup ───────────────────────────────────────────────────────
renderHeader('Environment')

const envCheckOn = deployConf.api?.envCheck === true || deployConf.api?.env_check === true
const envExample = resolvePath(context.paths.root, '.env.example')
const envKeys    = resolvePath(context.paths.root, '.env.keys')
const refExists  = existsSync(envExample) || existsSync(envKeys)

if (envCheckOn) {
  if (refExists) {
    renderCheck('.env.example reference exists (envCheck active)', 'pass',
      existsSync(envExample) ? '.env.example' : '.env.keys')
  } else {
    renderCheck('.env.example reference (envCheck active)', 'warn',
      'envCheck is enabled but no .env.example/.env.keys found — env validation will skip')
    warn()
  }
} else {
  renderCheck('envCheck', 'info', 'disabled — set deploy.api.envCheck: true to validate server env before each deploy')
}

// ─── Junction detection ───────────────────────────────────────────────────
const junctionDep = hasDep(rootPkg, '@frontierjs/junction')
const junctionImport = fileContains(apiSrcCandidates, /from\s+['"]@frontierjs\/junction['"]/)
const isJunction = junctionDep || junctionImport

if (isJunction) {
  renderHeader('Junction (WebSocket)')
  renderCheck('@frontierjs/junction detected', 'pass',
    junctionDep ? 'in package.json' : 'imported in api source')

  // /ws route check — the convention from the deploy:setup nginx template
  // channels() is what registers /ws; the path is never written in app source.
  const hasWs = fileContains(apiSrcCandidates, /['"\`]\/ws['"\`]/)
    || fileContains(apiSrcCandidates, /channels\s*\(/)
  if (hasWs) {
    renderCheck(`/ws route in api source`, 'pass')
  } else {
    renderCheck(`/ws route in api source`, 'warn',
      `the generated nginx config proxies /ws to your API. If your route is elsewhere, update nginx.`)
    warn()
  }

  renderCheck('proxy_read_timeout reminder', 'info',
    `nginx default is 60s — long-lived idle WebSockets get closed. Bump it in the /ws location block if needed.`)
}

// ─── Git state ────────────────────────────────────────────────────────────
renderHeader('Source control')

const branch = context.git.branch()
if (branch) {
  renderCheck(`branch: ${branch}`, 'pass')
} else {
  renderCheck('git repository', 'fail',
    `the deploy pulls via git on the server — this needs to be a tracked repository`)
  fail()
}

if (context.git.isDirty()) {
  const dirty = context.git.status()
  renderCheck(`uncommitted changes`, 'warn',
    `${dirty.length} file(s) — these won't be deployed since the server pulls from origin`)
  warn()
} else if (branch) {
  renderCheck('working tree clean', 'pass')
}

// Unpushed commits — `git rev-list @{u}..` returns commits ahead of upstream.
// If no upstream is configured, fall back silently.
if (branch) {
  let unpushed = null
  let upstreamOk = true
  try {
    const out = context.exec({
      command: `git -C "${context.paths.root}" rev-list --count @{u}..HEAD`,
      stdio:   'pipe',
    })
    unpushed = parseInt((out?.toString?.('utf8') ?? out ?? '0').trim()) || 0
  } catch {
    // No upstream set or some other failure — surface as a warn since it
    // means we can't tell if commits are pushed
    upstreamOk = false
    renderCheck('upstream tracking', 'warn',
      `branch has no upstream set — push it once with: git push -u origin ${branch}`)
    warn()
  }
  if (upstreamOk) {
    if (unpushed > 0) {
      renderCheck(`commits pushed`, 'warn',
        `${unpushed} commit(s) not pushed — server will pull origin, your unpushed work won't deploy`)
      warn()
    } else {
      renderCheck('commits pushed', 'pass')
    }
  }
}

// ─── Remote checks ────────────────────────────────────────────────────────
if (flag.remote) {
  if (!resolved) {
    echo('')
    log.warn('Skipping remote checks — server config not resolved')
  } else {
    renderHeader(`Server (${resolved.user}@${resolved.server})`)

    const host = `${resolved.user}@${resolved.server}`
    const path = resolved.path

    // SSH reachability — use BatchMode to avoid password prompts hanging
    let sshOk = false
    try {
      context.exec({
        command: `ssh -o ConnectTimeout=5 -o BatchMode=yes ${host} "echo ok" > /dev/null`,
        stdio: 'pipe',
      })
      sshOk = true
      renderCheck('SSH reachable', 'pass', `connected to ${host}`)
    } catch {
      renderCheck('SSH reachable', 'fail',
        `fix: ssh-copy-id ${host}  (or check that ${resolved.server} is correct)`)
      fail()
    }

    if (sshOk) {
      // Helper for remote probes — returns trimmed stdout, or '' on error.
      const ssh = (cmd) => {
        try {
          const out = context.exec({
            command: `ssh ${host} "${cmd}"`,
            stdio: 'pipe',
          })
          return (out?.toString?.('utf8') ?? out ?? '').trim()
        } catch { return '' }
      }

      // Required server tools — the same list deploy:setup checks
      for (const tool of ['docker', 'nginx', 'git', 'bun', 'rsync']) {
        const probe = ssh(`command -v ${tool} > /dev/null 2>&1 && echo ok`)
        if (probe === 'ok') {
          renderCheck(`${tool} on server`, 'pass')
        } else {
          renderCheck(`${tool} on server`, 'fail',
            `fix: fli deploy:setup${flag.production ? ' --production' : flag.stage ? ' --stage' : ''}`)
          fail()
        }
      }

      // Deploy directory exists
      const pathExists = ssh(`[ -d "${path}" ] && echo ok`)
      if (pathExists === 'ok') {
        renderCheck(`${path} exists on server`, 'pass')

        // Repo cloned at that path
        const isRepo = ssh(`[ -d "${path}/.git" ] && echo ok`)
        if (isRepo === 'ok') {
          renderCheck(`${path} is a git repository`, 'pass')

          // Repo origin matches local
          const remoteUrl = ssh(`cd ${path} && git config --get remote.origin.url`)
          if (remoteUrl) {
            renderCheck('git remote configured', 'pass', remoteUrl)
          }
        } else {
          renderCheck(`${path}/.git`, 'fail',
            `fix: fli deploy:setup  (or clone the repo manually at ${path})`)
          fail()
        }

        // .env.production
        const envFile = deployConf.api?.env ?? `${path}/.env.production`
        const envExists = ssh(`[ -f "${envFile}" ] && echo ok`)
        if (envExists === 'ok') {
          renderCheck(`${envFile} exists`, 'pass')

          // If envCheck is on and we have a local reference, count missing keys
          if (envCheckOn && refExists) {
            const refContent = readFileSync(existsSync(envExample) ? envExample : envKeys, 'utf8')
            const required = refContent.split('\n')
              .map(l => l.trim())
              .filter(l => l && !l.startsWith('#'))
              .map(l => l.split('=')[0].trim())
              .filter(Boolean)
            const remoteContent = ssh(`cat "${envFile}"`)
            const remoteKeys = new Set(
              remoteContent.split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('#'))
                .map(l => l.split('=')[0].trim())
                .filter(Boolean)
            )
            const missing = required.filter(k => !remoteKeys.has(k))
            if (missing.length === 0) {
              renderCheck(`${envFile} has all ${required.length} required keys`, 'pass')
            } else {
              renderCheck(`${envFile} env keys`, 'fail',
                `${missing.length} missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`)
              fail()
            }
          }
        } else {
          renderCheck(`${envFile}`, 'fail',
            `fix: scp .env.production ${host}:${envFile}  (or use fli env:set --remote)`)
          fail()
        }

        // Container state
        const container = `${appId}-api`
        const containerStatus = ssh(`docker inspect ${container} --format '{{.State.Status}}' 2>/dev/null || echo absent`)
        if (containerStatus === 'absent' || !containerStatus) {
          renderCheck(`${container}`, 'info', `not running — first deploy will create it`)
        } else if (containerStatus === 'running') {
          renderCheck(`${container} status`, 'pass', containerStatus)
        } else {
          renderCheck(`${container} status`, 'warn', containerStatus)
          warn()
        }

        // Stale lock
        const lockContent = ssh(`cat ${path}/.deploy.lock 2>/dev/null`)
        if (lockContent) {
          renderCheck('deploy lock', 'warn',
            `lock present (${lockContent}) — clear with: ssh ${host} "rm ${path}/.deploy.lock"`)
          warn()
        } else {
          renderCheck('deploy lock', 'pass', 'clear')
        }

        // Litestream is OPTIONAL, so its absence is informational — but a
        // running one that cannot replicate is not informational, it is a
        // believed backup that does not exist. That grades as a failure.
        const ls = litestreamStatus((cmd) => ssh(cmd) ?? '')
        if (!ls.running) {
          renderCheck('Litestream', 'info', 'not running on server (optional)')
        } else if (ls.supported === false) {
          renderCheck('Litestream', 'fail',
            `${ls.version} is too old — ${LITESTREAM_MIN_LABEL}+ required. It is running and replicating NOTHING: ` +
            `0.3.x cannot parse the STRICT tables litestone emits and loops on a sync error without exiting. ` +
            `fix: upgrade litestream (https://litestream.io/install)`)
          fail()
        } else if (ls.supported === null) {
          renderCheck('Litestream', 'warn',
            `running, but its version could not be read — cannot confirm ${LITESTREAM_MIN_LABEL}+`)
          warn()
        } else {
          renderCheck('Litestream', 'info', `running on server — ${ls.version}, continuous WAL replication`)
        }

      } else {
        renderCheck(`${path} on server`, 'fail',
          `fix: fli deploy:setup`)
        fail()
      }
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────
echo('')
if (failed === 0 && warned === 0) {
  log.success(`All checks passed${flag.remote ? '' : ' (run with --remote for server-side checks)'}`)
  log.info(`Ready to deploy → \x1b[1mfli deploy${flag.production ? ' --production' : flag.stage ? ' --stage' : ''}\x1b[0m`)
} else if (failed === 0) {
  log.warn(`${warned} warning(s) — these won't block a deploy but are worth fixing`)
  log.info(`To deploy anyway: \x1b[1mfli deploy${flag.production ? ' --production' : flag.stage ? ' --stage' : ''}\x1b[0m`)
} else {
  log.error(`${failed} failure(s)${warned > 0 ? `, ${warned} warning(s)` : ''} — fix the items above before deploying`)
  if (!flag.remote) {
    log.info(`After local checks pass, run with --remote to verify the server is ready.`)
  }
}
echo('')

// Doctor is read-only — never run any of the deploy/_steps under any
// circumstance. Setting abort=true short-circuits the auto-discovered
// step folder that lives at commands/deploy/_steps/.
context.config.abort = true
```
