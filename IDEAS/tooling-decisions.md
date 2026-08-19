---
id: tooling-decisions
status: assessment
dated: 2026-08-12
---

# Idea — The tooling decisions this project has not made

**Status: REGISTER + ONE RECOMMENDATION.** Dated 2026-08-12. Every fact below was
probed against the tree; the recommendations are marked as recommendations. This file
exists because tooling choices are the kind that get made by accident — the first
person who needs one installs something, and five years later that is the standard.

> **Items 1 and 3 are ruled, 2026-08-15 — `FJS-D32` and `FJS-D33`.** Read them in
> `DECISIONS.md`; what stays here is the reasoning that led there, and it is worth
> keeping because one premise below turned out to be wrong. Item 1 frames the
> choice as a taste call the maintainer owns. It is not: **the code `fli new`
> generates is aligned too**, so the first format run of any of the three
> candidates rewrites the app the scaffold had just written, and the answer is
> forced rather than chosen. The tool is **Biome, linter only**, shipped as
> `@frontierjs/config`; the boundary sentence below survives intact and is now
> the ruling's centre, with one correction — the app-facing command is **`fli
> check`**, which exists, rather than `fli doctor` (0.5), which does not and is
> about fli's own setup. What is still open from item 1 is only this repo
> extending its own config: `FJS-266`, a counted cleanup of ~600 findings.
> **Items 2, 4 and 5 are untouched and still unmade.**

Companion to `IDEAS/diagnostics.md`, which owns the FJS-*semantic* checks. **The
boundary between the two is item 1's whole subject** and is the most important thing
in this file.

---

## What is actually here today

- **No linter, no formatter, anywhere.** No ESLint, Prettier, Biome, oxlint or dprint.
  No config file. No `lint` script in any of the twenty packages. No `.editorconfig`.
- **The house style is enforced by people reading `CLAUDE.md`,** and it is holding —
  `packages/junction/src/core/app.ts` has zero trailing semicolons.
- **`bun run ci` is the whole of CI**, five phases in one node script, and none of
  them looks at source style. The hygiene phase is about clone parity — a `.gitignore`
  hiding a source file — not formatting.
- **Ten distinct shapes of `test` script across the workspace**, over four runners:
  `bun test`, `vitest run`, plain `node` with an explicit file list, and one package on
  `npm`.
- **Sixteen `tsconfig.json` files over one `tsconfig.base.json`.**
- **No changesets, no renovate, no dependabot, no `.npmrc`, no `bunfig.toml`.** One
  workflow file, which calls `scripts/ci.mjs` and nothing else.
- **`fli` already has the commands** — `npm:audit`, `npm:outdated`, `npm:release`,
  `workspace:version`, `workspace:publish`, `workspace:changed`. Nothing runs them on a
  schedule or in CI.

---

## 1. Lint and format — and the constraint that decides it

### The finding: an opinionated formatter is incompatible with a stated house rule

`CLAUDE.md` § House style requires **aligned columns** where a run of lines is
parallel, and names `example/api/app.ts` as canonical. It looks like this:

```ts
import { createCaravan }        from '@frontierjs/caravan'
import { conduit }              from '@frontierjs/conduit'
import { notificationsPlugin }  from '@frontierjs/notifications'
```

The root `package.json` does it too, in JSON:

```json
"build":         "bun run --filter '*' build",
"test":          "bun run --filter '*' test",
```

**Prettier, Biome and dprint all collapse those runs to a single space.** None of the
three can express alignment, and it is not a setting any of them is missing — an
opinionated formatter's value proposition is that whitespace carries no information,
and this rule says it carries some. So the first run of any formatter reformats both
files above, plus most of the repo.

That makes the order of decisions the opposite of the obvious one. **Settle the
alignment rule first; the tool follows from it.** Two coherent exits:

**(a) Keep alignment → adopt a linter only, never a formatter.** A linter changes only
what a rule names, so alignment survives untouched. Costs: quotes, semicolons and
indent stay a human matter, and a style argument stays possible.

**(b) Drop alignment → adopt one tool that formats and lints.** Costs: a large one-time
diff, a visible change to every file the docs cite, and `CLAUDE.md` loses a rule.

There is a third path and it should be **refused**: per-block suppression comments
(`// biome-ignore format:`, `// prettier-ignore`) above every aligned run. That is a
comment whose only reader is a tool, on a codebase whose stated rule is that **a
comment must be load-bearing or deleted**. Buying alignment with noise costs more than
alignment is worth.

### The tools, and what they actually differ on

Assessed against this repo, not in general. **Verify the version-specific claims before
acting on them** — this moves fast and the notes below are from outside the tree.

| | **Biome** | **ESLint** | **oxlint** |
| --- | --- | --- | --- |
| What it is | Rust, one binary, formatter **and** linter | JS, linter only (Prettier alongside) | Rust, linter, very fast |
| Install cost | one devDependency | a config plus its plugin and parser peers | one devDependency |
| Config | one `biome.json` | flat config, composable | one `.oxlintrc.json` |
| Custom rules | limited (GritQL plugins) | **anything, including custom parsers** | limited |
| Type-aware rules | partial, without `tsc` | via typescript-eslint, with `tsc` | newer, partial |
| Can it read `.mesa` / `.lite`? | **no** | only via a hand-written processor | **no** |

**The `.mesa` and `.lite` line is the one that matters, and its answer is the same for
all three: the two files where FJS's real mistakes live are not JavaScript.** ESLint is
alone in *being able* to reach a `.mesa` `<script>` block, through a processor of the
kind `eslint-plugin-svelte` uses — and that is a plugin to write and maintain, against
a compiler that already emits diagnostics into the VS Code extension. **Refuse it.**
Generic JS linting is worth having; a bespoke Mesa lint plugin is a second
implementation of something that exists.

### Recommendation

**Biome, and drop the alignment rule.** Reasons, in order:

1. **One binary, one config, both jobs.** The framework's stated ethos is small and
   light *mentally*. "Install one dev dependency and run `biome check`" is that
   sentence; "install a config, a parser, three plugins and a formatter, and know which
   of them owns quote style" is the thing people complain about most in the JS
   ecosystem, and it would be the first impression of a scaffolded FJS app.
2. **The same answer works in-repo and shipped**, which item 3 needs. A framework that
   lints itself with one tool and tells its users to run another has two answers to one
   question.
3. **Alignment is taste, and it is the only thing standing in the way.** It is a real
   loss and worth naming honestly in `DECISIONS.md` rather than quietly reverting to it
   in a file somebody hand-edits later.

**If alignment is kept instead** — a legitimate call, and it is the maintainer's — then
the answer is a **linter only** and Biome still wins on install cost, with its
formatter disabled. Do not adopt Prettier under any branch of this decision; it makes
the same alignment trade with none of Biome's compensating simplicity.

### The boundary that must be stated either way

This is the part that survives whichever tool wins, and the reason to write this record
even though the build is one afternoon:

> **A linter owns generic JavaScript correctness. `fli doctor` owns everything derived
> from the seed. Neither reimplements the other, and the VS Code extension surfaces
> both rather than implementing either.**

Without that sentence, the failure is predictable: `:id` in a raw route,
`ctx.params` in a service context and a service missing `model:` all *look* like lint
rules, so somebody writes four of `IDEAS/diagnostics.md`'s checks as lint rules. Then
there are two registries, they disagree, and neither is authoritative — the shape
Invariant 4 exists to prevent.

They are not lint rules, for a concrete reason: doctor's inputs are `parseFile()`, the
service registry and `project:map --json`, and its questions are cross-file. *Does this
resource name resolve to a model?* cannot be answered from the file it appears in, and
that is where every check in the hazard catalogue lives.

---

## 2. One test runner, or a stated reason for four

Ten shapes of `test` script over `bun test`, `vitest run`, plain `node`, and `npm`.
`CLAUDE.md` documents this as a hazard with its own table and a warning that **running
the wrong runner produces failures that belong to nothing** — `bun test` instead of
`bun run test` in mesa gives ~35 failures that are runner artefacts.

That table is a good mitigation of a problem that should probably not exist. Three of
the four have reasons — vitest for the packages with a browser-ish surface, plain node
for `utils` and `jetty` where zero-dependency is the point, `npm` for the VS Code
extension because vsce requires it. **The one with no reason is the split between
`bun test` and hand-listed `node test/x.js && node test/y.js`**, which is where the
ordering-dependent phase files live and where a new test file gets forgotten silently.

Not urgent, and worth a ruling before the count reaches twenty packages more.

---

## 3. What a scaffolded app gets

The question that made this file exist. When `create-frontier` (1.2) runs, the new
app's `package.json` has some set of dev dependencies and config files in it, and
**that set is the framework's real opinion about tooling** — far more than anything in
this repo, because most people will never read this repo.

Minimum to decide: linter/formatter config, `tsconfig`, `.editorconfig`, a `lint`
script, whether `fli doctor` runs in the app's own CI by default, and whether the
generated app has a CI workflow at all. Every one of those is a default that is nearly
impossible to change later.

Precedent worth copying: **the config is a dependency, not a copied file.**
`@frontierjs/config` (or whatever it is called) that the app extends in one line means
a rule can be improved for every app; a scaffolded copy means it never changes again.

---

## 4. Versions, changelogs and the release path

`fli` already has `workspace:version`, `workspace:publish`, `workspace:changed` and
`npm:release`, and `CLAUDE.md` records that `ws:*` understands this repo's single-repo
shape — one commit, one `<name>@<version>` tag each, one push. There are no changesets
and `CHANGES.md` is written by hand per package.

Two things unresolved rather than missing:

- **Nothing decides which packages a change should bump.** `workspace:changed` can say
  what moved; nothing maps a change in litestone to the packages that must republish,
  and `CLAUDE.md` already records the trap on the other side — **publishing a package
  silences every loose peer range that names it**, and below 1.0 a caret pins the
  minor. That combination is a live foot-gun with no tooling pointed at it.
- **A hand-written `CHANGES.md` is the right call and should be defended, not fixed.**
  Generated changelogs from commit messages are worse than what this repo already
  produces. The gap is only that nothing checks a published version has an entry.

---

## 5. Dependency freshness and advisories

`fli npm:audit` and `npm:outdated` exist as commands and nothing runs them. There is no
renovate or dependabot config. This is the tooling half of `IDEAS/overview.md` 2.12
(security advisories), and the two should be decided together — 2.12 argues the harder
half (*am I affected*, compared against the app model, rather than a scan), and this is
the boring half that must exist under it.

The decision is not "add dependabot"; it is **whether dependency posture is a CI phase
in `scripts/ci.mjs` like everything else, or an external bot.** Everything else in this
project chose the first, deliberately, so that CI runs identically on a laptop.

---

## 6. What to leave alone

Recorded so the next sweep does not raise them again.

- **No monorepo task runner.** `bun run --filter '*'` plus `scripts/ci.mjs` already do
  what turbo and nx do here, in a file anyone can read, with no daemon and no cache to
  be wrong. Adding one would trade a legible script for a build graph.
- **Bundler plurality is fine.** Vite for Sierra apps, esbuild for the VS Code
  extension (with a stated reason — vsce's dependency walk follows bun's symlinks),
  `bun build` for css. Three tools doing three different jobs is not incoherence.
- **`.editorconfig` is the one free thing on this page.** Six lines, understood by every
  editor, encodes indent and final-newline with no build step and no argument. Whatever
  happens to item 1, this should exist.

---

## 7. Dev URLs — the broker already knows the name

Added 2026-08-15 from an outside framework's DX list, whose entry reads
*"your-project.localhost instead of localhost:3000"*. Here it is
`localhost:8010` and `localhost:8110`, and remembering which is which is a tax paid
per context switch, per developer, forever.

**The reason it is worth a line rather than a shrug is that the derivation already
exists.** `packages/cli/core/ports.js` holds the formula, the category map and the
`PROJECTS` registry, so the broker already knows that project 1 is `example` and that
8010 is its frontend and 8110 its API. Nothing has to be configured, invented or kept
in sync — `example.localhost` and `api.example.localhost` are a rendering of a table
that is already the source of truth for the numbers. Any modern browser resolves
`*.localhost` to loopback without an `/etc/hosts` entry, so the client half is free;
what is not free is that a name has no port, which means a local reverse proxy on 80
mapping host to port, started with the dev servers and torn down with them.

**Three things it would actually fix**, none of which is remembering a number:
`strictPort` exists because vite otherwise hops in silence and *"the second app's drive
tests the first app's app"* — a name makes that failure impossible to reach rather than
merely loud. Cookie scope stops being a lie: `localhost:8010` and `localhost:8110`
share a cookie jar because a port is not part of origin for cookies, so cookie auth in
dev behaves unlike cookie auth anywhere else, and a subdomain pair reproduces
production. And a browser drive's assertions stop hard-coding the port the CLAUDE.md
table also states, which is one fact in two places.

**The reasons to be careful.** A proxy on port 80 needs a privileged bind or a
capability, on a project whose whole pitch is that everything runs as a plain user
process; the honest fallback is `:8080` and a name, which is less pretty and keeps the
property that matters. It must be strictly additive — the numbers keep working, because
`FLI_PORT_FE`/`FLI_PORT_BE`, `strictPort`, every drive and the whole ports table depend
on them, and a DX nicety that becomes load-bearing is a worse trade than the tax it
removes. And it belongs to the broker, not to vite: one owner, the same rule the ports
table already follows.

`S`, `●●○○`. The kind of item that is only cheap while the derivation is already
written down.

---

## Open questions

- **Does the framework lint the app, or does the app lint itself?** A shipped config is
  an opinion; `fli doctor` is an enforcement. Whether `fli lint` should exist at all,
  or whether that is one indirection too many over a tool the user already ran, is
  unasked.
- **Do the `.lite` and `.mesa` diagnostics that exist in the VS Code extension belong in
  a terminal?** The compiler already emits them and only an editor listens. That is
  either fine or a third of `fli doctor` already built.
- **Is a formatting change a reviewable diff?** `IDEAS/overview.md` 5.7 (`shift`) makes
  exactly this argument about codemods — *a reviewable diff, never a silent rewrite* —
  and a repo-wide first format run is the largest silent rewrite this project will ever
  do. If the rule is real it applies here.

## See also

- `IDEAS/diagnostics.md` — `fli doctor`, which owns every check derived from the seed,
  and whose boundary with a linter item 1 exists to draw
- `IDEAS/ecosystem-gaps.md` §13 — security advisories, the half above item 5
- `IDEAS/testing-and-ci.md` — the CI mechanism any of this would run in
- `IDEAS/command-surface.md` — `fli`'s own surface, where a `lint` command would land
- `CLAUDE.md` § House style — the rules item 1 has to either encode or retire
- `scripts/ci.mjs` — five phases, none of them about style
