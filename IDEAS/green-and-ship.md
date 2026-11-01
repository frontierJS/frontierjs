---
id: green-and-ship
status: proposed
dated: 2026-11-01
---

# Green and ship — FJS-009 to the latest of every package on both hosts

**Status: PROPOSED.** Dated 2026-11-01. Nothing here is built. Do not cite this
file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-01): a plan for checking CI and deploying the
latest of all the packages. Two plans already hold the pieces —
[FJS-009](../ISSUES.md#fjs-009) is the runner going green, and
[`publish-order.md`](publish-order.md) is the release that cannot strand a tag,
whose 1.3 and Phase 2 sit on branch `publish-order-integ` until FJS-009 closes.
This paper is the order between them, and the release at the end.

## What exists (probed 2026-11-01)

- **`origin/main` is `07817781`; `dev` is 18 commits past it at `0c34b8c3`**,
  tree clean. The runner's last verdict, run `41150925200` on `07817781`, was
  red 11 ways: lint, structure, registers, three snapshots, `deploy --source
  npm`, the deploy cycle's third deploy, and the basecamp, cli and sierra
  suites. The fast-tier half was drift already fixed in the tree when it was
  pushed; `deploy --source npm` is `FJS-3774`, fixed in `dev`.
- **The pre-push hook grades the pushed sha**, not the working tree, since
  `72d24887`: each branch tip is checked out into `../frontierjs-prepush`,
  installed with `--frozen-lockfile`, and run through `ci --fast`. Driven both
  ways before it landed. It only helps a push that does not say `--no-verify`.
- **The latest tags are on one host.** `@frontierjs/litestone@1.1.13`,
  `junction@0.1.11`, `sierra@0.1.10`, `cli@0.1.11` and ten more were tagged and
  released to GitHub on 2026-10-31 (`chore(release): 19 packages`,
  `347c0a3e`); npm holds one patch behind on each. `ws:pub` calls that a
  release in flight — held on `tarballs`, missing on `npm` — and finishes it
  where it is missing rather than bumping over it.
- **`publish-order-integ` is 21 commits past the merge base**, touching
  `ws:pub`'s steps, `publish-hosts.js`, `publish-preflight.js`,
  `publish-view.js`, `vendor.js` and their tests. It overlaps `dev` in one
  file, `IDEAS/publish-order.md`. Its CI gate — `publish-order` 2.1, the step
  file `01b-ci.md` on the branch — runs the full tier on the release sha with
  no bypass (`FJS-D1720`, `FJS-D1723`), which is why it waits.
- **The full tier's runner-only reds** are the deploy cycle's third deploy
  finding a lock "held by runner, started 0s ago, in step 02-decide", and three
  cli tests that pass alone: `resolveCommands`, `lanePatch`'s sierra-fresh
  sidecar, and the real-docker-from-another-cwd case that is
  [FJS-3394](../ISSUES.md#fjs-3394) (`env: real machine`). The sierra bundle
  ratchet rose by four numbers nobody adopted. Basecamp's three — key escrow,
  the host row, the pinned Outpost version — have not been run at `dev`.

## Questions

- **Q1 — A cli test red only in the full run and green alone: fix the
  isolation, file it `env:`, or name it in `scripts/ci-allowances.json`?**
  **Recommend fix the isolation** — an allowance hides the next one, and
  `env:` is for a cause that lives in the machine, which "passes alone" is not.
- **Q2 — Ship the 2026-10-31 tags to npm as they stand, or bump fresh under
  the new gate?** The tags point at `347c0a3e`, which no runner graded green,
  and `FJS-D1720` with `FJS-D1723` already bar a tag on an ungraded sha, so
  this asks only about the tags that exist.
  **Recommend one run of `ws:pub patch --to npm --to tarballs` after Phase 3**:
  a package with commits since its tag is bumped and graded; one without is
  finished on npm from its tag's worktree (`FJS-D1722`). Nothing red is
  promoted and nothing is published twice.

## Phase 0 — Know what dev is

Goal: a verdict on `dev` as committed, fast and full, with every red named.
Done when: `ci --fast` on the pushed sha is green, and each full-tier red is a
fix in `dev` or a row.

- [x] 0.1 Fast tier on `dev`'s tip through the hook: `echo "refs/heads/dev
  $(git rev-parse dev) refs/heads/main $(git rev-parse origin/main)" | sh
  scripts/hooks/pre-push origin x`.
  - 2026-11-01, at `0c34b8c3`: red on `registers` alone, 142s. Lint,
    structure, snapshots and typecheck are green. The four findings:
    `FJS-D1761`, `FJS-D1762` and `FJS-D1763` were issued twice — as
    question rows in `ISSUES.md` and, the same day, as naming-conformance
    rulings in `DECISIONS.md` — and `owed-rulings.md`'s advise-rules entry
    had a `**Recommend …**` line naming no option letter.
- [ ] 0.2 Full tier in the same worktree, `FJS_CI_REQUIRE_DOCKER=1 node
  scripts/ci.mjs` from `../frontierjs-prepush`, about 30 minutes. A laptop and
  the runner differ in uid and Chrome, so this names what is drift and leaves
  the runner-only reds to Phase 2.
- [ ] 0.3 Each red becomes a step below or a row: drift is fixed in `dev`,
  a machine cause is `env:`, and a suite that is green alone is Q1.

## Phase 1 — The fast tier green on main

Goal: a push to main that the hook let through, graded the same way by the
runner.
Done when: the runner's `ci-last` artifact shows every fast-tier phase ✓ on
main's tip.

- [x] 1.1 Clear 0.1's reds in `dev`: the three question rows are reissued
  as `FJS-D1766`–`FJS-D1768` (the rulings keep the ids, being the half other
  files cite), with their `blocked by` citations and the `owed-rulings.md`
  and `browser-kit.md` entries moved, and the `Recommend` line names `A`.
  `fli register:check` prints 0 errors (2026-11-01).
- [ ] 1.2 Merge `dev` into `main` and push without `--no-verify`. Four minutes
  in the hook; a block names the sha and the detail file.
- [ ] 1.3 Read the runner: `gh run list --workflow ci.yml -L 1`, then `gh run
  download <id> -n ci-last`. The fast phases are ✓; the full-tier list is
  checked against 0.2.

## Phase 2 — The full tier green: FJS-009 closes

Goal: `bun run ci` exits 0 on the runner.
Done when: a green run on main, and FJS-009 closed citing its run id.

- [ ] 2.1 Sierra's bundle ratchet: find the raise or adopt it — `cd
  packages/sierra && node bench/run.mjs --adopt`, reason in the commit.
- [ ] 2.2 The deploy cycle's third deploy: why the lock is still held, by the
  runner's own user, in `02-decide`, zero seconds in — a journal dir reused
  between the second deploy and the third, or a lock the second never let go.
  Reproduced in the worktree under `FJS_CI_REQUIRE_DOCKER=1` first.
- [ ] 2.3 The three cli tests, per Q1: each run alone, then inside the suite,
  then inside the full run, to find which neighbor breaks it. FJS-3394 is one
  of them and already a row.
- [ ] 2.4 Basecamp's three at `dev`: `cd packages/basecamp && bun run test`.
  The pinned-Outpost case reads the version this workspace carries, so a bump
  without the pin is the likely cause.
- [ ] 2.5 Push, runner verdict, close FJS-009 with the run id and the
  `ci-last` artifact's summary.

## Phase 3 — Land the tag-last release

Goal: `publish-order` 1.3 and Phase 2 on `dev`, proved in scratch.
Done when: `publish-order` Phase 2's own done-when — the 0.1 scratch replay
ends with the tag on the fixed HEAD and the packages shipped, no hand step.

- [ ] 3.1 Merge `publish-order-integ` into `dev`; the one conflict is
  `IDEAS/publish-order.md`. Then `cd packages/cli && bun run test` (583 were
  green on the branch) and a merged `fli ws:pub --dry` walking all six steps.
- [ ] 3.2 The 0.1 replay: a one-package bun workspace in a scratch directory
  under `$HOME`, a bare remote, a stub `npm` on `PATH`, a hook that fails
  once. Never this tree, never `git stash`.
- [ ] 3.3 Tick 1.3 and 2.1–2.5 in `publish-order.md`. Its Phases 3 and 4 —
  `--status` and the GUI panel — belong to that plan's session and are not a
  release's wait.

## Phase 4 — Ship the latest of every package

Goal: every package's newest version on both hosts, installable from each.
Done when: `fli ws:pub --dry --to npm --to tarballs` names nothing missing and
nothing to bump, and 04's fresh app installs from npm and from the package
host.

- [ ] 4.1 `fli ws:pub patch --to npm --to tarballs --dry` from `dev` at the
  Phase 2 sha: the picture per Q2 — which packages bump, which are finished on
  npm from their tag's worktree, and what 01b would grade.
- [ ] 4.2 The real run, `--interactive` for npm's 2FA. Under the landed gate:
  01 bumps and commits, 01b runs the full tier on that sha (about 30
  minutes), the tag is written on green, the graded sha and its tags are
  pushed with `--no-verify`, 03 packs each from its tag's worktree, 04
  scaffolds a fresh app from each host and fails the run if one does not
  install (`FJS-D1736`).
- [ ] 4.3 From outside this tree: `fli new --source npm` under a scratch
  `HOME` on this box, and once on another. A published litestone refusing a
  keyword the scaffold writes (`FJS-2084`'s shape) shows only here.
- [ ] 4.4 `ci`'s registry note goes to zero packages differing between tree
  and registry; the release's `ci-runs` record is kept (`FJS-D1738`).
