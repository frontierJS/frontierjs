---
id: conduits-move
status: shipped
dated: 2026-11-04
---

# Idea — moving the 27 connectors into `packages/conduits/`

**Status: DONE 2026-11-05, uncommitted. Every box closed; Q1–Q11 ruled 2026-11-04/05. Owed after the commit: the CI lane's skip-path proof and the toolbelt `units` declaration.**
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
  - The record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasconduits-movemd).
- [x] 0.2 Record the baseline: `fli check` and `fli ws:atlas --as=report` on this
  tree.
  - The record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasconduits-movemd).

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
  - The record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasconduits-movemd).
- [x] 1.1a Renames in the sibling, before any copy (Q7–Q11): tax folds into
  stripe as a module; shipping → easypost; google-maps → google with maps as
  its first module; push splits into apns and an fcm module of google, each keeping its own
  result type and failure vocabulary (there is no shared `PushMessage`;
  notifications is the layer that maps both onto one message);
  37signals keeps its name and gains Basecamp in its description and keywords.
  Each rename moves its sink, drive, README, CLAUDE.md and PROJECT_STATE.md;
  every drive green after. 27 packages become 26.
  - The record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasconduits-movemd).
- [x] 1.2 One owner for workspace membership in `packages/cli/core/` that reads
  the root `workspaces` globs (literal and `X/*`, which is all the root uses)
  and returns per Q5; every W walker calls it and `scripts/ci.mjs` imports it
  by path as `fix-loop.mjs` already imports `core/*.js`. The test is a fixture
  workspace with `packages/a` and `packages/group/b`, asserting each walker
  reaches `b` — `runnables.js` first.
  - The record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasconduits-movemd).
- [x] 1.3 `vendor.js` packs a dependency from whichever member directory holds
  it, through the same owner; its test packs a nested member; the emitted
  Dockerfile `bun link` loop iterates the member list, not `packages/*/`.
  - The record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasconduits-movemd).
- [x] 1.4 `connector-contract` and the `coverage` note read members from the
  owner; `docs/CI.md` row updated and `FJS-026`'s allowance kept. The R
  clusters that BUILD a path (`ci.mjs:1523` first) take `path` from the owner.
  - The record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasconduits-movemd).

**Done 2026-11-05.** The sibling is frozen at e0ace4e with 26 packages after the renames; one membership owner, `core/workspace-members.js`, replaced every walker, `vendor.js` packs from any member directory, and the connector-contract check reads members. All of it is in the owner's 00:58 commit; the move itself did not start until it was.

### Phase 2 — The move

Goal: 27 workspace members, every drive green from this tree.
Done when: `bun install` is clean, `bun run --filter './packages/conduits/*'
test` and `drive` are green, `fli check` reports no `connector-contract` or
`package-root-md` finding, and the snapshots phase is clean.

- [x] 2.1 Copy the 26 (after 1.1a) into `packages/conduits/`; `CONTRACT.md` to
  `packages/conduit/docs/`; the sibling-only `link.sh` and `REPORT.md` stay
  behind. `peerDependencies` stays; tax → stripe and gmail → oidc become
  `workspace:*`.
  - Done 2026-11-05. `git archive HEAD packages` from the sibling at e0ace4e,
    so committed content only: 26 folders, no `node_modules`, lockfile or
    `.env`. The sibling's shared drive harness `lib/drive.ts` lands at
    `packages/conduits/lib/drive.ts` — a folder with no manifest, which the
    membership owner skips — and the 20 drives that import it drop one
    `../`. `CONTRACT.md` is `packages/conduit/docs/CONTRACT.md`, indexed in
    that folder's README. Dependency shapes as found: a peer range on
    `@frontierjs/conduit` (`^0.1.0`) in every connector, toolbelt peers in
    s3, mailgun, postmark, hetzner, digitalocean; gmail's peer on
    `conduit-oidc` is `workspace:*`. Easypost imported
    `@frontierjs/toolbelt/units` with no toolbelt in its manifest — it only
    resolved through the sibling's `link.sh` — and now peers on `^0.1.10`.
- [x] 2.2 Root `workspaces` per Q2; `bun install`; the 27 drives run from this
  tree with their `test` script unchanged; `scripts/ci-allowances.json` drops
  the `packages/conduits` folder exemption.
  - Done 2026-11-05. `"packages/conduits/*"` is the last root `workspaces`
    entry; `bun install` added 34 packages and every nested
    `node_modules/@frontierjs/*` under a connector is a symlink into this
    tree — the published-copy shadow `link.sh` warned of did not happen,
    because every peer range is satisfied by the workspace version. The
    `packages/conduits` allowance is gone. The `test` script was `bun test`
    in 22 connectors and absent in 4, and `bun test` exits 1 with no test
    files: a connector's suite IS its drive (`test/<x>.drive.ts`, the
    harness above), so every `test` now runs `bun run drive`, as 37signals
    and mattermost already did. `bun run --filter './packages/conduits/*'
    test` exits 0 with 26 "all green" (the drives need no credential or
    network). `fli check` has no `connector-contract`, `package-root-md` or
    `test-files-run` finding; it does warn `doc-map-narration` ×4 and
    `doc-examples-run` for three connector READMEs — 2.3 answers them.
- [x] 2.3 Registers: 27 rows in the commented package table per Q1 with ring
  `conduits` (added to `repo-rings.js` below `batteries`, Q6) plus a check that
  a member without a row is a finding; ONE `DRIVES.md` row per table for the
  group and `resolveRun` in `proofs.js` expands it to the 27 drives so
  `proof-drive-named` and `fli proves` still name one connector (Q4 B); one
  `docs/TESTING.md` row for the group; `packages/conduit/CLAUDE.md` and
  `packages/conduits/README.md` point at the live home. Then `fli ws:exports`,
  `fli ws:deps`, `fli ws:atlas` and `--as=report`, diffed against 0.2.
  - Done 2026-11-05. 26 rows in the commented table (first cell is the
    folder, `conduit-<x>`; repo-map pairs a row by member name then folder),
    State "Prototyped. <n> drive rows green from this tree", ring `conduits`
    below `batteries` in `repo-rings.js` (its tone is a teal mix of info and
    success — every named tone was taken). The table parse moved to a leaf,
    `core/package-table.js`, because `repo-map.js` imports `checks.js` and the
    new `package-row` warning (a member with no row) could not reach it
    without a cycle. DRIVES.md carries one group row per table spelled
    `packages/conduits/*`: `drive`; `proofs.js` expands a `X/*` where into one
    target per member whose manifest has the script (none → one unknown
    target, so `proof-target` still fires) and `preflight.js` expands the
    same way; `fli proves` on one connector names all 26 — narrowing to the
    touched connector is a matcher change left for when the group is slow.
    `docs/TESTING.md` row; `packages/conduits/README.md` names the 26 as the
    live home; `packages/conduit/CLAUDE.md` points at it. The seven
    warnings: four dated sentences moved to each package's PROJECT_STATE.md,
    three sketch fences marked `ts fragment`. Atlas report: 27 → 53
    packages, snapshots regenerated; `fli ws:exports` now counts 47
    publishable, which 2.4 corrects. Two `ask.test` misses came from writing
    the harness path beside the word "drive" in DRIVES.md and TESTING.md —
    reworded. 616 pass in the touched test files.
- [x] 2.4 Publishing: `fli release check` shows the 27 held out until each is
  on npm; a connector enters the release list by a later ruling, not by moving.
  - Done 2026-11-05. There was no single publishable predicate — every release
    caller applied `!manifest.private` over `packageMembers`, which the atlas,
    registers, proofs and doc-audit also read — so the holdout is one
    `HELD_OUT = ['packages/conduits/']` prefix in `workspace-members.js`
    behind `releasableMembers(root)`, and the four release callers
    (`runtime.js` `wsPackages`, `publish-view.js`, `signatures.js`
    `publishedPackages`, `vendor.js` `sourceOfRoot`) read that view. Every
    `ws:*` command that shares `wsPackages` (`ws:list`, `ws:run`, `ws:exec`,
    `ws:status`) therefore leaves the connectors out too, which is the
    set-apart reading of `FJS-D1913`; the atlas and `fli check` still see all
    26. `fli ws:exports` 47 → 21 publishable; `fli ws:pub --dry` names no
    connector (before this, a never-tagged package counted as affected and a
    plain run would have shipped 26 at 0.0.2). `fli release check` is the
    schema release classifier, not a package list — the step's wording was
    wrong. Ruling a connector INTO releases later means narrowing the prefix,
    which is coarse; a per-connector list waits for that day.
- [x] 2.5 Typecheck: a connector enters `scripts/typecheck-baselines.json` only
  if red; absent means 0 and a ratchet only goes down.
  - Done 2026-11-05. Every connector has `"typecheck": "node
    ../../../scripts/typecheck.mjs"` and joins root `bun run --filter '*'
    typecheck`. mailgun and postmark extended `../../tsconfig.base.json`, a
    path one level short since the move, and went from 85 and 76 errors to
    clean once it read `../../../`. Thirteen are seeded in
    `typecheck-baselines.json` by hand (`--update` only lowers): microsoft
    42, oidc 12, gmail 6, apns 3, google 3, n8n 2, openai 2, and 1 each in
    digitalocean, easypost, hetzner, mattermost, s3, telnyx — four of the
    ones are a missing declaration for `@frontierjs/toolbelt/units`. Root
    typecheck is red only on haven (2) and basecamp (1), as before.
- [x] 2.6 Own CI lane (Q6): a `conduits` phase in `scripts/ci.mjs` that runs the
  group's tests and drives only when a path under `packages/conduits/` or
  `packages/conduit/` changed against the base ref, and is skipped otherwise;
  the default `test` phase excludes the prefix. `docs/CI.md` gets the row.

  - Done 2026-11-05. `conduits` phase after `tests` in `PHASES` and in
    `FULL_ONLY`; it runs `bun run drive` per connector in lanes when a changed
    or untracked path matches `^packages/conduits?/` against the base ref and
    is otherwise skipped in `mutate`'s words; `fli ci --phase conduits` runs
    it anyway. The `tests` phase excludes `isConnector` directories, and the
    prefix is `isHeldOut` from the membership owner. `--phase conduits`: 26
    drives, 41 s; `--tests-only --only conduit-stripe`: tests 0 suites,
    conduits 1 drive. `docs/CI.md` row added, sixteen phases → seventeen.
    Owed: the skip path has not fired, because this tree has the connectors
    untracked — the first `fli ci` after the commit on a change outside the
    group demonstrates it.
**Done 2026-11-05.** 26 members, every drive green from this tree, registers and atlas carry them in their own ring, `ws:pub` cannot reach them, typecheck ratchets them, and CI drives them only when they change. One owed proof: the CI lane's skip path, after the commit.

### Phase 3 — The callers follow

Goal: nothing points at the sibling.
Done when: `rg 'conduit-connectors'` across `fjs-prototypes/*`, `IDEAS/`, the
skills and the memory files hits only history.

- [x] 3.1 `fjs-prototypes/chat`, `chatwoot`, `serpgrid`: `link:` to the new path;
  each app's own drive green.
  - Done 2026-11-05. chat and chatwoot link by NAME (`link:@frontierjs/conduit-<x>`,
    bun's global link registry), so `bun link` run from the three new folders
    re-pointed the registry and a `bun install` in each prototype followed it;
    serpgrid's absolute `link:` path now names `frontierjs/packages/conduits/conduit-gmail`.
    All four resolve into the new home and import (gmail 64 exports,
    mattermost 43, mailgun 14, postmark 13). Prototype repos left uncommitted,
    as their other work is.
- [x] 3.2 Sibling repo: a `README.md` saying where the code went and that nothing
  is committed there again, as its last commit; no deletion.
  - Done 2026-11-05. Sibling commit 490bdae: a README saying the code is in
    `frontierjs/packages/conduits/`, the harness and contract paths, and that
    nothing lands there again; e0ace4e named as the last commit before the move.
- [x] 3.3 Docs: `conduit-connectors.md` § Prototyped points here, `IDEAS/overview.md`
  row 3.9 gets the landed date, `HANDOFF.md` and `packages/conduit/CLAUDE.md`
  name the home. `fli done`.

## See also

- `conduit-connectors.md` — which connectors, in what order, and the dropped
  basecamp Phases 2–3.
- `packages/conduits/README.md` — the home, with the 27 by area.
- `FJS-D1559`, `FJS-D1185`, `FJS-D889`/`D890` (the connector shape), `FJS-026`.

  - Done 2026-11-05. `conduit-connectors.md` status and § Prototyped name
    `packages/conduits/`; `IDEAS/overview.md` 3.9 is `partial`, landed
    2026-11-05, held out of releases; `HANDOFF.md` has the dated entry;
    `packages/conduit/CLAUDE.md` was pointed in 2.3. `fli done` below.

**Done 2026-11-05.** The three prototypes import from the new home, the sibling is history with a README saying so, and the papers point here. Later the same day: the toolbelt `units` declaration landed (`src/units/units.d.ts`, three baselines to zero) and `conduit-sendgrid` + `conduit-dataforseo` were built as stubs (`conduit-connectors.md` rows 14–15), so the group is 28. Owed after the owner's commit: the CI skip-path proof (2.6).
