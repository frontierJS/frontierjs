---
id: upgrade
status: proposed
dated: 2026-11-02
---

# Idea — Upgrade: a changelog for app developers, and `fli upgrade` to cross it

**Status: PROPOSED. Nothing described here as the proposal exists.** Dated
2026-11-02. Do not cite this file as describing behavior — see `VERIFYING.md`.

---

## The claim

**An app built on fjs has no way to learn what changed between two releases or
to move across them.** The repo's evolution policy renames everything and keeps
no alias, which is right inside the workspace, where a rename moves every caller
in one change. Outside it — a beta tester's app installed from npm — the same
rename is a break with no note and no fix.

**This is `PHILOSOPHY.md` § IV's *preservation vs. evolution* row, and the fact
it turns on has moved.** The row allows no migration path *where nobody
does* depend, and *where somebody does, the break is announced*. Nineteen
packages are on npm and testers install them (green-and-ship, 2026-11-02), so
somebody now depends, and this paper is the announcing. The answer here keeps the no-alias half —
a rename still moves every caller and keeps no alias — and adds a migration path
beside it: where another framework would keep an alias, this one ships a
codemod. **The root `CLAUDE.md`'s *nothing has shipped* line is amended in the
change that rules this paper.**

**A change file and an upgrade step are one unit, read two ways.** A breaking
change file says what changed and what the app does about it; when the "what to
do" is mechanical, it names a codemod. The release page is the human rendering,
`fli upgrade` the machine one, and neither is written twice.

---

## What is in the tree, 2026-11-02

- **One train is ruled and not built.** `FJS-D948` rules one version for every
  published package, bumped in lockstep, internal peers pinned to it; `FJS-D949`
  moves litestone and auth down to the train's `0.x`; `FJS-D766` generates peer
  ranges at pack time. None is built: the versions run from `0.0.1` (oracle)
  through `0.16.8` (css) to `1.1.13` (litestone), `fli npm:release`'s
  `03-version` step bumps each package from its own number, and sierra still
  peers on hand-typed floors (`junction ^0.1.0`, `litestone ^1.1.0`). **An
  upgrade needs one number on each side**, so this is the groundwork, Phase 0.
- **Two of the three changelog audiences have an owner.** Contributors read git
  and `fli changelog` (`FJS-D675` Q3). An app's end users get the what's-new
  panel (`IDEAS/release-notes.md`, ruled `FJS-D787`, `FJS-D744`, `FJS-D745`).
  **The developer building ON fjs has nothing**, and commit messages here are
  written as rulings for a reviewer, not as instructions for a consumer.
- **The consumer surface is already committed and diffable.**
  `exports.snapshot.md` (entry points, tarball contents, peer ranges),
  `app.snapshot.md`, `errors.snapshot.md`, `access.snapshot.md`, the litestone
  spec snapshot and the cli command list. `IDEAS/version-compatibility.md`
  proposes diffing them across tags (`fli ws:compat`); nothing does yet.
- **The codemod tool has a codename and no design.** `IDEAS/map-packages.md`
  lists `shift` — upgrade codemods, ships as `fli` — *"deferred for want of a
  stable surface to move between"*. One train plus the snapshot diff is that
  surface.
- **The cli tarball ships `bin`, `db`, `core`, `commands`, `console`, `native`,
  `web`** and the root docs — so anything `fli upgrade` reads at the target
  version has to live under one of those, not at the repo root.
- **The consumers that would exercise it.** The 22 `fjs-prototypes` repos link
  this tree and are always at HEAD, so they never upgrade. The npm path from the
  green-and-ship plan (a fresh app installs from npm and checks clean) does.

---

## How others do it

Fetched 2026-11-02 unless marked.

| Tool | Plan vs. apply | Where the steps live | What it is good at |
| --- | --- | --- | --- |
| [Nx `migrate`](https://nx.dev/docs/reference/nx-commands#nx-migrate) | writes `migrations.json`, then `--run-migrations` applies it — *"You can modify migrations.json and run this command many times"* | [each plugin](https://nx.dev/docs/features/automate-updating-dependencies) *"can provide migrations for its area of competency"*, collected from all installed plugins | the cleanest dry run: the plan is a file you can read and edit. Skipping majors is allowed; one major at a time *"is the safest path and is what Nx recommends"* |
| [Angular `ng update`](https://angular.dev/cli/update) | applies at once; `--migrate-only --from --to` re-runs a range | per package, selectable by `--name` | `--create-commits` puts each migration in its own commit |
| [ember-cli-update](https://github.com/ember-cli/ember-cli-update) | applies a diff, conflicts left to the person | the blueprint itself; `--run-codemods` downloads the codemods matching the app's version | scaffold-owned files: *"applies a diff of the changes from the latest version to your project"*, only the section that changed |
| [Changesets](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md) | consumed at release — *"consumes all changesets"* and *"writes changelog entries"* | a file added with each change | the shape: written with the change, collected later |
| Rails `app:update`, Svelte `sv migrate`, Next.js codemods | — | — | from memory, not fetched; not cited by any question |

---

## The proposal

### 1. One change file per consumer-facing change, written in its PR

A file under `.changes/`, changesets-shaped:

```md
---
kind: breaking            # breaking · added · fixed
codemod: rename-app-own   # optional; absent means the body is the manual step
---

`app.register` is now `app.own`. Run `fli upgrade`, or rename the call.
```

**Which surface moved is not a field** — the snapshot diff already says it, and
a field would restate it. At release the change files are collected into the
train's page (Q1) and deleted, so the page is the one origin from then on.

**What makes this different from the `CHANGES.md` that `FJS-D675` retired**:
that file grew 3.4 MB because a gate made every change write an entry and each
entry copied its diff. Here:

- **Only a consumer-surface change writes one** — a change that moves no
  committed snapshot does not.
- **Missing ones are reported, never gated.** The report lists the contract
  changes in the snapshot diff between the last tag and HEAD beside the
  `breaking` change files, for a person to match — the shape `release-notes.md`
  § What the framework owes argued for. A red would train everyone to write a
  change file that says nothing.
- **A dangling `codemod:` is refused at release.** A name that resolves to no
  codemod in the cli is a broken upgrade shipped silently, and failing the
  release is cheap.

### 2. `fli upgrade` reads the release pages between two versions

```
fli upgrade --dry-run           plan only: the release pages between the app's train and
                                the target, the codemods they name, the manual steps left
fli upgrade [--to 0.3.0]        apply:
  1. bump every @frontierjs/* dependency to the target, bun install
  2. run the named codemods in version order; each is idempotent and prints what it touched
  3. fli check, regenerate the app's snapshots
  4. print the manual steps no codemod covers
```

**The pages and codemods come from the target version, not the installed one** —
an old `fli` cannot know a rename made after it shipped. Running the target's
cli (`bunx @frontierjs/cli@<target> upgrade`) gives that with no new package
(Q4).

**A codemod is a pure source transform**: it reads and writes files and assumes
nothing about which version is installed between the app's and the target's.
That rule is what lets one install cover a jump of many versions (Q5).

### 3. What a codemod has to reach

| Kind | Example | What already parses it |
| --- | --- | --- |
| JS/TS source | a renamed import, an `app.<thing>` | a JS AST |
| `.mesa` | a renamed directive or component | mesa's own parser |
| `db/schema.lite` | a renamed `@`-attribute | litestone's parser, if it round-trips (unverified) |
| scaffold-owned files | `vite.config.js`, an Invariant 3 layout move | the scaffold itself: generate at X and at Y, 3-way merge the difference (ember-cli-update's shape) |
| generated SQL that moved | a new system column | not a codemod: the step prints the litestone migration to run |

The last row is why the machine step is not called a *migration* (Q2): here that
word is litestone's, and an upgrade that changes the schema's SQL hands off to
it.

### 4. Boxes are out of scope

Outpost and Basecamp hosts upgrade through their own pin (`OUTPOST_VERSION`);
this paper is about an app's source tree. Q6.

---

## Cut one level simpler

**The smallest version is a person doing the upgrade by hand and writing down
what they did** — Phase 1. Two rehearsals produce the first release pages, the
change file's real fields, and the list of renames the first codemods would have
saved. Nothing is built until that list exists, the same order `FJS-D787` chose
for release notes.

---

## The nine questions

- **Another origin of truth?** No. The change file is the origin until release,
  then the release page; the snapshot diff is read, never restated.
- **Concept budget?** No new noun. *Change file* is descriptive, and *codemod*
  is the ecosystem's word (Q2). *Migration* and *entry* are refused: litestone
  owns the first and `VOCABULARY.md` the second (the client's copy of a row).
- **Complexity the problem's?** Yes — a rename the app cannot see is the
  problem, and a codemod is its smallest machine answer; a written step is the
  smallest answer at all.
- **Predictability?** Improved: an app learns what changed from one page per
  version, and the dry run shows every edit before it happens.
- **Derived instead of restated?** Whether a change is consumer-facing, and
  which surface moved, are read off the snapshot diff; the change file adds only
  what a diff cannot say — why, and what to do.
- **One owner?** The text: the change file, then the release page. The surface:
  the snapshots. The version: the train.
- **Boundary explicit?** The consumer surface is the committed snapshots; what
  they do not hold is not promised.
- **Failure proportional?** A missing change file is a report line; a dangling
  codemod name fails the release; a codemod that fails stops the upgrade in a git
  tree the person can reset.
- **Wrong without anything saying so?** Two cases. A behavior change no snapshot
  holds: the upgrade drive (Phase 5) is the guard, and it covers only what the
  scaffold exercises. A contract change paired by a person with the wrong change
  file: **none** — the report shows both sides and nothing matches them.

---

## Plan

### Phase 0 — One number

Goal: every published package carries the train's version, and a release bumps
them together.
Done when: every published `package.json` holds one version, internal peers are
written from it at pack time, and `exports.snapshot.md` shows them.

- [ ] 0.1 The release bumps every published package to one version (`FJS-D948`)
- [ ] 0.2 Internal peers generated at pack time (`FJS-D766`)
- [ ] 0.3 litestone and auth to the train's `0.x`; their `1.x` deprecated on npm
  (`FJS-D949`) — outward-facing, the owner runs it

### Phase 1 — Rehearse by hand

Goal: know what an upgrade costs before building anything.
Done when: two releases each have a rehearsal record.

- [ ] 1.1 Scaffold an app from npm at train N−1, upgrade to N by hand, record
  every step in a draft release page for N
- [ ] 1.2 Repeat at the next release; compare the two records for the change
  file's real fields

### Phase 2 — Change files and the report

Goal: consumer-facing changes are recorded with the change, and missing ones are
visible.
Done when: a release collects `.changes/` into its page, refuses a dangling
codemod name, and the report prints the contract changes beside the change
files.

- [ ] 2.1 The change file's format, from Phase 1's records
- [ ] 2.2 `fli make:change` writes a change file with its id
- [ ] 2.3 The release collects change files into the train's page, refuses a
  dangling `codemod:`, and deletes them
- [ ] 2.4 The contract report: a diff of the committed snapshots between the last
  tag and HEAD, printed beside the `breaking` change files
  (`version-compatibility.md` level 1)

### Phase 3 — The dry run

Goal: `fli upgrade --dry-run` prints the plan for a real app.
Done when: run against a rehearsal app at N−1, it prints the pages, codemods and
manual steps between N−1 and N, and changes nothing.

- [ ] 3.1 Read the app's train from its dependencies; resolve the target
- [ ] 3.2 Read the release pages between them from the target's cli
- [ ] 3.3 Print the plan

### Phase 4 — Apply

Goal: `fli upgrade` applies the plan.
Done when: the rehearsal app upgrades from N−1 to N with no manual step the
pages did not name.

- [ ] 4.1 Bump dependencies and install
- [ ] 4.2 The first codemod, from a rename Phase 1 recorded
- [ ] 4.3 The scaffold diff for scaffold-owned files
- [ ] 4.4 `fli check` and snapshot regeneration as the closing step

### Phase 5 — The proof

Goal: every release proves the upgrade from the release before it.
Done when: a drive scaffolds from npm at N−1, runs `fli upgrade`, and requires
`fli check` clean, and the release runs it.

- [ ] 5.1 The upgrade drive, beside green-and-ship's fresh-install drive

---

## Open questions

1. **Where does a release page live?** It has two readers: `fli upgrade` at the
   target version, which reads only what the cli tarball holds, and a person on
   GitHub or the docs site.
   - **A** — a root `CHANGELOG.md`, collected from `.changes/`.
   - **B** — `packages/cli/releases/<version>.md`, one structured page per train,
     shipped in the cli tarball; a root `CHANGELOG.md`, if wanted, is generated
     from them.
   - **C** — the root `content/` set `release-notes.md` Q2 proposes, read by the
     site and copied into the cli at pack time.
   - **Recommend B**, confidence 2 — A is outside the tarball, so the machine
     reader would need a second copy and the unit stops being one. B puts the one
     origin where its machine reader is. C reaches the same place through a
     ruling that has not been made and a pack-time copy. The open part is
     whether a per-version file or one growing file reads better to a person;
     Changesets writes one growing file per package.
2. **What is the machine step called?**
   - **A** — a *migration*, the Nx and Angular word.
   - **B** — a *shift*, the codename `map-packages.md` gives the tool.
   - **C** — a *codemod*, the ecosystem's word for a source transform.
   - **Recommend C**, confidence 3 — A puts a second meaning on litestone's word
     in the step that hands off to it. B coins a noun the ecosystem already has a
     word for, and `map-packages.md`'s codenames name the work, not a concept.
3. **May a breaking change ship with no codemod?**
   - **A** — yes; the change file's body is the manual step.
   - **B** — no; every breaking change file names a codemod.
   - **Recommend A**, confidence 3 — a rename lands most days, and a written step
     is correct and cheap. Phase 1's record shows which renames a codemod would
     have paid for.
4. **Where do codemods ship?**
   - **A** — inside `@frontierjs/cli`; `fli upgrade` runs the target version's
     cli through `bunx`.
   - **B** — a separate `@frontierjs/upgrade` package.
   - **Recommend A**, confidence 2 — the target's cli already knows the target,
     so no new package and no version of it to keep in step. Unsourced as
     precedent: Nx collects migrations from each plugin and ember-cli-update
     downloads codemods on demand, and neither is this exact shape.
5. **One version at a time, or straight to the target?**
   - **A** — hop one train at a time, installing each.
   - **B** — install the target once and run every codemod between in version
     order.
   - **Recommend B**, confidence 2 — the train moves by patch-sized steps, so an
     app a month behind is many versions back, and A is an install per version.
     B holds only while every codemod is a pure source transform (§ 2's rule).
     Against it: Nx allows the jump but recommends one major at a time as the
     safest path. That advice is about majors, which the train does not have yet;
     revisit at 1.0.
6. **Are Outpost and Basecamp hosts in scope?**
   - **A** — no; they upgrade through their own pin.
   - **B** — yes; `fli upgrade` reaches a deployed box.
   - **Recommend A**, confidence 3 — a box upgrade is a deploy with its own
     rollback, and this paper is about source.

---

## See also

- `IDEAS/version-compatibility.md` — the train (`FJS-D948`), the snapshot diff
  this reads
- `IDEAS/release-notes.md` — the end-user half; the no-gate report shape
- `IDEAS/map-packages.md` § `shift` — the codemod tool this designs
- `DECISIONS.md` `FJS-D675` — why `CHANGES.md` was retired, and what a change
  file must not become
- `PHILOSOPHY.md` § IV *preservation vs. evolution* — the row whose fact moved
