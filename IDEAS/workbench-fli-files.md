---
id: workbench-fli-files
status: proposed
dated: 2026-11-06
---

# Idea — fli's files, readable in Workbench

**Status: BUILDING. Q1–Q5 ruled (`FJS-D1991`–`FJS-D1995`); Phase 0 and 7.1 done 2026-11-06; 1.1 next.**
Probed against the tree 2026-11-06. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-06): fli keeps a lot in the home folder, and almost
all of it wants to be visible. Workbench is the place; `fli gui` is not (below).

## What exists (probed 2026-11-06)

- **The four roots have one owner.** `packages/cli/core/paths.js` resolves
  `configDir()`, `dataDir()`, `cacheDir()` and `stateDir()` (`FJS-D1990`,
  `IDEAS/fli-home-layout.md`). `fli doctor` prints them from `core/doctor.js`,
  whose `ROOT_HOLDS` is a hand-written string per root — a second copy of what
  `paths.js`'s header comment says.
- **Nothing lists entries, sizes or modes.** The one mode check is doctor's
  `basecampRows` (`basecamps.json` must be 600). `~/.config/fli/env` sat at 664
  holding a password, and `kdev.conf` at 640 holding a WireGuard key, with
  nothing to say so.
- **Workbench already reads fli by path**: `atlas.ts` and `autopilot-run.ts`
  import `stateDir()`; `peer/basecamp.ts` and `app.ts` import `core/basecamps.js`.
  A model-less service gated at ADMINISTRATOR is the house shape
  (`services/basecamps/basecamps.service.ts`).
- **The readers and setters exist**: `global-env.js` `storeGlobal` and `pickEnv`;
  `ports.js` `readLock`, `listeningPorts`, `whoHolds`; `guard.js` `treeHold`;
  `registry.js` for user commands. `scripts/lanes.mjs` opens lanes and has no
  verb that removes one.
- **Measured on this laptop before cleanup**: `~/.fli/lanes` 4.3 GB,
  `~/.fli/registers` 428 MB, `dataDir()` backups 204 MB; 2.7 GB of agent scratch
  and verify leftovers in `~` and `~/.cache`, found only by hand.
- **One leaker is in the tree**: `packages/outpost/test/verify-docker.mjs:301-303`
  makes three `mkdtemp` dirs under `~/.cache` (snap Docker cannot mount `/tmp`)
  and never removes them.
- **Settings** (`web/src/routes/settings/index.mesa`) holds Appearance only.

**Why not `fli gui`.** Every per-user file is machine-wide; project state already
lives in the project (`.cache/`, `db/`). The inventory found no entry that is
`fli gui`'s alone, so this plan builds nothing there.

**Prior art.** `docker system df` reports each class with TOTAL, ACTIVE, SIZE and
RECLAIMABLE, and `docker system prune` acts on the reclaimable part only
([docs](https://docs.docker.com/reference/cli/docker/system/df/)). The XDG spec
defines the cache root as "non-essential data"
([basedir spec](https://specifications.freedesktop.org/basedir-spec/latest/)),
which is what makes Clear safe on `cacheDir()` and nowhere else. The Disk screen
takes Docker's columns; the four roots are its classes.

## Open questions

- ~~**Q1 — Where the screens live.**~~ **Answered 2026-11-07 (`FJS-D1991`): A — one nav entry, **Laptop** (`/laptop/`), with tabs Disk, Keys and Running; global env and user commands go in Settings; local backups go on the Basecamps screen beside the Basecamp they came from.**
  - **A** — one nav entry, **Laptop** (`/laptop/`), with tabs Disk, Keys and
    Running; global env and user commands go in Settings; local backups go on the
    Basecamps screen beside the Basecamp they came from.
  - **B** — everything under Settings, as sections.
  - **C** — a nav entry per screen (Disk, Keys, Running).
  - **Recommend A** — "laptop" is already the vernacular (`/basecamps/` says
    "every Basecamp this laptop made"; Workbench's `CLAUDE.md` calls it "a laptop
    tool"), while "machine" and "box" mean a server in Basecamp
    (`IDEAS/machine-visibility.md`). Settings stays for things a person sets;
    Disk and Running are things a person watches.
- ~~**Q2 — Where the catalog of entries lives.**~~ **Answered 2026-11-07 (`FJS-D1992`): A — a new `core/home.js` beside `paths.js`: one row per known entry (root, name, what it is, writer, secret, how it is reclaimed) and a `homeReport()` that walks the roots. `doctor.js` and Workbench both read it, and `ROOT_HOLDS` goes.**
  - **A** — a new `core/home.js` beside `paths.js`: one row per known entry
    (root, name, what it is, writer, secret, how it is reclaimed) and a
    `homeReport()` that walks the roots. `doctor.js` and Workbench both read it,
    and `ROOT_HOLDS` goes.
  - **B** — the rows inside `paths.js`.
  - **Recommend A** — `paths.js` stays the thing every writer imports to find a
    root; the catalog is read by two reporters only. Invariant 4 holds either way.
- ~~**Q3 — What Workbench may change.**~~ **Answered 2026-11-07 (`FJS-D1993`): B — reclaim (Clear a cache entry, remove an idle lane), Fix a file's mode to 600, and set or unset a global env key. User commands stay read-only, with their path to open in an editor.**
  - **A** — read only.
  - **B** — reclaim (Clear a cache entry, remove an idle lane), Fix a file's mode
    to 600, and set or unset a global env key. User commands stay read-only, with
    their path to open in an editor.
  - **C** — B plus editing user commands in the page.
  - **Recommend B** — each write goes through an owner that already exists or is
    one function (`storeGlobal`, `chmod`, a new lane remover). An editor already
    edits a `.md` command file better than a textarea would.
- ~~**Q4 — Files outside the four roots**~~ **Answered 2026-11-07 (`FJS-D1994`): B — no list; fix the leakers instead.** (agent scratch, verify leftovers).
  - **A** — a Strays list on Disk, matched by named patterns (`~/fjs-*`,
    `~/ci-clone-fjs-*`, `~/.cache/fjs-*`), each row with size and Delete.
  - **B** — no list; fix the leakers instead.
  - **C** — both.
  - **Recommend B** — a pattern list is a second catalog of things fli does not
    own, deletes by glob in `~`, and misses any scratch dir named differently;
    fixing the leaker (7.1) has a check that fails. A reopens if strays keep
    turning up after 7.1; built then, the client sends a row id and the server
    resolves the path, never a path from the page.
- ~~**Q5 — Haven's and Workbench's own files.**~~ **Answered 2026-11-07 (`FJS-D1995`): A — each shows as one row (size only) on Disk; their secret files (`~/.fli/haven/key.json`, `~/.config/workbench/peer.json` and `push.json`) are listed on Keys; Workbench's root resolves through one function first (0.4).** `~/.fli/haven/` is already inside
  `stateDir()`. `~/.config/workbench/` is a fifth root: `peer.ts:21`, `push.ts:44`,
  `workbench.ts:457` and `basecamps-create.ts:76` each join `homedir()` themselves,
  so `XDG_CONFIG_HOME` is ignored.
  - **A** — each shows as one row (size only) on Disk; their secret files
    (`~/.fli/haven/key.json`, `~/.config/workbench/peer.json` and `push.json`) are listed on Keys; Workbench's
    root resolves through one function first (0.4).
  - **B** — left out.
  - **Recommend A** — they are on the same disk and hold keys; one row each
    costs nothing and keeps Disk's total honest.

## Plan

### Phase 0 — The catalog

Goal: one module knows every per-user entry fli writes, and doctor reads it.
Done when: `fli doctor`'s roots section prints from the catalog; a test with
the four `XDG_*` variables pointed at a temp dir finds each seeded entry and
reports an unseeded file as unknown; a test fails when a `configDir()` or
`stateDir()` join in `packages/cli/core` names an entry the catalog lacks;
`bun run test` in `packages/cli` passes.

- [x] 0.1 Measure a size walk of all four roots on this laptop (lanes included),
  cold and warm. It decides whether Disk computes sizes per request or the API
  holds a cached report with a Refresh. **Measured 2026-11-06**: `lstat` walk of
  110k files / 3.2 GB across the four roots, 0.85 s on a warm page cache (no
  root to drop it, so no true cold run). Disk computes per request; no cached
  report, no Refresh button. Two conditions: `homeReport({ sizes })` defaults to
  no bytes so `fli doctor` never pays the walk, and the report carries `walkMs`
  so a drift toward seconds is visible on the page (reopen: a TTL cache with a
  "computed Ns ago" stamp).
- [x] 0.2 Add the catalog and `homeReport()` where Q2 rules. Each row carries
  root, name, what, writer, `secret`, `reclaim` (`clear`, `remove-lane` or none);
  a report row adds bytes, mode, mtime and `known`.
- [x] 0.3 `doctor.js` reads the catalog; `ROOT_HOLDS` goes. Doctor gains a mode
  row for every `secret` entry, so the 664 `env` case fails `fli doctor`.
- [x] 0.4 Workbench's root through one function (`WORKBENCH_DIR`, else
  `$XDG_CONFIG_HOME/workbench`); the four call sites in Q5 use it, the env
  overrides `WORKBENCH_PEER_FILE` and `WORKBENCH_PUSH_FILE` kept. Built
  2026-11-06: `workbenchDir()` in `api/src/core/env.ts`; a fifth site,
  `claude-write.ts`'s trash dir, was a constant and is now `trashDir()`.
- [x] 0.5 A `VOCABULARY.md` row for **Laptop** — the machine Workbench runs on,
  never a server — if Q1 rules A.

### Phase 1 — Disk, read only

Goal: one screen shows every root, every entry, its size and whether it can be
reclaimed.
Done when: signed in at `/laptop/` (or where Q1 rules), Disk lists the four
roots with per-entry sizes matching `du -s` to the shown precision, and an
unknown file seeded in a root shows as unknown. Proved with `drive-browser`.

- [ ] 1.1 A model-less `laptop` service, gated at ADMINISTRATOR like `basecamps`,
  with a `disk` read over `homeReport()`. Regenerate `app.snapshot.md` so the dev
  proxy routes it (Workbench's `CLAUDE.md` § Traps).
- [ ] 1.2 The route and nav entry; Disk's columns are Docker's (class, size,
  reclaimable), roots first, entries under each.

### Phase 2 — Reclaim

Goal: the reclaimable part can be reclaimed from the page.
Done when: Clear on the registry cache empties it and the next `fli` command
rebuilds it; removing an idle lane frees its bytes and `fli autopilot` opens it
again on the next run; Remove on a lane a loop holds, or a lane with uncommitted
work, is refused with the reason.

- [ ] 2.1 Clear for `reclaim: 'clear'` entries, inside `cacheDir()` only.
- [ ] 2.2 A `removeLane(n)` in `scripts/lanes.mjs` (worktree remove + prune),
  refused while a loop holds the lane or its worktree is dirty; Disk calls it.
- [ ] 2.3 Confirmation is in the page (the row turns into "Remove 1.1 GB? Yes /
  No"), and the toast says what was freed.

### Phase 3 — Keys

Goal: every secret file fli and its apps keep is listed with presence and mode,
and a wrong mode is visible and fixable.
Done when: a temp-home test with a 644 `.env` shows it flagged and Fix sets 600;
no response body from the `laptop` service contains a file's contents (a test
greps the payload for a seeded secret value).

- [ ] 3.1 `keys` read: each `secret` entry with present/absent, mode, owner, mtime.
  Values never leave the API.
- [ ] 3.2 Fix mode (chmod 600) per row.
- [ ] 3.3 The Frontier network identity (`frontier/member.json`, `peers.json`,
  `waiting.json`) shown as who this laptop is and who it peers with, read only.

### Phase 4 — Global env and user commands, in Settings

Goal: the global `.env` and the user commands can be seen without a terminal.
Done when: setting a key in the page makes `fli` read it on the next run, values
are masked in the page, and every user command shows with its file path.

- [ ] 4.1 Global env: keys listed, values masked, Set and Unset through
  `storeGlobal`.
- [ ] 4.2 User commands: each command from the registry's user layer, its
  description and its path.

### Phase 5 — Running

Goal: what fli is running on this laptop across every project.
Done when: a dev server started in `example/` shows with its port and project;
a tree hold taken by a loop shows with its tree; both disappear when released.

- [ ] 5.1 Sessions and ports from `ports.js` (`readLock`, `listeningPorts`,
  `whoHolds`).
- [ ] 5.2 Holds from `guard.js`'s holds dir.

### Phase 6 — Local backups on Basecamps

Goal: each Basecamp's row shows the backups pulled to this laptop.
Done when: `/basecamps/` lists each entry's local copies under `dataDir()` with
date and size, and Delete removes one.

- [ ] 6.1 Read `dataDir()/basecamp/<name>` per entry.
- [ ] 6.2 Delete per copy, with the same in-page confirmation as 2.3.

### Phase 7 — Strays and leakers

Goal: files outside the four roots that fli's tooling left behind are found and
stop appearing.
Done when: `verify-docker.mjs` leaves nothing in `~/.cache` after a run that
passes or fails.

- [x] 7.1 `verify-docker.mjs` removes its three `mkdtemp` dirs in a `finally`
  (file an `FJS-###`). Found already so on re-probe 2026-11-06: the `finally`
  at the drive's end removes all three and `~/.cache` holds no `fjs-verify-*`
  dir, so the 2.7 GB were from runs before that landed. No defect to file.
- [~] 7.2 The Strays list — dropped: Q4 ruled B (`FJS-D1994`); it reopens only if strays keep turning up after 7.1.
