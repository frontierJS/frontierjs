---
namespace: deploy
description: Deploy FrontierJS apps to a server via SSH + Docker + nginx
---

<script>
const { loadFrontierConfig } = await import(new URL('file://' + global.fliRoot + '/core/utils.js'))

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

```js
export default {
  deploy: {
    server: 'myapp.com',
    user:   'deploy',          // default: 'deploy'
    path:   '/apps/myapp',
    app_id: 'myapp',           // default: last segment of path

    api: {
      port:       3000,        // default: 3000
      health:     '/health',   // default: '/health'
      dockerfile: 'api/deploy/Dockerfile',
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

## How a deploy works

```
01-preflight   → SSH check, deploy lock, Litestream detection
01b-env-check  → validate server env against .env.example (if envCheck: true)
02-pull        → git pull on server, capture commit SHA
03-build-web   → bun build on server, create versioned release
04-build-api   → docker build on server (no registry needed)
05-backup      → hot backup of the database before any changes
06-swap        → stop old container, start new (migrations run in entrypoint)
07-health      → poll /health — rolls back to previous container on failure
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
