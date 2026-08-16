# cli (`fli`) — package map

**A markdown-native command runtime.** A command is a `.md` file: prose and
fenced code, compiled to JavaScript and run. 201 command files over 10 namespace
modules. Scaffolds, deploy, the workspace/release commands and the port broker
live here.
`bun run test` (bun).

---

## Layout

```
bin/       fli.js (the entry) · server.js · diagnose.js
core/
  compiler.js   .md command → JavaScript
  runtime.js    executes a compiled command
  registry.js   command discovery and resolution
  prose.js      the markdown side
  checks.js     the architecture rules — shared with scripts/ci.mjs
  typecheck.js  tsc's output, filtered to your files — shared with scripts/typecheck.mjs
  app-config.js what a scaffolded app is GIVEN — deps, scripts, configs, workflow
  widget-surface.js     what a `widgets/` surface IS — shared by `new` and `make:widget`
  extension-surface.js  what an `extension/` surface IS — ditto, `make:extension`
  vendor.js     pack the workspace into an app's build context
  config.js · bootstrap.js · ports.js · utils.js · server.js
commands/  one directory per namespace — db, auth, api, web, widgets, extension, site,
           deploy, git, github, npm, env, make, project, ports, browser, crypto,
           fetch, ai, cloudflare, caprover, completion, admin, literate, utils,
           fli, release, test
cli/src/   the CLI's own source tree
web/       the browser-facing side
tests/     compiler · checks · runtime · registry · server · deploy · project-root · steps
```

---

## What bites here

- **A clean compile is not proof of valid JS** (Invariant 15). Compiling all 195
  command files and *parsing* the output found 14 producing broken JavaScript
  that the compiler reported as fine. Every command file now has a parse test —
  a new command needs one too.
- **`commands/auth/install.md` reads `@frontierjs/auth`'s schema; it no longer
  carries a copy of it.** The copy drifted three times, and two walls had kept it
  there: `fli` is global, so the package is not beside it — and **`fli` runs on
  node** while `packages/auth/schema.ts` is TypeScript, so even resolved it could
  not be imported. Auth ships `db/user.lite` and `db/auth.lite`, this installs the
  package if the app lacks it and then reads those bytes, resolving the subpaths
  through auth's own `exports` (`createRequire().resolve` from the app's
  `package.json`) rather than guessing at a path inside it. `User` is appended to
  `schema.lite`, the three `@@gate("8")` models are written to `db/auth.lite` and
  imported. One rule is still restated — the `@@db(main)` swap — and auth's suite
  lifts this file's arrow out of the markdown and runs it (`FJS-038`).
- **A git question asked from a package directory answers repo-wide.** In this
  repo every member shares one `.git`, so `git status --porcelain` and
  `git describe --tags` run from `packages/mesa` describe the whole monorepo —
  which had all sixteen `ws:*` rows reporting one another's state. Ask through
  `context.git.pkgState(name, dir)`, which uses a pathspec and the
  `<name>@<version>` tag scheme. `context.wsRepo(packages)` is the other half:
  it says whether a release should be one commit or one per package.
- **A fenced block in a `_module.md` renders as an empty heading.** Module prose
  has every ``` block stripped, because in a command file a fence IS the body.
  Namespace overviews are written as plain lists.
- **The parse sweep compiles each command with NO module script**, so a command
  using a `_module.md` helper parses whether or not the module defines it. Run
  the command. This is not theoretical: `completion/_module.md` used `join`,
  `homedir`, `existsSync` and `statSync` without importing any of them, so all
  five completion commands threw `join is not defined` and **Tab completion had
  never worked**, while every suite stayed green (`FJS-167`).
- **Nothing on the read-only path may import zx.** zx is ~85ms of what was a
  ~200ms invocation, and `fli list`, `help`, `?` and completion wanted one thing
  from it — chalk, which is now `core/color.js`. The same rule is why
  `bootstrap.js` imports `runtime.js` at the call site rather than at the top: a
  static import pulls zx back in for every `fli list`. A command body is
  unaffected, since its compiled shim imports `zx/globals` itself.
- **`module.register()` costs 56ms because it starts a hooks thread**, and the
  `.md` loader hook is not what runs a command — the runtime compiles WITH the
  namespace module script (which a hooks thread cannot see) and imports the
  shim. No entry point registers it.
- **The edges are aspirational.** Several documented commands do not do what the
  prose says, and three packages' docs advertise `fli` commands that do not
  exist. Verify a command by running it before citing it.
- **A compiled command is a real file, so where it may be written is a
  constraint, not a detail.** The shim imports `zx/globals` by bare specifier and
  Node resolves that from the importing file's own directory — which is why the
  location is `fliTmpRoot()`'s decision in `core/utils.js` and nobody else's, and
  why the read-only fallback symlinks `node_modules` beside the shim. The
  workspace copy is always writable, so nothing here can see the install shape
  that is not (`FJS-166`).
- The port broker implements the FJS port scheme; the scheme itself is documented
  in `packages/jetty/src/dev/fjs-ports.js`.
- **`ws:exports` writes the published-surface snapshot, and it asks the packer.**
  `bun pm pack --dry-run` per publishable package, then every `exports` subpath,
  `bin`, `main` and `types` target is looked for in that listing. Two things it
  is easy to get wrong and both were: npm's `files:` globs have their own rules
  (a bare directory name means everything under it, README/LICENSE/package.json
  are always in), so the listing is asked for rather than derived; and a `*` in
  an `exports` target is **Node's subpath pattern, which matches across `/`** —
  read as a shell glob it reports `@frontierjs/ui` as shipping none of its 64
  components. The snapshot records top-level entries only, so adding a source
  file does not move it.
- **`core/snapshots.js` has the same two callers, for the same reason.**
  `fli test:snapshots` runs it over a client app; `scripts/ci.mjs`'s `snapshots`
  phase imports it by relative path and runs it over this repo. It walks for
  `*.snapshot.*`, reads the `generated by:` line out of each header, and reruns
  that command with `--check` from the file's own directory — so a new KIND of
  snapshot costs a generator, never an edit here — `fli release:check` is the
  newest one and cost this module nothing. **The header is data and this
  executes it**: the binary must be one of `litestone`/`junction`/`sierra`/`fli`
  and every argument a plain flag or path, both refused by name otherwise. A
  snapshot naming no generator FAILS rather than being skipped — a generated file
  nothing can recheck is a document wearing a gate's clothes. What stays in
  `ci.mjs` is the repo-history half: a snapshot tracked at the base ref and gone
  now is a failure, because discovery alone fails open.
- **`core/repo-map.js` reads the workspace; it never describes it.** `fli ws:map`
  writes one self-contained `repo-map.snapshot.html` — snapshots and their
  generators, the CI phases out of `main()` in `scripts/ci.mjs` (with each
  phase's own section comment as its description), the open register by
  severity, packages and their sibling deps, every `verify*` drive, the port
  registry, the command tree, the root markdown files by their opening claim. A
  section whose source is absent is omitted rather than faked. **The output is
  committed and rechecked**, so nothing in it may vary between two runs over one
  tree: no dates, no timings, every list sorted — and the generator line sits
  BELOW the doctype, because anything above one is quirks mode. The page lists
  every snapshot and is one, so the first generation writes twice to reach the
  fixed point; every run after is already there.
- **`core/repo-atlas.js` renders the same model as a deck, and owns the
  crossing.** `fli ws:atlas` deals one plate per package, app, claimed folder,
  and one for the workspace itself — the register files things against `repo`
  and they had nowhere to live. A plate opens a dossier: deps and dependents
  (each a link to that dossier), the issues filed against it, the snapshots it
  owns, its drives. **Three vocabularies name one noun** — the register uses a
  short name and sometimes two (`cli/auth`), the walker uses a path, the drives
  use a directory — so `matchesCard`/`inHome` do the crossing in one place, and
  a row naming two packages shows on both. The realm comes from the root
  `CLAUDE.md` table, parsed; an unlisted package reads *unfiled*. Buckets,
  plate numbers and motifs are cosmetic and fall back rather than fail.
  **The page is written in `@frontierjs/css`** (Invariant 13) — Topbar, Card,
  Dialog, Table, Facts, Item, Badge, Pill, Field — and a TONE carries what a
  colour used to: `danger` for an S1, `info` for a ruling, `muted` for a claimed
  folder. **A realm accent is the second axis** — identity, not status, which
  the vocabulary has no word for — so `--realm` is DERIVED from the tone tokens
  (mixed in oklab where seven tones cannot make nine) and used for a plate's
  rule, motif and badge, never body text — and a THEME may name all nine
  outright (`--realm-data` …), which is what `theme-field` does. That theme is
  the page's own field-manual look, a token block with no selector, default and
  listed beside the package's nine; its home is
  `packages/css/src/themes/field.css`, which the page now carries. A
  test fails a hex anywhere OUTSIDE the theme block, which is what keeps the
  themes working; the local CSS is unlayered on purpose, since the
  bundle declares `@layer` and unlayered beats every layer — and it is
  `<style id="atlas">` rather than the first `<style>` in the page, because
  slicing at a position is how a `not.toMatch` starts passing against the wrong
  block. **The stylesheet is INLINED, built from committed source every run**
  (`repo-map.js` § the styling language, vendored): `src/index.css` is 48
  layered imports and an `@layer a, b, c;` declaration, each import becomes an
  `@layer name { … }` block, the declaration is carried over first and verbatim.
  Three reasons a link could not stand — a `file://` page with no network, a
  published Artifact whose CSP refuses the request outright, and a link styled
  by whatever the registry answers rather than by the tree the page describes.
  **Not `dist/`**, which is that file already: it is gitignored and built on
  demand, so inlining-if-present would make the output depend on whether someone
  ran `bun run build`, and these pages are diffed by the `snapshots` phase.
  **Every import must resolve or the bundle is refused** — a partial one renders,
  looks nearly right and is missing whichever layer went absent — and that is
  stated as *all of them* rather than as a count, which a small tree fails and a
  truncated big one passes. Comments are stripped (60% of that package's source)
  by a quote-aware pass, since `content: "/*"` is legal CSS. The CDN link
  survives as the fallback for a tree that CANNOT read the package at all — and
  carries **no version range**: below 1.0 a caret pins the MINOR, so the derived
  `@^0.16` excluded every published copy and rendered the page unstyled the day
  css bumped its minor in the tree.
  **The workspace is not one more plate and the page opens on it.** A hub pane
  leads: the totals as tiles, then **the three registers as one row** — `Open`
  (`ISSUES.md`, what is wrong), `Rulings` (`DECISIONS.md`, what is settled),
  `Ideas` (`IDEAS/`, what is not started) — then every part carrying anything
  open, worst first, and the root registers each quoted. They are one row
  because the question *what should I work on* is answered by reading across
  them: reading `ISSUES.md` alone is how a defect gets fixed that a ruling
  already retired. Two judgements are made there and both are stated on the
  page — **ordering is by WEIGHT** (an S2 outranks a pile of S4s, so 8 rows can
  lead 21) and a bar's **length is that weight** against the worst plate,
  because a bar that fills its cell makes 21 open read exactly like 2.
  The dossier is the only one allowed to show another card's rows: all three
  registers whole, plus the deck as one table — the comparison 23 cards cannot
  make. **One facet mechanism, four dimensions** — a control declares which
  (`data-facet="stat"`), a unit carries its value (`data-stat`), and a unit
  carrying nothing for a dimension is untouched by it, so narrowing the ideas
  by status does not empty the register beside them. A facet is also a route
  (`#/part/repo/stat:defect`), which is what lets a hub count land with the
  filter applied; the bare form (`/S2`) means severity, and a route splits at
  the SECOND slash because one section title is `Design system (@frontierjs/css)`.
  **The workspace plate crosses the invariants with `checks.js`** — the root
  `CLAUDE.md` numbers 19, the rule table names the invariant each rule comes
  from, and nothing else puts the two together: 5 enforced, 14 held up by
  attention. A plate also carries its typecheck ceiling (absent = 0 = clean),
  its ports, and **the files its open rows link** — the Detail column is the one
  place the register says where a defect lives, counted per file and scoped to
  the card's own home, since half the register links the root `CLAUDE.md`.
  **⌘K is the fourth door and the widest** — one index built at generation time
  over parts, actions, open rows, doc topics, commands, snapshots, drives,
  scripts, CI phases and registers, ranked by prefix-then-substring. A test
  fails any route in it that names no rendered dossier. **Each plate also says
  what proves a change to it**, parsed from the root `CLAUDE.md`'s `Changed →
  Run` table and matched on the CHANGED half only — a package named as the
  drive to run is not the package that changed.
  **Three doors, all routes** — `#/part/…`, `#/do/…`, `#/realm/…`. The action
  door pools every runnable thing (command, script, drive, CI phase, snapshot
  generator) and matches it against a curated verb list; the VOCABULARY is
  curated and the membership is not, so an action nothing answers to is not
  offered. A plate's feature set is the package's own `docs/` (one file per
  capability) plus its README's `##` headings — read, never invented, because a
  feature list this repo maintained by hand is the thing that went stale.
  **The two are dealt the same**, because they are the same claim filed
  differently: litestone writes 35 files under `docs/` and junction writes 32
  sections in one README with one file beside it, and a row of bare headings is
  not a feature list. Each section carries the **first thing it says** — and
  half of junction's open on a fenced example rather than on prose, which is
  what an API README looks like, so the fence's opening LINE is kept instead
  (`Response helpers` says nothing; `ctx.json(data, status?)` says all of it).
  First thing wins: scanning past prose for a signature finds whatever example
  is furthest down the section. A section opening on a table says neither and
  shows just its heading. Both listings are in ⌘K. Beside them, **`src/*` with
  a file count each** answers the other question — structure, not features.
- **`core/vendor.js` is why an app built from local sources can ship, and it has
  three callers.** `link:` and `workspace:` resolve to a workspace on one machine
  and to nothing inside a Docker build, so `bun install` failed once per package
  and the scaffold this repo produces could not be containerised at all
  (`FJS-241`). It packs those packages into `deploy/generated/vendor/` and writes
  `app-manifest.json` pointed at the tarballs — **`overrides` included**, or
  sierra installs mesa from npm and the image runs two trees at once, which is
  not guaranteed to fail. `fli deploy:vendor` is the command; `deploy:local` and
  `_steps-docker/04-build-api` run it before they build; `packages/basecamp/deploy/build.mjs`
  had the only working implementation and now calls it. **The generated Dockerfile
  installs from that directory on both source modes** — with nothing linked it is
  a verbatim manifest copy with the lockfile beside it, and the freeze is
  conditional on that lock, since a rewritten manifest has none that matches. A
  branch in the template instead would sit in a file nobody regenerates when the
  source mode changes.
- **`project:map` and `project:view` read the API surface; they never scan for
  it.** What a service answers is decided at CONSTRUCTION — `collectCustomMethods`,
  read back through `svc.describe()` — so a regex over `*.service.ts` cannot
  agree with it in the general case, and the viewer it fed had no way to be
  contradicted (`FJS-254`). `readApiSurface()` in `commands/project/_module.md`
  parses the committed `surface.snapshot.md`; **no snapshot means no services**
  and a warning naming `junction surface`, because falling back to a scan is how
  the picture gets to be confidently wrong again. `extractResourceMeta` beside it
  is the exception and says why: a Resource is constructed in the browser and has
  no artefact, so the `createResource(...)` call is all there is — it reads that
  CALL, with comments stripped first, because a resource file is mostly prose and
  a `model:` in a sentence is not a declaration.
- **`core/checks.js` has two callers and one of them is not in this package.**
  `scripts/ci.mjs` imports it by relative path and runs it over this repo as the
  `structure` phase. Loosening a rule here loosens it for every app on the next
  release, and tightening one can fail the repo's own CI — which is the point.
  Zero dependencies, plain ESM, node or bun; a package import would break the
  `ci.mjs` caller, which runs on plain node before anything is installed.
- **`core/db-preflight.js` is why `fli dev` mentions an empty database.** An app
  with no rows boots clean and shows a blank screen, so nothing says anything.
  It resolves the path from the schema's `database` declaration — NOT from
  `resolveDb`, whose `development.db` / `test.db` convention describes a file
  many apps have never had — honours `env("VAR", default)` when the variable is
  set, and does not count litestone's `_migrations` table as data. Two callers,
  `utils:dev` and `ports:claim`, because a person claiming ports is about to
  start the servers it warns about. `node:sqlite` or `bun:sqlite`, whichever the
  host has; neither, and it degrades to silence rather than a guess.
- **Two commands claiming one alias is a bug, and the registry warns.** The
  winner is whichever loads LAST, and `find()` sorts its walk so that is at
  least reproducible — unsorted `readdir` made `fli new` mean `project:new` on
  one checkout and `make:command` on another, out of one tree. Sorted is not
  meaningful, though: nothing about `utils` sorting after `ports` says which
  command should own `dev`. Four aliases were contested and all four were
  resolved by renaming the less-typed side — `make:command` → `mkcmd`,
  `site:audit` → `site:setup` (it is setup, not an audit), `ports:dev` →
  `ports:claim` (it claims a session and starts nothing), and `deploy:doctor`
  has no short alias, so `doctor` means `fli:doctor`. There are none left; a new
  one is answered by renaming, not by leaving it to the alphabet.
- **`core/app-config.js` is the one owner of what a scaffolded app is GIVEN** —
  dev dependencies, the four check scripts, `tsconfig.json`, `biome.json`,
  `.editorconfig`, the workflow. That set is the framework's real opinion about
  tooling and far more people will read it than will read this repo, so it is one
  module with the reasoning attached rather than string literals in
  `project/new.md`, and `tests/app-config.test.js` asserts each default. Two
  rules it encodes: **the config is a dependency the app extends in a line**
  (`@frontierjs/config`), and **`fli check` runs first** in `bun run check`,
  because it is the half a linter cannot reach.
- **`core/widget-surface.js` is the same rule for the surface next door.** A
  `widgets/` sub-project is written by one function, called by `fli new
  --widgets` and by `fli make:widget` — the first widget creates the surface and
  every one after adds to it, so two generators would mean an app that its own
  extension command cannot read. It **never overwrites**: a config, a host page
  or a Dockerfile that exists is kept and reported, because a scaffold that
  clobbers is a scaffold nobody runs twice. The tag prefix belongs to the
  surface rather than to a widget, so the second `make:widget` reads it back out
  of `config/sierra.config.js` instead of taking a flag that would disagree.
- **`core/extension-surface.js` is the same again for jetty.** An `extension/`
  surface is written by one function, called by `fli new --extension` and by
  `fli make:extension`, and `fli extension:*` wraps jetty's binaries rather than
  reimplementing the build. What it must keep right is the install: an app has
  ONE `package.json`, at its root, so the surface has no `node_modules` of its
  own and jetty resolves Mesa by walking up. Scaffolding a package.json inside
  `extension/` would look tidy and break that.
- **`core/typecheck.js` has the same two-caller shape as `checks.js`.** An app
  cannot run a bare `tsc --noEmit`: every @frontierjs package ships TypeScript
  source, so tsc checks the framework as part of the app's program — 61
  diagnostics from inside `node_modules` on a fresh scaffold and none of its own.
  `fli typecheck` is one caller and `scripts/typecheck.mjs` is the other, which
  keeps only the baseline ratchet of Invariant 14. Zero dependencies, plain ESM:
  that script runs on node.
- **A command using a free identifier parses clean and throws on the first run.**
  `fli check` had never once executed — `resolve` with no import and no
  `fli/_module.md` to supply it — and nothing caught it for two reasons worth
  holding together: the parse sweep compiles a command WITHOUT its namespace
  module, and CI's `structure` phase imports `core/checks.js` directly, so the
  engine was green while the door was broken (`FJS-269`). A command whose only
  proof is the sweep has not been run.
- **A rule belongs there only if it is SILENT when broken.** A violation that
  already raises an error belongs in the thing that raises it. `--list` prints
  the table with the invariant each rule comes from.

## The context in this package

**One, per command invocation** (`FJS-D03`). `context` is what a compiled `.md`
command body is handed.

| | |
| --- | --- |
| Created per | **one `fli` invocation** |
| Carries | the resolved project (`context.paths`, `wsRoot()`, `wsRepo()`), git access (`context.git`), execution (`context.exec`, `context.stream`), and config |
| Is NOT | a request. Nothing here is on behalf of a remote caller, so there is no principal, no `auth`, no `query` |

The name is shared with the API realm's request context and the concept is not:
this is *the invocation's environment*, which is why the fields are capabilities
rather than inputs.

---

## Proving a change

`bun run test`. There is no browser drive for `fli` — a change to a scaffold is
proved by scaffolding into a temp directory and running what comes out. A change
to `core/checks.js` also needs `node scripts/ci.mjs --fast`, because the repo is
its other caller.
