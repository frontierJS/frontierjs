# FLI — Project State

**Version:** 0.1.0  
**Runtime:** Bun  
**Package name:** `@frontierjs/cli` (global binary via `bun link`, command: `fli`)  
**Scope:** `@frontierjs`  
**Repo location:** `packages/cli` inside the FJS monorepo  
**Last updated:** May 2026

---

## What FLI is

A modular CLI automation platform where every command is a plain `.md` file. Commands are live — drop a file, it runs. No compilation, no rebuilding. The same command files power three interfaces:

- **CLI** — `fli <command> [args] [flags]`
- **Web GUI** — `fli gui` → `http://localhost:8500`
- **TUI** — planned

---

## Architecture

### Two command roots

| Root | Path | Label | Who adds them |
|---|---|---|---|
| `fliRoot/commands/` | Core FLI commands | `core` | FLI team |
| `projectRoot/cli/src/routes/` | Project-specific commands | `project` | Each project |

Both are scanned at startup. Project commands override core commands with the same title.

### Core engine files (~2900 LOC)

| File | Role |
|---|---|
| `bin/fli.js` | CLI entrypoint — sets globals, registers loader, sweeps stale `.fli-tmp/`, runs bootstrap |
| `bin/server.js` | Web GUI server entrypoint |
| `bin/diagnose.js` | Self-check tool for the install |
| `core/bootstrap.js` | Parses argv, resolves command, handles `--help` / `list` / search |
| `core/compiler.js` | `.md` → ESM — frontmatter parser, `<script>` extractor, prose-vs-code segments, sourceURL pragma |
| `core/registry.js` | Scans both roots, builds a Map keyed by title and alias, skips `_steps/`, labels source, warns on collisions |
| `core/runtime.js` | Builds context, validates args/flags via `getConfig`, runs command or `_steps/` sequence, manages temp files |
| `core/server.js` | HTTP: `GET /api/commands`, `GET /api/commands/:name`, `POST /api/run/:name` (SSE), 2-second registry cache |
| `core/config.js` | Loads `.fli.json` from `projectRoot` into `global.fliConfig` |
| `core/utils.js` | `logger`, `findFilesPlugin`, `loadEnv`, `loadFrontierConfig`, `findProjectRoot` |
| `core/prose.js` | Prose-driven dry-run — interpolates `context.vars` into prose section |
| `core/ports.js` | Port broker — `[ENV][CATEGORY][PROJECT][SERVICE]` 4-digit scheme, lock file at `~/.fli/sessions.lock` |
| `web/index.html` | Single-file Web GUI — sidebar, segmented form/source view, SSE output, syntax highlighting |
| `web/viewer/index.html` | FJSChain — visual chain-of-responsibility diagram for `project:view` |

### Command file anatomy

```
commands/namespace/name.md
│
├── YAML frontmatter   → title, description, alias, args, flags
├── <script> block     → helper functions, imports (shared across CLI + GUI)
├── prose              → shown in Web GUI source view
└── ```js block        → main body — runs on execute
```

The compiler emits **literate-style segments** — prose and code blocks interleaved, each tracked separately. The Web GUI renders them inline so command source looks like a tutorial: prose explanation, then the code block it explains, then more prose. CLI execution still ignores prose entirely.

### `_steps/` convention

Large commands break into numbered step files sharing `context.config`:

```
commands/deploy/
  index.md            ← orchestrator: sets context.config.stepsDir based on frontier.config.js
  _steps/             ← legacy CapRover deploy
  _steps-docker/      ← Docker/SSH/nginx deploy (default for new apps)
  _steps-rollback/    ← rollback flow
  _steps-setup/       ← first-time server setup
```

The orchestrator sets `context.config.stepsDir = '_steps-docker'` (or another folder) and the runtime dispatches to the right one. Step files share `context.config` mutation so each can read what previous steps set.

**Step abort behavior**: if a step or orchestrator sets `context.config.abort = true`, subsequent steps are skipped without logging their headers. Steps that need to run on abort (cleanup, lock release) opt in via `runOnAbort: true` in their frontmatter.

### Context object

Available as top-level locals in every `js` block:

```js
arg          // positional args by name
flag         // named flags (--dry always present, --debug hidden but present)
log          // log.info / .success / .warn / .error / .dry
context      // full context — .paths .env .exec .execute .config .echo .git .vars
echo()       // ZX stdout, also used by Web GUI to capture command output
question()   // interactive prompt
$``          // ZX shell execution
```

`context.git` provides: `branch()`, `status()`, `isDirty()`, `lastTag()`, `hasChangesSince()`, `isAffected()`, `log()`. Defaults to `paths.root` for the dir but accepts an override.

`context.paths` exposes: `root`, `wiki`, `tests`, `cli`, `api`, `db`, `web`, `webPages`, `webComponents`, `webResources`, `site`, `siteContent`, `siteMedia`, `mobile`, `extension`.

---

## Current command count: 147 commands across 25 namespaces

### Namespaces with `_module.md` (shared helpers)

`auth`, `cloudflare`, `completion`, `db`, `deploy`, `github`, `project`

These provide functions and constants that prepend to every command in the namespace. The runtime loads them once at startup and merges into the compiled output.

### Recent additions (last few sessions)

- **`site:audit`** (alias `audit`) — first-time setup walkthrough for fresh ksite clones. Per-action confirmation, `--force` to bypass `config_ranSetup` guard, `--skip` for category, `--yes` to auto-accept. Cross-platform JS file edits (no `sed -i` hacks).
- **`site:update`** (alias `site-update`) — pulls KSITE_DIR canonical, mirrors framework dirs to local site. `--force` to skip version-gate and dirty-checkout warning, `--no-install` to skip final npm install. Major-version compatibility check between local and canonical site/package.json.
- **`deploy:doctor`** (alias `doctor`) — read-only deploy readiness checker. Local checks (config, Dockerfile, /health route, env reference, git state), Junction-aware checks (`@frontierjs/junction` detection, `/ws` route, proxy_read_timeout reminder), and `--remote` for server-side probes (SSH, required tools, deploy dir, .env.production, container state, lock).
- **`make:fetch-config`** (alias `mkfetchconfig`) — scaffolds a `fetch.config.js` template with all options shown commented-out.
- **`fli:update`** (alias `update`) — monorepo-aware self-update via `git pull` + `bun install` in the fli source tree. `--branch`, `--no-install`, `--no-link` flags.
- **`site:fetch`** (alias `site-fetch`) — sitemap/URL→markdown converter using turndown + linkedom. Validates config (errors abort, warnings continue), prints destination upfront, sitemap-index recursion, namespace-loc filtering, HTTP timeout/retry. Uses `context.paths.siteContent` and `context.paths.siteMedia`.

### Existing namespace breakdown (147 commands)

Top counts: `npm` (14), `db` (14), `utils` (11), `make` (10), `workspace` (8), `git` (7), `env` (6), `caprover` (6), `fli` (6), `web` (5), `site` (5), `api` (4), `browser` (4), and the deploy namespace's 8 commands plus 4 step folders, plus various smaller namespaces (`admin`, `auth`, `cloudflare`, `completion`, `crypto`, `ai`, `fetch`, `github`, `ports`, `project`, `literate`).

---

## Deployment system (deploy:* namespace)

Three modes coexist:

1. **Modern Docker/SSH/nginx** — triggered by `frontier.config.js` having a `deploy` block. Used for new FJS apps, especially Junction.
2. **Legacy CapRover** — fallback when no `deploy` block. Uses `DEV_SERVER`/`STAGE_SERVER`/`PROD_SERVER` env vars.
3. **ksite-specific** — `site:deploy` for static-site projects, separate code path.

### Modern deploy pipeline (10 steps)

| Step | Function | Skippable |
|---|---|---|
| `01-preflight` | SSH check, validate config, acquire `${path}/.deploy.lock`, detect Litestream | no |
| `01b-env-check` | Diff `.env.example` against server's `.env.production` | yes (gated by `envCheck: true`) |
| `02-pull` | `git pull` on server, capture short SHA, set `imageTag = ${appId}:${commit}` | no |
| `03-build-web` | `bun build` on server, copy `dist/` → `releases/${commit}/`, merge previous release's hashed assets, prune | yes (gated by `web: false`) |
| `04-build-api` | `docker build -t ${imageTag} -f ${dockerfile} .` on server | no |
| `05-backup` | `sqlite3 .backup` of prod DB → timestamped file, prune old | yes (gated by `db.backup: false`) |
| `06-swap` | Rename old container to `_replaced`, stop with `--time 10`, start new one with mounts and env-file | no |
| `07-health` | Poll `/health` for 20s — auto-rolls back to `_replaced` on failure | no |
| `08-release-web` | Atomic symlink swap `current → releases/${commit}`, `nginx -s reload` | yes (gated by `web: false`) |
| `09-cleanup` | Remove `_replaced` container, prune images, release deploy lock — runs on abort too via `runOnAbort: true` | always |

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

`fli deploy` (alias for `deploy:all`), `fli deploy:doctor`, `fli deploy:local`, `fli deploy:setup`, `fli deploy:status`, `fli deploy:logs`, `fli deploy:run`, `fli deploy:rollback`. `fli make:deploy` to scaffold the Dockerfile, deploy block, and health endpoint hint.

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
   (or: fli env:set --remote KEY=value)

7. fli deploy:doctor --remote
   → server-side probes: SSH, tools, deploy dir, env keys, container, lock

8. fli deploy
   → runs the 9 docker steps. ~30-60s. Auto-rollback on failure.
```

---

## Test suite

**150/150 passing across 8 test files. 2,500+ expect() calls.**

| File | Tests | What it covers |
|---|---|---|
| `tests/compiler.test.js` | 35 | `extractFrontmatter`, `transformMarkdown`, `compileCli`, `extractSegments`, echo context shadowing |
| `tests/runtime.test.js` | 15 | `getConfig` — arg/flag validation, short-chars, options enum, deep-clone, defaultFlags isolation |
| `tests/registry.test.js` | 18 | Dual-root scanning, source labelling, `_steps/` exclusion, `fli list --json`, alias/title collision warns |
| `tests/server.test.js` | 25 | API endpoints, SSE streaming, CORS, segments shape in metadata, registry cache TTL |
| `tests/config.test.js` | 10 | `loadConfig` / `getConfig` — no file, merge, partial, malformed JSON |
| `tests/zz-steps.test.js` | 8 | All `_steps/` execution scenarios |
| `tests/deploy-helpers.test.js` | 24 | `resolveTarget`, `resolveDeployConf`, `loadFrontierConfig` |
| `tests/deploy-dispatch.test.js` | 17 | End-to-end fixture-based dispatch logic for docker vs legacy mode |

Run: `bun test` (or `npm test` for the explicit pre-batch order).

---

## Web GUI

**Port:** 8500 (override: `FLI_PORT=8080`)  
**Start:** `fli gui` or `bun bin/server.js`

Layout:
- Collapsible sidebar with core/project split, namespace grouping, command palette (`Ctrl+K`/`Cmd+K`), live search
- Form panel with auto-generated forms from frontmatter (args → inputs, booleans → toggles)
- Resizable output panel with SSE streaming, color-coded by log level
- Three themes (Mesa, Dark, Light)
- Source view (collapsible) with **literate segments** — prose and code blocks interleaved, prose rendered via `mdToHtml`, code via single-pass syntax highlighter
- ⎘ copy cmd button — builds full CLI string from current form state
- Sidebar refresh after `done` event

API: `GET /api/commands`, `GET /api/commands/:name` (with segments), `POST /api/run/:name` (SSE).

---

## Configuration

### `.fli.json` (project root)

```json
{
  "routesDir":        "cli/src/routes",
  "defaultNamespace": "hello",
  "editor":           "code"
}
```

### Environment variables

```bash
# FLI behaviour
FLI_PORT=8500              # Web GUI port
FLI_DEBUG=1                # Enable full stack traces (or pass --debug)
WORKSPACE_DIR=~/outlaw     # Workspace root (all ws-* commands)
KSITE_DIR=~/.../ksite      # Local clone of canonical ksite (for site:update)
ANTHROPIC_API_KEY=sk-...

# Project directories (override defaults)
WEB_DIR=web
API_DIR=api
DB_DIR=db
SITE_DIR=site
CLI_DIR=cli

# Server targets (legacy CapRover deploys + utils:ssh)
DEV_SERVER, DEV_SERVER_PATH
STAGE_SERVER, STAGE_SERVER_PATH
PROD_SERVER, PROD_SERVER_PATH

# CapRover (caprover:* commands)
DEV_CAPTAIN, CAPROVER_URL, CAPROVER_TOKEN
```

### Port schema

`[ENV][CATEGORY][PROJECT][SERVICE]` 4-digit structure. ENV: 7=test, 8=dev, 9=prod. Global tooling on `8500` (gui), `8501` (pview), `8502` (studio). Dynamic project ports assigned at runtime via `~/.fli/sessions.lock` with O_EXCL file lock for atomicity.

### Temp files

Compiled command shims live at `<fliRoot>/.fli-tmp/<pid>/c_*.mjs`. Created lazily on first compile, removed on exit. Stale-PID sweep at every fli startup. `.gitignore` includes `.fli-tmp/` and the legacy `.__fli_*.mjs` pattern.

---

## Recent engine improvements (worth knowing about)

These were the substantive runtime changes in recent sessions, in case behavior elsewhere depends on them:

1. **`getConfig` deep-clones `defaultFlags` per-call.** Previously a process-wide leak — setting `--step 99` in one call leaked into all subsequent calls. Affected web GUI sessions running multiple commands sequentially.
2. **`getConfig` per-key-merges command flags with defaults.** A command can re-declare `dry` to add its own description without losing inherited `char: 'd'` from defaultFlags. Without this, short-flag resolution silently broke for any command that re-declared a default flag.
3. **Step abort honored before logging.** When `context.config.abort = true`, subsequent steps don't log their `[N/M] step-name` header. Cleanup steps opt back in via `runOnAbort: true`. Silently fixed the "stuck step header" output in `deploy:status`, `deploy:logs`, and any other `deploy:*` command that early-exits.
4. **Server registry cached for 2 seconds.** Sidebar load + meta fetch + run share one filesystem scan instead of three.
5. **`bootstrap.js` doesn't import `zx/globals`.** Saves ~100ms cold start on read-only commands (`fli list`, `fli help`, search). Compiled commands still import it themselves.
6. **`compileCli` emits a `sourceURL=file://...` pragma** so Node stack traces reference the `.md` file, not the temp shim. Bun ignores this — known limitation.
7. **`loadEnv` accepts `{override: true}`** for project `.env` to win over global `~/.config/fli/.env`. Handles multi-line quoted values and `\n \r \t` escapes inside double quotes.
8. **Atomic `claimSession`** via O_EXCL guard file to prevent two concurrent fli processes from claiming the same project ID. Stale guard files reclaimed via PID liveness probe.
9. **Bounded module cache** (256-entry LRU) so long-running GUI sessions don't accumulate stale entries from edited files.
10. **`findFreeServicePort`** probes all 10 service slots in parallel via `Promise.all`. ~10× faster on cold scans.

---

## Known issues / pending notes

| Item | Status | Priority |
|---|---|---|
| `sourceURL` pragma works on Node, ignored on Bun | partial | low |
| Frontmatter regex non-greedy but breaks on stray `---` in body | deferred | very low |
| Registry's `mod.prose` leftover from before segments refactor | cosmetic | very low |
| `utils:qrcode` requires `npm install qrcode` | known | low |
| `fli dev` port-broker orchestration | designed, not implemented | medium |
| TUI interface | planned | medium |

All previously-pending test fixes (deploy-helpers, deploy-dispatch, zz-steps) are resolved. All carryover engine bugs from past sessions are resolved.

---

## On the horizon

1. **`fli dev` orchestrator** — reads `.fli.json` for required service categories, uses port broker to start them. Infrastructure is in place; needs the user-facing command + config conventions.
2. **`fli init`** — bootstrap experience for new contributors. Currently it's "clone, cd packages/cli, bun install, bun link" — could be a one-shot command.
3. **TUI** — full-screen Ink shell vs. `--interactive` flag wizard mode. Open question.
4. **Test namespace** (`fli test:plan` / `fli test:run`) — turning the "tests as canonical AI context" workflow into actual fli commands.
5. **`fli make:command` review** — should be checked for compatibility with the literate-segments style.
6. **README** — none of the deep accumulated knowledge is user-facing yet. Would help with onboarding.
7. **Cold start ~225ms** — mostly Bun warmup. `bun build --compile` would cut this dramatically once the API surface stabilizes.

---

## Dev setup

```bash
cd packages/cli
bun install
bun link          # makes `fli` available globally
fli gui           # Web GUI at http://localhost:8500
```

```bash
# Recommended .env additions
WORKSPACE_DIR=~/outlaw
KSITE_DIR=~/.../ksite-canonical
ANTHROPIC_API_KEY=sk-...
```

---

## Approach & patterns

- **Iterative, file-driven sessions**: zip uploads, run commands immediately, paste errors back, expect targeted fixes.
- **State doc as handoff artifact**: this file is the source of truth carried forward to each new session.
- **Concise communication preference**: "caveman mode" available via skill file when detail isn't needed.
- **Namespace consistency enforced**: all workspace aliases use colon format (`ws:*`), all tooling ports in `85xx` range.
- **Verify before assuming**: redirect when about to write against an unknown format. The runtime has multiple cases where this prevented hours of debugging (litestone JSON Schema, Bun ESM cache semantics, frontmatter edge cases).

## Tools & resources

- **Runtime**: Bun, ZX globals (only in compiled commands), `bunx` for package execution
- **Frontend**: Svelte (resources/routes), Ink (planned TUI)
- **Testing**: `bun test` (built-in), Playwright for E2E elsewhere, `bunx litestone` for JSON Schema validation
- **Visualization**: FJSChain (compiled JSX → plain JS, self-contained HTML viewer)
- **Port management**: `core/ports.js` with lock manager at `~/.fli/sessions.lock`
- **Deploy infrastructure**: SSH + Docker + nginx, no external platform required (CapRover is legacy fallback only)
- **Monorepo scope**: `@frontierjs`
