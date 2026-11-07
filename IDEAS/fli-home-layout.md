---
id: fli-home-layout
status: shipped
dated: 2026-11-06
---

# Idea — where fli keeps a person's files

**Status: SHIPPED 2026-11-06.** Ruled by `FJS-D1990`; every phase built.

fli writes per-user files to four roots, and no module owns which one. About a
dozen files in `packages/cli/core` each build their own `join(homedir(), …)`,
which is how both a one-root layout and an XDG layout came to exist side by side
on one machine:

- `~/.fli/` — holds, lanes, registers, loop logs, `sessions.lock`, `frontier/`,
  `haven/`, the registry cache (`core/registry.js`), and two config files,
  `config.json` (`core/tell.js`) and `autopilot.json` (`core/autopilot.js`).
- `~/.config/fli/` — `.env`, `commands/`, `basecamps.json` (`FJS-D1828`), and
  `logs.db`, which is state.
- `~/.local/share/fli/basecamp` — backups (`core/basecamp.js`, `FJS-D1851`).
- `~/.cache/fli/` — autocomplete and `error.log`.

Project state is not in question: it already lives in the project (`.cache/`,
`db/`).

## Open questions

- ~~**Q1 — Which layout every per-user file moves into.**~~ **Answered 2026-11-07 (`FJS-D1990`): C — split by class: run state stays in `~/.fli`, config goes to `$XDG_CONFIG_HOME/fli`, data to `$XDG_DATA_HOME/fli`, cache to `$XDG_CACHE_HOME/fli`, every path resolved by one `core/paths.js`.**
  - **A** — one root, `~/.fli/{config,state,data,cache}`. Cost: reverses
    `FJS-D1828`, moves every caller, and backup tools cannot tell the cache is
    disposable.
  - **B** — the full XDG split: `~/.config/fli`, `~/.local/state/fli`,
    `~/.local/share/fli`, `~/.cache/fli`. Cost: moves holds, lanes and registers,
    the paths a person and `fli top` read most, and retires `~/.fli`.
  - **C** — split by class: run state stays in `~/.fli`, config goes to
    `$XDG_CONFIG_HOME/fli`, data to `$XDG_DATA_HOME/fli`, cache to
    `$XDG_CACHE_HOME/fli`, every path resolved by one `core/paths.js`.
  - **D** — C plus a `~/.fli/cache` symlink to the cache root. Cost: `rm -rf
    ~/.fli` leaves the cache behind, a backup tool that follows links copies the
    cache anyway, and `fli doctor` has to repair a dangling link.
  - **Recommend C** — the code and `FJS-D1828` already split by class, so C moves
    only the misplaced files, and a `paths.js` owner makes B's last step (state to
    `$XDG_STATE_HOME`) a one-line change later. D buys `ls` visibility that a
    printed list of the four roots gives without a link.

## Plan

### Phase 0 — Inventory

Goal: every writer of a per-user path is known, across the workspace.
Done when: the list below names each file and the root it moves to.

- [x] 0.1 List every per-user path built outside a project root, in `packages/cli`
  and in every other package that writes one (`logs.db`, `lanes/`,
  `sessions.lock`, `haven/`, the `~/.cache/fli` files are written outside
  `cli/core`).
  - Found 2026-11-07. `cli/core` (moved onto `paths.js`): `registry.js` user
    commands (config) and registry cache (cache) · `basecamp.js` key copies
    (config) and backups (data) · `tell.js` `config.json` (config), `frontier/`
    (state) · `autopilot.js` `autopilot.json` (config), loop logs (state) ·
    `ports.js` `sessions.lock` (state) · `registers.js` guard and `registers/`
    (state) · `guard.js` `holds/` (state) · `repo-work.js` fix-loop log (state) ·
    `loop-log.js` log dir (state) · `global-env.js` `.env` and `basecamps.json`
    (config) · `bootstrap.js` passed `homedir()` to `loadFliEnv`, now nothing.
    `commands/haven/walk.md` built `config.json` and `haven/` itself, now on `paths.js`.
  - Outside `cli`, on `paths.js`: `scripts/headless.mjs` `LOG_DIR` (state; `lanes.mjs`
    and the loops take `lanes/` from it) · `workbench/api` `atlas.ts` `FLI_DIR` and
    `autopilot-run.ts` `OUT_DIR` (state), and the Switch's displayed
    `autopilot.json` path (config). Workbench already depends on `@frontierjs/cli`.
  - Outside `cli`, NOT movable: `haven` (`agents.js`, `hash/*.js`, `study/kept.js`
    build `~/.fli/haven/...` in ~12 files) -- the package does not depend on
    `@frontierjs/cli` and is installed alone under `~/.fli/haven/<version>`, so
    importing `cli/core` is a new dependency edge. All state; `~/.fli` is where they
    already are, so nothing is misplaced. `workbench` `~/.config/workbench`,
    `basecamp` `~/.config/basecamp/sites`, `mcp` `$XDG_*/<app>` are those apps' own roots.
  - `logs.db`, `~/.cache/fli/autocomplete` and `error.log`: no writer anywhere in the
    tree (the `logs.db` on this machine is dated 2021). Nothing to move; they are stale
    files for the owner to delete.

### Phase 1 — One owner

Goal: `core/paths.js` is the only place a per-user root is computed.
Done when: `rg "homedir\(\)" packages/cli/core` hits only `paths.js` and the
home-relative paths fli does not own (`~/.bun`, `~/.ssh`); `bun run test` in
`packages/cli` passes.

- [x] 1.1 Add `core/paths.js` exporting `configDir()`, `stateDir()`, `dataDir()`
  and `cacheDir()`, each reading its `XDG_*` variable per call so a test can point
  it at a temp dir, as `core/registry.js` does today.
- [x] 1.2 Move every caller from Phase 0 onto it, `global-env.js` and `ports.js`
  included.

### Phase 2 — Files in their class

Goal: each file sits in its class's root.
Done when: `~/.fli` holds only run state, and the four files below resolve to
their new roots.

- [x] 2.1 Registry cache to `cacheDir()`.
- [x] 2.2 `config.json` and `autopilot.json` to `configDir()`.
- [x] 2.3 `logs.db` to `stateDir()`.
  - No code writes `logs.db`; nothing to change (see 0.1).
- [x] 2.4 Move the old copies on this machine; pre-alpha keeps no migration step.
  - `config.json` and `autopilot.json` moved by hand to `~/.config/fli`; `~/.fli/cache` (32 registry files) deleted and rebuilt in `~/.cache/fli`; `logs.db` was already gone.

### Phase 3 — Kept true

Goal: a new per-user path cannot bypass the owner.
Done when: a `core/checks/repo.js` rule fails on a `homedir()` join in `cli/core`
outside `paths.js`, and passes on the tree.

- [x] 3.1 Add the rule, the same shape as `homePathLiteral`.
  - `home-dir-join` in `core/checks/repo.js`; exempt files are `paths.js`, `bun-fence.js`, `install-preflight.js`, `cloud.js`, `docker-context.js`.
- [x] 3.2 A `fli doctor` section prints the four roots.
  - `report.roots` in `core/doctor.js`, printed by `commands/fli/doctor.md`. `diagnose` no longer defaults `home` to `homedir()`: an absent home follows the XDG variables.

### Phase 4 — REPL histories into the state root

Goal: the two REPL histories stop sitting loose in `~` and live in `~/.fli`, the
state root.
Done when: a fresh `litestone` REPL and a `junction` call session each write their
history under `~/.fli`, and nothing new appears in `~`.

- [x] 4.1 `~/.litestone_repl_history` and `~/.junction_call_history` move to
  `~/.fli/history/litestone` and `~/.fli/history/junction`.
  - The owner chose `~/.fli` over a dotfile in `~` (every REPL's convention) and
    over XDG state: fli is how FrontierJS is used, so its state root is where a
    person looks. Litestone owns the path, `historyFile(name)` in
    `src/tools/repl.js`, because it cannot import `cli/core/paths.js`
    (Invariant 1) and junction already imports its REPL; the write makes the
    directory first, since a failed append is swallowed.
