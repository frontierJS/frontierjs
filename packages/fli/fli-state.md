# FLI — Project State

**Version:** 0.1.0  
**Runtime:** Bun  
**Package name:** `fli` (global binary via `bun link`)  
**Scope:** `@frontierjs`  
**Repo:** `~/outlaw/packages/fli` (or standalone)  
**Last updated:** April 2026

---

## What FLI is

A modular CLI automation platform where every command is a plain `.md` file. Commands are live — drop a file, it runs. No compilation, no rebuilding. The same command files power three interfaces:

- **CLI** — `fli <command> [args] [flags]`
- **Web GUI** — `fli gui` → `http://localhost:4444`
- **TUI** — planned

---

## Architecture

### Two command roots

| Root | Path | Label | Who adds them |
|---|---|---|---|
| `fliRoot/commands/` | Core FLI commands | `core` | FLI team |
| `projectRoot/cli/src/routes/` | Project-specific commands | `project` | Each project |

Both are scanned at startup. Project commands override core commands with the same title.

### Core files

| File | Role |
|---|---|
| `bin/fli.js` | CLI entrypoint — sets roots, registers loader, runs bootstrap |
| `bin/server.js` | Web GUI server entrypoint |
| `bin/diagnose.js` | Standalone diagnostics script — checks env, paths, loader |
| `core/bootstrap.js` | Parses argv, resolves command, handles `--help` and `list --json` |
| `core/compiler.js` | `.md` → ESM — extracts frontmatter, script block, main `js` block |
| `core/registry.js` | Scans both roots, builds a `Map`, skips `_steps/`, labels source |
| `core/runtime.js` | Builds context, validates args/flags, runs command or `_steps/` sequence |
| `core/server.js` | HTTP: `GET /api/commands`, `GET /api/commands/:name`, `POST /api/run/:name` (SSE) |
| `core/config.js` | Loads `.fli.json` from `projectRoot` into `global.fliConfig` |
| `core/ports.js` | Port schema, formula, socket probe, lock manager, session lifecycle |
| `core/prose.js` | Terminal markdown renderer with `{{var}}` interpolation for dry-run output |
| `core/utils.js` | `logger`, `findFilesPlugin`, `loadFrontierConfig` |
| `web/index.html` | Single-file Web GUI — sidebar, form generation, SSE output, syntax highlighting |

### Command file anatomy

```
commands/namespace/name.md
│
├── YAML frontmatter   → title, description, alias, args, flags
├── <script> block     → helper functions, imports (shared across CLI + GUI)
├── prose              → shown in Web GUI source view; dry-run rendered in terminal
└── ```js block        → main body — runs on execute
```

### `_module.md` convention

Namespaces with shared helpers use a `_module.md` file. It carries a `namespace:` and `description:` in frontmatter and a `<script>` block with constants and utilities loaded into scope for every command in that namespace. The file is not a runnable command (excluded from `fli list`).

Namespaces currently using `_module.md`: `auth`, `cloudflare`, `completion`, `db`, `deploy`, `github`, `project`.

The `project` namespace `_module.md` also documents litestone JSON Schema extensions: `x-gate` (per-operation gate levels on model entries) and `x-relations` (array of related model refs) — both now confirmed in litestone output and consumed by `project:map` and `project:view`.

`project:view` serves `FJSChain.jsx` (located at `web/viewer/FJSChain.jsx` in fliRoot) as a self-contained HTML page via a local HTTP server. Refreshing the browser tab regenerates the map live from current files. Falls back to `basecamp/src/components/chain/FJSChain.jsx` in the project root if present.

### `_steps/` convention

Large commands break into numbered step files sharing `context.config`:

```
commands/npm/release/
  index.md            ← orchestrator: sets context.config, runs first
  _steps/
    01-test.md        ← skip: "context.config.noTest"
    02-build.md       ← optional: true
    03-version.md
    04-publish.md
    05-push.md        ← skip: "flag.dry"
```

```bash
fli release patch          # all steps
fli release patch --dry    # step 5 auto-skips
fli release patch --step 3 # re-run step 3 only
```

Named step directories (`_steps-docker/`, `_steps-rollback/`, `_steps-setup/`) are supported — the orchestrator selects which directory to run based on runtime conditions.

### Context object

Available as top-level locals in every `js` block:

```js
arg          // positional args by name
flag         // named flags (--dry always present)
log          // log.info / .success / .warn / .error / .dry
context      // full context — .paths .env .exec .execute .config .echo .git
echo()       // ZX stdout
question()   // interactive prompt
$``          // ZX shell execution
```

### `frontier.config.js`

Projects that use the Docker-based deploy pipeline define a `frontier.config.js` in their project root. FLI reads it via `loadFrontierConfig(root)` (in `core/utils.js`). The `deploy` block configures server targets, Dockerfile paths, health endpoints, nginx config, and per-environment overrides. `make:deploy` scaffolds this file interactively.

---

## Current command count: 140

### Core commands (in `commands/`)

#### `admin` (1)
| Command | Alias | Description |
|---|---|---|
| `admin:generate` | `admin-gen` | Generate a gate-aware CRUD admin UI from schema.lite — list, detail, create, edit per model |

#### `ai` (1)
| Command | Alias | Description |
|---|---|---|
| `ai:ask` | `ask` | Ask Claude — streams response, supports `--file`, `--system`, `--model` |

#### `api` (4)
| Command | Alias | Description |
|---|---|---|
| `api:deploy` | `api-deploy` | Deploy API via SSH — prod/stage/dev env branching |
| `api:dev` | `api-dev` | Start the API dev server |
| `api:model` | — | Feathers model file — delegate to `make:model` |
| `api:service` | — | Feathers service generator — delegate to `make:service` |

#### `auth` (5)
| Command | Alias | Description |
|---|---|---|
| `auth:create-user` | `create-user` | Create a user directly in the database — no running server needed |
| `auth:install` | `auth-install` | Install FJS native authentication — injects schema models, generates keys, scaffolds auth.ts |
| `auth:list-users` | `list-users` | List users in the database |
| `auth:revoke-sessions` | `revoke-sessions` | Revoke all active sessions for a user — forces re-login on all devices |
| `auth:rotate-key` | `rotate-key` | Rotate the ENCRYPTION_KEY — re-encrypts all @secret fields in the database |

#### `browser` (4)
| Command | Alias | Description |
|---|---|---|
| `browser:captain` | `captain` | Open `$DEV_CAPTAIN` in browser |
| `browser:live` | `live` | Open `$LIVE_SITE_URL` |
| `browser:open` | `open` | Open any URL |
| `browser:servers` | `servers` | Open `$SERVERS_URL` |

#### `caprover` (6)
| Command | Alias | Description |
|---|---|---|
| `caprover:backup` | `cap-backup` | Trigger app backup via API |
| `caprover:create` | `cap-create` | Register new app on captain server |
| `caprover:login` | `cap-login` | Login with config file |
| `caprover:setup` | `cap-setup` | Run server setup wizard |
| `caprover:ssl` | `cap-ssl` | Enable/renew SSL |
| `caprover:update` | `cap-update` | Deploy app from local directory |

#### `cloudflare` (5)
| Command | Alias | Description |
|---|---|---|
| `cloudflare:dns` | `cf:dns` | List, add, update, or delete DNS records for a zone |
| `cloudflare:pages` | `cf:pages` | List, create, and manage Cloudflare Pages projects |
| `cloudflare:purge` | `cf:purge` | Purge Cloudflare cache — everything or specific URLs |
| `cloudflare:workers` | `cf:workers` | List Workers scripts in your Cloudflare account |
| `cloudflare:zones` | `cf:zones` | List all zones (domains) in your Cloudflare account |

#### `completion` (4)
| Command | Alias | Description |
|---|---|---|
| `completion:generate` | `cgen` | Print the shell completion script — pipe into your shell config to install |
| `completion:install` | `ci` | Add fli tab completion to your shell — one-time setup |
| `completion:query` | `cq` | Return completions for the current command line (called by shell on Tab) |
| `completion:refresh` | `cr` | Clear and rebuild the completion cache |

#### `crypto` (1)
| Command | Alias | Description |
|---|---|---|
| `crypto:keygen` | `keygen` | Generate cryptographic keys/secrets |

#### `db` (15)
| Command | Alias | Description |
|---|---|---|
| `db:backup` | `db-backup` | Timestamped sqlite backup to `db/backups/` |
| `db:columns` | `db-columns` | List columns for a table |
| `db:db` | `db` | Open an interactive sqlite3 shell or run a query |
| `db:download` | `db-download` | SCP production db from server |
| `db:import` | `db-import` | **5-step:** remote backup → scp → restore → extras |
| `db:jsonschema` | `db-jsonschema` | Generate JSON Schema from schema.lite |
| `db:migrate` | `db-migrate` | Create and apply a migration file from schema changes |
| `db:pull` | `db-pull` | Introspect a live database and generate schema.lite |
| `db:push` | `db-push` | Apply schema.lite changes directly — no migration file |
| `db:reset` | `db-reset` | **3-step:** rm file → migrate reset → push schema |
| `db:schema` | `make-schema` | Append a Prisma model stub to schema.prisma |
| `db:seed` | `db-seed` | Run db seeder — `db/seeders/seed.ts` |
| `db:status` | `db-status` | Show pending migrations and verify schema match |
| `db:studio` | `studio` | Open Litestone Studio in the browser |
| `db:tables` | `db-tables` | List tables or table sizes |

#### `deploy` (7)
| Command | Alias | Description |
|---|---|---|
| `deploy:all` | `deploy` | **Multi-step:** deploy to server via SSH — auto-detects env from git branch; falls back to legacy CapRover or Docker pipeline based on `frontier.config.js` |
| `deploy:local` | `dlocal` | Build and run the API Docker image locally — validates before deploying |
| `deploy:logs` | `dlogs` | Stream or show logs from the running API container on the server |
| `deploy:rollback` | `rollback` | **3-step:** roll back web and API to the previous release |
| `deploy:run` | `drun` | Run a one-off command inside the running API container on the server |
| `deploy:setup` | `setup-server` | **7-step:** check server and walk through making it ready for `fli deploy` |
| `deploy:status` | `dstatus` | Show running containers, web release, disk usage, and last deploy info |

#### `env` (6)
| Command | Alias | Description |
|---|---|---|
| `env:copy` | `ecopy` | `.env` → `.env.example` with values stripped |
| `env:delete` | `edel` | Remove a key from `.env` |
| `env:get` | `eget` | Read a value from `.env` |
| `env:list` | `elist` | List all keys (values masked by default) |
| `env:pull` | `epull` | Pull from caprover / url / gist / ssh / file into `.env` |
| `env:set` | `eset` | Set or update a key in `.env` |

#### `fetch` (2)
| Command | Alias | Description |
|---|---|---|
| `fetch:image` | `fimg` | Fetch URL, return blob info |
| `fetch:json` | `fget` | Fetch URL, return JSON — `:3000/path` localhost shorthand |

#### `fli` (7)
| Command | Alias | Description |
|---|---|---|
| `fli:doctor` | `doctor` | Check FLI setup — env vars, dependencies, namespace requirements |
| `fli:edit` | `edit` | Open a command file in `$EDITOR` |
| `fli:env` | `config` | Open global FLI env file (`~/.config/fli/.env`) |
| `fli:gui` | `gui` | Start Web GUI on port 4444 |
| `fli:init` | `init` | Scaffold `cli/src/routes/` in current project |
| `fli:setup` | `setup` | Show setup instructions for adding fli to PATH |
| `fli:update` | `update` | `git pull + bun install` in fliRoot |
| `fli:validate` | `validate` | Cross-realm integrity check — services → models, resources → services, routes → resources, env vars |

#### `git` (7)
| Command | Alias | Description |
|---|---|---|
| `git:changelog` | `changelog` | Generate `CHANGELOG.md` from conventional commits |
| `git:commit` | `gc` | Conventional commit interactive prompt |
| `git:pull` | `gpl` | Pull with branch info |
| `git:push` | `gp` | Push to origin |
| `git:release` | `gr` | Tag + changelog + push |
| `git:stash` | `gstash` | Stash / pop / list |
| `git:status` | `gs` | Clean status summary |

#### `github` (3)
| Command | Alias | Description |
|---|---|---|
| `github:clone` | `gh:clone` | Clone a GitHub repository |
| `github:create` | `gh:create` | Create a new GitHub repository from a template |
| `github:prs` | `gh:prs` | List open pull requests for the current or specified repo |

#### `make` (9)
| Command | Alias | Description |
|---|---|---|
| `make:command` | `new` | Scaffold new FLI `.md` command interactively |
| `make:component` | `mkc` | Svelte component in `src/components/` |
| `make:deploy` | `mkdeploy` | Scaffold deployment artifacts — Dockerfile, `frontier.config.js`, health endpoint |
| `make:model` | `mkmodel` | Append a model block to schema.lite — optionally scaffold service + resource |
| `make:resource` | `mkresource` | Svelte resource component (full Frontier template) |
| `make:route` | `mkroute` | Svelte route — composable `--resource` `--component` `--open` |
| `make:scaffold` | `scaffold` | Full vertical slice — schema stanza + service + resource + 4 CRUD routes in one shot |
| `make:schema` | `mkschema` | Alias for `make:model` |
| `make:service` | `mksvc` | Scaffold a Junction service file in `api/src/services/` |

#### `npm` (14)
| Command | Alias | Description |
|---|---|---|
| `npm:audit` | `audit` | Security audit — `--fix` supported |
| `npm:info` | `ninfo` | Registry metadata, `--versions` |
| `npm:install` | `ni` | Install deps — `--frozen` for ci mode |
| `npm:link` | `npm-link` | Link/unlink local package |
| `npm:login` | `npm-login` | Login with optional `--scope` |
| `npm:outdated` | `outdated` | Show outdated deps |
| `npm:publish` | `pub` | Publish — `--tag` `--otp` `--access` |
| `npm:release` | `release` | **5-step:** test → build → version → publish → push |
| `npm:run` | `nr` | Run any npm script |
| `npm:size` | `pkgsize` | Bundle size via bundlephobia API |
| `npm:tag` | `tag` | Manage dist-tags — add / remove / list |
| `npm:unpublish` | `unpub` | Unpublish with confirmation prompt |
| `npm:version` | `version` | Bump version — patch/minor/major/prerelease |
| `npm:whoami` | `whoami` | Show logged-in npm user |

#### `project` (2)
| Command | Alias | Description |
|---|---|---|
| `project:map` | `pmap` | Structural snapshot of the FJS project — schema models/enums, services with hooks, resources, migrations |
| `project:view` | `pview` | Serve FJSChain — visual chain-of-responsibility map of the project — in the browser |

#### `ports` (2)
| Command | Alias | Description |
|---|---|---|
| `ports:dev` | `dev` | Claim a port session for the current project and inject `FLI_PORT_*` env vars |
| `ports:status` | `ps` | Show all active FLI port sessions and their status; `--clean` prunes stale entries |

#### `site` (3)
| Command | Alias | Description |
|---|---|---|
| `site:clone` | `clone` | Clone from `github.com/kobamisites` into `$SITES_DIR` |
| `site:deploy` | `site-deploy` | `npm run deploy:site` |
| `site:serve` | `serve` | Serve `dist/client/` with npx serve |

#### `utils` (12)
| Command | Alias | Description |
|---|---|---|
| `utils:check-deps` | `check-deps` | `npx npm-check-updates` |
| `utils:dev` | `dev` | Smart dev server — bun if `bun.lockb` exists, else npm |
| `utils:diff-env` | `diff-env` | Diff `.env` against project template defaults |
| `utils:killnode` | `kill` | `killall node` |
| `utils:note` | `note` | Scaffold a dated `.md` note in cwd |
| `utils:pack` | `pack` | Zip a folder, excluding media and build artifacts by default |
| `utils:password` | `password` | Hash with `crypto.scrypt` or generate random hex secret |
| `utils:qrcode` | `qrcode` | QR code from URL (requires `qrcode` npm package) |
| `utils:ssh` | `ssh` | SSH to dev/stage/prod from env vars |
| `utils:tunnel` | `tunnel` | Run cloudflared tunnel |
| `utils:vpn` | `vpn` | WireGuard up/down/status |
| `utils:zip` | `zip` | `npm run zip` |

#### `web` (6)
| Command | Alias | Description |
|---|---|---|
| `web:build` | `web-build` | `NODE_ENV=production npm run build` |
| `web:component` | — | Delegate to `make:component` |
| `web:deploy` | `web-deploy` | Deploy the web app to a remote server via SSH |
| `web:dev` | `web-dev` | `npm run dev` in web dir |
| `web:resource` | — | Delegate to `make:resource` |
| `web:route` | — | Delegate to `make:route` |

#### `workspace` (13)
| Command | Alias | Description |
|---|---|---|
| `workspace:add` | `ws:add` | Move/copy a repo into `packages/`, scope to `@frontierjs` |
| `workspace:changed` | `ws:changed` | List packages that have changed since their last git tag |
| `workspace:clean` | `ws:clean` | Delete build artifacts across all workspace packages |
| `workspace:exec` | `ws:exec` | Run a shell command in every package directory |
| `workspace:graph` | `ws:graph` | Show the dependency graph between workspace packages |
| `workspace:init` | `ws:init` | Scaffold `~/outlaw/` monorepo root |
| `workspace:install` | `ws:install` | `bun install` at workspace root |
| `workspace:link` | `ws:link` | Write `workspace:*` dep between two packages |
| `workspace:list` | `ws:list` | Show all packages, versions, interdependencies |
| `workspace:publish` | `ws:pub` | **3-step:** version all → publish all → push all |
| `workspace:run` | `ws:run` | Run script across packages — `--filter` `--parallel` `--affected` |
| `workspace:status` | `ws:status` | Git status across all packages — branch, ahead/behind, dirty files |
| `workspace:version` | `ws:version` | Bump versions across workspace packages without publishing |

### Project commands (in `cli/src/routes/`)

| Command | Alias | Description |
|---|---|---|
| `hello:exec` | `lsd` | Demo: list files (tests exec + dry) |
| `hello:greet` | `greet` | Demo: greeting with args and flags |

---

## Multi-step commands

Step pipelines in core:

| Command | Steps dir | Count | What it does |
|---|---|---|---|
| `npm:release` | `_steps/` | 5 | test → build → version → publish → git push |
| `workspace:publish` | `_steps/` | 3 | version all → publish all → push all |
| `db:reset` | `_steps/` | 3 | rm db file → migrate reset → push schema |
| `db:import` | `_steps/` | 5 | mkdir → ssh backup → scp → restore → ela.prod extras |
| `deploy:all` | `_steps/` | 3 | deploy api → deploy web → report time (legacy CapRover path) |
| `deploy:all` | `_steps-docker/` | 9 | preflight → env-check → pull → build-web → build-api → backup → swap → health → cleanup (Docker path) |
| `deploy:rollback` | `_steps-rollback/` | 3 | rollback web → rollback api → report |
| `deploy:setup` | `_steps-setup/` | 7 | check deps → install deps → directories → repo → nginx → ssl → report |

The orchestrator in `deploy:all/index.md` selects `_steps-docker/` when `frontier.config.js` is present, otherwise falls back to `_steps/`.

---

## Port brokering (`core/ports.js`)

**Fully implemented.** FLI acts as a runtime port broker — claims, tracks, and injects ports as env vars.

### Port schema

```
[ENV][CATEGORY][PROJECT][SERVICE]

ENV       7=test  8=dev  9=prod
CATEGORY  0=fe  1=be  2=widgetDev  3=widgetServe  4=ext  5=tooling
PROJECT   0–9  (dynamically assigned per project name)
SERVICE   0–9  (per-project slot within a category)

Examples:
  8000  →  dev / fe      / project 0 / service 0
  8100  →  dev / be      / project 0 / service 0
  8010  →  dev / fe      / project 1 / service 0

Global tooling (project-local, fixed slots within 85xx):
  8500  →  fli gui       (web GUI)
  8501  →  fli pview     (FJSChain project viewer)
  8502  →  db studio
```

### Key exports

| Export | Description |
|---|---|
| `port(category, { env, projectId, serviceId })` | Derive port number from components |
| `decode(p)` | Decode port number back into components |
| `isPortInUse(p)` | Socket probe — returns a Promise\<boolean\> |
| `findFreeServicePort(category, env, projectId)` | Scan service slots 0–9 for a free port |
| `claimSession(name, env, categories)` | Register project, assign ports, write lock, inject env vars |
| `releaseSession(name)` | Remove a session from the lock file |
| `autoRelease(name)` | Register exit/SIGINT/SIGTERM handlers to auto-clean |
| `getSessionStatus()` | List all sessions with alive/stale flag |
| `readLock()` | Read `~/.fli/sessions.lock` (JSON) |

Sessions are stored in `~/.fli/sessions.lock`. On `claimSession`, ports are injected into `process.env` so child processes inherit them (`FLI_PORT_FE`, `FLI_PORT_BE`, etc.). Stale sessions (dead PIDs) are evicted on next claim.

---

## Test suite

**8 test files** across the full stack:

| File | What it covers |
|---|---|
| `tests/compiler.test.js` | `extractFrontmatter`, `transformMarkdown`, `compileCli`, echo context shadowing |
| `tests/runtime.test.js` | `getConfig` — arg/flag validation, short-chars, options enum, deep-clone |
| `tests/registry.test.js` | Dual-root scanning, source labelling, `_steps/` exclusion, `fli list --json` |
| `tests/server.test.js` | All endpoints, SSE, CORS, `_source` blocks in metadata |
| `tests/config.test.js` | `loadConfig` / `getConfig` — no file, merge, partial, malformed JSON |
| `tests/deploy-helpers.test.js` | `loadFrontierConfig`, `resolveTarget`, `resolveDeployConf` — config loading, target resolution, per-env overrides |
| `tests/deploy-dispatch.test.js` | Full deploy dispatch — step dir selection, Docker vs legacy path, fixture-based integration |
| `tests/zz-steps.test.js` | All `_steps/` execution scenarios — sequence, config, skip, `--step`, optional, required |

Run: `npm test` (runs both batches automatically)
Run deploy tests only: `npm run test:deploy`

---

## Web GUI

**Port:** 8500 (override: `FLI_PORT=8080`)  
**Start:** `fli gui` or `node bin/server.js`

Features:
- Sidebar with core/project split, namespace grouping, live search
- Auto-generated forms from frontmatter (args → inputs, booleans → toggles)
- `make:command` gets a structured editor form
- Source view (collapsible) with single-pass syntax highlighter — no external deps
- SSE output streaming, color-coded by log level
- `⎘ copy cmd` button — builds full CLI string from current form state
- Sidebar refresh after `done` event
- Three themes: Mesa (default), Dark, Light

### API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Web GUI HTML |
| `GET` | `/api/commands` | All commands with `_source` label |
| `GET` | `/api/commands/:name` | Full metadata including `_source` blocks |
| `POST` | `/api/run/:name` | Run command, returns SSE stream |

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

### `frontier.config.js` (project root)

Used by the Docker-based deploy pipeline. Scaffold with `fli make:deploy`.

```js
export default {
  deploy: {
    server:     'user@example.com',
    path:       '/srv/app',
    app_id:     'my-app',
    api: {
      dockerfile: 'api/deploy/Dockerfile',
      health:     '/health',
    },
    web: {
      dist: 'web/dist',
      nginx: 'api/deploy/nginx.conf',
    },
    production: {
      server: 'user@prod.example.com',
    }
  }
}
```

### Environment variables

```bash
# FLI behaviour
FLI_PORT=4444              # Web GUI port (default 4444)
WORKSPACE_DIR=~/outlaw     # Workspace root (all ws:* commands)
ANTHROPIC_API_KEY=sk-...   # Required for ai:ask
GITHUB_TOKEN=...           # Required for github:* commands
CF_API_TOKEN=...           # Required for cloudflare:* commands

# Project directories (override defaults)
WEB_DIR=web
API_DIR=api
DB_DIR=db
CLI_DIR=cli

# Server targets (used by deploy:*, utils:ssh, db:import)
DEV_SERVER=user@dev.example.com
DEV_SERVER_PATH=/srv/app
STAGE_SERVER=user@stage.example.com
STAGE_SERVER_PATH=/srv/app
PROD_SERVER=ela.prod
PROD_SERVER_PATH=/srv/app

# CapRover (caprover:* and env:pull --from caprover)
DEV_CAPTAIN=https://captain.dev.example.com
CAPROVER_URL=https://captain.example.com
CAPROVER_TOKEN=...
```

---

## Known limitations / pending

| Item | Status |
|---|---|
| `utils:qrcode` | Stubbed — requires `npm install qrcode` |
| Hard-tier migrations | `project:init`, `web:init`, `api:init`, `utils:diff` (interactive conflict resolution) not yet ported |
| TUI interface | Planned — mdsvex/Svelte pipeline preserved in compiler for this |
| Node ESM module cache | Scenarios 8–9 in `zz-steps.test.js` skipped — same command compiled twice in one process returns stale module |
| `fli dev` child process spawning | `ports:dev` claims + injects ports but does not spawn dev servers itself — the caller still runs Vite/API manually with the injected env vars |

## Futures

### `fli validate` — cross-realm integrity checker ✓ shipped

`fli:validate` / alias `validate`. See `commands/fli/validate.md`.

Shells out to `litestone jsonschema` on each run (silent, `stdio: 'pipe'`) to get a fresh `db/schema.json`, then cross-references services, resources, and routes against it.

**Tier 1 checks (existence):** service `model:` → schema model exists · resource `model:`/`service:` → schema model + service file exist · route `@/resources/Name` imports → resource file exists · `ENCRYPTION_KEY` in `.env` if schema has `@secret`/`@guarded` fields (grepped from `schema.lite` directly since litestone strips these from JSON output) · `_module.md` `requires:` vars present in `.env`.

**Tier 2 (future):** field-level drift — service query fields present in schema, TypeScript type alignment.

`@secret` note: litestone strips secret/guarded fields from default JSON Schema output. The env check falls back to grepping `schema.lite` for `@secret`/`@guarded`. Also validates the key is exactly 64 hex chars (32 bytes, AES-256) and prints the correct `fli keygen` invocation if it's not.

### `fli admin:generate` — schema-derived admin UI ✓ shipped

`admin:generate` / alias `admin-gen`. See `commands/admin/generate.md`.

Shells out to `litestone jsonschema` for a fresh schema read, then generates `_layout.svelte` (auth guard), `index.svelte` (dashboard), and 4 route files per model (list, detail, new, edit). Creates a minimal resource file for any model that doesn't already have one. All files are plain Svelte dropped into `web/src/routes/admin/` — edit freely after generation.

**Decisions made:** relation fields (Integer FK) → raw number inputs. Auth guard checks `$session.user.isAdmin` — `isAdmin` must be a Boolean field on the `users` model. Regeneration: existing files are skipped unless `--force`. `--model <name>` scopes to one model. Enum fields from `$ref` entries in JSON Schema → `<select>` with known options.

### `fli scaffold` — full vertical slice from a single command ✓ shipped

`make:scaffold` / alias `scaffold`. See `commands/make/scaffold.md`.

`fli scaffold Lead` drops the complete vertical slice: schema.lite stanza, Junction service, Svelte resource component, and four CRUD routes (list, detail, new, edit), all wired end to end.

`--fields` uses simple `name:type` syntax — `fli scaffold Lead --fields "name:string email:email status:string"`. Supported types: `string email text url secret integer float boolean date datetime`. Type defaults to `string` if omitted. Richer field constraints (required, unique, default values) are a future addition.

`--no-routes` and `--no-resource` scope the output down. `--force` overwrites. `--open` opens all created files. `--soft-delete` adds `deletedAt` + `@@softDelete` to the stanza.

`make:model`, `make:service`, `make:resource`, and `make:route` are unchanged — scaffold is the fast path, the primitives remain for surgical use.

---

## Dev setup

```bash
bun install
bun link          # makes `fli` available globally
fli gui           # Web GUI at http://localhost:4444
fli doctor        # verify setup
```

```bash
# Recommended .env additions
WORKSPACE_DIR=~/outlaw
ANTHROPIC_API_KEY=sk-...
GITHUB_TOKEN=...
```
