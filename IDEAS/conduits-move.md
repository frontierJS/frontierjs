---
id: conduits-move
status: proposed
dated: 2026-11-04
---

# Idea — moving the 27 connectors into `packages/conduits/`

**Status: PROPOSED. Phase 0 done; Q1–Q11 ruled 2026-11-04/05; 1.1 next and it is the owner's, 1.1a the renames follow.**
Probed against the tree 2026-11-04. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-04): the gameplan for executing `FJS-D1559` — every
`conduit-<x>` prototype leaves the sibling repo `../conduit-connectors/` and
becomes a workspace member at `packages/conduits/conduit-<x>/`.

## What is ruled

`FJS-D1559` (2026-10-27, supersedes `FJS-D1185`) settled the home and the gate:

- Home is `packages/conduits/conduit-<x>/`; the folder keeps the `conduit-`
  prefix (the package name minus its scope, as aws-sdk `clients/client-s3`).
- The move is its own session, after the sibling's uncommitted work is committed.
- `CONTRACT.md` moves to `packages/conduit/docs/`.
- Four conditions on the move: (a) `vendor.js` resolves more than one packages
  directory; (b) workspace membership is read from the root `workspaces` globs
  through ONE owner, with a test that every walker reaches every member; (c) the
  prototype `link:` callers move in the same change; (d) the sibling's
  uncommitted work is committed first.

Which connectors exist and in what order they matured is
`conduit-connectors.md`; this paper is only the move. `packages/conduits/`
already exists holding one `README.md` that restates the ruling and lists the
27, and `scripts/ci-allowances.json` already exempts the folder.

## What the tree says today

- **The sibling holds 27 packages**, 24 tracked and 3 untracked
  (`conduit-microsoft`, `conduit-n8n`, `conduit-zapier`); 92 paths dirty,
  26 of them under `conduit-37signals` (its paused Phase 4.1 diff). Last commit
  is `5081762` (conduit-quo). All 27 carry `README.md`, `CLAUDE.md` and
  `PROJECT_STATE.md` and no fourth root markdown, so Invariant 17 holds on
  arrival.
- **A connector's manifest** is `exports` `.` → `src/index.ts` and `./sink`,
  `peerDependencies` on `@frontierjs/conduit ^0.1.0`, `test` = `bun test`,
  `drive` = `bun test/<x>.drive.ts`, version `0.0.1`. Two cross-connector
  dependencies: tax → stripe (`^0.0.1` dependency), gmail → oidc (peer). The
  sibling's `link.sh` symlinks conduit, junction, toolbelt and litestone from
  this tree and every connector under its own name; in the workspace both halves
  are Bun's job and `link.sh` dies.
- **Condition (b) is not met**: the root glob is `packages/*` plus three literal
  members, and no helper reads the globs for general use. Seven independent
  enumerators return the same set in seven shapes, and about 14 more modules
  `readdirSync(join(root, 'packages'))` on their own. The `coverage` phase
  documents the consequence — *a `package.json` nested below `packages/*` is
  invisible to the workspace glob, so uninstalled and untested* (`docs/CI.md`,
  `FJS-026`). `connector-contract` reads `packages/conduit-*` one level deep and
  today reports *no packages/conduit-\** — after the move it would skip the new
  home silently. The inventory is Phase 0's record.
- **Condition (a) is not met**: `vendor.js` `resolvePackagesDir` returns ONE
  directory and `namesIn(dir)` lists one level, so a connector under
  `packages/conduits/` is invisible to the image build, and a `bun link` target
  whose parent is `packages/conduits` names a different directory than
  junction's.
- **The atlas reads a package's realm, state and ring from the commented table
  in the root `CLAUDE.md`** (`repo-map.js`, `repo-rings.js`; a comment costs no
  context). A package with no row has no ring. Folder basename is the key in
  about ten modules, among them the typecheck baselines and `ask`'s doc path.
- **`link:` callers outside this tree**: `fjs-prototypes/chat`
  (`conduit-mattermost`), `fjs-prototypes/chatwoot` (`conduit-mailgun`,
  `conduit-postmark`), `fjs-prototypes/serpgrid` (`conduit-gmail`, by absolute
  path). No `link:` inside this repo. Basecamp's `api/src/providers/compute/`
  keeps its own DO + Hetzner copies; moving basecamp onto the connectors is
  `conduit-connectors.md` Phase 3, dropped there and not reopened here.
- **The emitted Dockerfile** (`basecamp/.../dockerfile-template.ts:51`) runs
  `for p in packages/*/; do bun link; done` inside the image — a shell glob,
  one level.
- **Publishing**: 19 packages are on npm; a connector at `0.0.1` is not, and
  must not ride the next `fli release mint` by being a member.

## Open questions

- ~~**Q1 — How the 27 enter the atlas.**~~ **Answered 2026-11-05 (`FJS-D1908`): A — 27 rows in the commented package table, ring `batteries`, one line each.** Each connector needs realm, state and ring
  or `fli ws:atlas` draws it blank.
  - **A** — 27 rows in the commented package table, ring `batteries`, one line each.
  - **B** — the atlas learns a *group*: one row `conduits/*` and the per-connector
    line comes from each package's own `description`.
  - **Recommend A** — the table is already the one owner and a comment costs no
    context; B is a second owner for the same fact and a parser change for a
    cosmetic gain. Twenty-seven hand lines can drift, so 2.3 adds a check that a
    member with no row is a finding.
- ~~**Q2 — The workspace glob.**~~ **Answered 2026-11-05 (`FJS-D1911`): A — the explicit entry, the convention the root already follows for `packages/sierra/example`. A nested `package.json` anywhere else stays invisible, which is what `FJS-026` relies on.** `packages/*` becomes either `["packages/*",
  "packages/conduits/*"]` or `["packages/**"]`.
  - **A** — the explicit entry, the convention the root already follows for
    `packages/sierra/example`. A nested `package.json` anywhere else stays
    invisible, which is what `FJS-026` relies on.
  - **B** — the recursive glob; every nested manifest becomes a member.
  - **Recommend A** — B silently enrolls the `nonMembers` allowance and every
    fixture app with a manifest. B is the reopen path if a third group appears.
- ~~**Q3 — Whether the sibling's git history comes along.**~~ **Answered 2026-11-05 (`FJS-D1909`): A — plain copy; the sibling repo stays as the read-only history, its README says where the code went and that nothing is committed there again.**
  - **A** — plain copy; the sibling repo stays as the read-only history, its
    README says where the code went and that nothing is committed there again.
  - **B** — `git subtree add` / `filter-repo` so `git log --follow` crosses.
  - **Recommend A** — the history is "updates" commits and three named ones, and
    three of the 27 have no history at all; the drives are the record. B costs a
    merge commit with 27 roots and nothing reads it.
- ~~**Q4 — Rows in `DRIVES.md`.**~~ **Answered 2026-11-05 (`FJS-D1912`): B — one row `conduits` whose script runs every connector drive (`bun run --filter './packages/conduits/*' drive`), and `resolveRun` learns to expand it.** `proofs.js` parses BOTH tables (*The drives*
  and *Which drive proves a change*) and `proof-drive-named` fails every drive
  no proof row names.
  - **A** — one row per connector drive in each table, the sink's name in the
    proves column.
  - **B** — one row `conduits` whose script runs every connector drive
    (`bun run --filter './packages/conduits/*' drive`), and `resolveRun` learns
    to expand it.
  - **Recommend A** — a change to `conduit-stripe` should name one drive, not
    27, and A is the rule already in force; B is a parser exception for a
    table nothing reads by eye.
- ~~**Q5 — What the membership owner returns, and what keys a package.**~~ **Answered 2026-11-05 (`FJS-D1910`): A — the owner returns `{ name, folder, path, dir, manifest }` and every caller that keys or builds a path moves to `path` (`packages/conduits/ conduit-stripe`); `folder` stays for display and the typecheck-baseline key.** Today
  the folder basename is the id in about ten modules.
  - **A** — the owner returns `{ name, folder, path, dir, manifest }` and every
    caller that keys or builds a path moves to `path` (`packages/conduits/
    conduit-stripe`); `folder` stays for display and the typecheck-baseline key.
  - **B** — keep `folder` as the id everywhere and add `path` beside it.
  - **Recommend A** — a basename key collides silently the day two groups share
    one; the 27 basenames are unique today, which is why B works until it does not.

- ~~**Q6 — What sets a connector apart from a core package.**~~ **Answered 2026-11-05 (`FJS-D1913`): A — four treatments hang off the `packages/conduits/` prefix: an own CI lane that runs connector tests and drives only when a connector or conduit changed, never in the default every-package run; held out of `fli release` until a later ruling admits one; an own atlas ring `conduits` below `batteries`, which amends Q1's rows to carry that ring; and group register rows, one `DRIVES.md` row and one `docs/TESTING.md` row for the group, which is Q4's B.** Membership is
  mechanical (install, `workspace:*`, `vendor.js`); every other treatment is a
  choice. The owner (2026-11-04) does not want the 27 treated as core packages.
  - **A** — four treatments hang off the `packages/conduits/` prefix: an own CI
    lane that runs connector tests and drives only when a connector or conduit
    changed, never in the default every-package run; held out of `fli release`
    until a later ruling admits one; an own atlas ring `conduits` below
    `batteries`, which amends Q1's rows to carry that ring; and group register
    rows, one `DRIVES.md` row and one `docs/TESTING.md` row for the group, which
    is Q4's B.
  - **B** — members like any other: default CI run, release list, ring
    `batteries`, 27 register rows.
  - **Recommend A** — the owner's stated wish, and it keeps the connector count
    out of every core-package table a person reads.

- ~~**Q7 — `conduit-tax`.**~~ **Answered 2026-11-05 (`FJS-D1915`): A — fold it into `conduit-stripe` as a `tax` module; one credential, one sink, one drive; the package count drops by one.** Named for a capability; it wraps Stripe Tax only and
  already depends on `conduit-stripe`. `FJS-D153` names a connector for its vendor.
  - **A** — fold it into `conduit-stripe` as a `tax` module; one credential, one
    sink, one drive; the package count drops by one.
  - **B** — rename to `conduit-stripe-tax` and keep the dependency.
  - **Recommend A** — Stripe Tax spends Stripe's key; a second package for the
    same credential is `FJS-D153`'s own three costs for nothing.
- ~~**Q8 — `conduit-shipping`.**~~ **Answered 2026-11-05 (`FJS-D1916`): A — rename to `conduit-easypost`.** The wish-list name; EasyPost won and Shippo would
  be a second connector, not a second target.
  - **A** — rename to `conduit-easypost`.
  - **B** — keep `conduit-shipping` as an aggregator name.
  - **Recommend A** — an aggregator over carriers is EasyPost's product, not a
    protocol the package speaks.
- ~~**Q9 — `conduit-gmail` and `conduit-google-maps`.**~~ **Answered 2026-11-05 (`FJS-D1917`): A — `conduit-gmail` stays the user's delegated OAuth grant (calendar and drive join it as modules if they ride the same token); `conduit-google-maps` renames to `conduit-google`, the project-credential products (API key or service account): Maps Platform now, Translate, Vision, YouTube Data later, each a module with a subpath export.** Two Google packages today;
  `conduit-microsoft` is company-named because Graph mail and the identity
  platform share one Entra grant. The line that reads in one sentence is the
  credential kind.
  - **A** — `conduit-gmail` stays the user's delegated OAuth grant (calendar and
    drive join it as modules if they ride the same token); `conduit-google-maps`
    renames to `conduit-google`, the project-credential products (API key or
    service account): Maps Platform now, Translate, Vision, YouTube Data later,
    each a module with a subpath export.
  - **B** — keep gmail and google-maps as two product packages.
  - **C** — one `conduit-google` holding gmail and maps.
  - **Recommend A** — one sentence per package about whose credential it
    spends; C puts a user token and an API key under one name, and nothing
    depends on `conduit-google-maps` yet so the rename is free.
- ~~**Q10 — `conduit-push`.**~~ **Answered 2026-11-05 (`FJS-D1918`): A — split: `conduit-apns` is its own package; FCM authenticates with a Google service account, so by Q9's line it is a module of `conduit-google`. `PushMessage` and the unregistered-device error get one home, in notifications, before the split.** One package, two vendors (`apns.ts`, `fcm.ts`), two
  auth schemes, two error vocabularies; `FJS-D889` allows a multi-implementer
  package only for a shared protocol, and these share none. Notifications
  already has one push driver per vendor (`webPush`, `ntfy`) behind one
  `PushMessage`.
  - **A** — split: `conduit-apns` is its own package; FCM authenticates with a
    Google service account, so by Q9's line it is a module of `conduit-google`.
    `PushMessage` and the unregistered-device error get one home, in
    notifications, before the split.
  - **B** — keep `conduit-push` as a written exception, a capability over two vendors.
  - **Recommend A** — B coins a precedent every later connector can cite.
- ~~**Q11 — `conduit-37signals`.**~~ **Answered 2026-11-05 (`FJS-D1919`): A — keep `conduit-37signals`; Basecamp goes in the description, keywords and README title so a search finds it.** Company-named where the product is Basecamp, and
  `packages/basecamp` is the deploy host.
  - **A** — keep `conduit-37signals`; Basecamp goes in the description, keywords
    and README title so a search finds it.
  - **B** — rename to `conduit-basecamp`, with the `37signals:event` job id and
    its callers.
  - **Recommend A** — in this repo Basecamp already means the host, and a reader
    of `conduit-basecamp` would assume it talks to it.

`conduit-openai` was asked too and is not open: `FJS-D889` names a protocol
connector for the protocol (`s3`, `oidc`, `openai`).

## The plan

### Phase 0 — Inventory

Goal: the exact list of places that assume `packages/<name>` is one level deep.
Done when: the walker table below names every hit with a path and a line, and
`fli check` and `fli ws:atlas --as=report` have been run once as the baseline.

- [x] 0.1 Inventory the walkers in cli, scripts, outpost, basecamp and testing;
  classify each as walker, named-package resolver, already glob-driven or doc.
  - **W — 27 walkers that enumerate `packages/` one level** (file:line):
    `cli/core/checks/repo.js` 286 (`test-files-run`), 414 (`doc-examples-run`),
    458 (`package-root-md`), 520 (`docs-index`), 597 (`connector-contract`,
    filters `^conduit-`) · `repo-map.js:284` `packages()` (atlas, rings, live)
    · `runnables.js:42` `workspaceDeps` and `:57` `appDirs` · `publish-view.js:98`
    `workspaceMembers` · `runtime.js:490` `config.wsPackages` (feeds 12
    `workspace/*` commands and `surface.js`; its comment says *reads packages/*
    only, not the globs*) · `signatures.js:42` · `seams.js:124` and `:280`
    (recursive walk, attributes by `parts[1]`) · `ask.js:420` · `tutorial.js:32`
    · `terms.js:994` · `doc-audit.js:186` and `:204` · `proofs.js:504` ·
    `register-check.js:110` · `vendor.js:132` `namesIn` · `done.js:135, 197`
    (existence gate only) · `scripts/typecheck.mjs:117` · `scripts/bench-ab.mjs:44, 65`
    · `scripts/scaffold-build.mjs:1328` `_publishablePackages` ·
    `basecamp/api/src/domain/release/dockerfile-template.ts:51` (shell glob in
    the image) · `cli/commands/workspace/link.md:42` `findPkg`.
  - **R — about 31 clusters that build `packages/<folder>` or derive a folder
    from `parts[1]`**: `scripts/ci.mjs` 1523 `localVersion` (folder = name minus
    scope, the strongest assumption), 1752 (bench regex `packages/[^/]+/bench`),
    2246, 399/497/1781 (path-keyed maps) · `bench-ab.mjs:135` · `fix-loop.mjs:351`
    · `scaffold-build.mjs:274` (passes `packagesDir`), 1666 · `vendor.js:103, 110`
    · `repo-map.js:159` · `git-status.js:32` · `terms.js:150, 890, 919` ·
    `done.js:363` · `surface.js:222, 246` · `repo-live.js:40` ·
    `repo-atlas.js:189, 243, 1257` · `seams.js:214` · `register-check.js:144, 153,
    180` · `proofs.js:173` · `ask.js:352, 435` · `assets.js:61, 87` ·
    `repro.js:105` · `utils.js:380, 421` (root finders, stay valid) · path-keyed
    configs `biome.json:24-41`, `scripts/mutate-baselines.json`,
    `scripts/ci-allowances.json` · commands that CREATE at `packages/<name>`
    (`workspace/add`, `project/new`, `github/clone`, `workspace/init`) stay as
    they are.
  - **G — 5 already glob- or lock-driven, none a general owner**:
    `scripts/ci.mjs:2254` `workspaceDirs` (understands `X/*` and literals only;
    `packages/*` would still emit the bare `packages/conduits` folder) and
    `:2286` `nestedPackageDirs` (the `FJS-026` note) · `snapshots.js:176`
    `workspaceMember` (`X/*` or literal, bin lookup only) · `deps.js:69`
    `collectDeps` (lockfile `workspaces` keys, nesting-proof once installed) ·
    `vendor.js:99` (tests for a `workspaces` key, then hard-codes `packages`).
  - **D — docs and tests that encode the layout**: `docs/CI.md:15, 23`,
    `packages/conduits/README.md`, `workspace/surface.md:100`, `exports.md:157`;
    fixtures writing `workspaces: ['packages/*']` in `cli/test/` `vendor` (41–320,
    incl. `FJS_PACKAGES_DIR`), `publish-view` 48/103, `deps:24`, `project-root`,
    `runnables:289`, `register-check` 897/969, `terms`, `next:29`, `server:720`,
    `framework-checkout:30`, `checks:6124` (`connector-contract`), `advisories:75`.
  - **Not walkers**: `packages/outpost`, `packages/testing` (only
    `repository.directory`), `.github/workflows` (path filters on `packages/cli`).
    `tsconfig.base.json` has no path-keyed references; `typecheck-baselines.json`
    is keyed by folder BASENAME (`scripts/typecheck.mjs:48`, `repo-map.js:473`)
    and holds only comment keys today.
  - **Top five files by blast radius**: `checks/repo.js` (five walkers, one
    silent after the move), `vendor.js` (+ `scaffold-build.mjs:274`,
    `basecamp/deploy/build.mjs:100`), `runtime.js` `wsPackages` (largest fan-out),
    `scripts/ci.mjs` (`workspaceDirs`, `nestedPackageDirs`, `localVersion`),
    `repo-map.js` (shared model for atlas, rings, live).
- [x] 0.2 Record the baseline: `fli check` and `fli ws:atlas --as=report` on this
  tree.
  - `fli check`: 28 rules, 1 error, 118 warnings; the error is `drive-holds` on
    `packages/outpost/test/verify-docker.mjs`, from the uncommitted outpost work
    in this tree, not this plan. `connector-contract` reports *nothing to check*.
    Atlas report exit 0. Both saved in the session scratchpad; `bun run ci` was
    not rerun, `.cache/ci-last.txt` from `92b1a6fa6` stands.

**Done 2026-11-04.** 27 walkers, about 31 path builders, 5 glob readers, no
owner. The two conditions are real and `runnables.js` is the one that would
fail silently: miss it and no connector drive is a runnable, so
`proof-drive-named` skips them and everything stays green.

### Phase 1 — The sibling is committed, then the owner lands

Goal: conditions (a), (b) and (d) are met before a file moves.
Done when: the sibling's `git status` is clean, and a test in `packages/cli`
fails when any walker misses a member of a two-level fixture workspace.

- [x] 1.1 Commit the sibling: the three untracked connectors and the 37signals
  Phase 4.1 diff as their own commits; the rest as one. The owner commits, or
  says to.
  - Owner said go 2026-11-05. Five commits `c165e64`…`3157182` in the sibling
    (no remote; local only). Nothing secret in the three untracked packages;
    the one secret-looking string is microsoft's sink stand-in.
- [x] 1.1a Renames in the sibling, before any copy (Q7–Q11): tax folds into
  stripe as a module; shipping → easypost; google-maps → google with maps as
  its first module; push splits into apns and an fcm module of google, each keeping its own
  result type and failure vocabulary (there is no shared `PushMessage`;
  notifications is the layer that maps both onto one message);
  37signals keeps its name and gains Basecamp in its description and keywords.
  Each rename moves its sink, drive, README, CLAUDE.md and PROJECT_STATE.md;
  every drive green after. 27 packages become 26.
  - 2026-11-05, done: tax → stripe `src/tax.ts` as `export * as tax`, one sink
    with `taxExpiresInSeconds`, 26 drive rows (`c1f2472`); shipping → easypost
    (`6bef653`); google-maps → google with `src/maps/` and a `./maps` subpath
    export, README states the credential line (`1a23348`); 37signals
    description, keywords, README title (`FJS-D1919`). Module-level names
    (`googleMapsTargets`, `GOOGLE_MAPS_API_KEY`, target ids) kept. All three
    drives green from the main thread.
  - Push split done 2026-11-05 (`6887a18`, `e0ace4e`): `conduit-apns` (14 rows)
    and `conduit-google` `src/fcm/` with a `./fcm` subpath, the google sink
    split into `sink/maps.ts` + `sink/fcm.ts` behind one `sink.ts` with
    per-module `/maps/_sink/*` and `/fcm/_sink/*` controls (32 rows). The
    `provider` field is dropped from results and failures: the caller knows
    which package it called. Owed: the b64url/PEM/DER and `decodeJwt` helpers
    are duplicated in apns and google's `jwt.ts`; toolbelt is their home when
    a third copy appears. No `tsc` run in the sibling (`link.sh` says `bunx
    tsc` triggers an install); `fli typecheck` after 2.2 is the proof. Sibling
    at 26 packages, clean, drives green from the main thread.
- [ ] 1.2 One owner for workspace membership in `packages/cli/core/` that reads
  the root `workspaces` globs (literal and `X/*`, which is all the root uses)
  and returns per Q5; every W walker calls it and `scripts/ci.mjs` imports it
  by path as `fix-loop.mjs` already imports `core/*.js`. The test is a fixture
  workspace with `packages/a` and `packages/group/b`, asserting each walker
  reaches `b` — `runnables.js` first.
  - 2026-11-05, in progress: `core/workspace-members.js` built with
    `workspaceMembers`, `memberByName`, `memberByPath` and `packageMembers`
    (members under `packages/` not nested in another member — the view the
    old `packages/*` callers get, so `example`, `website` and `sierra/example`
    stay out of `ws:pub`, the atlas and `next`). A root with no `workspaces`
    yields `[]`; six test fixtures gained the list. Moved: `runnables.js`,
    `publish-view.js`, `repo-map.js` `packages()`, `runtime.js` `wsPackages`
    (its `path` is now the owner's). On this tree the owner returns the same
    27 as before, the bare `packages/conduits` correctly absent. Full cli
    suite 4356 pass / 0 fail from the main thread. Left: signatures, seams,
    ask, tutorial, terms, doc-audit, register-check, link.md, and the
    `parts[1]` attributions in seams, terms, git-status, repo-map.
- [ ] 1.3 `vendor.js` packs a dependency from whichever member directory holds
  it, through the same owner; its test packs a nested member; the emitted
  Dockerfile `bun link` loop iterates the member list, not `packages/*/`.
- [ ] 1.4 `connector-contract` and the `coverage` note read members from the
  owner; `docs/CI.md` row updated and `FJS-026`'s allowance kept. The R
  clusters that BUILD a path (`ci.mjs:1523` first) take `path` from the owner.

### Phase 2 — The move

Goal: 27 workspace members, every drive green from this tree.
Done when: `bun install` is clean, `bun run --filter './packages/conduits/*'
test` and `drive` are green, `fli check` reports no `connector-contract` or
`package-root-md` finding, and the snapshots phase is clean.

- [ ] 2.1 Copy the 26 (after 1.1a) into `packages/conduits/`; `CONTRACT.md` to
  `packages/conduit/docs/`; the sibling-only `link.sh` and `REPORT.md` stay
  behind. `peerDependencies` stays; tax → stripe and gmail → oidc become
  `workspace:*`.
- [ ] 2.2 Root `workspaces` per Q2; `bun install`; the 27 drives run from this
  tree with their `test` script unchanged; `scripts/ci-allowances.json` drops
  the `packages/conduits` folder exemption.
- [ ] 2.3 Registers: 27 rows in the commented package table per Q1 with ring
  `conduits` (added to `repo-rings.js` below `batteries`, Q6) plus a check that
  a member without a row is a finding; ONE `DRIVES.md` row per table for the
  group and `resolveRun` in `proofs.js` expands it to the 27 drives so
  `proof-drive-named` and `fli proves` still name one connector (Q4 B); one
  `docs/TESTING.md` row for the group; `packages/conduit/CLAUDE.md` and
  `packages/conduits/README.md` point at the live home. Then `fli ws:exports`,
  `fli ws:deps`, `fli ws:atlas` and `--as=report`, diffed against 0.2.
- [ ] 2.4 Publishing: `fli release check` shows the 27 held out until each is
  on npm; a connector enters the release list by a later ruling, not by moving.
- [ ] 2.5 Typecheck: a connector enters `scripts/typecheck-baselines.json` only
  if red; absent means 0 and a ratchet only goes down.
- [ ] 2.6 Own CI lane (Q6): a `conduits` phase in `scripts/ci.mjs` that runs the
  group's tests and drives only when a path under `packages/conduits/` or
  `packages/conduit/` changed against the base ref, and is skipped otherwise;
  the default `test` phase excludes the prefix. `docs/CI.md` gets the row.

### Phase 3 — The callers follow

Goal: nothing points at the sibling.
Done when: `rg 'conduit-connectors'` across `fjs-prototypes/*`, `IDEAS/`, the
skills and the memory files hits only history.

- [ ] 3.1 `fjs-prototypes/chat`, `chatwoot`, `serpgrid`: `link:` to the new path;
  each app's own drive green.
- [ ] 3.2 Sibling repo: a `README.md` saying where the code went and that nothing
  is committed there again, as its last commit; no deletion.
- [ ] 3.3 Docs: `conduit-connectors.md` § Prototyped points here, `IDEAS/overview.md`
  row 3.9 gets the landed date, `HANDOFF.md` and `packages/conduit/CLAUDE.md`
  name the home. `fli done`.

## See also

- `conduit-connectors.md` — which connectors, in what order, and the dropped
  basecamp Phases 2–3.
- `packages/conduits/README.md` — the home, with the 27 by area.
- `FJS-D1559`, `FJS-D1185`, `FJS-D889`/`D890` (the connector shape), `FJS-026`.
