# FLI architecture

Reference moved from PROJECT_STATE.md: command roots, engine files, command anatomy, context, the GUI, startup cost, caches and temp files.

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
| `core/prose.js` | Prose-driven dry-run — interpolates `$.vars` into prose section |
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

Large commands break into numbered step files sharing `$.config`:

```
commands/deploy/
  index.md            ← orchestrator: sets $.config.stepsDir based on frontier.config.js
  _steps/             ← legacy CapRover deploy
  _steps-docker/      ← Docker/SSH/nginx deploy (default for new apps)
  _steps-rollback/    ← rollback flow
  _steps-setup/       ← first-time server setup
```

The orchestrator sets `$.config.stepsDir = '_steps-docker'` (or another folder) and the runtime dispatches to the right one. Step files share `$.config` mutation so each can read what previous steps set.

**Step abort behavior**: if a step or orchestrator sets `$.config.abort = true`, subsequent steps are skipped without logging their headers. Steps that need to run on abort (cleanup, lock release) opt in via `runOnAbort: true` in their frontmatter.

### Context object

Available as top-level locals in every `js` block:

```js
arg          // positional args by name
flag         // named flags (--dry always present, --debug hidden but present)
log          // log.info / .success / .warn / .error / .dry
context      // full context — .paths .env .exec .execute .config .echo .git .vars
echo()       // one output line — stdout, or the GUI's event stream
tty.line()   // one typed line; tty.keys() one key
$``          // the shell — Bun's, captured by default, --dry aware
```

`$.git` provides: `branch()`, `status()`, `isDirty()`, `lastTag()`, `hasChangesSince()`, `isAffected()`, `log()`, `remote()`, `ahead()`, `behind()`, `repoRoot()`, `pkgState()`. Defaults to `paths.root` for the dir but accepts an override.

`$.paths` exposes: `root`, `wiki`, `tests`, `cli`, `api`, `db`, `web`, `webPages`, `webComponents`, `webResources`, `site`, `siteContent`, `siteMedia`, `mobile`, `extension`.

### Workspace context

Three helpers for the `ws:*` commands, all on `context`:

| Helper | Answers |
|---|---|
| `wsRoot()` | where the monorepo is — the workspace cwd is standing in, else `$WORKSPACE_DIR`, else a prompt |
| `wsPackages()` | `{ wsRoot, packages }`, each `{ dir, folder, path, pkg }`, read from `packages/*` |
| `wsRepo(packages)` | the shared git repo root when every member lives in ONE repo, `null` when each has its own |

`git.pkgState(name, dir)` is the fourth: `{ lastTag, commits, files, affected, dirty }` for a single package. Both of the questions it answers are asked with a pathspec and a `<name>@<version>` tag lookup, because `git status` and `git describe` run from a package directory describe the whole repo — which is why every member used to report the same tag and the same dirty flag.


## Current command count

`fli list --json` names them all — around 210, across the namespaces `fli list` groups by.

### Namespaces with `_module.md` (shared helpers)

`auth`, `cloudflare`, `completion`, `db`, `deploy`, `github`, `project`, `workspace`

These provide functions and constants that prepend to every command in the namespace. The runtime loads them once at startup and merges into the compiled output.

### Namespace breakdown

`fli list` groups every command by namespace; the tally there is the one to
trust rather than a number typed here.

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

### Startup cost

A read-only invocation (`fli list`, `help`, `?`, completion) is ~119ms where it was ~306ms, measured as 10 runs of each. Three things paid for that and each is a rule, not a tweak:

- **No `.md` loader hook.** `module.register()` starts a hooks thread — 56ms — and nothing imports a `.md`; the runtime compiles with the namespace module script and imports the shim.
- **The read-only path imports no command runtime.** `core/color.js` is the ANSI subset those paths use; `runtime.js` is imported where a command is run.

A command that runs imports its shim, which imports two node builtins and nothing else; the shell it may call is `Bun.$`, already in the runtime.

### Registry cache

`buildRegistry()` used to read and frontmatter-parse ~200 files on every invocation, including on every press of Tab. It now caches one parsed block per file at `~/.fli/cache/registry-<digest>.json`, keyed by mtime+size: a run stats what the walk finds and parses only what moved. ~13-23ms → ~4-7ms.

Discovery still walks the directories — a cached file list would not notice a new command, and "drop a file, it runs" is the authoring model. The cache lives under `~/.fli/` for the same reason the temp root does. `FLI_NO_CACHE=1` bypasses it for one run; `fli completion:refresh` drops it via `clearRegistryCache()`. Invalidation is held by 4 tests in `test/registry.test.js`.

### Temp files

Compiled command shims live at `<fliRoot>/.fli-tmp/<pid>/c_*.mjs`. Created lazily on first compile, removed on exit. Stale-PID sweep at every fli startup. `.gitignore` includes `.fli-tmp/` and the legacy `.__fli_*.mjs` pattern.

`fliTmpRoot()` in `core/utils.js` decides the location and is the only thing that does. When fliRoot is not writable (a global install under a root-owned prefix, where every command used to die on the first mkdir) the session moves to `$TMPDIR/fli-<digest of fliRoot>/`; a shim imports nothing by a bare specifier, so it may sit anywhere. `sweepStaleTmp()` is the other half; it reaps `<pid>` and the suites' `test-<pid>` alike.

---

## Approach & patterns

- **Iterative, file-driven sessions**: zip uploads, run commands immediately, paste errors back, expect targeted fixes.
- **State doc as handoff artifact**: this file is the source of truth carried forward to each new session.
- **Concise communication preference**: "caveman mode" available via skill file when detail isn't needed.
- **Namespace consistency enforced**: all workspace aliases use colon format (`ws:*`), all tooling ports in `85xx` range.
- **Verify before assuming**: redirect when about to write against an unknown format. The runtime has multiple cases where this prevented hours of debugging (litestone JSON Schema, Bun ESM cache semantics, frontmatter edge cases).

## Tools & resources

- **Runtime**: bun (`FJS-D593`) — the shebang, the version check in `bin/fli.js`, and `Bun.$` behind a command's `$`
- **Frontend**: `web/index.html` — a single-file GUI written in `@frontierjs/css`, no framework dependency
- **Testing**: `bun test`, plus `bun run test:browser` (mesa's CDP harness) for the GUI
- **Visualization**: FJSChain — plain HTML/JS in `@frontierjs/css`, served with no network
- **Port management**: `core/ports.js` with lock manager at `~/.fli/sessions.lock`
- **Deploy infrastructure**: SSH + Docker + nginx, no external platform required (CapRover is legacy fallback only)
- **Monorepo scope**: `@frontierjs`
