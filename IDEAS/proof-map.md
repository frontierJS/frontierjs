---
id: proof-map
status: shipped
dated: 2026-08-29
---

# Idea — the proof map: which drive proves the change I just made

**Status: SHIPPED 2026-08-29.** All four of §6 are behavior — `core/proofs.js`,
`fli proves`, the two `fli check` rules, and the dashboard panel over
`GET /api/proves`. Everything else here is the argument that produced them; see
`VERIFYING.md`.

**What the build changed about this file.** A fourth match tier was needed and is
the one that made the command usable: `area`, the package NARROWED by the row's own
words, because four rows name sierra and a package match answered *run everything*.
And the first run of the check found what §1 predicted — **zero unresolvable targets
and seven drives of twenty-eight that no row named**, `verify:catalogue` and
`verify:tenants` among them. Six rows were written to close them, which is the
feature paying for itself before its own UI exists.

---

## 1. The observation

`CLAUDE.md` § *Which drive proves a change* is thirty rows of the most expensive
knowledge in this repository:

| Changed | Run |
| --- | --- |
| sierra router/resource/build | `example`: `verify` + `verify:build` |
| junction channels/publish | `example`: `verify:live` — nothing else can see a broadcast |
| jetty — the adapter, the harbor, `resources/` | `example`: `verify:extension` |

Every row was paid for once, usually by a defect that got through. And it is
**prose**: nothing reads it, so it answers nobody at the moment somebody has just
changed sierra's router; and nothing checks it, so a row naming a drive that has
been renamed is indistinguishable from a row that is right.

**The second half is the sharper one.** There are twenty-eight drives and thirty
rows, and no test has ever asked whether the two sets agree. A drive added without a
row is knowledge that exists and cannot be found; a row naming a drive that is gone
is advice that fails when taken.

## 2. Why this is not a generic feature

`nx affected` and Tilt's dependency graph answer the same question from a **build
graph** — what imports what, therefore what to rebuild. That is derivable and it is
not this. Half these rows are not import edges at all:

- *a `@@gate` or a row policy on a model a SCREEN reads* → `verify:account`, because
  it asks the boundary and the screen as three audiences, which is the only way to
  tell *the policy is wrong* from *the screen is wrong*.
- *the money — `api/src/pricing.ts`, a discount, a delivery method* →
  `verify:money`, because it is the only drive where a discount, a threshold and a
  tax rate are in scope **together**, which is the only way the crossing between
  them can be seen.

No import graph produces either sentence. They are statements about what a drive can
SEE, and a person wrote them down. That is why this is worth building here and could
not be copied from anywhere: the table is the asset, and the tooling is small.

## 3. What is already there

**The table is already parsed.** `packages/cli/core/repo-map.js`'s `proofs(root)`
reads it into `{ changed, run }` and renders it. So the input is data; what is
missing is that neither column is RESOLVED — `changed` is free text and `run` is
free text, and the map is only useful once one side matches a file and the other
side names something runnable.

**Both sides are more regular than they look.** `run` is overwhelmingly
`` `<where>`: `<script>` `` with prose after an em-dash — `example`, `basecamp`,
`sierra`, `packages/junction`, `ui` on the left, a `verify*` script, `bun run test`
or a test FILE on the right. `changed` leads with a package name in almost every
row, and the specific ones carry backticked paths (`api/src/pricing.ts`,
`web/src/cart.js`, `nodes.ts`) and backticked symbols (`announceDataWrites`,
`findWindow`, `matchesQuery`, `stripReadOnly`).

**And the runnables exist.** `core/runnables.js` already answers every drive, suite
and task as a row with an id and a command. So `run` resolves to something that can
be pressed rather than to a string.

## 4. What it would be

**`fli proves [--from <ref>]`** — what to run for what changed. Working tree by
default; a ref for a branch.

```
$ fli proves
  changed  packages/sierra/src/build/prerender.js
           packages/junction/src/transport/channels.ts

  run      example · verify:site      sierra prerender/islands/static-safety
           example · verify:live      junction channels/publish
           example · verify           sierra router/resource/build
```

Three matchers, in descending confidence, and the tier is reported so a weak match
reads as a weak match:

| Tier | Signal | Example |
| --- | --- | --- |
| `path` | a backticked token that looks like a path, matched against the changed file | `api/src/pricing.ts` |
| `package` | the row's leading package name → `packages/<name>/**` | *junction channels/publish* |
| `symbol` | a backticked identifier appearing in the diff's own text | `announceDataWrites` |

**Where it surfaces.** Three readers, and the third is the reason the second exists:

1. **The command**, for a person about to push.
2. **The dashboard** (`IDEAS/control-surface.md` §10.3) — a panel above the tiles,
   where every answer is already a row with a start button.
3. **`fli check`, as a rule over the table itself** — every `run` must resolve to a
   runnable that exists, and every drive should be named by at least one row. That
   is the half that makes the other two trustworthy, and it is decidable today.

## 5. What it must not become

- **Not a replacement for running the suite.** It answers *which drive*, and the
  package's own suite is still the first thing. The table says so in its own first
  line and the output should repeat it.
- **Not a gate.** A row that fails to match is a table that is behind, not a change
  that is unproven; the failure mode of a strict version is somebody deleting rows
  to get green. The `check` rule grades the TABLE, never the change.
- **Not a build graph.** It must not start inferring edges from imports. The moment
  it does, the rows that are statements about what a drive can SEE — the valuable
  half — become the exceptions to a mechanism rather than the content.
- **Not a second table.** The map lives in `CLAUDE.md` where it is read by people.
  A `proofs.js` that carries its own copy is the failure the whole control surface
  was built against.

## 6. What would have to be built

1. ~~`packages/cli/core/proofs.js`~~ — **shipped.** The parse moved out of
   `repo-map.js`, which now imports it; the rendered model is identical, asserted
   against the old implementation over the same tree. `findApps` moved to
   `core/runnables.js` on the way, because rules reading the runnable list and
   `runnables.js` reading `checks.js` is a cycle.
2. ~~`fli proves [--from <ref>] [--json]`~~ — **shipped.**
3. ~~Two `fli check` rules~~ — **shipped**, and they are two rather than one because
   the failures are graded differently: an unresolvable target is never right, and a
   drive no row names can be (a broader row may cover it).
4. ~~The dashboard panel~~ — **shipped.** `GET /api/proves` and a panel above the
   tiles, where a target that resolved to a runnable row is the same start button
   the tile below it carries. Three things were decided in the building of it and
   none of them was in this paper.

   **The endpoint takes no parameter.** `fli proves --from <ref>` takes a ref
   because the person typing it chose it; a ref arriving over HTTP is
   caller-supplied text on a git command line, and the branch view is not worth
   that. So the panel is the working tree and only the working tree.

   **It is not polled.** The state probe is, because a port's answer goes stale
   while nobody is typing; a diff cannot. So it is read once per dashboard load
   and on a button — and the button re-runs git, because a refresh answering a
   cached read is a broken refresh.

   **A clean tree hides it, and an uncovered change does not.** *Nothing changed*
   on every page load is a panel people learn to skip past; *these files changed
   and no row of the table covers them* is the one thing this panel can report
   that nothing else does, and §5 already says that is a table which is behind
   rather than a change which is unproven.

Steps 1 and 3 are the value even if 2 and 4 never ship: the table has never been
checked, and it is thirty rows of knowledge nobody has verified since the day each
was written.

## See also

- `CLAUDE.md` § *Which drive proves a change* — the table itself
- `IDEAS/control-surface.md` §10.3 — where the answer gets pressed
- `packages/cli/core/repo-map.js` `proofs()` — the parse that already exists
