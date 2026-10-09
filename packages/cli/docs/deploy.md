# FLI deploy (deploy:* namespace)

Three modes coexist:

1. **Modern Docker/SSH/nginx** — triggered by `frontier.config.js` having a `deploy` block. Used for new FJS apps, especially Junction.
2. **Legacy CapRover** — fallback when no `deploy` block. Uses `DEV_SERVER`/`STAGE_SERVER`/`PROD_SERVER` env vars.
3. **ksite-specific** — `ksite:deploy` for static-site projects, separate code path.

### Modern deploy pipeline — `commands/deploy/_steps-docker/`, 13 files

`fli deploy:plan` prints the live step list for a given config; the table
below is a summary, not the source of truth.

| Step | Function | Skippable |
|---|---|---|
| `01-preflight` | SSH check, validate config, acquire the deploy lock | no |
| `01b-env-check` | Diff `.env.example` against the server's `.env.production` | yes, gated by `envCheck` |
| `02-pull` | `git pull` on the server, capture the short SHA | no |
| `02b-build-check` | Refuse a build that would bake configuration into the image | yes, gated by `buildCheck: false` |
| `03-build-web` | Build web on the server, versioned release | yes, gated by `doWeb` |
| `04-build-api` | Build the Docker image on the server | yes, gated by `doApi` |
| `04c-journal` | Open the deploy journal on the target and record the transition | yes, gated by `journal: false` or `--dry` |
| `05-backup` | Hot backup of every declared database, inside the running container | yes, gated by `db.backup: false` |
| `05b-jobs-volume` | Ask the running container where its jobs database is, before the swap discards it | yes, gated by `doApi` |
| `06-swap` | Stop the old container, start the new one — migrations run in the entrypoint | yes, gated by `doApi` |
| `07-health` | Health-check the new container, rolling back to `_replaced` on failure | yes, gated by `doApi` |
| `08-release-web` | Point nginx at the new web release via symlink | yes, gated by `doWeb` |
| `09-cleanup` | Remove `_replaced`, prune old images, release the deploy lock — also runs on abort (`runOnAbort: true`) | always |

### Key design choices in deploy

- Built on the server, not pushed (no Docker registry needed)
- Versioned web releases via symlinks for atomic cutover
- SQLite single-writer respected — old container stopped before new starts; ~3-10s gap during migrations
- Auto-rollback on health failure (rename `_replaced` back, start it)
- Stale client protection — previous release's hashed assets merged into new release with `cp -rn` so cached HTML clients can still load `app-x9y8z7.js`
- Deploy lock at `${path}/.deploy.lock` prevents concurrent deploys to same server

### Junction-specific notes

The `deploy:setup` nginx template includes a `/ws` location block with WebSocket upgrade headers. Default `proxy_read_timeout` is 60s — long-lived idle Junction WebSockets get closed unless this is bumped. The `deploy:doctor` command surfaces this as a reminder when `@frontierjs/junction` is detected.

`/health` route is critical — auto-rollback won't work without it. Doctor heuristically greps for it in `api/src/server.{ts,js}`, `api/src/index.{ts,js}`, `api/src/app.ts`.

### `frontier.config.js` deploy block shape

```js
export default {
  deploy: {
    server: 'myapp.com',
    user: 'deploy',          // default
    path: '/apps/myapp',
    app_id: 'myapp',         // defaults to last segment of path

    api: {
      port: 3000,
      health: '/health',
      dockerfile: 'api/deploy/Dockerfile',
      env: '/apps/myapp/.env.production',
      envCheck: true,        // validates server env before deploy
    },
    web: {
      domain: 'myapp.com',
      keep_releases: 3,
      ssl: { cert: '/etc/ssl/myapp.pem', key: '/etc/ssl/myapp.key' },
    },
    db: {
      path: '/apps/myapp/db',
      file: 'production.db',
      keep_backups: 5,
    },

    production: { server: 'prod.myapp.com' },  // per-target overrides
    stage:      { server: 'stg.myapp.com'  },
  },
}
```

### Deploy commands available

`fli deploy` (the full pipeline), `fli deploy:doctor`, `fli deploy:local`,
`fli deploy:setup`, `fli deploy:status`, `fli deploy:logs`, `fli deploy:run`,
`fli deploy:rollback`, `fli deploy:revert`, `fli deploy:pause`,
`fli deploy:unpause`, `fli deploy:unlock`, `fli deploy:journal`,
`fli deploy:plan`, `fli deploy:vendor`. `fli make:deploy` scaffolds the
Dockerfile, deploy block, and health endpoint hint.

### Deploying a new Junction app — the path

```
1. fli make:deploy --server <host> --domain <domain>
   → scaffolds api/deploy/Dockerfile, deploy block in frontier.config.js, prints health hint

2. Add /health and /ws routes to your Junction API (returns 200 / handles WebSocket)

3. fli deploy:doctor
   → checks everything is wired correctly. Junction-aware. No network.

4. fli deploy:local
   → builds the Dockerfile, runs locally on :3001, polls /health
   → if this fails, fli deploy will fail too — fix here first

5. fli deploy:setup
   → SSH check, install missing deps on server, create directories, clone repo,
     write nginx config (/ws proxy already in template), optional SSL

6. ssh <host> + populate /apps/<appId>/.env.production

7. fli deploy:doctor --remote
   → server-side probes: SSH, tools, deploy dir, env keys, container, lock

8. fli deploy
   → runs the docker pipeline (13 steps, `fli deploy:plan` to preview). Auto-rollback on failure.
```

---
