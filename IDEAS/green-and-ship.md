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

## Open questions

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

- ~~**Q3 — The Outpost pin and the release in flight.**~~ **Answered 2026-11-02 (`FJS-D1772`): B — leave the pin, close FJS-009 with the pin test as the one named red (never a `knownTestFailures` entry), move the pin in 4.2.** Basecamp pins
  `OUTPOST_VERSION = '0.1.8'`, npm's newest; the workspace carries `0.1.9`,
  tagged 2026-10-31 and on the tarball host alone. `compute.test.ts` holds the
  pin to the workspace (red now), and `outpostUnpublished()` asks the real npm
  on every enrollment, so a pin of `0.1.9` turns every enrollment test red
  instead (five, probed 2026-11-01) and refuses a real machine by name
  (`FJS-3534`). One of the two is red until `@frontierjs/outpost@0.1.9` is on
  npm, which is Phase 4's finish-in-flight.
  - **A** — finish outpost alone on npm first (`fli ws:pub --to npm` over that
    one package, `--interactive` for 2FA), move the pin to `0.1.9`, then the
    Phase 2 push.
  - **B** — leave the pin, close FJS-009 with the pin test as the one named
    red (never a `knownTestFailures` entry), move the pin in 4.2.
  - **Recommend A** — it is one package of the run 4.2 makes anyway, and it
    ends with no allowance to retire. Under Q4-B the recommendation is B: the
    `0.1.9` tag A would ship is one of the nineteen deleted.

- ~~**Q5 — FJS-3394 blocks FJS-009 on its own.**~~ **Answered 2026-11-02 (`FJS-D1770`): A — chase it on the runner: a one-off workflow step that builds twice and prints both images' histories and `buildx` metadata, so the differing layer is named and the fix is a deterministic build or a test that compares what a build controls.** `packages/cli` test *a real
  docker, from a cwd that is not the app root* builds the same context twice
  and expects one digest; on the runner's BuildKit the two differ, and the
  row is `env: real machine` with no measured cause — nothing here
  reproduces it, two runs today included.
  - **A** — chase it on the runner: a one-off workflow step that builds twice
    and prints both images' histories and `buildx` metadata, so the differing
    layer is named and the fix is a deterministic build or a test that
    compares what a build controls.
  - **B** — `knownTestFailures` for `packages/cli` citing the row, which keeps
    the ratchet but hides every other cli red until it is removed.
  - **Recommend A** — Q1's rule; an allowance for a 4214-test suite is the
    widest one CI would hold.

- ~~**Q4 — Finishing a release in flight, after the branch moved on.**~~ **Answered 2026-11-02 (`FJS-D1771`): B — delete the 19 tags npm lacks, by name and sha, and the GitHub Release each one carries, so a version number names one set of bytes; 4.2 then re-tags the same numbers at one graded sha through `ws:pub`'s untagged-bump path (the workspace already carries them), no patch number spent.** 4.1's
  dry run shows every public package finishing from its 2026-10-31 tag, and
  02 pushing that tag's sha to the branch head (`FJS-3827`).
  - **A** — 02 pushes the branch ref only when the graded sha is this run's
    HEAD, and for a tag the remote already holds pushes nothing; then 4.2
    ships the 19 as tagged, from `347c0a3e` and its neighbors, which no
    runner graded.
  - **B** — delete the 19 tags npm lacks, by name and sha, and the GitHub
    Release each one carries, so a version number names one set of bytes;
    4.2 then re-tags the same numbers at one graded sha through `ws:pub`'s
    untagged-bump path (the workspace already carries them), no patch number
    spent.
  - **Recommend B** — Q2 wanted "nothing red is promoted", and A promotes
    tags on an ungraded sha. `decision-rules` (2026-11-01, twice) agrees,
    with conditions: B overrides `FJS-D1722` (an unshipped pushed tag is
    finished from its worktree) and `FJS-D1725` (a version on one host keeps
    its tag), so its ruling names both and lists each tag with its sha, only
    tags absent from npm, deleted in the run that re-tags; a hand-run
    deletion is a one-off with no test, and the ruling says so; and under B,
    Q3 is B too — the Outpost pin moves to the version 4.2 mints. The push
    fix itself (`FJS-3827`) is independent of the answer and lands now.

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
- [x] 0.2 Full tier in the same worktree, `FJS_CI_REQUIRE_DOCKER=1 node
  scripts/ci.mjs` from `../frontierjs-prepush`, about 30 minutes. A laptop and
  the runner differ in uid and Chrome, so this names what is drift and leaves
  the runner-only reds to Phase 2.
  - 2026-11-01, at `d71dd112`, 1188s, red 7 ways: registers (0.1's four),
    `tutor:tools` (the scaffold's `AuditTrail` lacks `@@index([createdAt])`,
    which `retention-without-an-index` now warns on), `tutor:fleet` (laptop
    only — the Outpost needs root for `nft` and `/etc/outpost`; the runner has
    it and was green here), basecamp (the runner's three), haven (the townhall
    frame was not refreshed after `townhall.data.json` gained 4.55, 4.56 and
    5.55), junction (five, one cause) and mesa (`bytes.floor` and `bytes.rows`
    rose). cli and sierra were green, so 2.1 and 2.3 are runner-only. The
    deploy cycle was a warning, not a red: `--source npm` is skipped while 15
    pins are not on npm.
- [x] 0.3 Each red becomes a step below or a row: drift is fixed in `dev`,
  a machine cause is `env:`, and a suite that is green alone is Q1.
  - Fixed in `dev`: the scaffold and the trait's doc example carry
    `@@index([createdAt])`; haven's frame and world regenerated by `bun run
    frames`; mesa's two numbers adopted (`FJS-3766`'s depth-yield in `_drain`
    and the virtual list's pitch measurement are the bytes); junction's
    operator-filter test sent `price={"$gte":0}`, a JSON document the query
    grammar (`FJS-D125`) never defined and the client never sends — litestone's
    `FJS-3727` now refuses that text on a number column, and the failed
    assertion skipped `app.stop()`, so the app's crash handlers leaked into
    `shutdown.test.ts`'s four; the test sends `price[$gte]=0`. Basecamp's
    key escrow and host row were never order-dependent: both grade the
    development placeholder as its own case, and the real key a laptop has
    is the gitignored `.env`, which bun autoloads here and nowhere else —
    the runner and a worktree run see the placeholder. `bun run test` now
    hands the suite a fixed key (`packages/basecamp/package.json`); the two
    files pass in the worktree without a `.env`. The pin is Q3.
  - Not drift: `tutor:fleet` on a laptop without root — the runner's verdict
    is the one that counts.

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
- [x] 1.2 Merge `dev` into `main` and push without `--no-verify`. Four minutes
  in the hook; a block names the sha and the detail file.
  - 2026-11-01: `main` was an ancestor of `dev`, so `git push origin dev
    dev:main` fast-forwarded it to `9bd4309a`; the hook graded the sha once
    (118s, fast tier green) and the runner opened run `41349376207`.
- [x] 1.3 Read the runner: `gh run list --workflow ci.yml -L 1`, then `gh run
  download <id> -n ci-last`. The fast phases are ✓; the full-tier list is
  checked against 0.2.
  - 2026-11-01: run `41350563144` on `52f78f92` (the 1.2 run was cancelled
    by the next push). Every fast phase ✓, and `mutate` and `perf` with them.
    Against 0.2: registers, haven, junction, mesa and sierra are clear;
    basecamp is down to the pin (Q3) and cli to the docker digest
    (FJS-3394), so 2.3's `lanePatch` and `resolveCommands` were the runner's
    home. Still red: `tutor:tools` (`fli check` finds something in the
    scaffold), `tutor:fleet` (red on the runner now too — the Outpost wrote
    `/etc/outpost`), and print-kit, new (`Runtime.evaluate did not answer in
    30s`). The deploy cycle is the same `--source npm` warning as 0.2.

## Phase 2 — The full tier green: FJS-009 closes

Goal: `bun run ci` exits 0 on the runner.
Done when: a green run on main, and FJS-009 closed citing its run id.

- [x] 2.1 Sierra's bundle ratchet: find the raise or adopt it — `cd
  packages/sierra && node bench/run.mjs --adopt`, reason in the commit.
  - 2026-11-01: already adopted on `dev` — `bench.baseline.json` moved in
    three commits after `07817781`, and 0.2's sierra suite was green.
- [x] 2.2 The deploy cycle's third deploy: why the lock is still held, by the
  runner's own user, in `02-decide`, zero seconds in — a journal dir reused
  between the second deploy and the third, or a lock the second never let go.
  Reproduced in the worktree under `FJS_CI_REQUIRE_DOCKER=1` first.
  - 2026-11-01: the `deploy:revert --plan` between the second deploy and the
    third. Its preflight takes the deploy lock, and a plan ends with
    `$.config.stop`, which skips every later step — `05-cleanup`, the one
    that releases it — so the lock stays at `step=02-decide`. Reproduced by
    hand in a kept cycle directory: the pre-fix cli leaves that lock, the
    fixed one none. The plan branch now releases before it stops; the cycle
    alone passes here (`deployJournalCycle` from a scratch script — never
    with `verbose`, which is `FJS-3826`).
- [x] 2.3 The three cli tests, per Q1: each run alone, then inside the suite,
  then inside the full run, to find which neighbor breaks it. FJS-3394 is one
  of them and already a row.
  - 2026-11-01: not neighbors — the runner's home. `lanePatch` copies the
    lane's index into `~/.fli/lanes`, which only a claimed lane creates, so a
    machine that never opened a lane fails it (`ENOENT`, reproduced with a
    fresh `HOME`); `snapshot()` now creates it. `resolveCommands` passes
    under a fresh `HOME` here and the runner's report carries no error text
    for it, so it waits for the next runner verdict. The docker case is
    FJS-3394: the two builds' digests differ on the runner's BuildKit and
    nothing here reproduces it.
  - Run `41350563144`: `lanePatch` and `resolveCommands` green on the runner;
    the docker case is the one cli red left, and it is FJS-3394.
- [x] 2.4 Basecamp's three at `dev`: `cd packages/basecamp && bun run test`.
  The pinned-Outpost case reads the version this workspace carries, so a bump
  without the pin is the likely cause.
  - 2026-11-01: two were the missing `.env` (0.3); the pin is Q3 and stays
    red until its answer.
- [ ] 2.5 Push, runner verdict, close FJS-009 with the run id and the
  `ci-last` artifact's summary.
  - 2026-11-01: run `41354648097` on `38bc01c5` (`main` = `dev`): every
    phase ✓ but `tests`, and `tests` is exactly the two named reds — the
    basecamp pin (Q3) and the cli docker digest (FJS-3394, Q5); print-kit
    did not repeat. The deploy cycle is still the `--source npm` warning,
    which 4.4 ends. FJS-009 closes on the first run after Q3 and Q5 are
    answered.
- [x] 2.6 The runner's three new reds, from 1.3. `tutor:fleet`: the Outpost's
  fixed layout (`FJS-D1544`) writes `/etc/outpost` and `/var/lib/outpost`,
  which only root has, so the tutor now hands it systemd's two directory
  variables pointing into the workspace; and the release lesson looked for
  `fjs-<appId>`, a name the naming change retired, so it asks for the
  `fjs.app` label and records the container for 08-finish, which had never
  removed one. `tutor:tools`: the lessons scaffold `done:boolean`, which
  `boolean-prefix` (`FJS-D1749`) warns on, so every lesson scaffolds `isDone`
  (23 files, the access lesson's schema anchors and the jobs lesson's SQL with
  them). CI's tutor phase runs green here, 13 lessons. print-kit: green here
  (24 passing); the runner's `Runtime.evaluate` 30 s is the family of
  FJS-1366 and FJS-2230, and gets a row if the next run repeats it.

- [x] 2.7 FJS-3394 on the runner, per Q5 (`FJS-D1770`). The probe workflow
  (`dd70ef0b`, run `41367088483`) built the test's context twice on the
  runner's Docker 29 and found identical RootFS layers, Created and history
  under two image ids: with the containerd image store the id is an index
  digest that takes in BuildKit's provenance attestation, which records the
  Dockerfile path and the cwd, so the two differ by construction. The test
  now compares `RootFS.Layers`, what a build controls; the row closes on the
  next runner run and the probe workflow goes with it.

## Phase 3 — Land the tag-last release

Goal: `publish-order` 1.3 and Phase 2 on `dev`, proved in scratch.
Done when: `publish-order` Phase 2's own done-when — the 0.1 scratch replay
ends with the tag on the fixed HEAD and the packages shipped, no hand step.

- [x] 3.1 Merge `publish-order-integ` into `dev`; the one conflict is
  `IDEAS/publish-order.md`. Then `cd packages/cli && bun run test` (583 were
  green on the branch) and a merged `fli ws:pub --dry` walking all six steps.
  - 2026-11-01: merged as `fb515f22` with no conflict — git folded the two
    sides of `publish-order.md` itself. The cli suite is green on the merge
    (4214 pass, 150 files, 147s) and `fli ws:pub --dry` walks 00 → 01 →
    01b → 02 → 03 → 04, packing all twelve at `fb515f22`.
- [x] 3.2 The 0.1 replay: a one-package bun workspace in a scratch directory
  under `$HOME`, a bare remote, a stub `npm` on `PATH`, a hook that fails
  once. Never this tree, never `git stash`.
  - 2026-11-01: `~/fjs-pub-replay/replay.sh`, rerunnable from scratch. Run 1
    commits `alpha@0.1.1`, goes red at the gate (`scripts/ci.mjs` exits 1
    while `BROKEN` exists), and tags nothing — `git tag` holds the seed
    alone, the stub published nothing. Run 2, after the fix commit, takes
    the untagged-bump path, grades HEAD in a checkout, tags `alpha@0.1.1`
    on that HEAD (`rev-parse` of both agree), pushes branch and tag to the
    bare remote and publishes once (`bun publish`, which 03 calls — an
    `npm` stub alone would not have caught it). Verified by a second run
    from the main thread. Two notes: a first release (no tag at all) that
    goes red at the gate has no resume path, since `untaggedBumps` needs a
    last tag — the replay seeds `alpha@0.1.0`; and 01 prints `committed 1
    release commit(s)` on the resume when it committed nothing.
- [x] 3.3 Tick 1.3 and 2.1–2.5 in `publish-order.md`. Its Phases 3 and 4 —
  `--status` and the GUI panel — belong to that plan's session and are not a
  release's wait.
  - 2026-11-01: the branch had ticked them; 2.3's open note (the replay) now
    cites 3.2.

## Phase 4 — Ship the latest of every package

Goal: every package's newest version on both hosts, installable from each.
Done when: `fli ws:pub --dry --to npm --to tarballs` names nothing missing and
nothing to bump, and 04's fresh app installs from npm and from the package
host.

- [x] 4.1 `fli ws:pub patch --to npm --to tarballs --dry` from `dev` at the
  Phase 2 sha: the picture per Q2 — which packages bump, which are finished on
  npm from their tag's worktree, and what 01b would grade.
  - 2026-11-01, at `fb515f22`: nothing bumps. All 19 public packages are
    "tagged and missing from npm", so the run finishes the 2026-10-31
    release — `patch` is ignored, each is packed from its tag's worktree,
    and 01b prints `CI: skipped — these tags were written after a green
    run`, a credit read from this laptop's `.cache/ci-runs`, not a runner's.
    Q2's premise was wrong: a package with commits since its tag is NOT
    bumped while its tag is unshipped somewhere. Two findings, Q4 and
    `FJS-3827`: 02 would push each tag's sha to `refs/heads/dev`, which git
    rejects as non-fast-forward (`--dry-run` says *tip is behind*), so the
    real run stops in 02 before 03 ships anything.
- [x] 4.1b Per Q4 (`FJS-D1771`), 2026-11-01: the 19 tags npm lacks and the
  GitHub Release each carried are deleted, locally, on origin and on GitHub;
  the ruling lists every tag with its sha. The dry run afterward reads
  *19 package(s) have a bumped version that was never tagged -- tagging it
  after CI, not bumping again*: `css 0.16.8 → 0.16.8` and so on down the
  nineteen, each tagged at this tree's sha once 01b grades it. 4.2 is that
  run.
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
