---
id: workbench-fli-files
status: proposed
dated: 2026-11-06
---

# Idea — fli's files, readable in Workbench

**Status: DONE. Built 2026-11-06, committed `e021a3409`; Q1–Q8 ruled (`FJS-D1991`–`FJS-D2000`); every phase done. Q6's sync marker (`laneDirty` in `scripts/lanes.mjs`) built 2026-11-07, uncommitted.**
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

- ~~**Q6 — When a lane counts as dirty.**~~ **Answered 2026-11-07 (`FJS-D2000`): B — dirty means "differs from what `syncLane` last wrote": record a sync marker (the main tree's diff digest) when a lane is opened or synced, and refuse only when the lane's diff differs from it.** `syncLane` applies the main tree's
  uncommitted diff into every lane, so an idle lane is dirty whenever the main
  tree is — which on this laptop is always. Remove is refused on every real
  lane today, and Phase 2's "removing an idle lane frees its bytes" is met only
  on a clean tree. The lane copy is disposable: a session's edits are harvested
  into the main tree when its row ends.
  - **A** — keep the strict refusal; the row says "has uncommitted changes —
    Remove will refuse". Built so.
  - **B** — dirty means "differs from what `syncLane` last wrote": record a
    sync marker (the main tree's diff digest) when a lane is opened or synced,
    and refuse only when the lane's diff differs from it.
  - **C** — a second confirmation behind a `force` body field.
  - **Recommend B** — it is the one reading under which the refusal means what
    the plan says (the lane holds work nothing else has), and a marker is one
    file per lane written by the writer that already syncs it. A is safe and
    useless on a working laptop; C puts the judgment on the person every time.

- ~~**Q7 — How the services fli signs in to are documented on the screens.**~~ **Answered 2026-11-07 (`FJS-D1998`): A — a sibling catalog, `services.js` beside `packages/cli/core/home.js`: one row per service with how fli signs in (an env key read from `requires:` and `CLOUDS`, a file, or an external CLI with its probe such as `gh auth status`) and a pointer to its Setup section. The actions are DERIVED from the command registry — every command whose `requires:` names the key or whose namespace is the service — never hand-written. Read by a Services tab on Laptop, a "used by" column on Settings' global env, `fli doctor` credential rows, and that configuration doc's § Credentials.**
  fli's accounts live in four places: tokens in the global env
  (`DIGITALOCEAN_TOKEN`, `HETZNER_TOKEN`, `CLOUDFLARE_TOKEN`, `GITHUB_TOKEN`,
  `VW_*`, `ANTHROPIC_API_KEY`), `basecamps.json` (admin and scoped keys),
  `~/.fli/frontier/key.json` (the network identity), and the logins of external
  CLIs (`gh`, `cf`, `npm`, `wrangler`, `claude`, `ssh`). What fli does with each
  is spread over `commands/*/_module.md` § Setup; `packages/cli/docs/configuration.md`
  § Environment variables lists no token; `fli doctor` checks only `requires:`
  keys, the `cf` binary and `basecamps.json` ssh Hosts (probed 2026-11-06).
  - **A** — a sibling catalog, `services.js` beside `packages/cli/core/home.js`:
    one row per service with how fli signs in (an env key read from `requires:`
    and `CLOUDS`, a file, or an external CLI with its probe such as `gh auth
    status`) and a pointer to its Setup section. The actions are DERIVED from
    the command registry — every command whose `requires:` names the key or
    whose namespace is the service — never hand-written. Read by a Services
    tab on Laptop, a "used by" column on Settings' global env, `fli doctor`
    credential rows, and that configuration doc's § Credentials.
  - **B** — as A, with a hand-written actions list per service as well.
  - **C** — a description column on the existing Keys and Settings rows; no
    catalog, doctor and docs unchanged.
  - **Recommend A** — one authored model (sign-in method and probe), the rest
    derived from `requires:`, `CLOUDS` and the registry, so nothing is kept in
    step by hand; `FJS-D1992` chose the same sibling-catalog shape for files.
    B is a second copy of the registry that drifts; C answers "is fli signed
    in to GitHub" in four places. Reopen: if derived command titles read
    poorly, add an optional `blurb` per service, not an actions list.
- ~~**Q8 — Whether the Services screen probes external CLI logins.**~~ **Answered 2026-11-07 (`FJS-D1997`): A — a Check button per service runs its probe (`gh auth status`, `npm whoami`, `cf` profile, `wrangler whoami`, `claude` login) and shows signed-in-as; presence of a key or file shows at once; `fli doctor` runs the same probes. Nothing shells out on page load.**
  - **A** — a Check button per service runs its probe (`gh auth status`, `npm
    whoami`, `cf` profile, `wrangler whoami`, `claude` login) and shows
    signed-in-as; presence of a key or file shows at once; `fli doctor` runs
    the same probes. Nothing shells out on page load.
  - **B** — every probe runs when the tab opens.
  - **C** — no probes; presence only.
  - **Recommend A** — a page that shells out on load is slow and a hung probe
    blocks the tab; presence alone never answers the question for a CLI login.
    A probe never reads or prints a value, and the result is shown as checked
    or unchecked, never inferred from presence.

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

- [x] 1.1 A model-less `laptop` service, gated at ADMINISTRATOR like `basecamps`,
  with a `disk` read over `homeReport()`. Regenerate `app.snapshot.md` so the dev
  proxy routes it (Workbench's `CLAUDE.md` § Traps).
- [x] 1.2 The route and nav entry; Disk's columns are Docker's (class, size,
  reclaimable), roots first, entries under each.

### Phase 2 — Reclaim

Goal: the reclaimable part can be reclaimed from the page.
Done when: Clear on the registry cache empties it and the next `fli` command
rebuilds it; removing an idle lane frees its bytes and `fli autopilot` opens it
again on the next run; Remove on a lane a loop holds, or a lane with uncommitted
work, is refused with the reason.

- [x] 2.1 Clear for `reclaim: 'clear'` entries, inside `cacheDir()` only.
- [x] 2.2 A `removeLane(n)` in `scripts/lanes.mjs` (worktree remove + prune),
  refused while a loop holds the lane or its worktree is dirty; Disk calls it.
- [x] 2.3 Confirmation is in the page (the row turns into "Remove 1.1 GB? Yes /
  No"), and the toast says what was freed. Built 2026-11-06; Clear proved in
  the browser on real registry files, Remove proved on a throwaway lane 3 by
  script (clean: freed; a scratch file: refused; a live pid: refused). Dirty
  is measured from the sync marker (`FJS-D2000`, `laneDirty`), so a lane
  carrying only the main tree's diff is removable; a lane opened before the
  marker reads dirty until its next sync.

### Phase 3 — Keys

Goal: every secret file fli and its apps keep is listed with presence and mode,
and a wrong mode is visible and fixable.
Done when: a temp-home test with a 644 `.env` shows it flagged and Fix sets 600;
no response body from the `laptop` service contains a file's contents (a test
greps the payload for a seeded secret value).

- [x] 3.1 `keys` read: each `secret` entry with present/absent, mode, owner, mtime.
  Values never leave the API.
- [x] 3.2 Fix mode (chmod 600) per row. A secret directory lists only the
  credential-shaped files inside it (`key`, `token`, `.env`, `.pem`,
  `study.json`); the rest of an app folder is Disk's, or every log in
  `state/haven` got a Fix button.
- [x] 3.3 The Frontier network identity (`frontier/member.json`, `peers.json`,
  `waiting.json`) shown as who this laptop is and who it peers with, read only.

### Phase 4 — Global env and user commands, in Settings

Goal: the global `.env` and the user commands can be seen without a terminal.
Done when: setting a key in the page makes `fli` read it on the next run, values
are masked in the page, and every user command shows with its file path.

- [x] 4.1 Global env: keys listed, values masked, Set and Unset through
  `storeGlobal`. `global-env.js` gained `listGlobal` and `unsetGlobal` beside
  it; Set chmods `.env` to 600 after every write, since `storeGlobal` writes
  under the umask.
- [x] 4.2 User commands: each command from the registry's user layer, its
  description and its path.

### Phase 5 — Running

Goal: what fli is running on this laptop across every project.
Done when: a dev server started in `example/` shows with its port and project;
a tree hold taken by a loop shows with its tree; both disappear when released.

- [x] 5.1 Sessions and ports from `ports.js` (`readLock`, `listeningPorts`,
  `whoHolds`).
- [x] 5.2 Holds from `guard.js`'s holds dir. A guard file names its tree by
  `sha1(realpath)`, so the tree is recovered by hashing every session root and
  worktree; one matching none shows as an unknown tree.

### Phase 6 — Local backups on Basecamps

Goal: each Basecamp's row shows the backups pulled to this laptop.
Done when: `/basecamps/` lists each entry's local copies under `dataDir()` with
date and size, and Delete removes one.

- [x] 6.1 Read `dataDir()/basecamp/<name>` per entry. A pulled backup is a
  directory (`<stamp>/` with the archive and its manifest, or `<stamp>-raw/`),
  so `core/basecamp.js`'s `localBackups` lists directories and Delete removes
  one whole; folded into `list` as `local` rather than a second read.
- [x] 6.2 Delete per copy, with the same in-page confirmation as 2.3.

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

### Phase 8 — Services

Goal: every external service fli signs in to is documented on the screens with
how it signs in, whether it is signed in, and what fli does with it.
Done when: a Services tab on `/laptop/` lists each service from the catalog
with its sign-in method, the key or file present or absent, a Check that runs
its probe and shows signed-in-as, and the commands that use it, derived from
the registry; Settings' global env shows which service each key belongs to;
`fli doctor` prints a credential row per service; a test fails when a
`requires:` key or a `CLOUDS` key is missing from the catalog, and when
`packages/cli/docs/configuration.md` § Credentials disagrees with it.

- [x] 8.1 `core/services.js`: one row per service — name, how fli signs in
  (`env` with the key read from `requires:`/`CLOUDS`, `file` with a catalog
  entry of `home.js`, or `cli` with the binary and its probe argv), the Setup
  section it points at; `servicesReport({ probe })` answers presence per row
  and runs a probe only when asked, never reading a value. `commandsUsing
  (service)` derives the actions from the registry.
- [x] 8.2 `doctor.js` prints a credential row per service (presence; `--probe`
  runs the probes).
- [x] 8.3 `packages/cli/docs/configuration.md` § Credentials generated from or checked
  against the catalog; its stale token-less § Environment variables retired.
- [x] 8.4 The Services tab on `/laptop/` and the "used by" column on Settings'
  global env, through `services` and `probeService` reads on the `laptop`
  service. The command list comes from a real `buildRegistry()` built once per
  API process with `projectRoot` at the cli package, so a command added while
  the API runs shows after a restart, and project-level commands are not listed.
