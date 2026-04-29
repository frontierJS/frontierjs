# FLI — Project State

**Version:** 0.1.0  
**Runtime:** Bun  
**Package name:** `@frontierjs/cli` (global binary via `bun link`, command: `fli`)  
**Scope:** `@frontierjs`  
**Repo:** `~/outlaw/packages/fli` (or standalone) — moving to `~/code/FRONTIER/frontierjs/packages/cli`  
**Last updated:** April 2026

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

### Core files

| File | Role |
|---|---|
| `bin/fli.js` | CLI entrypoint — sets roots, registers loader, runs bootstrap |
| `bin/server.js` | Web GUI server entrypoint |
| `bin/diagnose.js` | Standalone diagnostics — checks env, paths, loader |
| `core/bootstrap.js` | Parses argv, resolves command, handles `--help`, `list --json`, `? <query>` search |
| `core/compiler.js` | `.md` → ESM — extracts frontmatter, script block, main `js` block |
| `core/registry.js` | Scans both roots, builds a `Map`, skips `_steps/`, labels source |
| `core/runtime.js` | Builds context, validates args/flags, runs command or `_steps/` sequence |
| `core/server.js` | HTTP: `GET /api/commands`, `GET /api/commands/:name`, `POST /api/run/:name` (SSE) |
| `core/config.js` | Loads `.fli.json` from `projectRoot` into `global.fliConfig` |
| `core/ports.js` | Port schema, formula, socket probe, lock manager, session lifecycle |
| `core/prose.js` | Terminal markdown renderer with `{{var}}` interpolation for dry-run |
| `core/utils.js` | `logger`, `findFilesPlugin`, `loadFrontierConfig` |
| `web/index.html` | Single-file Web GUI — sidebar, forms, SSE output, syntax highlighting |
| `web/viewer/index.html` | FJSChain viewer — pre-compiled from `FJSChain.jsx`, served by `project:view` |

### Command file anatomy

```
commands/namespace/name.md
│
├── YAML frontmatter   → title, description, alias, args, flags
├── <script> block     → helper functions, imports (shared CLI + GUI)
├── prose              → shown in Web GUI; dry-run rendered in terminal
└── ```js block        → main body — runs on execute
```

### schema.lite model naming convention

Model names are **PascalCase singular** — `Lead`, `User`, `Account`, not `leads`, `users`, `accounts`. This matches how resources and services reference them (`model: 'Lead'`). All `make:*` commands and `auth:install` enforce this. Litestone JSON Schema output uses these names as `$defs` keys.

### `_module.md` convention

Namespaces with shared helpers use a `_module.md` file — a `<script>` block with imports and utilities available to every command in that namespace. Not a runnable command (excluded from `fli list`).

**Critical rule:** Commands must never re-import anything already in `_module.md` — duplicate identifier runtime error results.

Namespaces using `_module.md`: `auth`, `cloudflare`, `completion`, `db`, `deploy`, `github`, `project`.

The `project` `_module.md` provides: `existsSync`, `readFileSync`, `readdirSync`, `writeFileSync`, `resolve`, `basename`, `execSync`, plus `freshJsonSchema`, `scanFiles`, `extractServiceMeta`, `extractResourceMeta`, `parseMigrationFiles`, `extractServerMeta`, `TIER1_PACKAGES`.

`createServer` (http) is the only thing `project:view` adds in its own `<script>` block — everything else comes from `_module.md`.

Litestone JSON Schema extensions confirmed in output and consumed by `project:map` / `project:view`: `x-gate` (per-operation gate levels on model entries), `x-relations` (array of related model refs).

### `_steps/` convention

Large commands break into numbered step files sharing `context.config`. Named step directories (`_steps-docker/`, `_steps-rollback/`, `_steps-setup/`) are supported — the orchestrator selects which directory to run at runtime.

### Context object

```js
arg          // positional args by name
flag         // named flags (--dry always present)
log          // log.info / .success / .warn / .error / .dry
context      // .paths .env .exec .execute .config .echo .git
echo()       // ZX stdout
question()   // interactive prompt
$``          // ZX shell execution
```

### `frontier.config.js`

Projects using the Docker deploy pipeline define this at project root. Read via `loadFrontierConfig(root)`. Scaffold with `fli make:deploy`.

---

## Current command count: 140

### Core commands (in `commands/`)

#### `admin` (1)
| Command | Alias | Description |
|---|---|---|
| `admin:generate` | `admin-gen` | Generate gate-aware CRUD admin UI from schema.lite — list, detail, create, edit per model |

#### `ai` (1)
| Command | Alias | Description |
|---|---|---|
| `ai:ask` | `ask` | Ask Claude — streams response, `--file` `--system` `--model` |

#### `api` (4)
| Command | Alias | Description |
|---|---|---|
| `api:deploy` | `api-deploy` | Deploy API via SSH |
| `api:dev` | `api-dev` | Start API dev server |
| `api:model` | — | Delegate to `make:model` |
| `api:service` | — | Delegate to `make:service` |

#### `auth` (5)
| Command | Alias | Description |
|---|---|---|
| `auth:create-user` | `create-user` | Create user directly in database |
| `auth:install` | `auth-install` | Install FJS auth — PascalCase models: User, Credential, Session, Verification |
| `auth:list-users` | `list-users` | List users |
| `auth:revoke-sessions` | `revoke-sessions` | Revoke all sessions for a user |
| `auth:rotate-key` | `rotate-key` | Rotate ENCRYPTION_KEY, re-encrypt @secret fields |

#### `browser` (4)
| Command | Alias | Description |
|---|---|---|
| `browser:captain` | `captain` | Open `$DEV_CAPTAIN` |
| `browser:live` | `live` | Open `$LIVE_SITE_URL` |
| `browser:open` | `open` | Open any URL |
| `browser:servers` | `servers` | Open `$SERVERS_URL` |

#### `caprover` (6)
| Command | Alias | Description |
|---|---|---|
| `caprover:backup` | `cap-backup` | Trigger app backup |
| `caprover:create` | `cap-create` | Register new app |
| `caprover:login` | `cap-login` | Login with config file |
| `caprover:setup` | `cap-setup` | Run server setup wizard |
| `caprover:ssl` | `cap-ssl` | Enable/renew SSL |
| `caprover:update` | `cap-update` | Deploy app from local directory |

#### `cloudflare` (5)
| Command | Alias | Description |
|---|---|---|
| `cloudflare:dns` | `cf:dns` | Manage DNS records |
| `cloudflare:pages` | `cf:pages` | Manage Pages projects |
| `cloudflare:purge` | `cf:purge` | Purge cache |
| `cloudflare:workers` | `cf:workers` | List Workers scripts |
| `cloudflare:zones` | `cf:zones` | List zones |

#### `completion` (4)
| Command | Alias | Description |
|---|---|---|
| `completion:generate` | `cgen` | Print shell completion script |
| `completion:install` | `ci` | Install tab completion |
| `completion:query` | `cq` | Return completions for current line (called by shell on Tab) |
| `completion:refresh` | `cr` | Rebuild completion cache |

#### `crypto` (1)
| Command | Alias | Description |
|---|---|---|
| `crypto:keygen` | `keygen` | Generate keys. For ENCRYPTION_KEY: `--format hex --length 32` → 64 hex chars (32 bytes, AES-256) |

#### `db` (15)
| Command | Alias | Description |
|---|---|---|
| `db:backup` | `db-backup` | Timestamped sqlite backup |
| `db:columns` | `db-columns` | List columns for a table |
| `db:db` | `db` | Interactive sqlite3 shell or query |
| `db:download` | `db-download` | SCP production db |
| `db:import` | `db-import` | **5-step:** remote backup → scp → restore → extras |
| `db:jsonschema` | `db-jsonschema` | Generate JSON Schema via `bunx litestone jsonschema` |
| `db:migrate` | `db-migrate` | Create and apply migration |
| `db:pull` | `db-pull` | Introspect live db → schema.lite |
| `db:push` | `db-push` | Apply schema.lite directly |
| `db:reset` | `db-reset` | **3-step:** rm → `bunx litestone migrate reset` → push |
| `db:schema` | `make-schema` | Append PascalCase singular model stub to schema.lite |
| `db:seed` | `db-seed` | Run db seeder |
| `db:status` | `db-status` | Pending migrations + schema match |
| `db:studio` | `studio` | Open Litestone Studio |
| `db:tables` | `db-tables` | `sqlite3 <db> '.schema'` or table sizes — no npm |

#### `deploy` (7)
| Command | Alias | Description |
|---|---|---|
| `deploy:all` | `deploy` | Multi-step — Docker or legacy CapRover based on `frontier.config.js` |
| `deploy:local` | `dlocal` | Build/run API Docker image locally |
| `deploy:logs` | `dlogs` | Stream logs from API container |
| `deploy:rollback` | `rollback` | **3-step** rollback |
| `deploy:run` | `drun` | One-off command in API container |
| `deploy:setup` | `setup-server` | **7-step** server readiness wizard |
| `deploy:status` | `dstatus` | Containers, disk, last deploy info |

#### `env` (6)
| Command | Alias | Description |
|---|---|---|
| `env:copy` | `ecopy` | `.env` → `.env.example` stripped |
| `env:delete` | `edel` | Remove key from `.env` |
| `env:get` | `eget` | Read value from `.env` |
| `env:list` | `elist` | List all keys (masked) |
| `env:pull` | `epull` | Pull from caprover / url / gist / ssh / file |
| `env:set` | `eset` | Set or update key in `.env` |

#### `fetch` (2)
| Command | Alias | Description |
|---|---|---|
| `fetch:image` | `fimg` | Fetch URL, return blob info |
| `fetch:json` | `fget` | Fetch URL → JSON; `:3000/path` shorthand |

#### `fli` (8)
| Command | Alias | Description |
|---|---|---|
| `fli:doctor` | `doctor` | Check FLI setup |
| `fli:edit` | `edit` | Open command file in `$EDITOR` |
| `fli:env` | `config` | Open `~/.config/fli/.env` |
| `fli:gui` | `gui` | Start Web GUI on port **8500** |
| `fli:init` | `init` | Scaffold `cli/src/routes/` |
| `fli:setup` | `setup` | PATH setup instructions |
| `fli:update` | `update` | `git pull + bun install` in fliRoot |
| `fli:validate` | `validate` | Cross-realm integrity check |

#### `git` (7)
| Command | Alias | Description |
|---|---|---|
| `git:changelog` | `changelog` | Generate CHANGELOG.md |
| `git:commit` | `gc` | Conventional commit prompt |
| `git:pull` | `gpl` | Pull with branch info |
| `git:push` | `gp` | Push to origin |
| `git:release` | `gr` | Tag + changelog + push |
| `git:stash` | `gstash` | Stash / pop / list |
| `git:status` | `gs` | Clean status summary |

#### `github` (3)
| Command | Alias | Description |
|---|---|---|
| `github:clone` | `gh:clone` | Clone a GitHub repo |
| `github:create` | `gh:create` | Create repo from template |
| `github:prs` | `gh:prs` | List open pull requests |

#### `make` (9)
| Command | Alias | Description |
|---|---|---|
| `make:command` | `new` | Scaffold new FLI `.md` command |
| `make:component` | `mkc` | Svelte component |
| `make:deploy` | `mkdeploy` | Scaffold Dockerfile + `frontier.config.js` |
| `make:model` | `mkmodel` | Append PascalCase singular model to schema.lite |
| `make:resource` | `mkresource` | Svelte resource component |
| `make:route` | `mkroute` | Svelte route |
| `make:scaffold` | `scaffold` | Full vertical slice — PascalCase schema + service + resource + 4 routes |
| `make:schema` | `mkschema` | Alias for `make:model` |
| `make:service` | `mksvc` | Scaffold Junction service file |

#### `npm` (14)
| Command | Alias | Description |
|---|---|---|
| `npm:audit` | `audit` | Security audit |
| `npm:info` | `ninfo` | Registry metadata |
| `npm:install` | `ni` | Install deps |
| `npm:link` | `npm-link` | Link/unlink local package |
| `npm:login` | `npm-login` | Login |
| `npm:outdated` | `outdated` | Show outdated deps |
| `npm:publish` | `pub` | Publish |
| `npm:release` | `release` | **5-step** release pipeline |
| `npm:run` | `nr` | Run any npm script |
| `npm:size` | `pkgsize` | Bundle size via bundlephobia |
| `npm:tag` | `tag` | Manage dist-tags |
| `npm:unpublish` | `unpub` | Unpublish with confirmation |
| `npm:version` | `version` | Bump version |
| `npm:whoami` | `whoami` | Show logged-in npm user |

#### `ports` (2)
| Command | Alias | Description |
|---|---|---|
| `ports:dev` | `dev` | Claim port session, inject `FLI_PORT_*` env vars |
| `ports:status` | `ps` | Show active sessions — `--clean` prunes stale |

#### `project` (2)
| Command | Alias | Description |
|---|---|---|
| `project:map` | `pmap` | Structural snapshot — schema, services, resources, migrations, installed FJS packages |
| `project:view` | `pview` | Serve FJSChain visual diagram on port **8501** |

#### `site` (3)
| Command | Alias | Description |
|---|---|---|
| `site:clone` | `clone` | Clone from kobamisites |
| `site:deploy` | `site-deploy` | `npm run deploy:site` |
| `site:serve` | `serve` | Serve dist/ with npx serve |

#### `utils` (12)
| Command | Alias | Description |
|---|---|---|
| `utils:check-deps` | `check-deps` | `npx npm-check-updates` |
| `utils:dev` | `dev` | Smart dev server (bun or npm) |
| `utils:diff-env` | `diff-env` | Diff `.env` vs template |
| `utils:killnode` | `kill` | `killall node` |
| `utils:note` | `note` | Scaffold dated `.md` note |
| `utils:pack` | `pack` | Zip folder excluding media/build |
| `utils:password` | `password` | Hash or generate secret |
| `utils:qrcode` | `qrcode` | QR code from URL |
| `utils:ssh` | `ssh` | SSH to dev/stage/prod |
| `utils:tunnel` | `tunnel` | Run cloudflared tunnel |
| `utils:vpn` | `vpn` | WireGuard up/down/status |
| `utils:zip` | `zip` | `npm run zip` |

#### `web` (6)
| Command | Alias | Description |
|---|---|---|
| `web:build` | `web-build` | Production build |
| `web:component` | — | Delegate to `make:component` |
| `web:deploy` | `web-deploy` | Deploy web app via SSH |
| `web:dev` | `web-dev` | `npm run dev` |
| `web:resource` | — | Delegate to `make:resource` |
| `web:route` | — | Delegate to `make:route` |

#### `workspace` (13)
| Command | Alias | Description |
|---|---|---|
| `workspace:add` | `ws:add` | Move/copy repo into `packages/` |
| `workspace:changed` | `ws:changed` | Packages changed since last tag |
| `workspace:clean` | `ws:clean` | Delete build artifacts across workspace |
| `workspace:exec` | `ws:exec` | Run command in every package |
| `workspace:graph` | `ws:graph` | Dependency graph |
| `workspace:init` | `ws:init` | Scaffold monorepo root |
| `workspace:install` | `ws:install` | `bun install` at root |
| `workspace:link` | `ws:link` | Write `workspace:*` dep between packages |
| `workspace:list` | `ws:list` | All packages, versions, deps |
| `workspace:publish` | `ws:pub` | **3-step:** version → publish → push all |
| `workspace:run` | `ws:run` | Run script across packages |
| `workspace:status` | `ws:status` | Git status across all packages |
| `workspace:version` | `ws:version` | Bump versions without publishing |

### Project commands (in `cli/src/routes/`)

| Command | Alias | Description |
|---|---|---|
| `hello:exec` | `lsd` | Demo: list files |
| `hello:greet` | `greet` | Demo: greeting |

---

## Multi-step commands

| Command | Steps dir | Count | What it does |
|---|---|---|---|
| `npm:release` | `_steps/` | 5 | test → build → version → publish → git push |
| `workspace:publish` | `_steps/` | 3 | version all → publish all → push all |
| `db:reset` | `_steps/` | 3 | rm → `bunx litestone migrate reset` → push |
| `db:import` | `_steps/` | 5 | mkdir → ssh backup → scp → restore → extras |
| `deploy:all` | `_steps/` | 3 | legacy CapRover |
| `deploy:all` | `_steps-docker/` | 9 | preflight → env-check → pull → build-web → build-api → backup → swap → health → cleanup |
| `deploy:rollback` | `_steps-rollback/` | 3 | rollback web → api → report |
| `deploy:setup` | `_steps-setup/` | 7 | check deps → install → dirs → repo → nginx → ssl → report |

---

## Port brokering (`core/ports.js`)

```
[ENV][CATEGORY][PROJECT][SERVICE]

ENV       7=test  8=dev  9=prod
CATEGORY  0=fe  1=be  2=widgetDev  3=widgetServe  4=ext  5=tooling

Global tooling (fixed, within 85xx):
  8500  →  fli gui
  8501  →  fli pview (FJSChain)
  8502  →  db studio

GLOBAL = { gui: 8500, pview: 8501, studio: 8502 }
Ports 8500–8502 are reserved — dynamic assignment skips them.
```

Key exports: `port()`, `decode()`, `isPortInUse()`, `claimSession()`, `releaseSession()`, `autoRelease()`, `getSessionStatus()`, `GLOBAL`.

---

## `project:view` — FJSChain Viewer

Serves `web/viewer/index.html` — pre-compiled self-contained HTML, no Babel/JSX at runtime, CDN React. Refreshing the browser tab regenerates the project map live.

**Script order in `index.html`:**
1. CDN React + `const { useEffect } = React`
2. Project map helpers (`buildProjectMap`, `resolveFieldType`, `TIER1_REGISTRY`, etc.)
3. `useProjectMap` hook — fetches `/data`, calls `buildProjectMap`
4. FJSChain compiled block — declares `useState`, `FONT`, all FJSChain internals
5. `FJSChainWithData` — passes `data={data}` prop to `<FJSChain />`
6. `ReactDOM.createRoot` mount

**`extractServerMeta(root)`** scans `server.ts` + `auth.ts` for 5 tier-1 FJS package signals: `auth`, `conduit`, `caravan`, `notifications`, `litestream`. Returns `{ serverFile, packages: [{id, label, realm, installed}], mailer }`.

**Chip rendering:** installed = full color; uninstalled = 45% opacity, grey dot, "not installed" label. Sierra realm = 35% opacity when no resources found.

**All sample data zeroed:** `DB_SCHEMA`, `MIGRATIONS`, `HEALTH_PACKAGES`, `HEALTH_GAPS`, `CHANNELS_DATA`, `RELATIONS_DATA`, `PACKAGE_REGISTRY`, `ROUTES_DATA`, `CLI_DATA`, all realm nouns. Everything from live project map.

---

## `fli:validate`

Runs `bunx litestone jsonschema` for fresh schema, then checks:
- Service `model:` → PascalCase model exists in schema
- Resource `model:`/`service:` → model + service file exist
- Route `@/resources/Name` imports → file exists
- `ENCRYPTION_KEY` in `.env` if schema has `@secret`/`@guarded` (grepped from `schema.lite` directly — litestone strips these). Validates key = 64 hex chars (32 bytes AES-256)
- `_module.md` `requires:` vars in `.env` (warn, not error)

Exit code 1 on errors. `--layer schema|services|resources|env` to scope.

---

## Test suite

| File | Covers |
|---|---|
| `compiler.test.js` | `extractFrontmatter`, `transformMarkdown`, `compileCli` |
| `runtime.test.js` | `getConfig` — arg/flag validation, short-chars, options |
| `registry.test.js` | Dual-root scanning, source labelling, `_steps/` exclusion |
| `server.test.js` | All endpoints, SSE, CORS |
| `config.test.js` | `loadConfig` / `getConfig` |
| `deploy-helpers.test.js` | `loadFrontierConfig`, `resolveTarget`, `resolveDeployConf` |
| `deploy-dispatch.test.js` | Step dir selection, Docker vs legacy |
| `zz-steps.test.js` | `_steps/` execution — sequence, skip, `--step`, optional |

Run: `npm test` · Deploy only: `npm run test:deploy`

---

## Web GUI

**Port:** 8500 (override: `FLI_PORT=8080`) · **Start:** `fli gui`

Features: sidebar with core/project split + namespace grouping + live search (`fli ? <query>` in CLI too) · auto-generated forms · source view · SSE streaming · `⎘ copy cmd` · three themes: Mesa, Dark, Light · minimum font size **14px** throughout.

---

## FrontierJS monorepo

```
~/code/FRONTIER/frontierjs/
  package.json             ← private, workspaces: ["packages/*"]
  packages/
    cli/                   ← @frontierjs/cli (this repo, binary: fli)
    junction/
    auth/
    litestone/
    conduit/
    caravan/
    sierra/
    notifications/
    vscode-fjs/            ← VS Code extension (vsce publish, not npm)
```

Cross-package deps use `workspace:*`. For external app projects: `bun link` in each FJS package, then `bun link @frontierjs/<name>` in the app. Add to app's `.bunfig.toml` to survive `bun install`:
```toml
[install.scopes]
"@frontierjs" = { link = true }
```

---

## Configuration

### `.fli.json`
```json
{ "routesDir": "cli/src/routes", "defaultNamespace": "hello", "editor": "code" }
```

### Environment variables
```bash
FLI_PORT=8500
WORKSPACE_DIR=~/outlaw
ANTHROPIC_API_KEY=sk-...
GITHUB_TOKEN=...
CF_API_TOKEN=...
WEB_DIR=web  API_DIR=api  DB_DIR=db  CLI_DIR=cli
DEV_SERVER=user@dev.example.com  PROD_SERVER=ela.prod
CAPROVER_URL=https://captain.example.com  CAPROVER_TOKEN=...
```

---

## Known limitations / pending

| Item | Status |
|---|---|
| `utils:qrcode` | Stubbed — requires `npm install qrcode` |
| TUI interface | Planned |
| Node ESM module cache | `zz-steps.test.js` scenarios 8–9 skipped |
| `fli dev` spawning | `ports:dev` injects ports but doesn't spawn processes |
| `ws:link` FJS symlinking | Planned — `bun link` all FJS packages + link into target in one shot |

---

## Futures

All three previously planned items shipped (`fli validate`, `fli scaffold`, `fli admin:generate`). Futures list currently empty — add new items here.
