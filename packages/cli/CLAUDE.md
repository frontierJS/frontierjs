# cli (`fli`) — package map

**A markdown-native command runtime.** A command is a `.md` file: prose and
fenced code, compiled to JavaScript and run — one directory under `commands/`
per namespace. Scaffolds, deploy, the workspace/release commands and the port broker
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
  runnables.js  what this project can START — surfaces, tools, drives, suites,
                tasks, snapshots, each a row with an id, a command and a port.
                Derived from files that would break something else if they were
                wrong; `repo-map.js` reads the same readers. `probeState` is the
                one answer to which of them are up, and it has FOUR — `unknown`
                is a row with no port, which is a different sentence from `down`
  children.js   the process table behind a start button. Two runners allowed and
                nothing else, `detached: true` and a `-pid` kill because a child
                is a LAUNCHER: signaling the pid kills the wrapper and leaves
                the server answering. It also keeps the LAST finished run per
                row — facts only (when, how long, the exit, and whether the stop
                was asked for), because the words differ by kind and belong to
                the page. `stopped` is marked before the signal: a SIGTERM looks
                the same whoever sent it
  release-view.js the Release realm read rather than typed — the pivot verdict
                per app (local, free, on page load) and what is SERVING (remote,
                a press). The split is the design: every other panel on that page
                reads the tree, and a panel that ssh'd while a page loaded would
                be the monitoring agent this realm refuses. It re-derives no
                verdict — `classifyPivot` and the revert refusals are reached by
                running the command that owns them, because a second
                implementation is how the GUI ends up disagreeing with the
                terminal about whether a deploy can be undone
  proofs.js     which drive proves a change — the parse of `CLAUDE.md`'s own
                table and the resolution of both its columns. A PARSE and never
                a second table; not a build graph, and it must not become one
  server.js     also the control surface's own endpoints — `/api/runnables`,
                `/api/state`, `/api/proves`, `/api/health/:id`, and start/stop/
                output. The health probe is HERE and not in the page: 8500
                fetching 8110 is cross-origin, and a CORS failure reads exactly
                like the app being down
  proxy.js      one listener, so a dev surface has a NAME — `example.localhost`
                for `localhost:8010`. TCP and not `node:http`, because bun's
                emits `upgrade` and hands over a socket nothing written to ever
                reaches the client, and junction's live layer is a socket.
                Nothing is rewritten: junction READS the Host and vite allows
                `*.localhost`. The target is picked per CONNECTION, which is the
                one bound and is why nothing may come to depend on it
  doctor.js     can this MACHINE run fli — binaries, the two env files, and the
                env vars a namespace declares. The sibling of `checks.js` and
                deliberately not merged with it: a missing `sqlite3` is not an
                architecture finding. `blocked` is system and config only,
                because a missing token blocks one namespace and nothing else
  preflight.js  what a drive needs started FIRST — the *Start first* column of
                the drive table, ordered, resolved onto rows the page can press.
                Reading the prose beat declaring it beside the script and beat
                asking the drive, because the answer was already written down
  typecheck.js  tsc's output, filtered to your files — shared with scripts/typecheck.mjs
  app-config.js what a scaffolded app is GIVEN — deps, scripts, configs, workflow
  crud-templates.js     what a GENERATED CRUD page IS — shared by `make:scaffold`
                        and `admin:generate`. Built on @frontierjs/ui
  widget-surface.js     what a `widgets/` surface IS — shared by `new` and `make:widget`
  site-surface.js       what a `site/` surface IS — ditto, `make:site`
  extension-surface.js  what an `extension/` surface IS — ditto, `make:extension`
  image.js      WHICH BYTES ran, and how far that answer travels — a registry
                digest means the same thing anywhere, an image id means it on
                one host, and a tag means nothing at all
  build-check.js  can this image be PROMOTED, or only deployed — the three doors
                configuration takes into an artefact (the context, an ENV line,
                a build ARG) plus an unpinned base. It traces a context file
                ACROSS STAGES, because a wholesale `COPY --from=b /app /app`
                ships what a subtree copy does not, and grading on the context
                copy alone refuses every multi-stage build here. Pure — the
                caller reads the files, so the suite needs no daemon
  revert.js     can serving state be put back, and what stops it — seven
                refusals, four of them with no override because they are not
                judgement calls. All of them reported, never just the first. It
                targets the previous TRANSITION rather than the previous release:
                build-on-target puts no digest in the id, so two deploys of
                different source mint the same one and a lookup by id answers
                whichever is newest — which is the one serving (measured: a
                revert restored the bytes it was reverting from and said it
                worked)
  machine.js    running a command on the machine being deployed to, and moving an
                IMAGE between two of them (`shipTo` — `docker save | docker load`,
                which preserves the id, so the digest a Release names is the
                digest that starts). ONE owner for
                (host, script) → the argv that runs it there, and the script
                travels on STDIN — `context.exec` is `/bin/sh -c`, so an
                interpolated script is parsed twice and nine of this pipeline's
                ten multi-line commands were syntax errors on the target for as
                long as they existed. `localhost` is a transport rather than a
                simulation, which is what makes the pipeline runnable in CI at
                all. `run`/`capture` are the verbs; `tty` and `pipe` exist
                because stdin can carry one thing and `docker exec -it` and the
                journal runner each want it
  lock.js       is another run working in this directory — the format, the
                parser, the four scripts and the reading of one. A DIFFERENT
                question from the journal's *what state did the last run leave*,
                and the two only looked like rival answers because this one could
                not expire (`FJS-D156`). It records the run, the actor, when, and
                WHICH STEP — never a pid: `fli` runs on the operator's machine and
                reaches the target one command at a time, so a pid there is dead
                the moment it is written and no probe can be built on one.
                `set -C` is the compare-and-set. `--resume` takes it over,
                `deploy:unlock` drops it and settles nothing
  journal.js    the deploy journal — statements and verdicts, all pure. The
                brain is HERE and `journal-runner.mjs` is the half that ships to
                the target: it binds parameters and decides nothing, which is
                what lets the suite drive the real runner against a temp file
  journal-runner.mjs  copied to the target and run with bun. Imports
                `bun:sqlite` and nothing else, because a deploy target has no
                node_modules — the build is inside Docker
  plan.js       the journal rows a transition WOULD write — `Transition` +
                `TransitionStep`, built once and either printed (1d) or inserted
                (1e). The step list is READ off `_steps-docker/` with the
                runner's own filter and sort, and each `skip:` is evaluated the
                way the runner evaluates it, so a plan cannot describe a
                pipeline that has moved
  release.js    what a Release IS — the four terms and the content-addressed id.
                Minting writes nothing: the id is a pure function of the tree and
                the bindings, which is what makes a digest promotable
  vendor.js     pack the workspace into an app's build context
  config.js · bootstrap.js · ports.js · utils.js · server.js
commands/  one directory per namespace — db, auth, api, web, widgets, site, extension,
           deploy, git, github, npm, env, make, project, ports, browser, crypto,
           fetch, ai, cloudflare, caprover, completion, admin, literate, utils,
           fli, release, test, ksite (NOT FrontierJS — a separate static-site
           toolchain that used to hold the `site:` namespace)
db/        deploy.lite + ddl.snapshot.sql — the deploy journal's models, and the
           DDL derived from them. The snapshot is what ships: nothing on a target
           can emit DDL, so the fragment stays the single source and the
           `snapshots` phase fails a stale derivation. OPENED, not installed:
           `createClient({ schema, db })` with `db` naming `deploy.db` on the
           target, so it declares no `database` block and `@@db(main)` in it
           does not parse
cli/src/   the CLI's own source tree
web/       the browser-facing side
tests/     compiler · checks · runtime · registry · server · deploy · project-root · steps
           · deploy-journal (a real Litestone client over a real file)
           · release-mint (what does and does not move a Release id)
           · image-identity (registry digest vs image id vs tag)
           · plan (the rows a transition would write) · journal (the rows it does
             write — through the REAL runner, against a real SQLite file)
           · revert (the seven refusals, and what each one's way out is)
           · machine (the argv, and — executed — that a script reaches a shell
             untouched; plus the nine shapes that shipped broken, as scripts)
           · deploy-scripts (every script the pipeline can send to a machine,
             parsed with `sh -n` — the check nothing was running)
```

---

## What bites here

- **Assigning `process.env.X` does not reach a child.** `fli` runs on Bun, and
  Bun's `child_process` hands a child the environment the process STARTED with,
  where node passes the mutation on. So the assignment compiles, reads as a fix
  and does nothing — measured with
  `bun -e "process.env.FOO='x'; execSync('printenv FOO')"`, which prints nothing.
  Pass `env:` on the `context.exec` call instead. This is what made `fli new
  --auth` unable to finish (`FJS-343`), and the assignment that failed had been
  written specifically to fix that symptom.
- **Never shell out to a bare `fli`.** That is a GLOBAL install, present on the
  machine of anyone who has run `bun add -g` and on no CI runner, in no
  container, and for nobody arriving through `npm create frontier`. It is also
  how a command in this tree gets tested against a DIFFERENT build of itself.
  `runFli` in `project/new.md` is the shape: `global.fliRoot` + `process.execPath`.
  Snapshot generators had the same disease through `bunx <name>`, which on a
  machine with no global went to the registry and downloaded a stranger's package
  (`core/snapshots.js` resolves bin → package → workspace member now).
- **A clean compile is not proof of valid JS** (Invariant 15). Compiling every
  command file and *parsing* the output found fourteen producing broken
  JavaScript that the compiler reported as fine. Every command file now has a parse test —
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
  read as a shell glob it reports `@frontierjs/ui` as shipping none of its
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
  color used to: `danger` for an S1, `info` for a ruling, `muted` for a claimed
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
- **A `.dockerignore` pattern without `**` protects the context ROOT and nothing
  under it.** Docker matches with Go's `filepath.Match`, where a plain `*` does
  not cross a separator — measured: with `.env.*`, a root `.env.production` is
  excluded and `api/.env.production` is COPIED; `**/.env.*` reaches both. That
  is what `02b-build-check` grades and it found a live one, `db/*.db` admitting
  `db/db/basecamp.db` into basecamp's image (`FJS-555`). **The step reads the
  SERVER rather than this tree, and must**: the file most likely to be baked is
  the one deliberately in no repository — `.env.production` sits at the deploy
  root, which IS the build context — and it runs after `02-pull`, because before
  it the server's Dockerfile is the previous release's. Refusing there and only
  REPORTING in `deploy:local` is deliberate: that command answers *does this
  build and start at all*, and `deploy:doctor` is where the question is asked
  without deploying anything. `deploy.api.buildCheck = false` opts out, beside
  the `envCheck` already there.
- **A step file's prefix is `\d+[a-z]*`, and a LETTERED one is how you insert a
  step without renumbering the rest.** `01b-env-check` sorts after
  `01-preflight` because the runner sorts whole filenames, which is the point of
  spelling it that way. The duplicate-prefix warning used to match on digits
  alone and therefore fired on every deliberate insertion — a warning that is
  always wrong is how everyone learns to ignore the one that is right.
- **`fli deploy --plan` and `fli deploy:plan` print the same document, from
  `deployPlan` in `_module.md`.** Two implementations of a plan is the failure
  the whole Release design is arranged against: a plan is what somebody reads to
  decide. `--plan` sets `context.config.stop` rather than returning — the
  runner discovers steps AFTER the orchestrator and falls back to `_steps/` when
  no `stepsDir` is set, which is the legacy CapRover list, so an early return
  would run it.
- **A step stops the pipeline two ways and they are different verdicts**
  (`FJS-589`). `context.config.abort` is a REFUSAL: every later step self-skips
  and the command exits NON-ZERO, even though nothing threw. `context.config.stop`
  is a deliberate early exit that SUCCEEDED — `--plan` is the whole of its use.
  Fail closed, so a refusal nobody thought about is loud. **`runOnAbort: true`
  means run on a refusal** and not on a stop: a cleanup step undoes a half-done
  run and a deliberate stop did not start one. The check is asked on BOTH of the
  runtime's return paths, because a command with no steps (`deploy:logs`,
  `:status`, `:run`, `:unlock`) takes the other one, and every refusal in those
  four exited 0 until it was.
- **A deploy target has bun and no `node_modules`, and that is what decides how
  the journal is written.** `deploy:setup` installs docker, nginx, git, bun,
  rsync and sqlite3; `02-pull` leaves a git checkout and the build happens inside
  Docker, so litestone is not there and cannot be imported there. Hence the
  committed DDL and a runner whose only import is `bun:sqlite` — and hence
  `packages/cli` still depending on no database. **Every rule lives in
  `core/journal.js` on the machine running `fli`**; adding a decision to the
  runner puts it somewhere no test can reach.
- **The journal hook is on the step RUNNER, not on the steps.** `core/runtime.js`
  calls `config.journal?.beforeStep/afterStep` around every step of any command
  that installs one, and knows nothing about deploys. That is what turned the
  existing eleven `_steps-docker` files into journal rows without editing any of
  them, and it is why a twelfth is journaled for free. A `beforeStep` answering
  `run: false` is the replay-into-a-no-op the occurrence-key scheme exists for.
- **`serving` is the last transition that SUCCEEDED.** Not the last transition: a
  failed deploy leaves the previous release up, and a journal that called the
  attempted one serving would be lying in exactly the situation somebody is
  reading it to get out of. `09-cleanup` settles on BOTH paths for the mirror
  reason — an aborted deploy must leave `failed` and not a `running` row the next
  run reads as a crash to resume.
- **A recorded Release carries the digest, and the resume no longer depends on
  recomputing it.** This used to say a Release must carry NO digest under
  build-on-target: the id is content-addressed on it, and a resume that
  recomputes the id needs the rebuild to be reproducible, which a build on the
  target cannot promise. Both halves were right and the conclusion was the wrong
  way round. `04c-journal` moved the journal open to AFTER the build so a Release
  names the bytes it deployed — a null digest made two deploys of different
  source mint one id, and a revert restore what it was reverting from. What that
  cost was the resume, silently and completely: an image ID is not a content
  address, so any rebuild that is not a FULL cache hit mints a new Release from
  identical bytes, the attempt lookup keys on `releaseId`, and every resume
  opened a second transition while the skip-and-replay machinery below it stayed
  unreachable (`FJS-595`). **`--resume` asks what is OPEN instead** —
  `readLiveTransition`, scoped to app and environment and to the continuable
  kinds — and adopts that transition WITH its Release, so the bytes the
  interrupted run recorded are the bytes `06-swap` starts. An ordinary deploy
  still keys on the Release, because there *different bytes are a different
  Release* is the right question.
- **`revert` and `rollback` are two commands on purpose, and one must not become
  the other.** `deploy:rollback` puts the previous IMAGE back — no journal, no
  history, no questions — and works on a target that has never deployed through
  one. `deploy:revert` restores the PAIR (Release, Generation) and refuses by
  name. With no journal, revert says so and points at rollback rather than
  quietly degrading into it, because the degrade is exactly the silent
  previous-image-and-nothing-else every other tool ships.
- **A revert refusal reports ALL of them, and three carry no override.** An
  operator deciding whether to force needs the whole picture; stopping at the
  first makes them discover the rest one flag at a time, mid-incident. `no-image`
  (nothing recorded which bytes that release ran), `in-flight` and
  `nothing-prior` have no flag, and the line says so — *not a judgement call*.
  **`bindings` is a refusal rather than a fix**: `fli` writes no `.env` on a
  target, so once the generation has moved a revert genuinely cannot restore the
  pair, only put old code onto today's config.
- **`swapContainer` and `healthOrRestore` live in `deploy/_module.md` and have
  two callers each.** The going-back path is the one nobody exercises until the
  day it matters, so `_steps-revert` calls the same functions `_steps-docker`
  does rather than a copy of them.
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
- **`core/crud-templates.js` is the one answer to what a generated CRUD page
  looks like**, and it has two callers for the reason every shared engine here
  does: `make:scaffold` and `admin:generate` both emit a list, a create form and
  an edit page, and while each carried its own copy they drifted — one filtered
  `id` by name, the other asked the resource for its idField. The pages are
  built on `@frontierjs/ui`, and **neither page contains a form**: `<Model />`
  is the form — the markup half of the Resource, `core/resource-template.js` —
  so the create page and the edit page render the same fields and nothing about
  the model is written into either. That was documented and generated before it
  worked: the wrapper had no submit button and swallowed a page's
  `slot="actions"`, while these templates went on emitting a `<Form>` each
  (`FJS-559`). **The list is the deliberate
  exception**: which of twenty columns belong in a table is a judgement, so it is
  named at generate time (scaffold) or taken off the schema at runtime (admin,
  which cannot name them). Anything here that names a field, a type or an enum
  member belongs in the kit or in the resource instead.
- **The scaffold's package list has one owner too, now.** `fli new` used to keep
  `neededPkgs` — what `--source local` runs `bun link` over — beside the deps
  `makePackageJson` writes, and the two had to agree by hand. They stopped
  agreeing the moment the kit was added to one of them, and the failure surfaced
  three commands later in `deploy:vendor`, naming every package at once. It is
  read off the manifest now.
- **`core/checks.js` has two callers and one of them is not in this package.**
  `scripts/ci.mjs` imports it by relative path and runs it over this repo as the
  `structure` phase. Loosening a rule here loosens it for every app on the next
  release, and tightening one can fail the repo's own CI — which is the point.
  Plain ESM, node or bun, and **one import**: `@frontierjs/toolbelt/inflect`, the
  substrate package below the dependency graph (`FJS-D26`). *What is the singular
  of this service name* has one owner (Invariant 2) and five callers, and a rule
  answering it a sixth time would grade an app by an inflection the app does not
  run — `people` → `person` is exactly the case `service-model` has to get right.
  Nothing else may be imported: `ci.mjs` runs on plain node.
- **`core/invariants.js` is the enforcer per Invariant, and it may not import
  `core/checks.js`.** The rule table is the derived half of that answer, so it is
  handed IN — the same shape `checkRulesCountable` uses and for the same reason:
  `checks.js` imports this module, so reaching back for `RULES` is a cycle. The
  declared half is a test, a CI phase or a drive, which nothing can derive, and
  `invariant-enforcer` grades that it resolves rather than that it is right —
  whether a named suite really holds the assertion is a judgement no rule makes
  (`FJS-D190`). An invariant with NO enforcer is not a finding: that is the gap
  `invariants.snapshot.md` exists to publish, and failing on it makes deleting the
  row the fastest fix.
- **A rule about a NAME written twice has to accept every spelling of it.**
  `transition-methods` asks whether a declared `@@transitions` move is reachable
  from `api/`, and reachable means the move name OR the state it moves to —
  `transition(id, 'cancel')` and `update({ data: { status: 'cancelled' } })` are
  the same move and litestone enforces the machine on both. The name-only
  version was written first and measured: it reports eleven of basecamp's
  nineteen moves and is wrong about eight. **The two spellings are not
  symmetrical**, which is the part worth knowing — `transition()` resolves a
  move NAME, so the target-state spelling works for `update()` and throws here,
  unless the move is unnamed (`pending -> paid` names itself `paid`). Both
  directions are pinned in `tests/checks.test.js`, and writing one of them the
  wrong way round is what found it.
- **A rule that OVER-fires costs more than one that is missing, and neither
  caller can see it.** `ci.mjs` runs `runChecks` over the four APPS, so this
  repo's own tree is checked by nobody — two errors sat under a bare `fli check`
  at the root until someone ran one (`FJS-329`). One of them was a false
  positive: `body-tag-in-comment` flagged any `<body` in any comment, where the
  hazard is only a mention BEFORE the real tag, because Vite injects at the
  first textual match. A check nobody trusts is the failure this engine exists
  to prevent. **Run `fli check` at the repo root after touching a rule** — it is
  the only caller that sees this package's own neighbors.
- **`fli dev` runs two preflights and they disagree on purpose: the port check
  REFUSES, the database check warns.** An empty database is the correct state
  for a first run; a port that is already answering is not correct in any
  reading. `core/ports.js` derives which ports rather than reading a per-app
  list, so nothing goes stale the day somebody adds a surface, and it names a
  script the manifest actually declares, because two conventions are live (the
  apps here call it `api`, `fli new` writes `dev:api`). **Two functions and the
  difference is the bug** (`FJS-568`): `appPorts()` is the CATALOGUE — every
  surface that exists (Invariant 3), which is what `runnables.js` wants —
  and `devPorts()` is what `fli dev` refuses on, that set narrowed to the
  surfaces this app's own `dev` script actually runs, walked transitively
  through its `bun run` targets. They are the same set only in a scaffolded
  app, where `fli new` composes every surface into one `dev`; `example` has
  five surfaces and starts two, so the catalogue refused on a storefront's
  8610 that `bun run dev` would never have bound. A `dev` that runs no other
  script cannot be narrowed and is not — that is a one-surface app whose `dev`
  IS the surface command. **An app's own `dev`
  cannot be `fli dev`** — this runs `bun run dev`, so that is a loop; `dev` runs
  the surfaces and `fli dev` is the checked door in front of it.
- **`core/db-preflight.js` is why `fli dev` mentions an empty database.** An app
  with no rows boots clean and shows a blank screen, so nothing says anything.
  It resolves the path from the schema's `database` declaration — NOT from
  `resolveDb`, whose `development.db` / `test.db` convention describes a file
  many apps have never had — honors `env("VAR", default)` when the variable is
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
- **`core/site-surface.js` is the same rule again, and it exists because the
  surface list was incomplete.** A public prerendered site passed every part of
  `FJS-D107`'s test and was on none of its lists, so this repo's own example put
  one inside `web/` and nothing could say so (`FJS-451`, `FJS-D127`). The axis
  that decides it is **output**: one Vite root is one `dist/`, and `vite build`
  empties `outDir`, so the SPA's build deleted the site. `app-layout` reports a
  `target: 'static'` config found inside another surface now — decidable from the
  config's own text, which is the only reason the rule can see it at all. Note
  what the generator does NOT skip: it writes an `index.html` and a `src/main.js`,
  because `target: 'static'` is the SPA's Vite config plus a prerender pass, so
  `vite dev` on the surface serves routes as a client-routed app. Dev is an SPA
  and the build is files; every generated comment says so, because a page that
  works in dev and fails in the build is the normal case.
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
- **`core/doc-commands.js` grades the prose against the registry, and the
  registers are exempt on purpose.** Every `` `fli <command>` `` in a README, a
  CLAUDE.md or a command file must resolve; `IDEAS/` names commands that
  deliberately do not exist. A namespace mention (`fli make`) and a built-in
  (`fli list`, read from `bin/fli.js`'s `NO_PROJECT_NEEDED`) resolve too. It
  found the message an empty workspace prints, which named `ws-init` and
  `ws-add` where the aliases are `fli ws:init` and `fli ws:add`. (Written that
  way here deliberately: a backticked `fli <name>` is a claim that you can run
  it, which is the whole thing this grades — the rule caught this paragraph.)
- **A test file no script names never runs, and `test-files-run` is the rule.**
  This package's own `tests/pipe.test.js` pinned `FJS-379` and had never
  executed. **A new test file here has to be added to the `test` script** — the
  runner does not walk the directory, which is the shape the rule exists for.
- **`register-check.js` grades a register row against its own table's HEADER,
  never against a shape written into the rule.** `registers.js` infers a row's
  shape from its cell COUNT, so a row with fewer columns than its table falls to
  the decision-shaped branch and is handed a status nobody wrote — which is how
  four closed rows sat in an open section where `closed-in-open` could not see
  them, and two open defects sat in § Closed uncounted. A row with MORE columns
  is the other half and it is markdown's: **the excess is dropped at render
  time**, measured with a renderer, so 137 closed rows displayed no citations
  while the links sat in the file. `row-shape` compares counts and nothing else.
  The first version probed the DATE column instead and had to be withdrawn: it
  also fired on a cell reading *last tuesday*, which is a bad value in the right
  column and is `malformed-date`'s — one mistake reported twice, pointing at the
  wrong fix. Every real case disagreed on width too, so width alone is exact.
- **A rule belongs there only if it is SILENT when broken.** A violation that
  already raises an error belongs in the thing that raises it. `--list` prints
  the table with the invariant each rule comes from.
- **Two rules grade a DOC against what the package ships, and they are the
  newest class here.** `register-check.js` already covers a register that
  contradicts ITSELF; nothing covered a page that is merely out of date, which is
  the same silence one layer over. `docs-index` — a `docs/` page the index links
  from nowhere (a link, never a mention: the failure is a page nothing navigates
  to). `roadmap-shipped` — a roadmap section whose fenced sample uses an
  attribute `catalog.snapshot.md` already carries. The measured cost of not
  having them: litestone's roadmap kept *Exact numbers — `@scale(n)`, then
  `@money`* under **High priority**, opening *there is no fixed-point numeric
  type*, four days after `FJS-D142` built it; `exact-numbers.md` was linked from
  nothing; and a session read all three signposts, concluded the language could
  not express money, and filed a defect against the ruling (`FJS-560`).
- **Neither carries a list of what ships, on purpose** — a list here rots exactly
  the way the roadmap did. `roadmap-shipped` asks the generated catalogue, the
  same authority `litestone explain` asks. Its two quieteners are derived too:
  **scaffolding comes out of the file itself** (an attribute appearing in two
  sections' samples is holding them up rather than being their subject, which is
  `@id` in every `model` block), and a heading carrying `~~`, `SHIPS` or
  `SHIPPED` has already answered — an entry may legitimately propose the unbuilt
  HALF of something that ships, which is what `@slug`'s collision handling is.
- **Twelve of the rules read source rather than the tree, and `readCode` is why
  they are usable.** `raw-route-param`, `ctx-params`, `set-auth-discarded`,
  `call-header-declared`, `service-model`, `resource-model-miss`,
  `service-module-db`, `scheduler-dispatch`, `gate-unreachable`,
  `transition-methods`, `static-publish-db` and `static-publishes-0` match text — so they match the
  paragraphs that DESCRIBE those hazards too, and this repo's own `api/` files
  are full of them. Comments are blanked (to spaces, so every line number
  survives) before a rule sees a byte. **A statement is judged, never a
  substring**: `db.$setAuth(u)` alone is the fault, `const x = db.$setAuth(u)`
  and `db.$setAuth(u).order.create(…)` are the correct shapes, and a call
  spanning two lines is left alone rather than guessed at. Where a rule cannot
  resolve what it is reading — a `callHeaders` naming a value that is not a
  string literal or a single-valued constant — it **skips and says so**, because
  a declaration this rule cannot read is not an absent declaration.
- **One rule reads a DEPENDENCY's source, and what it is keyed on is the whole
  of it.** `package-model-drift` compares the app's copy of a model against the
  `.lite` the package ships, found through that package's own `exports` map — a
  path guessed into a package is the thing litestone's own resolver refuses to do
  and so is this. **Keyed on the columns THE PACKAGE DECLARES, never on the
  copy's existence**: a package reaches an app two ways and they are not the
  same, so `@frontierjs/auth` ships `Credential` to be IMPORTED and `User` to be
  appended and grown, and a rule on presence fires on every correct install. A
  column the app added is not a finding; a model attribute it added is not a
  finding; a column the package declares and this declares differently is. The
  issue was filed concluding a package needed a new way to say which file is
  which — it does not, and the narrower question needed no new surface at all
  (`FJS-483`). A **warning**, both declarations printed, because a deviation can
  be right and the reader is the one who can tell: its first run named two
  basecamp columns that had lost a field policy and one column where AUTH was the
  side that was wrong.
- **A finding may carry an EDIT, and `applyFixes` is the one thing that writes.**
  `edit: { start, end, was, replacement }`, byte offsets into the real file —
  which works only because `readCode` blanks comments to SPACES, so a span found
  in the blanked text names the same bytes on disk. Three rules carry one
  (`raw-route-param`, `service-model`, `resource-model-miss`) and the other six
  carry none on purpose: `const scoped = db.$setAuth(u)` would silence
  `set-auth-discarded` and leave every write below it unscoped, which is a green
  check over the bug. **Adding a fix to a rule means asking whether the rewrite
  is the WHOLE fix**, not whether it is easy. Edits go back to front, `was` is
  re-verified before the write, and `--fix` re-runs the checks from disk rather
  than subtracting what it applied.
- **Where a BUILD already proves something, a rule here asks whether the proof is
  switched on — never whether it passes.** Sierra's static-safety check taps what
  a route's `load()` read and grades it against `@@gate`, fail-closed; nothing
  textual can reach that question. What is decidable is a `target: 'static'`
  config wiring no `db:` (the tap has no client, so every route is refused until
  it declares `publishes:`) and a `publishes: 0` (the default bar, so it raises
  nothing and silences the two fail-closed branches — measured by calling
  `checkRoute`, not read off the source). That boundary is the general rule for
  the next one of these: **the build owns the verdict, this owns the wiring.**
- **`check-baseline.json` is the ratchet and it is not the allowance mechanism.**
  One number per rule id at the app root, absent = 0, `--update` cannot raise and
  `--adopt` is the separate verb that can. The findings still PRINT under a
  baseline — it moves the exit code and nothing else — because a rule set that
  goes red the day it is installed gets removed rather than obeyed. **A rule that
  SKIPPED keeps its ceiling**: 0 findings from a rule with nothing to look at is
  indistinguishable from 0 findings from a fixed one, and ratcheting the first
  case down locks in a number no later run can meet. `allow` answers the other
  question — *this one is fine, and here is why*, keyed by path and carrying a
  reason — and neither replaces the other.
- **Three proposed rules were killed by measuring them, and that is the cheaper
  half of the work.** `IDEAS/diagnostics.md` listed `@encrypted` on a `Json`
  column (it round-trips correctly now — `Int`, `Float` and an array THROW at the
  write, loudly, which is somebody else's job), a directive key in a `find()`
  filter (`autoFilter` answers a 400 naming the key and saying paging is a
  directive), and a model service with no `channel:` (ruled the intended state
  in `DECISIONS.md` § API design — a report on it "would fire on nearly every
  service in every app, which is how a warning gets trained out"). **A rule
  proposed off a hazard paragraph is a lead, not a spec**: two of those three
  were fixed after the paragraph was written, and the third was ruled against.

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

`bun run test`. A change to a scaffold is proved by scaffolding into a temp
directory and running what comes out. A change to `core/checks.js` also needs
`node scripts/ci.mjs --fast`, because the repo is its other caller.

**The GUI has its own drive and it is not in `test`**: `bun run test:browser`
(`tests/browser/`, one spec per panel, over mesa's harness by relative path)
needs Chrome. A change to `web/index.html` is proved there and nowhere else —
the page is built from strings, so every class in it is a claim about a
stylesheet nobody linked at author time, and a missing one renders as unstyled
markup that a test asking what the page SAYS reports as passing (`FJS-545`'s
shape one layer up).
