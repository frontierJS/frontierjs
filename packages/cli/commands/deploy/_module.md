---
namespace: deploy
description: Deploy FrontierJS apps to a server via SSH + Docker + nginx
---

<script>
const { loadFrontierConfig }        = await import(new URL('file://' + global.fliRoot + '/core/utils.js'))
const { vendorWorkspacePackages, linkedDeps, GENERATED_DIR } = await import(new URL('file://' + global.fliRoot + '/core/vendor.js'))

// ─── vendorApp ────────────────────────────────────────────────────────────────
// Write the build context the Dockerfile installs from: deploy/generated/, with
// a manifest and — for an app depending on the framework by `link:` or
// `workspace:` — a packed copy of every one of those packages beside it.
//
// Runs on EVERY build, not only a linked one. With nothing linked it copies the
// manifest and the lockfile, which is what lets one Dockerfile serve both source
// modes; making it conditional here would move the condition into a template
// nobody regenerates when the source mode changes.
//
// It throws on anything it cannot finish. A half-vendored context installs the
// rest from npm and produces an image running two trees at once, which does not
// have to fail to be wrong.
//
// It does NOT prune devDependencies, and the reason is worth stating because
// pruning them looks free: the image builds nothing — it copies `api/` and
// `db/` and runs `db:migrate` then `start` — and **`bun install --production`
// resolves devDependencies anyway**, only skipping their install, so one dev
// tool that 404s fails an image that would never have run it. The `transform`
// hook can drop them; a manifest that no longer matches the lockfile beside it
// then fails `--frozen-lockfile` outright, which is the worse trade. An
// unresolvable devDependency is a publish problem and belongs upstream.
const vendorApp = (root, log) => {
  const result = vendorWorkspacePackages({ appRoot: root, log: (m) => log.info(m) })
  if (result.vendored.length)
    log.success(`Vendored ${result.vendored.length} workspace dependenc(ies) from ${result.packagesDir}`)
  return result
}

// ─── resolveTarget ────────────────────────────────────────────────────────────
// Resolves the deploy target from flags and git branch.
// Priority: --production > --stage > branch name > dev
//
// Usage in any deploy command:
//   const target = resolveTarget(flag, context.git)
const resolveTarget = (flag, git) => {
  if (flag.production) return 'production'
  const branch = git?.branch?.() ?? ''
  if (flag.stage || ['stage', 'staging'].includes(branch)) return 'stage'
  return 'dev'
}

// ─── resolveDeployConf ────────────────────────────────────────────────────────
// Extracts the resolved server/user/path for a given target from the deploy
// block, applying per-target overrides over the top-level values.
//
// Returns null if the required fields are missing — callers should check and
// set context.config.abort = true before returning.
//
// Usage:
//   const conf = resolveDeployConf(deployConf, target)
//   if (!conf) { log.error('...'); context.config.abort = true; return }
const resolveDeployConf = (deployConf, target) => {
  if (!deployConf?.server) return null
  const targetConf = deployConf[target] ?? {}
  const server = targetConf.server ?? deployConf.server
  const user   = targetConf.user   ?? deployConf.user ?? 'deploy'
  const path   = targetConf.path   ?? deployConf.path
  if (!server || !path) return null
  return { server, user, path }
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
  const user   = ts.user   ?? s.user   ?? t.user   ?? deployConf.user ?? 'deploy'
  const path   = ts.path   ?? s.path   ?? t.path   ?? deployConf.path
  if (!server || !path) return null
  return { server, user, path, host: `${user}@${server}` }
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
// LITESTREAM_MIN is a hand copy of litestone's own floor in
// `src/tools/replicate.js` — change one, change both. This side cannot import
// it: litestream reaches the server as a binary and litestone reaches it as a
// dependency of the app, neither of which the CLI can resolve from here.
//
// `run` takes a remote shell command and returns its stdout as a string, so the
// three callers keep their own ssh plumbing.
const LITESTREAM_MIN = { major: 0, minor: 5 }

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

// ─── distinctHosts ────────────────────────────────────────────────────────────
// The machines a run touches, deduplicated by host AND path — the SSH check, the
// deploy lock, the git pull and the cleanup are per machine, not per side, and
// the common case is one machine wearing both hats. Deduplicating on the pair
// matters: two apps sharing a host but not a path are two locks, and one app
// split across two hosts is two pulls.
const distinctHosts = (sides) => {
  const seen = new Map()
  for (const side of sides) {
    if (!side) continue
    const key = `${side.host}:${side.path}`
    if (!seen.has(key)) seen.set(key, { host: side.host, path: side.path })
  }
  return [...seen.values()]
}
</script>

## Overview

The `deploy:` commands deploy FrontierJS apps to a Linux server using SSH,
Docker, and nginx. Configuration lives in `frontier.config.js` — no CapRover,
no external platform required.

```
fli make:deploy         ← scaffold Dockerfile, deploy config, and health endpoint

fli deploy:local        ← build + run + health check locally (no server needed)

fli deploy              ← deploy to dev (or auto-detected from branch)
fli deploy --production ← deploy to production
fli deploy --stage      ← deploy to staging
fli deploy --api        ← API only  (see § Splitting, below)
fli deploy --web        ← web only

fli deploy:status       ← check what's running on the server
fli deploy:logs         ← stream or show API container logs
fli deploy:run <cmd>    ← run a one-off command inside the running container
fli deploy:rollback     ← roll back to the previous release
fli deploy:setup        ← first-time server setup walkthrough
```

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
- SSH access to the server (`ssh user@server` must work without a password prompt)
- Docker (for `fli deploy:local`)
- A `frontier.config.js` with a `deploy` block in your project root

**On the server:**
- Ubuntu 20.04+ (or any Debian-based Linux)
- Docker, nginx, git, Bun

Run `fli deploy:setup` to check and install what's missing.

## frontier.config.js

The `deploy` block is the single source of truth for all deploy commands:

<!-- Illustrative config, not command code — a ```js fence is compiled INTO the
     command body, and an `export default` there is a syntax error. Every other
     fence in this file is a plain one for the same reason. -->

```
export default {
  deploy: {
    server: 'myapp.com',
    user:   'deploy',          // default: 'deploy'
    path:   '/apps/myapp',
    app_id: 'myapp',           // default: last segment of path

    api: {
      port:       3000,        // default: 3000
      health:     '/health',    // must match the app: healthPlugin() serves
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
      ssl: {
        cert: '/etc/ssl/myapp.pem',
        key:  '/etc/ssl/myapp.key',
      },
    },

    db: {
      path:         '/apps/myapp/db',   // default: {path}/db
      file:         'production.db',    // default: production.db
      keep_backups: 5,                  // default: 5
    },

    // Per-target overrides — server/user/path only
    production: { server: 'prod.myapp.com' },
    stage:      { server: 'stg.myapp.com'  },
  },
}
```

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
02-pull        → git pull on server, capture commit SHA
03-build-web   → bun build on server, create versioned release
04-build-api   → docker build on server (no registry needed)
05-backup      → hot backup of the database before any changes
06-swap        → stop old container, start new (migrations run in entrypoint)
07-health      → poll deploy.api.health — rolls back to previous container on failure
08-release-web → atomic symlink swap, nginx reload
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

Without a `deploy` block in `frontier.config.js`, `fli deploy` falls back to
the legacy CapRover mode using `DEV_SERVER` / `PROD_SERVER` from `.env`.

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
