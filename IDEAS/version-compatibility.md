---
id: version-compatibility
status: proposed
dated: 2026-09-03
---

# Idea — Version compatibility: what a version number here promises

**Status: IDEA. Nothing here is built.** Dated 2026-09-03. No code in this repo
computes, checks, or enforces anything below. Do not cite this file as describing
behaviour — see `VERIFYING.md`.

---

## The claim

**Twenty packages are published from this workspace and nothing anywhere says what
a version number means.** A search of all 82 files in `IDEAS/` on 2026-09-03
returns zero hits for `semver`, zero for `version skew`, and zero for `release
train`. The only trace in the register is one bullet in `ecosystem-gaps.md` § tier
3 — *"upgrade guides and a deprecation policy"* — which names it as a **document**
that is missing, never as a mechanism.

This is a blind spot rather than a deferral. A deferred thing has a row.

---

## What is actually in the tree

Versions, on 2026-09-03:

```
litestone 1.1.5   auth   1.0.3   css    0.16.1   junction 0.1.4
sierra    0.1.3   mesa   0.1.3   jetty  0.0.3    cli      0.1.3
```

Two packages are past 1.0. A person installing `@frontierjs/litestone@1.1.5` from
npm has every reason to read that as a semver promise, and this workspace has
never made one.

Every internal peer range, read off the packages themselves:

| Package | Peers on |
| --- | --- |
| auth 1.0.3 | litestone `^1.1.0` · junction `^0.1.0` |
| junction 0.1.4 | litestone `^1.1.0` |
| sierra 0.1.3 | mesa `^0.1.0` · junction `^0.1.0` · litestone `^1.1.0` |
| ui 0.1.2 | css `^0.16.0` · mesa `^0.1.0` |
| caravan · conduit · notifications | junction `^0.1.0` |
| testing 0.1.4 | junction `^0.1.0` · litestone `^1.1.0` |
| jetty 0.0.3 | mesa `^0.1.0` · junction `^0.1.0` |
| email-kit 0.1.2 | mesa `^0.1.0` |

**Every one of them is the floor, typed once and never moved.** junction is at
0.1.4 and nine packages peer on `^0.1.0`. That is not a range anybody chose; it is
the number that was true the day the field was first written.

Two consequences, and neither is visible from inside the workspace:

- **`sierra@0.1.3` + `junction@0.1.0` installs cleanly and has never been run.**
  The range permits it, so a consumer with a stale lockfile, a pinned transitive,
  or a slow mirror gets a combination nobody has ever built. Multiply across nine
  packages and the permitted space is large and almost entirely untested.
- **`^1.1.0` on litestone permits a minor bump to 1.9.0**, which under semver may
  add anything. Litestone is where a breaking change would come from, and its
  consumers have declared that they will take whatever it does short of a major.

Nothing inside the repo can see either, because `bun install` resolves
`workspace:*` and the published range is never consulted — a hazard `CLAUDE.md`
already states, one layer down: *a `workspace:*` devDep answers first and the
range is never consulted*.

The `registry` CI phase is the closest thing to a guard and it asks a different
question: **is this package published**, never **do these two work together**.

`CLAUDE.md` § Repo already names both traps that make this bite — *publishing a
package silences every loose peer range that names it*, and *below 1.0 a caret
pins the minor*. So the mechanism is understood and written down. What is missing
is an owner.

---

## Why this is worth doing here rather than adopting a convention

Because **the framework already built the machine and pointed it at a database.**

`fli release:check` answers one question: *can the release still serving and the
release starting share one database?* It derives a surface, diffs it against a
base ref, and classifies the change **expand** / **contract** / **unknown**, with
`--strict` failing a branch on anything but expand.

That is the semver question, asked about a schema.

The same three-part shape exists for a package and is unbuilt:

| | database (built) | package (unbuilt) |
| --- | --- | --- |
| the surface | `db/release.snapshot.md` | **`exports.snapshot.md`** — already committed, already gated by the `snapshots` phase |
| the diff | `--from <ref>` | `--from <tag>` |
| the verdict | `classifyPivot` → expand · contract · unknown | the same three words |
| the gate | `--strict` | the same |

`exports.snapshot.md` already holds, per publishable package: the top-level
entries the tarball actually contains (asked of `bun pm pack --dry-run`, never
derived from globs), every `exports`/`bin`/`main`/`types` target marked with
whether the tarball holds it, and **the peer ranges naming a sibling**. Three of
the four inputs are sitting there.

So the first cut is a diff of a file that is already committed and already
checked:

```
fli ws:compat --from v0.1.3

  @frontierjs/sierra     removed export  ./islands/mount        CONTRACT
                         0.1.3 -> 0.1.4 is a minor bump         REFUSED
  @frontierjs/junction   added   export  ./core/transients      expand    ok
  @frontierjs/ui         peer css ^0.16.0 excludes published 0.17.1       WARN
```

The last row is the one no external tool can produce, because it needs both the
declared range and the registry, which is exactly the pairing the `registry` CI
phase already makes for a different reason.

---

## Three levels, and only the first is cheap

1. **The export surface.** Did an entry point disappear, or a `files:` glob stop
   shipping one? Decidable from `exports.snapshot.md` alone, no parsing.
   Catches the whole class of *broken install*.

2. **The type surface.** Did an exported signature narrow? Needs `.d.ts`, which
   junction does not emit — its `exports` map points at `.ts` (`CLAUDE.md`
   § Packages). So this level is blocked on a decision that has nothing to do with
   versioning, which is worth knowing before anyone starts.

3. **The behavioural surface.** Did a default move, a hook order change, a
   thrown class change status? Undecidable in general — but **not undecidable
   here**, because four of the surfaces are already committed and diffable:
   `surface.snapshot.md` (routes, hook order, plugins), `principal.snapshot.md`,
   `errors.snapshot.md` (what a thrown value becomes), `access.snapshot.md`.
   Those are behavioural facts under version control. No other framework has
   them and this one has never diffed them across a release.

Level 1 is a script over a file that exists. Levels 2 and 3 are where the
interesting claim is, and level 3 is the one that would be genuinely novel.

---

## What it unblocks

- **`shift`** (`IDEAS/package-map.md`) — the codemod tool, deferred *"because it
  needs a stable surface to move between"*. A codemod needs a machine-readable
  diff of what moved. This produces one. `shift` is currently waiting on a thing
  nobody is building.
- **A third party pinning to anything.** The difference between twenty npm
  packages and an ecosystem is that somebody outside can depend on a number and
  survive. There is no such number today.
- **The `deprecated` frontmatter key** that `IDEAS/command-surface.md` already
  asks for — *"there is no way today to retire a command or an alias except to
  delete it and let somebody's script break."* That is the same problem, one
  surface along, already filed and unowned.

---

## Open questions

- **Does this workspace release as one train or twenty packages?** They are not
  the same product. A train means one number, a lockstep bump, and a compatibility
  matrix of size one — which is what pre-1.0 frameworks with many packages
  usually converge on, and which would make most of the above unnecessary. Twenty
  independent packages is the harder and more honest position and needs all of it.
  **This question should be answered before anything is built**, because the wrong
  answer builds a matrix nobody needed.
- **What does 1.0 mean here?** Two packages are already past it and the repo
  describes itself as pre-alpha. Either the numbers are wrong or the description
  is, and a consumer cannot tell which.
- **Should the peer ranges be generated rather than written?** They are facts
  about what a package calls, and every other fact of that shape in this repo is
  derived and committed. A hand-typed floor that nobody moves is the same failure
  as a hand-copied gate ladder (`FJS-520`), one layer out.
- **Is `unknown` allowed to ship?** `release:check` treats unknown as contract,
  fail-closed, because a database cannot be half-migrated. A package surface is
  more forgiving and the same rule may be too strict.

---

## See also

- `exports.snapshot.md` — the surface, already committed
- `CLAUDE.md` § Repo — the two traps, already named
- `IDEAS/release-transitions.md` — the expand/contract classifier this borrows whole
- `IDEAS/package-map.md` § `shift` — the codemod tool waiting on this
- `IDEAS/command-surface.md` § `deprecated` — the same problem on the CLI surface
- `IDEAS/ecosystem-gaps.md` § tier 3 — the one existing mention, as a doc gap
