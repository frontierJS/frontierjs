---
id: prototypes-catalog
status: proposed
dated: 2026-11-18
---

# Prototypes catalog — every prototype in one place, grouped by label, not by folder

**Status: PROPOSED.** Dated 2026-11-18. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: one Workbench page that lists every prototype, lets the owner group,
order and keep some at the top, and says whose each one is — KOBAMI,
Knightworks, personal, or a framework example or test. The same record is the
one place Claude starts when it looks for prior work, an earlier example of a
pattern, or two prototypes that should merge. That holds while the repos stay
together on disk and after some move out.

---

## What exists

- **`../fjs-prototypes/` is 56 separate repos and is not a repo itself.** Only
  `vellum` has a remote (`knightworksicc/vellum`), so nothing on disk records an
  owner. `LEGACY/` and `OUTDATED/` sit beside it in `~/code/FRONTIER/`, not in it.
- **Moving a repo keeps its `package.json`, not its `node_modules`.** Every
  prototype names `"link:@frontierjs/*"`, which resolves through bun's link
  registry, but bun writes each link into `node_modules` as a relative path
  (`../../../../frontierjs/packages/auth`). A move to another depth leaves
  13–20 of them dangling per repo until they are re-pointed or reinstalled.
- **Moving a repo loses what is keyed by its path.** Claude Code keys a
  project's transcripts and memory by its path, and there are 29
  `~/.claude/projects/-home-j-code-FRONTIER-fjs-prototypes-*` folders today.
  `charterDir()` falls back to `fjs-prototypes/charter`
  (`api/src/domain/charter/live-runs.ts:72`), and memories and `IDEAS/` cite
  the paths.
- **Workbench already scans a folder for repos.** `listLocalRepos(root)` in
  `packages/workbench/api/src/domain/local/local-git.ts` returns, per repo,
  branch, ahead/behind, change count, redacted remote, last commit and a
  `frontier` flag (a `frontier.config.js` at the root). It is metadata only, it
  pins `core.fsmonitor` off, and `git.service.ts` serves it to
  `web/src/routes/git-activity/local.mesa`.
- **Workbench's own state is JSON under `WORKBENCH_DIR`** (`pins.json`,
  `logs/`), not the database. `WORKBENCH_DIR` defaults to
  `$XDG_CONFIG_HOME/workbench` (`api/src/core/env.ts`).
- **"Pin" is taken.** In Workbench a Pin is a checkout opened for chats
  (`api/src/domain/workbench/workbench.ts`). This page's "keep at the top"
  needs either a different word or to *be* that Pin (Q2).
- **A `CLAUDE.md` in a parent folder is loaded by every session started under
  it.** A `fjs-prototypes/CLAUDE.md` would load into all 56 repos' sessions on
  every turn, so the catalog file Claude reads must not be one.

## Recommended setup

- **A record is about the repo, and the view is about the owner.** A *record*
  holds owner, kind, status, a one-line purpose and its related repos. It
  lives in one `CATALOG.json` in `fjs-prototypes/catalog/`, its own git repo
  (`FJS-D2270`), and is what Claude reads. *View state* holds favorites, the hand order and
  which groups are folded. It lives in `WORKBENCH_DIR/prototypes.json`, beside
  `pins.json`.
- **A record:**
  ```json
  {
    "ela": {
      "path": "~/code/FRONTIER/fjs-prototypes/ela",
      "owner": "kobami",
      "kind": "client",
      "status": "active",
      "purpose": "ELA conversion — live at ela.maverickmade.tech",
      "related": [{ "to": "sstime", "why": "merges into ELA later" }]
    }
  }
  ```
  `owner` ∈ `kobami | knightworks | personal | framework`. `kind` ∈
  `client | product | stressor | example | test | spike`. `status` ∈
  `active | paused | archived | moving`. Owner and kind are separate axes:
  "examples, tests" is a kind, not an owner.
- **`path` is absolute (with `~/`) from the start**, so a repo that moves only
  changes its own record. The page scans every distinct parent folder the
  records name, plus the default root.
- **A repo the scan finds with no record shows under *Unsorted*.** A record
  whose path no longer exists shows as *missing*. Neither case is an error.
- **Claude's entry point is a `README.md` beside `CATALOG.json`.** It says
  where the catalog is, how to read `related`, and to pass `rg -L` once any
  path is a symlink. No `CLAUDE.md` in the prototypes folder (§ What exists,
  last bullet), and no `.git` at `fjs-prototypes/` itself: the scan stops at
  one and would hide every repo below it.

## Open questions

- ~~**Q1 — Where records live.**~~ **Answered 2026-11-19 (`FJS-D2266`): A — one `CATALOG.json` in the prototypes folder.**
  - **A** — one `CATALOG.json` in the prototypes folder.
  - **B** — a `catalog` key in each repo's `frontier.config.js`, which travels
    with a repo when it moves.
  - **Recommend A** — one file for the owner to write and Claude to read, with
    no edits across 56 repos with work in flight. Only 25 of the 56 have a
    `frontier.config.js`, and the scan reads its presence as "this is an app".
    B's one gain is a record that travels with its repo, which the absolute
    `path` and Phase 4 already cover, so B reopens only if records drift after
    moves.
- ~~**Q2 — The word for "keep at the top".**~~ **Answered 2026-11-19 (`FJS-D2267`): A — *favorite*, page-local view state, the word Workbench chat already uses for a room kept at the top (`isFavorite`, `db/schema.lite`).**
  - **A** — *favorite*, page-local view state, the word Workbench chat already
    uses for a room kept at the top (`isFavorite`, `db/schema.lite`).
  - **B** — reuse Workbench's Pin: keeping a prototype at the top opens it as a
    chat checkout.
  - **Recommend A** — a Pin starts a checkout and its chats, which is heavier
    than wanting a repo near the top; each row gets an "Open in Workbench"
    action instead.
- ~~**Q3 — Keeping `CATALOG.json` safe.**~~ **Answered 2026-11-19 (`FJS-D2268`): A — make it a git repo that tracks only `CATALOG.json` and `README.md` (`.gitignore` = `/*/`).** The prototypes folder is not a repo.
  - **A** — make it a git repo that tracks only `CATALOG.json` and `README.md`
    (`.gitignore` = `/*/`).
  - **B** — rely on machine backups.
  - **C** — A, plus committed copies of each repo's `README.md` and
    `package.json` under `snapshot/<name>/`, refreshed with the catalog.
  - **Recommend A** — the records are hand-judged and lose their reasons without
    history. The outer repo cannot track a nested repo's own files (`git add
    a/README.md` exits 0 and stages nothing when `a/` holds a `.git`), and C's
    copies duplicate history each repo already keeps.
- ~~**Q4 — `LEGACY/` and `OUTDATED/`.**~~ **Answered 2026-11-19 (`FJS-D2269`): B — leave them out.**
  - **A** — catalog them as extra roots with status `archived`.
  - **B** — leave them out.
  - **Recommend A** — old examples are part of what Claude looks for.
- ~~**Q5 — Where the catalog repo sits.**~~ **Answered 2026-11-19 (`FJS-D2270`): A — `CATALOG.json` and `README.md` move to `fjs-prototypes/catalog/`, an ordinary repo the scan lists as one more row; `fjs-prototypes/` holds no `.git`.** Found while building `FJS-D2268`:
  `findRepoDirs` (`packages/workbench/api/src/domain/local/local-git.ts`) stops
  at a folder holding `.git` and never descends, so a `.git` at
  `fjs-prototypes/` hides all 56 repos from the Local scan (default root
  `~/code`) and from Phase 1.2.
  - **A** — `CATALOG.json` and `README.md` move to `fjs-prototypes/catalog/`,
    an ordinary repo the scan lists as one more row; `fjs-prototypes/` holds no
    `.git`.
  - **B** — keep the repo at `fjs-prototypes/` and teach `findRepoDirs` to
    descend into a repo whose working tree holds other repos.
  - **C** — history in `fjs-prototypes/.catalog.git` with no `.git` entry,
    reached with `git --git-dir=.catalog.git --work-tree=.`.
  - **Recommend A** — it removes the cause instead of working around it: no
    scan change for every caller (B), and no history that plain `git`, editors
    and `fli` cannot see (C). Amends `FJS-D2266`'s location and drops
    `FJS-D2268`'s `.gitignore /*/`.
- ~~**Q6 — A moved repo's transcripts.**~~ **Answered 2026-11-20 (`FJS-D2279`): B — rewrite only each line's top-level `cwd`, old path prefix to new, to a temp file renamed over the original with its mtime kept; refused while any process runs inside the repo.** Moving a repo renames its
  `~/.claude/projects/` folders; `claude --resume` from the new path then works
  (probed). But each transcript line records the `cwd` it ran in, and Workbench's
  Claude screens and Import read that as where the session ran.
  - **A** — leave the transcripts as written.
  - **B** — rewrite only each line's top-level `cwd`, old path prefix to new,
    to a temp file renamed over the original with its mtime kept; refused while
    any process runs inside the repo.
  - **C** — keep a ledger of moves and teach every Workbench reader of `cwd` to
    map old to new.
  - **Recommend B** — one truth, written where the move happens. A lists a moved
    repo's sessions under a gone path and Import never offers them; C adds a
    second name every reader (about seven) must consult, and a new one forgets.

---

## Plan

### Phase 0 — The draft catalog

Goal: every prototype has a record the owner has corrected.
Done when: `CATALOG.json` names all 56 repos, every `owner` and `kind` is set
by the owner, and Q1–Q3 are ruled.

- [x] 0.1 Script a first draft: one record per repo from the scan; `purpose`
  from its `PROJECT_STATE.md` or `README.md` first line; `related` and status
  from the memory index and `IDEAS/`. Mark owner and kind `?` wherever the
  remote, memory or IDEAS don't say. *Done 2026-11-19: 56 records, 17 owner
  `?`, 2 kind `?`. Every README's first line was scaffold boilerplate, so
  `purpose` came from the `IDEAS/stressors.md` table and memory; status is
  `active` for a commit since 2026-11-05.*
- [ ] 0.2 The owner fills the `?` owner and kind cells and corrects the rest.
  *Every `?` answered 2026-11-19 (37 framework, 9 personal, 6 kobami,
  4 knightworks). Purpose, status and related wait on the owner's read.*
- [x] 0.3 `README.md` beside it (§ Recommended setup, last bullet).
  *Done 2026-11-19: both files in `fjs-prototypes/catalog/`, a git repo with
  one commit (`FJS-D2270`). `findRepoDirs` over `fjs-prototypes/` finds 48:
  the 47 git prototypes plus `catalog`.*
- [x] 0.4 Rule Q1–Q4 and write the rulings into `DECISIONS.md` (`FJS-D2266`–`FJS-D2269`).
- [x] 0.5 Rule Q5 (`FJS-D2270`).

### Phase 1 — The API reads and writes it

Goal: one call returns every prototype, merging scan, record and view state.
Done when: an API test over a temp folder of three repos (one recorded, one
unrecorded, one record with a missing path) returns all three, each in its
right bucket, and a write round-trips.

- [x] 1.1 `domain/prototypes/catalog.ts` — read and validate `CATALOG.json`.
  Validate owner/kind/status against their sets. Write it atomically, keep key
  order, and preserve unknown fields so hand edits survive.
  *Done 2026-11-19: `PROTOTYPES_DIR` in `core/env.ts`; a copy of the real file
  reads clean (56 records) and re-serializes byte-identically; a bad record is
  listed under `problems`, never dropped from the file.*
- [x] 1.2 The scan reads the records' parent folders plus the default root and
  calls `listLocalRepos` once per folder, then merges by real path into
  recorded / unsorted / missing. The folder holding `CATALOG.json` is skipped,
  not *Unsorted*.
  *Done 2026-11-19: one `listLocalRepos` per folder at depth 1; a recorded
  non-git folder is `recorded` with `git: null`.*
- [x] 1.3 View state in `WORKBENCH_DIR/prototypes.json`: favorites, order,
  folded groups. A name that matches no record is ignored.
  *Done 2026-11-19: `readView` drops unknown names; `writeView` keeps them, so a
  catalog that failed to read does not empty the view.*
- [x] 1.4 `prototypes.service.ts`: `list`, `saveRecord`, `saveView`. It refuses
  a record path outside the scanned folders.
  *Done 2026-11-19: `saveRecord` refuses a path whose parent folder does not exist
  (the scanned set is derived from the records, so "outside" has no other
  meaning); `list` also returns the view. Registered by autoload.*

### Phase 2 — The page

Goal: the owner manages prototypes on one screen.
Done when: a `drive-browser` run groups by owner, favorites one, drags one, edits a
record inline, and the edit is in `CATALOG.json` on disk.

- [x] 2.1 `/prototypes/` route: group by owner (switchable to kind or status),
  favorites first, then hand order, then last commit. Unsorted and missing go
  last. Each row shows git state from the scan.
- [x] 2.2 Inline record edit: owner, kind, status, purpose, related.
- [x] 2.3 Drag to reorder within a group, and fold a group.
- [x] 2.4 Row actions: Open in Workbench (a Pin), open in editor, copy path.
  Open in editor is Lathe on a record, by name, so it pins nothing
  (`prototypes.open`, `domain/local/lathe.ts`).
- [x] 2.5 Nav entry beside `git-activity`. In the Machines menu; the
  palette reads the nav table, so it is there too.
- [x] 2.6 `bun run verify:prototypes` (workbench) is the done-when drive, over a
  scratch catalog: the owner's `CATALOG.json` and view are fingerprinted and untouched.

### Phase 3 — Claude crawls it

Goal: "has a prototype done X?" starts from the catalog, not a 56-folder hunt.
Done when: a fresh session asked for prior art on a named pattern reads
`README.md` → `CATALOG.json` and narrows its `rg` to the matching records.

- [x] 3.1 A memory entry pointing at the README, replacing the path-only
  `fjs-prototypes-link-this-tree` lead line.
  *Done 2026-11-19: `prototypes-catalog-lookup` (reference), indexed beside the
  old entry, which now points at it. Proved: a fresh `claude -p` asked for a
  shared support inbox read the README, grepped `CATALOG.json`, and read only
  `chatwoot/db/schema.lite`, answering in 8 turns.*
- [x] 3.2 Consolidation view on the page: pairs linked by `related`, and repos
  of the same kind with overlapping `db/schema.lite` model names, as
  candidates for the owner to judge.
  *Done 2026-11-19: `prototypes.candidates` (`domain/prototypes/candidates.ts`),
  read only when the page's Merge candidates panel opens. Overlap counts only
  top-level model declarations, at least two shared names, and names declared
  in fewer than a quarter of the schemas (the real 44 drop AuditTrail, User and
  Notification; one shared name gave 87 mostly-noise pairs, two gives 40). Over
  the real catalog the unlinked finds are anvil–linear and chatwoot–quo (six
  models each). `verify:prototypes` 70/0.*

### Phase 4 — Repos leave the folder

Goal: a repo moved to a KOBAMI or Knightworks folder stays on the page and in
Claude's reach.
Done when: one repo is moved, its record's `path` updated, and the page,
`charterDir()` (if charter) and its Claude history all still find it.

- [x] 4.1 A move action: move the folder, update its record, and rename its
  `~/.claude/projects/` folder so transcripts and memory follow.
  *Built 2026-11-19: `prototypes.move` (`domain/prototypes/move.ts`) and a Move
  form on each recorded row. It carries every history folder whose transcripts
  started in the repo or under it (by recorded `cwd`, since `lynx-spike-device`
  encodes like `lynx-spike/device`), rewrites each line's `cwd` (`FJS-D2279`),
  re-points every relative symlink that leaves the repo (bun's `node_modules`
  links), repairs linked worktrees, and refuses a pinned checkout, a process running
  inside, a taken destination and another disk before moving anything.
  `charterDir()` reads the `charter` record. Proved by `prototypes.test.ts`
  (Workbench Import offers the moved session at the new path) and
  `verify:prototypes` 80/0 over a scratch Claude dir. The done-when's real move
  of one of the owner's repos is not done; the owner picks which.*
- [ ] 4.2 An optional generated lens folder of symlinks, one per record, rebuilt
  from the catalog. Only worth building once records span several roots.
