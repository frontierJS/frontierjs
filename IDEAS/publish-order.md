---
id: publish-order
status: proposed
dated: 2026-10-31
---

# Publish order — a release that cannot strand a tag

**Status: PROPOSED.** Dated 2026-10-31; Q1–Q6 ruled `FJS-D1720`–`FJS-D1723`, `FJS-D1725`, `FJS-D1726`. Nothing here is built. Do not cite this
file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-10-31): getting a release out takes too many tries. CI
fails, tags don't land, snapshots need regenerating, more commits arrive, and the
tags then need pointing back at HEAD. Is there a sturdier shape, and is `fli gui`
the place for it?

## What exists (probed 2026-10-31)

`fli ws:pub` (`packages/cli/commands/workspace/publish/`) is the whole release,
in five steps:

- **00-preflight** refuses a dirty package, peer drift, a moved dependency, a
  held-back package, and missing npm or gh auth. All of this happens before a
  version is spent.
- **01-version-all** writes the bumps and the scaffold pins, refreshes the
  lockfile, regenerates the snapshots the bump made stale, then **commits and
  tags** — one lightweight `<name>@<version>` tag per package.
- **02-push-all** runs `git push origin HEAD --tags`. **The pre-push hook runs
  `ci.mjs --fast` here, after the tags already exist.**
- **03-publish-all** packs each package once (`bun pm pack` in the **working
  directory**) and ships the tarball to npm and/or the GitHub Release.
- **04-verify-assets** reads the hosts back.

A release in flight is resumed, not bumped: a package whose tag exists and is
missing from a destination is shipped as it stands. If **commits have landed
since the tag**, the run refuses with `in-flight-moved` (`index.md:239`), and the
only fix it offers is a hand-run `git worktree add` + `bun publish` per package.

`fli gui`'s publish page (`core/publish-view.js`) walks the same steps as a
checklist. It re-derives nothing — every number comes from `ws:pub --dry`, and
that rule stays.

## Where it breaks

**The version is spent before the gate most likely to fail.** The usual run:

1. 01 commits and tags.
2. 02's pre-push CI fails.
3. The owner, or another session, commits fixes.
4. The tags now sit on a commit behind HEAD. The next run hits `in-flight-moved`
   and stops.

Two more ways the tarball can drift from its tag:

- **The pack reads the working tree.** Another session's edit landing between
  01 and 03 ships bytes the tag does not hold. `allow-dirty` exists only because
  of this.
- **`--fast` is the only CI the release passes.** The full tier never runs on
  the release commit.

## Prior art

From memory, not from a run — check before citing.

- **changesets** (CI mode): the version bump merges as a PR only once CI is
  green, and publishing runs on a clean CI checkout of `main`. Tags are created
  by `changeset publish`, after the registry accepts the package.
- **cargo-release**: bump → commit → `cargo publish` → tag → push. The tag comes
  after the publish succeeds.
- **lerna**: `version` commits, tags and pushes; `publish from-package` finishes
  a release whose tags exist. This is the shape `ws:pub` has today, including
  the resume.
- **goreleaser**: the tag is the trigger, and CI builds from a fresh checkout of
  it.

The common thread: **tag after the gates**, and **build from a checkout of the
commit**, never from a working tree.

## The proposal

1. **Tag last.** 01 writes and commits the bump but tags nothing. The release
   commit is checked out into a worktree, CI runs there, and only a green run
   tags it. The push then goes out with `--no-verify`, because CI already
   passed on that exact sha.
2. **An untagged release commit is resumable.** A manifest version that has no
   tag and is on no host is a release in progress. The next run tags **HEAD**
   once HEAD passes CI. Since no tag existed, nothing has to move. This covers
   the CI-failed-and-fixed loop.
3. **Pack from the worktree.** The tarball is built from the release sha, so it
   matches its tag no matter what lands in the main tree meanwhile.
4. **`ws:pub --status`.** One row per package: manifest version, tag sha vs
   HEAD, on npm, on the release host, CI green on that sha, and the next move.
   `--json` feeds the GUI.
5. **The GUI shows state, not a checklist.** The publish page renders
   `--status` as a live table with one button per row for its next move. All
   logic stays in `ws:pub`.

What remains of `in-flight-moved` after 1–3 is narrow: tagged and pushed, then
the npm session lapsed, then commits landed. Packing from the tag's worktree
(step 3) already ships that correctly, so the refusal can become "publish from
the tag" rather than a stop (Q3).

## Questions

- **Q1 — Which CI tier gates the tag?** Ruled **A** ([`FJS-D1720`](../DECISIONS.md#fjs-d1720)).
  - **A** — the full `ci`.
  - **B** — `ci --fast`, the same tier as the pre-push hook.
  - **Recommend A**: a release is rare, and it is the one push that cannot be
    taken back once npm has the package.
- **Q2 — Where does CI run?** Ruled **A** ([`FJS-D1721`](../DECISIONS.md#fjs-d1721)).
  - **A** — in the release worktree, after a `bun install` there.
  - **B** — in the main tree, only while it is clean and HEAD is the release
    sha.
  - **C** — A, falling back to B when the install is too slow.
  - **Recommend A.** It is the only one where the graded bytes are provably the
    tagged sha's, because other sessions write to the main tree. `ci.mjs`
    derives its root from its own path, so the worktree's copy grades its own
    sha. A slow install gets a dependency cache, not a second path. C is the
    reopen path if 0.2 shows A is impractical.
- **Q3 — With commits since a pushed-but-unshipped tag, what happens?** Ruled **B** ([`FJS-D1722`](../DECISIONS.md#fjs-d1722)).
  - **A** — keep the refusal.
  - **B** — publish from the tag's worktree, saying so.
  - **C** — offer to move the tag to HEAD.
  - **Recommend B**: the tag is already public, and the worktree pack makes "the
    bytes the tag names" exact. C rewrites a pushed tag.
- **Q4 — Should the pre-push hook skip a sha CI already passed on?** Ruled **A** ([`FJS-D1723`](../DECISIONS.md#fjs-d1723)). That would
  help every push, not just releases. Each `.cache/ci-runs/*.jsonl` already
  records `commit` and `dirty`, but `dirty` ignores untracked files, which the
  run still graded.
  - **A** — no; `ws:pub` alone pushes `--no-verify` after its own run.
  - **B** — yes, when the recorded run was on a clean tree.
  - **Recommend A** for this plan. B makes the hook trust a gitignored,
    per-clone cache, so a stale file would skip the hook with nothing visible.
    B stays open as its own idea.
- **Q5 — A tag only this clone holds, with commits since and on no host?**
  Found by 0.1. Ruled **A** ([`FJS-D1725`](../DECISIONS.md#fjs-d1725)).
  - **A** — delete it, by name and sha, and resume as an untagged bump
    (2.3). Only when the remote answered, the tag is absent there, and no
    destination holds the version; otherwise refuse.
  - **B** — refuse, naming `git tag -d <tag>` as the fix.
  - **C** — publish from it, as `FJS-D1722` does for a pushed tag.
  - **Recommend A**: a tag the remote lacks was never public, and its sha is
    usually the commit the hook refused. C ships those bytes; B is a hand
    step on the loop this plan removes.
- **Q6 — The release gate and `deploy --source npm`?** Found by 0.2. Ruled
  **A** ([`FJS-D1726`](../DECISIONS.md#fjs-d1726)). That branch installs the
  scaffold pins from npm, and 01 raises them to versions no host has yet, so
  it fails on every release sha by construction.
  - **A** — the gate skips that branch and says so; after publish, 04
    installs a fresh app from each host the run shipped to (`--source url`
    for `tarballs`, `--source npm` for `npm`).
  - **B** — on the release sha, resolve bumped pins to the last published
    version.
  - **C** — publish, then gate, then tag.
  - **D** — a `knownDeployFailures` entry for release runs.
  - **Recommend A**: the published framework is a fact only after publish.
    B grades what nobody ships, C contradicts `FJS-D1720`, and D's allowance
    goes stale right after publish and ratchets.

## Phase 0 — Measure and reproduce

Goal: know what a worktree pack costs and see today's failure on purpose.
Done when: 0.1's scratch run prints `in-flight-moved`, and 0.2 has numbers.

- [x] 0.1 Reproduce the stuck path in a scratch repo, not this tree: release,
  fail the hook, commit a fix, re-run.
  - 2026-10-31: a one-package bun workspace, a bare local remote, a hook that
    fails, and a stub `npm` on `PATH`. Run 1 commits and tags `alpha@0.1.1`,
    then the hook refuses the push. Run 2, after a fix commit, prints
    `in-flight-moved`.
  - **The tag in that state was never pushed.** The remote holds no tags, yet
    the refusal says "publish each from its tag", and the tagged sha is the
    commit the hook refused. Its fix line ships the broken code. 1.3 has to
    tell a local-only tag from a pushed one.
- [x] 0.2 Time `git worktree add` + `bun install` + `ci` at HEAD, and a pack
  of `@frontierjs/css` there. css has a `prepack` build, so it needs real
  dependencies.
  - 2026-10-31, at `f7e71079`: `worktree add` 0.9s, `bun install
    --frozen-lockfile` 0.8s (warm cache, 1.1 GB of hardlinks), css pack with
    its `prepack` build 0.14s. The worktree's `ci` logs to its own
    `.cache/ci-runs/` with `dirty: false`, so it grades its own sha. The
    worktree costs nothing; `FJS-D1721` stands.
  - **Full `ci` is the cost: 25 minutes, and red on a clean sha.** Before
    this run, the last four full runs took 49–57 minutes on a dirty main tree,
    and all four were red. The clean run had 8 failures:
    - four stale snapshots, basecamp's `seed` and `schema` tests, and a
      basecamp structure ceiling, all with fixes uncommitted in the main tree;
    - sierra's bundle-size ratchet, up by 4 numbers;
    - `deploy --source npm`, which is Q6 and `FJS-3774`;
    - `tutor` skipped, because port 7120 was in use.
  - So `FJS-D1720`'s gate goes green only once `FJS-009` closes. Until then
    Phase 2 is built and proved in the scratch repo, and a real release
    under it waits.
- [x] 0.3 Confirm `bun pm pack` in a worktree rewrites `workspace:*` from that
  worktree's lockfile.
  - 2026-10-31, bun 1.4.4: it rewrites from the sibling's **manifest**, not
    the lockfile. In the worktree, toolbelt bumped to `9.9.9` with the
    lockfile left stale packs sierra with `toolbelt: 9.9.9`. The control
    packs `0.1.8`. Either way the pin comes from the tree being packed, so a
    worktree pack is right. The "from the LOCKFILE" comments in `index.md`
    § One bump and `01-version-all` are wrong; 1.1 corrects them. The
    lockfile refresh stays, for `--frozen-lockfile` image builds.

## Phase 1 — Pack from the release sha

Goal: the tarball matches its tag by construction.
Done when: a dry-run pack from a worktree is byte-equal to one from a clean
main tree at the same sha, and `--allow-dirty` is gone.

- [ ] 1.1 03 packs from a worktree of the release commit, removed at teardown.
- [ ] 1.2 Drop `--allow-dirty` and the dirty-package refusal; a dirty tree no
  longer reaches the bytes.
- [ ] 1.3 `in-flight-moved` per Q3, for a tag the remote holds. A tag only
  this clone holds was never public, and its sha is usually the one the hook
  refused (0.1), so it is not published from (Q5).

## Phase 2 — Tag last

Goal: no failing gate can leave a tag behind.
Done when: 0.1's scratch run, replayed, ends with the tag on the fixed HEAD and
the packages shipped, with no hand step.

- [ ] 2.1 01 commits without tagging; a new step runs CI (tier per Q1, place
  per Q2) on the release sha, skipping `deploy --source npm` and saying so
  (Q6).
- [ ] 2.2 Tag only on green, then push **the graded sha** and its tags with
  `--no-verify`, never `HEAD`. A commit landing mid-run would otherwise ship
  ungraded, with the hook's backstop already turned off.
- [ ] 2.3 Resume: an untagged bumped version on no host means "tag HEAD after
  CI", with snapshots regenerated at HEAD first.
- [ ] 2.4 After publish, 04 scaffolds and installs a fresh app from each
  host the run shipped to: `--source url` for `tarballs`, `--source npm` for
  `npm` (Q6).
- [ ] 2.5 Update `PUBLISH_STEPS` so the GUI's `ci` and `push` steps describe
  the new order.

## Phase 3 — Status

Goal: "where is this release" is one command.
Done when: `fli ws:pub --status` prints each package's row and its next move
on this tree, and `--json` parses.

- [ ] 3.1 `--status` reads tags, hosts and CI records using the readers `ws:pub`
  already uses (`hosts()`, `pkgState`, `unpublished`); no new derivation.
- [ ] 3.2 `--json`.

## Phase 4 — The GUI panel

Goal: the publish page shows state and offers the next move.
Done when: `test/browser/specs/publish.spec.mjs` drives the panel through a
scratch release.

- [ ] 4.1 Render `--status --json` as the page's top table.
- [ ] 4.2 One button per row, each running the `ws:pub` invocation the row
  names.
