# FLI — Project State

**Version:** 0.1.6  
**Runtime:** node (the shipped shebang); re-invokes itself under whichever
runtime started the parent, which is bun for every test and CI call here  
**Package name:** `@frontierjs/cli` (global binary via `bun link`, command: `fli`)  
**Scope:** `@frontierjs`  
**Repo location:** `packages/cli` inside the FJS monorepo

---

## What FLI is

A modular CLI automation platform where every command is a plain `.md` file, compiled to JavaScript and run — drop a file, it is discovered by the next invocation. The same command files power two interfaces:

- **CLI** — `fli <command> [args] [flags]`
- **Web GUI** — `fli gui` → `http://localhost:8500`

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
| `bin/fli.js` | CLI entrypoint — sets globals, sweeps stale `.fli-tmp/`, runs bootstrap. Deliberately no `.md` loader hook — `module.register()` starts a hooks thread, and nothing imports a `.md` directly |
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
| `web/index.html` | Single-file Web GUI — sidebar, form/source view, SSE output. Written in `@frontierjs/css` |
| `web/viewer/index.html` | FJSChain — chain-of-responsibility diagram for `project:map --as=serve`. Written in `@frontierjs/css` |
| `core/assets.js` | The styling language and the highlighter a browser gets, from the copy this fli holds |

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

`context.git` provides: `branch()`, `status()`, `isDirty()`, `lastTag()`, `hasChangesSince()`, `isAffected()`, `log()`, `remote()`, `ahead()`, `behind()`, `repoRoot()`, `pkgState()`. Defaults to `paths.root` for the dir but accepts an override.

`context.paths` exposes: `root`, `wiki`, `tests`, `cli`, `api`, `db`, `web`, `webPages`, `webComponents`, `webResources`, `site`, `siteContent`, `siteMedia`, `mobile`, `extension`.

### Workspace context

Three helpers for the `ws:*` commands, all on `context`:

| Helper | Answers |
|---|---|
| `wsRoot()` | where the monorepo is — the workspace cwd is standing in, else `$WORKSPACE_DIR`, else a prompt |
| `wsPackages()` | `{ wsRoot, packages }`, each `{ dir, folder, path, pkg }`, read from `packages/*` |
| `wsRepo(packages)` | the shared git repo root when every member lives in ONE repo, `null` when each has its own |

`git.pkgState(name, dir)` is the fourth: `{ lastTag, commits, files, affected, dirty }` for a single package. Both of the questions it answers are asked with a pathspec and a `<name>@<version>` tag lookup, because `git status` and `git describe` run from a package directory describe the whole repo — which is why every member used to report the same tag and the same dirty flag.

---

## Current command count

`fli list --json` names them all — around 210, across the namespaces `fli list` groups by.

### Namespaces with `_module.md` (shared helpers)

`auth`, `cloudflare`, `completion`, `db`, `deploy`, `github`, `project`, `workspace`

These provide functions and constants that prepend to every command in the namespace. The runtime loads them once at startup and merges into the compiled output.

### Namespace breakdown

`fli list` groups every command by namespace; the tally there is the one to
trust rather than a number typed here.

---

## Deployment system (deploy:* namespace)

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

## Test suite

One file per module under `core/` plus the deploy-pipeline layer (`plan`,
`journal`, `revert`, `machine`, `deploy-scripts`); see `package.json`'s `test`
script for the explicit list — it is not a glob, so a new file runs nowhere
until it is named there. Run: `bun run test`.

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
# FLI behavior
FLI_PORT=8500              # Web GUI port
FLI_DEBUG=1                # Enable full stack traces (or pass --debug)
WORKSPACE_DIR=~/outlaw     # Workspace root (all ws-* commands)
KSITE_DIR=~/.../ksite      # Local clone of canonical ksite (for ksite:update)
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

`[ENV][CATEGORY][PROJECT][SERVICE]` 4-digit structure. ENV: 7=test, 8=dev, 9=prod. Global tooling reserves `8500`–`8509` whole: `8500` (gui), `8501` (project map, served), `8502` (studio), `8503` (junction devtools). Dynamic project ports assigned at runtime via `~/.fli/sessions.lock` with O_EXCL file lock for atomicity.

### Startup cost

A read-only invocation (`fli list`, `help`, `?`, completion) is ~119ms where it was ~306ms, measured as 10 runs of each. Three things paid for that and each is a rule, not a tweak:

- **No `.md` loader hook.** `module.register()` starts a hooks thread — 56ms — and nothing imports a `.md`; the runtime compiles with the namespace module script and imports the shim.
- **No zx on the read-only path.** ~85ms for chalk. `core/color.js` is the ANSI subset those paths use; `bootstrap.js` imports `runtime.js` at the call site so a `fli list` does not pull zx in through it. A command body still gets the real zx from its own shim, so nothing a command author writes changes.
- **The registry cache** — see below.

A command that actually runs still pays zx once (~206ms for `crypto:keygen`), because its shim imports `zx/globals`.

### Registry cache

`buildRegistry()` used to read and frontmatter-parse ~200 files on every invocation, including on every press of Tab. It now caches one parsed block per file at `~/.fli/cache/registry-<digest>.json`, keyed by mtime+size: a run stats what the walk finds and parses only what moved. ~13-23ms → ~4-7ms.

Discovery still walks the directories — a cached file list would not notice a new command, and "drop a file, it runs" is the authoring model. The cache lives under `~/.fli/` for the same reason the temp root does. `FLI_NO_CACHE=1` bypasses it for one run; `fli completion:refresh` drops it via `clearRegistryCache()`. Invalidation is held by 4 tests in `tests/registry.test.js`.

### Temp files

Compiled command shims live at `<fliRoot>/.fli-tmp/<pid>/c_*.mjs`. Created lazily on first compile, removed on exit. Stale-PID sweep at every fli startup. `.gitignore` includes `.fli-tmp/` and the legacy `.__fli_*.mjs` pattern.

`fliTmpRoot()` in `core/utils.js` decides the location and is the only thing that does — a shim imports `zx/globals` by bare specifier, so it has to sit where Node's resolver can reach a `node_modules`. When fliRoot is not writable (a global install under a root-owned prefix, where every command used to die on the first mkdir) the session moves to `$TMPDIR/fli-<digest of fliRoot>/` with `node_modules` symlinked back at the install's. `sweepStaleTmp()` is the other half; it reaps `<pid>` and the suites' `test-<pid>` alike.

---

## Known issues — see `ISSUES.md`

Open defects for this package are filed there, one id each; nothing is open
unless it is there. Add a new item to `../../ISSUES.md`, not here.

## On the horizon

`fli dev`, `fli init`, `fli test:*` and this package's own README all shipped
since this list was last true. What is left is whatever `ISSUES.md` and
`IDEAS/` still carry against this package — check those rather than this
section.

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

- **Runtime**: node's shebang, re-invoked under whichever runtime started the parent (bun in this repo's own scripts and tests); ZX globals only in compiled commands
- **Frontend**: `web/index.html` — a single-file GUI written in `@frontierjs/css`, no framework dependency
- **Testing**: `bun test`, plus `bun run test:browser` (mesa's CDP harness) for the GUI
- **Visualization**: FJSChain — plain HTML/JS in `@frontierjs/css`, served with no network
- **Port management**: `core/ports.js` with lock manager at `~/.fli/sessions.lock`
- **Deploy infrastructure**: SSH + Docker + nginx, no external platform required (CapRover is legacy fallback only)
- **Monorepo scope**: `@frontierjs`
