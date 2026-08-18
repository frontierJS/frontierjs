# Changes

## 2026-08-18 — `fli outbox:install` could not be loaded at all

Two unescaped backticks inside `wiringHint`'s template literal — the line
`// Then, in a service that declares \`transactional:\`` — closed the template
and reopened it, so the file compiled to JavaScript that does not parse:
`SyntaxError: Unexpected identifier 'transactional'`. The command was
unrunnable from the day it was written.

Invariant 15 is why this was caught at all: `tests/compiler.test.js` parses the
output of every one of the 201 command files rather than trusting a clean
compile. The suite had been failing on it and nothing here runs the suites in
the pre-push tier, so it took a CI runner to say so (`FJS-009`).


## 2026-08-18 — three ways `fli new --auth` could not work outside this machine (`FJS-343`)

**`runFli` shelled out to a bare `fli`.** That is a GLOBAL install: it exists on
the machine of anyone who has run `bun add -g` and on no CI runner, in no
container, and for nobody who arrived through `npm create frontier`. There it was
`/bin/sh: 1: fli: not found`, so `fli:init` and `auth:install` never ran. It
invokes the running cli now, through `global.fliRoot`.

**`auth:install`'s failure was caught, warned about and stepped over**, so the
scaffold printed `✓ created` over an app with no `User` model — one that
installs, builds, boots, answers health and 500s on the first register with
`"user" is not a table in this schema`. Fatal now. `make:scaffold User` beside it
stays a warning: the example slice is optional and auth is not.

**And with the tree's own cli finally running, the push failed every time.** The
scaffold writes `.env` with a bare `ENCRYPTION_KEY=`, so bun puts an empty string
on the process environment at startup and a child that already has the name set
will not take `.env`'s value for it. Step 6 existed to fix that by assigning
`process.env.ENCRYPTION_KEY` before the push — and **under Bun an assignment to
`process.env` does not reach a child at all**: `child_process` hands over the
environment the process STARTED with, where node would pass the mutation on.
Bun is the only runtime `fli` runs on, so that fix had been a no-op since it was
written. The values are passed as `env:` on the exec now.

None of it was visible here, because a global `fli` answered every call.


## 2026-08-18 — `fli new --auth` no longer reports success when auth was never installed

`auth:install` is what puts the `User` model and the three credential models
into `db/schema.lite`. Its failure was caught, logged as a warning and stepped
over, so `fli new --auth` went on to print `✓ <name> created` over an app where
`--auth` had not happened.

That app installs, builds, boots and answers health. It fails on the first thing
anyone does: `POST /api/auth/register` → 500, `"user" is not a table in this
schema`, thrown from `createUser` at the Data boundary. Three services instead
of four, and nothing anywhere saying why.

It had never been seen here, because `auth:install` has never failed on this
machine. It failed on a CI runner, on both package sources at once, and the
`deploy` phase's new register-and-login smoke is what caught it (`FJS-252`,
`FJS-009`) — the health answer that ran before it was green.

The failure is fatal now and says what it cost. `make:scaffold User` beside it
stays a warning: the example slice is genuinely optional, and auth is not.


## 2026-08-17 — `body-tag-in-comment` stops crying wolf (`FJS-329`)

The rule flagged any `<body` inside any comment. The hazard is narrower and
exact: Vite injects the built `<script>` at the FIRST textual match and does not
skip comments, so a mention matters only when it comes BEFORE the real tag —
below it, Vite has already matched. `packages/css/guide/index.html` documents its
own markup nine lines under a real `<body>`, and has no Vite build at all, and
was an error.

`core/checks.js` is the same engine `fli check` gives a client app, so an
over-fire ships to every app on the next release — and a check nobody trusts is
the failure this engine exists to prevent. It now finds the first `<body` in the
file and reports only if that one is inside a comment. A file whose ONLY body tag
is commented still fails, because that is the same case. The finding points at
the mention rather than at the comment enclosing it: the mention is the token to
delete.

**The other half is where it was found.** The `structure` CI phase runs
`runChecks` over the four apps, so nothing checks this repo's own tree, and two
errors had been sitting under a bare `fli check` at the root. The second was
real: `packages/mesa/mesa-bench/vite.config.js` had no `strictPort`, so a bench
run can be served beside the one it is being compared against. Fixed rather than
allowed.

Four cases in `tests/checks.test.js` — above, below, only, and a closing tag,
which is not the injection point and never was.

## 2026-08-17 — `fli outbox:install` (`FJS-D35`)

Appends `import "@frontierjs/junction/outbox.lite"` to the app's `db/schema.lite`
and pushes the schema, then prints the two lines that wire the relay.

Nothing is copied, which is the difference from `fli auth:install`: auth writes
out `model User` because the app owns it and adds columns to it. Every model
here is machinery an app reads when something did not arrive and writes never,
so there is nothing to hand over and a package upgrade reaches an installed app.
`--db` becomes `into <db>` on the import line, which is also why there is no
`@@db(main)` string rewrite here — the nearest `into` already beats it.

Refuses by name on a schema that already declares or imports the model, on a
`--db` naming a block the schema does not declare (`main` is checked like any
other — exempting it is what let auth inject models naming a database nobody
had), and on a junction that does not ship `db/outbox.lite`.

## 2026-08-16 — a scaffolded app generates its own types (`FJS-018`)

`fli new` writes a `db:types` script, and it writes TWO commands because they are
two audiences: `--audience system` into `db/schema.d.ts` for the API, which holds
a system client and legitimately sees `@guarded` and `@secret` columns, and
`--audience client --augment junction` into `web/src/db.d.ts` for the browser,
which never does. One file for both would tell browser code a column exists that
every response strips.

`--augment junction` is the half that crosses the wire — it registers the rows
with the browser client, so `client.service('leads')` is typed from the seed
rather than from a hand-written shape beside it. Only on the web file: the
augmentation names `@frontierjs/junction/client`, and an api-only app has no
browser to type.

## 2026-08-16 — the generated pages carry their own stylesheet

`fli ws:atlas` linked `@frontierjs/css` from unpkg, so the one page that
describes the workspace did not render from a `file://` path without the
network, and a published Artifact could not render it at all — CSP refuses the
external request outright. `FJS-256`, closed.

**The link broke outright before it was replaced.** The range was DERIVED from
the workspace's own copy on the reasoning that an exact pin 404s, because the
local version routinely runs ahead of the published one. A caret does not fix
that below 1.0, it hides it: `^0.16` means `>=0.16.0 <0.17.0`, so the day css
went 0.15 → 0.16 in the tree the page named a version the registry has never
had. Measured: `@^0.16` 404, no range 302. A derived range can name a version
that has never existed, which is strictly worse than none.

**The stylesheet is now built from committed source on every run.**
`src/index.css` is 48 `@import … layer(name)` lines and an `@layer a, b, c;`
declaration; each import becomes an `@layer name { … }` block and the
declaration is carried over first and verbatim, which is the shape `bun build`
already gives the package's own bundle. Three things decided along the way:

- **Not `dist/`**, which is that file already. It is gitignored and built on
  demand, so inlining-when-present and linking-when-absent would make the output
  depend on whether somebody had run `bun run build` — and these pages are
  committed snapshots the `snapshots` phase regenerates and diffs. The tree's
  `dist/` at the time held a two-day-old `frontier.css` and no
  `frontier.min.css` at all.
- **Every import must resolve or the bundle is refused**, and that is stated as
  *all of them* rather than as a floor. The first version used a count, which a
  four-import fixture fails and a truncated forty-eight-import tree passes. A
  partial bundle is the worst outcome available: it renders, looks nearly right,
  and is missing whichever layer went absent.
- **Comments are stripped by a quote-aware pass.** They are ~60% of that
  package's source. `content: "/*"` is legal CSS, and a stripper that is right by
  luck is one nobody can safely edit.

The CDN link survives as the fallback for a tree that cannot read the package at
all, and carries no range.

Verified by loading the generated page in headless Chrome with no stylesheet
request in it: `body` at the field theme's ground, `--surface` resolving, `.btn`
taking its padding off the space ladder. Four new tests. Two existing ones sliced
"the local CSS" at the first `<style>` in the page and now name it by id —
`<style id="atlas">` — because the page carries two, and one of those tests had
started passing vacuously against an empty slice.

## 2026-08-15 — `fli test:access --from <ref>` — the permission diff

`--from` and `--strict` pass through to `litestone access`, which with a
baseline answers *what did this branch do to who may do what* instead of writing
the snapshot: gates, row policies, field-level `@allow`, `@guarded` /
`@encrypted` / `@secret` and transition gates, graded `widens` / `narrows` /
`undecidable`. `--strict` exits 1 on a widening and on no baseline at all.

`scripts/ci.mjs` gains an `access` phase that runs it per app against the base
ref. **It reports and never fails**, which is the one deliberate exception to
that runner's rule that a check either passes or fails: a branch that widens
access is usually a branch doing its job, and a red on every feature branch
trains everyone to skip the phase. The gate belongs on the branch that deploys.

## 2026-08-15 — `extension/` is a surface too, and `fli` builds it

The same ruling as `widgets/`, one surface over: a browser extension is a
sub-project at the app root, and further from the SPA than a widget is. Its
config emits a *manifest*; `--browser chrome|firefox|both` makes one source two
builds; the artefact is loaded unpacked into a profile rather than served, so
there is no URL for a drive; and the release is a signed upload to two web stores
under a review measured in days.

`core/extension-surface.js` is its one owner — `fli make:extension` and `fli new
--extension` — and `fli extension:{dev,build,audit}` wrap jetty's own `jetty-*`
binaries with `--root` at the surface. That is the `fli` integration jetty's
README had listed as not done.

`app-layout` gained the fourth surface and a second misplacement probe:
`src/harbor/` inside `web/` or `api/`, which is jetty's service worker and cannot
mean anything else. `--template extension-only` joins `widgets-only` as a
surface-only project, both resolved from one `surfaceOnly` branch rather than two.

**It found a defect in jetty on the way**: the Mesa compiler lookup probed two
fixed directories and never walked up, so in this exact layout — one install at
the app root — every `.mesa` in an extension silently became stub mode and the
build failed with a parse error inside the component. Fixed there, with the
fixture's dock converted to real Mesa so the path is exercised at all.

Verified end to end: a scaffolded `extension-only` project builds for both
browsers, and `fli check` is clean on it.

## 2026-08-15 — `widgets/` is a surface the CLI knows about

`fli make:widget <Name>` creates a widget, and creates the surface the first
time. `core/widget-surface.js` is the one owner of its shape — `fli new
--widgets` and `fli new --template widgets-only` call the same function, so the
app a scaffold wrote is the app the second widget extends. `context.paths` gains
`widgets`, `widgetEmbeds` and `widgetTests`, and `fli widgets:{dev,build,serve}`
run from the surface root the way `web:*` runs from `web/`.

**Two rules, both silent when broken.** `app-layout` learned that a surface is a
directory at the app root, and that WHICH surfaces an app has is the app's
business: api-only, web-only and widgets-only are all whole projects, so the
rule stopped demanding all three and started reporting a surface in the wrong
place — widgets under `web/src/Embeds/` inherit the SPA's build, port and
release, and the first symptom is a widget shipping when the app does. The new
`widget-entry-name` covers Invariant 19 next door: a widget's name is also the
custom element a stranger's page writes, so `booking.mesa` reaches HTML as
`<booking>`, which no browser upgrades — and a directory in `src/Embeds/` with
no `index.mesa` builds nothing at all, which is correct for a widget's shared
parts and wrong for one somebody is midway through writing.

The clean-app fixture in `tests/checks.test.js` now carries the third surface,
because a rule that only ever skips is what that file exists to catch.

## 2026-08-15 — `auth:install` imports auth's models instead of copying them (FJS-265)

The command wrote `db/auth.lite` into the app. It appends one line now:

```
import "@frontierjs/auth/schema.lite"
```

`Credential`, `Session` and `Verification` stay in the package, so `bun update`
reaches them — which is the whole reason the specifier is a package rather than a
path. `User` is still written out as text, because it is the app's: it grows
columns and relations point at it.

`--db` becomes `into <db>` on that import line rather than a rewrite of a copied
file, so the `@@db` swap this file still restates now only has to reach `User`.

The already-installed test accepts all three layouts that have shipped — imported
by name, copied to `db/auth.lite` and imported, and all four models pasted into
`schema.lite` — because missing any of them injects over an app that already has
auth.

## 2026-08-15 — what a scaffolded app is given, and a `fli check` that runs

`IDEAS/overview.md` 5.13. The generated `package.json` and config files are the
framework's real opinion about tooling and far more people will read them than
will ever read this repo, so they moved out of a 1400-line command into
`core/app-config.js`, one module with the reasoning attached and a test per
default.

**Everything extensible is a dependency now.** `tsconfig.json` and `biome.json`
are one line of `extends` over `@frontierjs/config`; the app keeps only `paths`
and `include`, which are the parts about its own layout. A copied config is
frozen at the moment it was written. `.editorconfig` is the exception and a
mechanical one — EditorConfig has no extends — so it is a hand copy byte-pinned
by a test on both sides.

**The app gets a gate and a workflow.** `bun run check` is `fli check`, then
lint, then typecheck; `.github/workflows/ci.yml` calls that and nothing else,
the same rule this repo holds itself to. `--no-ci` opts out. `@frontierjs/cli`
is a devDependency rather than a global assumed on PATH, since three of the four
scripts call `fli` and a global one of a different vintage generating files for
this app's framework version is the drift a pin removes.

**`fli check` had never run** (`FJS-269`). `commands/fli/check.md` used `resolve`
with no import and there is no `fli/_module.md` to supply one, so every
invocation since it shipped died with `resolve is not defined` — in this repo and
in a client app alike. The parse sweep cannot see it: it compiles each command
**without** its namespace module, so a free identifier parses clean. CI stayed
green because its `structure` phase imports `core/checks.js` directly, so the
engine worked and only the door was broken. Found by putting the command into a
scaffolded app's gate and running it.

**`fli typecheck` is new, and it is not a convenience.** Every `@frontierjs`
package ships TypeScript source, so `tsc --noEmit` in an app follows those
imports and checks the framework: measured on a fresh scaffold, 61 diagnostics
inside `node_modules` and none of the app's own. `core/typecheck.js` reports the
ones that belong to the project and counts the rest; `scripts/typecheck.mjs` is
its other caller and keeps only the baseline ratchet, which is this repo's alone.

**`scripts/scaffold-build.mjs` now runs `bun run check` inside the app it
builds.** An opinion that is red on a freshly scaffolded app is worse than none,
and three things are only reachable there: `fli check` from an installed cli,
Biome against a config resolved out of `node_modules`, and the typecheck against
packages that ship `.ts`. It found a missing `parseInt` radix in the scaffold's
own vite template on the first run.

## 2026-08-15 — `auth:install` reads auth's schema instead of restating it (FJS-038)

The hand copy of the four auth models is gone. Two walls had kept it here, not
one: `fli` is global, so `@frontierjs/auth` is not installed beside it — and
**`fli` runs on node** while `packages/auth/schema.ts` is TypeScript, so even
resolved it could not be imported. Auth ships `db/user.lite` and `db/auth.lite`
now, and reading bytes gets past both walls.

The command installs the package if the app lacks it — the test is a RESOLVE, so
a declared dependency nobody installed fails the same way — then resolves
`@frontierjs/auth/user.lite` and `/schema.lite` through auth's own `exports`
with `createRequire` off the app's `package.json`, rather than guessing at a path
inside the package.

**It writes two files, split by who owns the model.** `db/auth.lite` gets
`Credential`, `Session` and `Verification`, all `@@gate("8")`; `schema.lite` gets
`import "./auth.lite"` and `model User`, appended. An APPEND, not an insertion —
`import` is legal anywhere at the top level and `parseFile` merges imported
models ahead of local ones regardless, so nothing here has to parse the app's own
file to find a spot in it.

**Re-running it appended a second copy of all four models.** The already-installed
test read `'model users'` — lowercase plural, from before the rename — and the
fragments have emitted `model User` ever since, so it matched nothing. It is
anchored and PascalCase now, and reads `auth.lite` too, so an app installed
BEFORE the split is still recognised rather than injected over.

One rule is still restated here, because it cannot be imported: the `@@db(main)`
swap that makes `--db` work. Auth's own suite lifts this arrow out of the
markdown and runs it against the shipped bytes.

## 2026-08-15 — the project viewers read the API surface instead of guessing at it

`fli project:map` and `fli project:view` derived what a service IS from regexes
over `*.service.ts`, and the problem was not that the regexes were weak. Junction
decides at CONSTRUCTION whether a key is an option or an action — `collectActions`,
read back through `svc.describe()`, Invariant 4 — `svc.pipelines()` resolves the
hook chain, and `apiPrefix` moves every route. **None of that is a fact about how
a file reads**, so the scan could not agree in the general case: an action
assigned from a module-level const takes no visible `ctx`, a `methods:` list
built from a variable is not a literal to match, and a hook added by a plugin or
by `app.hooks()` is in no service file at all. A viewer with no way to be
contradicted then draws a confident wrong picture.

`extractServiceMeta` is deleted. Both commands read the committed
`surface.snapshot.md` — written off a BUILT app by `junction surface`, and failed
by the `snapshots` CI phase when it goes stale — so what the viewer shows is
current or CI is red. **Absent means absent**: no snapshot yields no services and
a warning naming the command, because a fallback scan is how the viewer gets to
be wrong again with nobody told.

What came free, none of which a scan could reach: basecamp reads as
`alerts · model AlertRule` where the scanner saw the accessor, five actions on
that one service, the app-level hooks that run around **every** call, 27 mounted
routes, and the plugins in configure order.

`FJS-037` closes with it — the sixth reserved-key list was the `RESERVED` set
inside that function, re-applying junction's option-or-action rule from outside
junction. The fix was never to share the set; it was to stop asking the question
here.

**`extractResourceMeta` stays, and was rewritten.** A Resource has no committed
artefact — it is constructed in the browser — so the `createResource(...)` call's
literal arguments are the only thing there is. It now reads the CALL rather than
the file: comments stripped first (a `model:` in prose is not a declaration, the
same shape as the body tag written inside a comment), a balanced argument list
rather than `[^)]*`, and hooks read per phase and per method instead of swept for
lowercase identifiers minus a skip list. Diffed against the sweep it replaces on
six shapes and wrong on all six — a second phase or method written on one line
took the whole block with it and answered empty, an inline arrow contributed its
argument name, and `session.stamp` came back as two hooks.

## 2026-08-15 — an app built from local sources ships (FJS-241)

`fli new --source local` writes `link:@frontierjs/junction` and four siblings.
They resolve to a workspace on the machine that made them and to nothing inside
a Docker build, so `bun install` failed once per package and **`fli deploy:local`
could not be run against the scaffold this repo produces by default** — which is
how four defects sat undetected on the deploy path, all of them found by reading.

The fix is not a different spec. A `link:` is what makes an edit to a package
visible with no reinstall, which is the whole point of developing against local
sources; a `file:` tarball in the same place goes stale on the first save and
says nothing about it. So the swap happens at BUILD time. `core/vendor.js` packs
every publishable package sharing a scope with a linked one into
`deploy/generated/vendor/` and writes `app-manifest.json` with the specs pointed
at the tarballs — **`overrides` included**, because the packages depend on each
other and a range left alone resolves from npm and quietly mixes a published
sierra into a local mesa.

**One owner, three callers**, which is the half that matters more than the
mechanism: `fli deploy:vendor` is the command, `deploy:local` and the pipeline's
`04-build-api` run it before they build (the server-side one rsyncs the result,
since a generated directory cannot arrive by `git pull`), and
`packages/basecamp/deploy/build.mjs` — which had the only working implementation
of this — now calls it instead of carrying its own. A scaffolded app and the app
whose purpose is to exercise the tree answering the packaging question
differently is how the two stop being one framework.

**One Dockerfile serves both source modes.** With nothing linked the vendor step
writes a verbatim manifest copy and the lockfile beside it, and the template's
freeze is conditional on that lock being present: a rewritten manifest has none
that matches, and a `file:` spec names its own content, which is the stronger
pin anyway. Making the template conditional instead would put the branch in a
file nobody regenerates when the source mode changes.

`deploy:doctor` fails a Dockerfile that installs from `package.json` while a
`link:`/`workspace:` spec is declared — reading it with comments stripped,
because the template explains `deploy/generated/` in its own header and asking
the whole source passes for a Dockerfile that only talks about it.

Proven by running it: `fli new --source local` → `make:deploy` → `deploy:local`
builds, boots, migrates and answers health. CI's `deploy` phase now runs both
sources, and its `scaffold` phase packs through the same module rather than its
own copy of the rule.

## 2026-08-15 — `fli release:check` — the Release realm arrives as one question

A new `release` namespace with one command in it. `fli release:check` reads
`db/schema.lite` twice — as it is, and as it was at the release you name — and
classifies the deploy between them: **expand**, and it can be taken back;
**contract**, and that deploy is the pivot; **unknown**, which counts as a
contract. It writes `db/release.snapshot.md`, the surface the serving release
binds to, so the diff between two releases is the classified change.

It cost no CI edit, which is the point of the two engines being shared: the
snapshot names `litestone release --schema schema.lite` in its own header, so
`fli test:snapshots` found and rechecked it with nothing added to a list. Run
over `example/` it reports current; run over `basecamp/`'s working tree it
reports **14 contract findings**, one per model that gained the row-level
tenancy predicate — which is correct, and is the first time that change has been
visible as a deploy risk rather than as a schema edit.

`--strict` is the gate for a deploying branch, `--check` the gate for a stale
snapshot, `--from <ref|path>` the question a deploy actually asks. The classifier
itself is litestone's (`src/release.js`); this is the app-facing door onto it.

## 2026-08-14 — the atlas opens on the workspace, not on the deck

The workspace was the 20th plate in a deck of 23, which is where the register
files things against `repo` — and everything a person actually arrives with is a
question about the whole tree rather than about one part. `fli ws:atlas` now
leads with a **hub pane**: six tiles (open · plates · capabilities · runnable ·
gated artefacts · invariants checked), the open register broken by severity as
routes into it, every package carrying anything open ordered **worst first**,
and the eleven root registers each quoted with its own opening claim.

Two things in that are judgements rather than counts and both are stated on the
page. **Ordering is by WEIGHT, not by count** — an S2 outranks a pile of S4s, so
basecamp's 8 rows lead litestone's 21 — and a bar's **length** is that weight
against the worst plate while its segments are the mix and the number is the
count; every bar filling its cell made 21 open read exactly like 2. Under it,
the workspace dossier now carries the WHOLE register — 106 rows, facetted by
severity and by the part they are filed against, each linking the plate that
owns it — plus the deck as one table, which is the comparison 23 separate cards
cannot make: who is published, who carries a typecheck ceiling, who is clean.
A severity is a route (`#/part/repo/S2`), so a count in the hub lands in the
register with the filter already applied.

**Then the hub grew the other two registers.** `ISSUES.md` is what is wrong,
`DECISIONS.md` is what is settled, `IDEAS/` is what is not started — three
states one piece of work moves through, and only the first was on the page.
They are now one row, because *what should I work on* is answered by reading
across them and reading `ISSUES.md` alone is how a defect gets fixed that a
ruling already retired. 106 open · **69 rulings** across nine domains · **93
ranked ideas and 39 papers**, all three whole in the dossier, all three in ⌘K.

Both readers had to learn a convention written for people. A ruling is a date,
an optional `FJS-D##` and a bolded claim leading a paragraph. An idea's Status
column is written four ways in four adjacent rows — `**defect**`, `` `contested`
— see ISSUES.md ``, `~~shipped~~`, `part-shipped` — so it normalises to one word
and keeps the cell whole beside it. A paper introduces itself with its **H1**,
not its opening paragraph: all 39 open on the same `**Status: IDEA. Nothing here
is built.**` boilerplate, so the generic reader had every one of them saying the
same thing.

That made four filter dimensions over one dossier, so the facet machinery is now
**one mechanism**: a control declares its dimension (`data-facet="stat"`), a unit
carries its value (`data-stat`), and a unit carrying nothing for a dimension is
untouched by it — which is what lets narrowing the ideas by status leave the
register beside them alone. A route names its dimension too
(`#/part/repo/stat:defect`), and **splits at the second slash rather than the
last**, because one ruling domain is `Design system (@frontierjs/css)`.

**And a package that documents itself in one README now has a field guide too.**
Litestone writes 35 files under `docs/` and gets 35 cards; junction writes 32
capabilities as `##` sections in one README and got a row of bare chips, which
is not a feature list. They are the same claim filed differently, so they are
dealt the same — each section now carries the first thing it says. Half of
junction's open on a fenced example rather than on prose, which is what an API
README looks like, so the fence's opening line is kept instead: *Response
helpers* says nothing and `ctx.json(data, status?)` says the whole thing. First
thing wins — scanning past prose for a signature finds whatever example is
furthest down the section — and a section opening on a table says neither
rather than reaching. All 32 are in ⌘K now; none was findable before. Beside
them, `src/*` with a file count each answers the structural question the
feature list does not: junction is 14 subsystems, `core` 16 files and `plugins`
15.

Found while looking at it: **`openingClaim` was quoting the wrong sentence.**
It asked for the first bold run anywhere in the file, and the house convention
bolds a claim per SECTION — so `DECISIONS.md` introduced itself as *Outpost*,
`drift-report.md` as *code-wrong*, and `HANDOFF.md` with the last session's
summary out of a blockquote. It reads the opening paragraph now, and the bold
only counts where it leads it. That is the map's reader, so both pages moved.
 — @frontierjs/cli

## 2026-08-14 — no alias is contested, and discovery is sorted

Warning about a contested alias found the larger half of it: **the winner was
whichever command loaded last, and that was `readdirSync` order.** Not the
alphabet — the filesystem's. The same tree resolved `fli new` to `project:new`
on one checkout and to `make:command` on another, which means the CI `scaffold`
and `deploy` phases, `README.md` and `docs/QUICKSTART.md` all called a command
that scaffolds a `.md` file rather than an app, on any machine whose directory
order came out the other way. `find()` sorts its walk now.

Sorted is reproducible, not correct: nothing about `utils` sorting after `ports`
says which command should own `dev`. So all four collisions were resolved by
renaming the side fewer people type:

- **`make:command`'s `new` → `mkcmd`** — the whole family is already `mkroute`,
  `mkmodel`, `mksvc`, `mkschema`, `mkc`. `new` was the odd one out and it was
  standing on `project:new`.
- **`site:audit` → `site:setup`, no alias** — it audits nothing. It removes
  boilerplate pages, writes the domain into `site.md` and `robots.txt`, and
  creates a `stage` branch, once, guarded by `config_ranSetup`. `audit` is
  `npm:audit`, which is an audit.
- **`ports:dev` → `ports:claim`, alias `claim`** — it claims a port session and
  prints the `FLI_PORT_*` vars for you to pass to your own servers. It has never
  started one, and its description said it did. `dev` is `utils:dev`, which runs
  the project's dev script.
- **`deploy:doctor` loses `doctor`** — someone typing `fli doctor` blind is
  asking *is my setup ok*, which is `fli:doctor`. The deploy question is scoped
  and its full name reads as the question.

The `ports:claim` / `utils:dev` split is still one job in two commands — both
run the same database preflight — and merging them is the `fli dev` orchestrator
already on the horizon. Closes `FJS-061`, whose other half was live: `POST
/api/env` called `writeFileSync` without importing it and 500'd on every save.
 — @frontierjs/cli

## 2026-08-14 — `fli db:seed` named a path nothing in this repo produces

It hardcoded `db/seeders/seed.ts` and reported *Seeder not found* for any app
that keeps its seeder anywhere else — which is every app here. There are three
competing conventions and it knew about none of them:

| | |
| --- | --- |
| `fli db:seed` | `db/seeders/seed.ts` |
| `litestone seed` | `cfg.seeder` ?? `./seeders/DatabaseSeeder.js` |
| basecamp | `db/seed.js`, behind a `db:seed` script |
| example | no seeder at all |

`resolveSeeder()` in `commands/db/_module.md` now ASKS the app instead of adding
a fourth guess: `litestone.config.js`'s `seeder:` first, then the `db:seed` /
`seed` script in `package.json`, then a probe of the five known locations, then
an error that names everything it looked for.

**The script is preferred over the path it resolves to**, because a seed script
often does more than run one file — reset first, migrate, set an env var — and
that is what the app author meant by "seed". A script that calls `fli db:seed`
itself is skipped rather than recursed into.

`--force` passes through, which is what re-seeding an app that already has rows
needs; without it litestone's seeder stops on the first `UNIQUE constraint`.

## 2026-08-14 — `fli dev` says when the database is empty, and knows which runner to use

**The failure it exists for:** an app with an empty database boots clean, serves
every route, answers every request correctly, and shows a person a blank screen.
Nothing is broken, so nothing speaks, and the first ten minutes go into looking
for a bug in the app.

`core/db-preflight.js` is the check, and it has two callers — `utils:dev` and
`ports:dev` — because `dev` is an alias on both and which one answers depends on
discovery order. It reports three states and refuses nothing: the database does
not exist, it has no tables (migrations have not run), or every table has zero
rows. `--no-check` skips it.

Three things it gets right that the CLI's own `resolveDb` does not:

- **The path comes from the schema's `database` declaration**, which is what
  litestone opens and which WINS over `createClient({ db })`. `resolveDb`
  assumes `development.db` / `test.db` and would look at a file basecamp has
  never had. `litestone.config.js` is the fallback.
- **`env("DATABASE_URL", "./db/x.db")` yields to the variable** when it is set,
  or the check reports on a file the app is not going to open.
- **Litestone's own `_migrations` table does not count as data.** A freshly
  migrated database has rows in it and nothing else, which is exactly the state
  worth naming.

`node:sqlite` arrived in Node 22.5 and fli's floor is 20.6, so the binding is
optional and its absence costs the row count, not the check — the file-level
signals need nothing. It takes `bun:sqlite` too, because nothing stops `fli`
being run under bun and a node-only import would make the check blind rather
than wrong. The experimental-feature warning is muted across the import; a Node
implementation note has no business on top of `fli dev`.

**And `utils:dev` had been running the wrong runner in every workspace.** It
tested for `bun.lock` beside `package.json` — but a package inside a workspace
has no lockfile of its own, so it reported *npm detected* for every package in
this monorepo and then ran npm. `detectRunner()` walks up.

## 2026-08-14 — two commands can claim one alias, and now it says so

The registry only warned when an alias collided with a command's TITLE, so an
alias-vs-alias collision was silent: four were contested — `doctor`, `new`,
`audit`, `dev` — and the winner was whichever loaded last. `fli dev` ran
`utils:dev` and nothing anywhere said `ports:dev` existed.

It warns now, naming both and saying which one answers. The precedence was left
alone at this point, on the reasoning that `fli new` had always meant
`project:new` by virtue of load order and every doc plus two CI phases call it —
making first-wins would have moved it silently. That reasoning was half right
and the warning is what exposed the other half: **load order was `readdirSync`
order, not the alphabet**, so the resolution was never stable in the first
place. See *no alias is contested, and discovery is sorted* above, which sorts
the walk and renames every contested side.
 — @frontierjs/cli

## 2026-08-14 — three numbers, one crossing

**Two numbers that were already in files and on no page.** A plate now carries
its typecheck ceiling from `scripts/typecheck-baselines.json` — absent is 0 and
0 is *clean*, said rather than left blank — and an app carries the ports the
formula gives it, which is the number wanted immediately before running a drive
and was one table away.

**Where an open row actually points.** Every row's Detail column links its
evidence, and those links are paths into this tree — the one place the register
says WHERE. Counted per file and filed onto the package that owns the path, so a
dossier answers *is anything filed against this file* with the file already
open. Scoped to the card's own home on purpose: half the register links the root
`CLAUDE.md`, and counting those per package would make the busiest rows the
busiest files everywhere. A doc topic whose own file is named by an open row
carries the count on its tile, which is how you find the capability to read
first.

**Invariants against the rules that check them.** The root `CLAUDE.md` numbers
19; `core/checks.js` exports 10 rules and each names the invariant it comes
from — and nothing crossed the two, so *which of these does a machine actually
enforce* was a question you answered by reading both. Crossed on the workspace
plate: **5 of 19 are enforced, 14 are held up by attention**, which is the
finding, not the decoration. Two rules guard a live hazard rather than an
invariant and say so.

⌘K indexes the new nouns too — 518 rows now, including every invariant and every
file an open row names.

## 2026-08-14 — `fli ws:atlas --live`, and the theme goes home

**The theme moved into the package that owns themes.** `theme-field` is now
`@frontierjs/css`'s `themes/field.css`, and the atlas READS it out of the
workspace — or out of `node_modules`, for an app — and inlines it, rather than
carrying a copy. Two copies of a palette drift and the copy is the one nobody
edits. It has to be read at all because the page links the published bundle,
which lags the workspace by a release; absent, the page offers the themes the
bundle does have and defaults to one of those rather than rendering unthemed.
The nine realm accents stay in the page: a category is an app's fact, not a
design system's.

**`--live` is the ungated sibling.** A committed page is byte-compared, so it
can hold neither a clock nor an answer from the network — which rules out the
two things most often wanted about a package. `fli ws:atlas --live` writes
`repo-atlas.live.html`: **no generator line**, a timestamp on the page,
`.gitignore`d, and `--check --live` refused outright rather than quietly
comparing something that cannot match. Per package: last commit and its
subject, commits in 90 days, uncommitted files, and local version against the
registry. That last column is `FJS-252`'s whole class — every id in the open
register is a statement about the tree, so *published is a release behind* is
invisible from inside it. The first run over this workspace found **ten**
packages ahead, including `cli` at 0.1.1 against a published `0.0.0-beta.0`.

## 2026-08-14 — the atlas answers a word, a change, and a glance

Three additions, each closing a gap the page had while looking complete.

**⌘K searches everything.** The deck's box narrowed plates and a dossier's box
narrowed one dossier, which left the thing somebody actually arrives with — a
word — matching nothing. One index over every noun the page holds: 400 rows here
across parts, actions, open rows, documented capabilities, commands, snapshots,
drives, scripts, CI phases and registers. Ranked rather than filtered (a prefix
on the title beats a hit buried in a subtitle), arrow keys and Enter, and every
route it offers is checked by a test to name a dossier the page actually
rendered — a palette that lands nowhere is worse than none, because it is
confidently wrong at the moment somebody is lost. Built at generation time, not
harvested at load: a corpus assembled in the browser can differ from what the
committed file says.

**Every plate says what proves a change to it.** The root `CLAUDE.md` carries a
`Changed → Run` table — *changed the compiler, run the SSR drive AND the
hydration one, they fail apart* — which is the highest-value paragraph in the
file and lives in exactly one place, in prose, read top to bottom by nobody who
needs it. It is parsed and filed onto the plate it names. A row naming three
packages shows on all three; a row that names a package as the drive to RUN
rather than the thing CHANGED does not file it there, which is the mistake the
obvious implementation makes.

**A count says twenty-one, not twenty-one of what.** Each plate carries a heat
strip — one segment per severity, sized by share, in the register's own tones —
so two S2s read as worse than twenty S4s at a glance.

## 2026-08-14 — the atlas is written in the styling language

It was not. The first cut of `fli ws:atlas` carried ~120 hand-rolled rules and
raw hex — a small bespoke design system inside a generator, which is exactly
what Invariant 13 exists to stop. It is now `@frontierjs/css`: Topbar, Card,
Dialog, Table, Facts, Item, Badge, Pill, Field, Chip, and the Layout terms.

**The field-manual look is now a theme, not a stylesheet.** `theme-field` — ink
ground, sand ink, a serif display over a monospace body, square-ish corners —
is a token block and nothing else, which is the discipline `themes/press.css`
sets: what needs a selector of its own names a missing token. It is the atlas's
default and sits in the picker beside the package's nine. One token it wanted
and could not have: heading tracking, which no `--*-letter-spacing` covers, so
the atlas tracks its own display type instead.

Its real home is `packages/css/src/themes/field.css`. It lives in the page while
the stylesheet is a CDN link, because a theme in the workspace is not a theme in
the registry (`FJS-256`).

**Two axes, not one.** A tone says how to READ a thing — `danger` is a defect,
`success` is a phase that passed. A realm says which family it BELONGS to, and
the vocabulary has no word for that, correctly: a category is an app's fact, not
a design system's. So the atlas derives nine realm accents from the seven tone
tokens — `--realm`, mixed in oklab where the tones do not reach, used for the
plate's rule, its motif and its badge and never for body text. No hex, and a
theme moves all nine at once. The two that mix to the same place are eight
realms wearing nine names, which is why `testing` and `cross` are measured
apart rather than assumed apart.

**A tone carries the meaning a colour used to.** An S1 defect is `danger`, a
ruling is `info`, a claimed folder is `muted`, a fast CI phase is `success`. No
hex is written for any of them, which is what makes the **nine themes** work —
the topbar carries a picker over `default · dark · midnight · forest · sunset ·
elite · basecamp · notebook · press`, remembered in `localStorage`. A test fails
a colour literal in the page's own stylesheet, because that is the rule that
would otherwise erode one convenience at a time.

What is still hand-written is only what the vocabulary has no word for: the
deck's grid, the plate art, the field-manual display face. All of it unlayered —
the bundle declares `@layer`, and unlayered rules beat every layer, so nothing
needs a specificity fight or an `!important` — and every value is a token, so
the themes reach it too.

A dossier is now a real `<dialog>` opened with `showModal()`, so the backdrop,
the focus trap and Escape are the platform's rather than this file's.

**The stylesheet is a CDN link for now, and that is a known cost**: the page no
longer renders offline from a `file://` path, and the range is derived from the
workspace's own copy rather than pinned because the local version runs ahead of
the published one. `FJS-256` holds the fix — inline the 71KB bundle at
generation time, fall back to the link.

## 2026-08-14 — `fli ws:atlas` — two doors, and the surface behind each plate

**Nobody arrives knowing the name of the package that owns their problem.** They
arrive with a realm or with a verb, so the atlas front page now opens with both:
*search by realm*, which filters the deck, and *search by action*, which pools
every runnable thing in the workspace — a command, a script, a drive, a CI
phase, a snapshot generator — and answers *how do I deploy* with all of them at
once. The vocabulary of verbs is curated; the membership is not, so an action
lists what is actually there and one nothing answers to is not offered. All
three doors are routes (`#/part/…`, `#/do/…`, `#/realm/…`), so any of them is a
link somebody can send.

**Every dossier carries its own search.** Litestone's runs to ninety-odd
searchable units, so the sheet gets a box that narrows the rows, topic tiles and
chips inside it and nothing else — and a block whose units have all gone hides
with them, because a heading over nothing reads as *this package has none*,
which is the opposite of an empty result. Opening a dossier clears the box and
focuses it; `/` focuses whichever box is in front, `Esc` clears it and then
closes the sheet.

**And a plate now opens onto what the package does**, which is the question
that made the deck insufficient: `docs/` is one file per capability and the
README's own `##` headings are the second index, so litestone's dossier lists
35 topics and 34 sections, each a link to the document itself. A feature list
this file invented would be wrong within a fortnight; a list of documents
somebody wrote is a list of documents somebody wrote.

## 2026-08-14 — `fli ws:atlas` — the same model, the other question

A plate per part of the workspace, each opening into a dossier: what it depends
on and what depends on it, the issues filed against it, the snapshots it owns
with the command that regenerates each, the drives that prove it, and for `cli`
its command namespaces. Package, app, workspace and claimed folder are four
kinds of plate, because they are four different things: an app is never
published and is where the seams are crossed, and a folder with no
`package.json` is a plan rather than a part.

**Three vocabularies name one noun** — the register files by short name
(`litestone`, `repo`, and `cli/auth` for a defect living in two), the snapshot
walker by path, the drives by directory — so the crossing is done in
`core/repo-atlas.js` and a row filed against two packages shows on both rather
than on neither.

The realm on each plate is parsed out of the root `CLAUDE.md` table rather than
restated, so a package that moves realm moves here; one the table forgets reads
*unfiled* rather than being quietly labelled. `core/repo-map.js` gained the
readers both pages share: that table, the app directories, and the inverse
dependency edge no file states.

It does not replace `fli ws:map`. The map answers *what do I run and where*; the
atlas answers *what is in here and what does it touch*, and a page answering
both would answer neither.

## 2026-08-14 — `fli ws:map` — the map, read rather than written

One page saying what is in a workspace and how to run it: the scripts at the
root, every snapshot with the command that regenerates it and the directory to
run it from, the CI phases in call order, the open register by severity, the
packages with the siblings each depends on, every `verify*` drive, the port
registry, the command tree, and each root markdown file quoted by its own
opening claim.

**Nothing on it is typed twice.** The hand-written version of this page was
wrong within a fortnight, which is the failure the command exists to stop: a row
is either read from a file that would break something else if it were wrong, or
it is not on the page. `core/repo-map.js` holds the readers; the phases come out
of `main()` in `scripts/ci.mjs`, so a phase that moves tier moves here too, and
the description is the phase's own section comment rather than a second copy of
it.

A section whose source is absent is omitted rather than faked — a client app has
no `scripts/ci.mjs` and no `ISSUES.md`.

Output is `repo-map.snapshot.html` at the workspace root, self-contained because
it is usually opened from a `file://` path: no stylesheet, no font, no fetch.
It names its own generator below the doctype (above one is quirks mode), so the
`snapshots` phase rechecks it without being told. Nothing in it varies between
two runs over one tree — no dates, no timings, every list sorted — and because
the page lists every snapshot in the workspace and becomes one, the first
generation writes twice to land on the fixed point.

## 2026-08-14 — `fli test:snapshots` — the gate an app was missing

Six generators shipped this week — `litestone access`, `litestone ddl`,
`litestone jsonschema --snapshot`, `junction surface`, `junction errors`,
`sierra routes` — and the thing that RUNS them lived in `scripts/ci.mjs`. So a
consuming app got every generator and no gate: a framework publishing half a
feature.

`core/snapshots.js` is that half, extracted, with the two callers `core/checks.js`
already has — `fli test:snapshots` over a client app, `scripts/ci.mjs`'s
`snapshots` phase over this repo. It walks for `*.snapshot.*`, reads the
`generated by:` line out of each header, and reruns that command with `--check`
from the file's own directory. Zero dependencies, plain ESM, node or bun,
because `ci.mjs` imports it before anything is installed.

**A header is data and this executes it**, so the binary must be one of
`litestone`/`junction`/`sierra`/`fli` and every argument a plain flag or path;
both are refused by name. A snapshot naming no generator is a FAILURE rather
than a skip — a generated file nothing can recheck is a document wearing a
gate's clothes.

One thing stays in `ci.mjs` on purpose: a snapshot tracked at the base ref and
absent now. That is a question about this repo's history, not about an app, and
discovery alone answers it in green.

## 2026-08-14 — `fli ws:exports` — the published surface, committed

`exports.snapshot.md` at the workspace root: per publishable package, the
top-level entries its tarball actually contains, every `exports` subpath, `bin`,
`main` and `types` target marked with whether that tarball holds it, and the
peer ranges naming a sibling. `--check` byte-compares; the `snapshots` CI phase
reruns it from the header the file carries.

`FJS-251` broke every npm install past 836 green Sierra tests, because an app in
this repo resolves a sibling to `packages/<name>/` and never to a `node_modules`
path. `scaffold` catches that class end to end in about seven seconds; this is
the cheap half — an entry point `files:` does not publish is decidable from the
tarball listing alone.

**The listing is asked of the packer**, `bun pm pack --dry-run` per package,
because npm's `files:` semantics are their own thing (a bare directory name
means everything under it; README, LICENSE and package.json are always in) and a
second implementation would disagree with the publish exactly when it mattered.
**A `*` in an `exports` target is Node's subpath pattern and matches across
`/`** — read as a shell glob, the first run reported `@frontierjs/ui` as
shipping none of its 64 components and `@frontierjs/css` none of its stylesheets.
Top-level entries only, and no versions: a snapshot that moves on every commit or
every release is one nobody reads on the change that mattered.

## 2026-08-14 — the deploy checks ask litestream's version, not the process table

`FJS-243`, the checking half. Three commands ran `pgrep -x litestream` and
reported the answer as *replication is healthy*. It is not the same question.

litestream 0.3.x cannot parse the STRICT tables litestone emits. Pointed at a
litestone database it starts, prints `replicating to:`, and then loops forever
on `malformed database schema … near "STRICT": syntax error` **without ever
exiting** — a live process, an empty replica, and every check here agreeing it
was fine. Demonstrated on this machine, which carries v0.3.4.

`litestreamStatus()` in `deploy/_module.md` is now the one owner, and the three
callers grade it differently on purpose:

- **`01-preflight`** — a warning. Blocking a deploy on the replication tool is
  worse than the state it describes, and an operator mid-incident needs the
  deploy. It cannot be quiet, though: the defect was a check that called this
  healthy.
- **`deploy:status`** — says it plainly, with the version.
- **`deploy:doctor`** — a **failure**. An absent litestream is optional; a
  running one that replicates nothing is a believed backup that does not exist.

A version it cannot read reports UNKNOWN, never fine — assuming is what the old
check did. `LITESTREAM_MIN` is a hand copy of litestone's floor in
`src/tools/replicate.js`: change one, change both. The CLI cannot import it,
because litestream reaches the server as a binary.

**Two regressions from the `FJS-250` narrowing surfaced here, both invisible to
the parse sweep.** A command using a `_module.md` helper compiles whether or not
the module defines it, so only running one says anything:

- **`context.config` was initialised inside the steps runner**, so every command
  in `commands/deploy/` had it by accident. Narrowing the inheritance left
  `deploy:doctor` throwing `undefined is not an object` on
  `context.config.abort = true`. It is per-run scratch and now exists for every
  command — reading your own scratch object should not require being a pipeline.
- **`deploy:rollback` and `deploy:setup` reached their steps by *setting*
  `context.config.stepsDir`**, which only worked because they inherited `_steps/`
  first. Setting stepsDir redirects a steps run; it does not start one. Both now
  declare `steps:` in their frontmatter.

**And steps are compiled with their namespace module now.** They were compiled
with an empty one, so a helper was reachable from the orchestrator and
`is not defined` from the step beside it — which pushes shared logic into
whichever step needs it first and leaves the next to copy it. A step is the
deepest part of a namespace, not a stranger to it.

Verified by driving every deploy command against a fake `ssh` answering as a
server running v0.3.4, v0.5.16, nothing, and an unparseable version — all four
graded correctly at all three sites. Two new scenarios in `tests/zz-steps.test.js`
pin the runtime halves, each checked against a negative control.

## 2026-08-14 — `deploy:local` is a gate: it stops lying, and it can fail

`FJS-250`, found while building CI's `deploy` phase on top of this command.
Three defects, and each one on its own makes the command useless as a check.

**`_steps/` was inherited by every sibling in its directory.** `runtime.js`
attached `<dir>/_steps` to any `.md` beside it, and `commands/deploy/` still
carries the legacy CapRover steps. So `deploy:local` printed its own plan and
then ran them:

```
~ Would build: docker build -t demo:local -f deploy/Dockerfile .
·   [1/3] 01-api
~ ssh undefined "npm run deploy:api --prefix='undefined'"
✓ Deployed to undefined in NaNs
```

The command whose whole purpose is a safe local rehearsal claimed a deployment
that never happened. `deploy:status` and `deploy:logs` did the same.

**Only the directory's index is the orchestrator now.** A non-index command opts
in by naming the folder — `steps: _steps-docker` in its frontmatter — and a
declared folder that does not exist is an error, not a silent skip. Every other
steps folder in the tree (`db/import`, `db/reset`, `npm/release`,
`workspace/publish`) sits beside nothing but an index, so none of them moved.

**Every `deploy:local` failure path exited 0.** `log.error` writes a line and
nothing more; the exit code comes from a thrown error. So a failed health check
printed `✗ Health check failed`, returned, and the shell saw success — which is
the one thing a gate may not do. All four paths throw now.

**And `--port` had never worked.** The argv parser types a value by how it
looks, before the command's declaration is consulted, so `--port 7100` arrived
at a `type: string` flag as a number and was refused as *must be type string*.
Fixed at the owner — the value is coerced toward the DECLARED type and then
checked — which also unbroke `fli deploy:logs --tail 200`, the command's own
documented example, and `cloudflare:dns`.

Pinned by four scenarios in `tests/zz-steps.test.js` over a new
`tests/fixtures/sibling-steps/`, each checked against a negative control:
widening the rule back fails the sibling test.

## 2026-08-14 — `fli scaffold <Model>` is run against a real installed app now

`FJS-036`. The templates had been updated twice and never put through the command
that uses them. CI's `scaffold` phase packed the working tree, installed a fresh
app and built it — and stopped one step short of the thing the row is about:
growing the app.

It now runs `fli scaffold Note --fields 'title:string body:text'` against the
installed app and builds again. Four generated files across all three realms, each
named individually rather than trusted to the exit code — `fli scaffold` reports
success per file, so a step that wrote nothing would otherwise pass:

```
db/schema.lite                        model Note { … }
api/src/services/notes.service.ts     the plural accessor
web/src/resources/Note.mesa           PascalCase singular — Invariant 19
web/src/routes/notes/index.mesa
```

Two of those four names are Invariant 19 in executable form. The second build is
what makes them more than files on disk.

## 2026-08-14 — `auth:install` scaffolded an auth.ts that could not import

Found while aligning the identity ladder, by running the shape the command
writes rather than reading it. Three defects in one file, each of which fails at
the first `bun run`:

- `createFjsAuth` and `createFjsAuthPlugin` are not exported by
  `@frontierjs/auth` — the names are `createLitestoneAuth` and
  `createAuthPlugin`. `project/_module.md` detected an installed auth by
  grepping for the same two absent names.
- `createClient('./db/schema.lite', { … })` — `createClient` destructures a
  single options object, so the positional form passes no schema at all.
- `encryption: { key }` is not an option; the key is `encryptionKey`.

Also aligned with the schema the same command writes: the generated `getLevel`
graded `userType === 'admin'` while `schema.lite`'s row and field policies read
`auth().isAdmin`, so a level and a policy disagreed about who an administrator
is — silently, because a policy filters rather than refuses. The resolver now
grades standing, and the generated `auth.ts` projects the app's own meaning of
'admin' onto it once, in `sessionFields`.

Verified by running the generated shape end to end against real packages:
client boots, register and login work, `role: 'admin'` reaches the session as
`isAdmin`, and an admin can write another user's role while an ordinary caller
cannot.

## 2026-08-14 — `fli new --full` installs

`--with litestream` named a package that exists neither on npm nor on disk.
Litestream is a Go binary that runs beside the app on the server; it is not a
dependency, and listing it in `validExtras` put `@frontierjs/litestream` into
`FJS_VERSIONS` and therefore into the generated manifest. `--full` adds every
extra, so **`fli new --full` failed in both directions**: `--source local`
aborted before writing anything (no `packages/litestream`), and `--source npm`
wrote the dep and 404'd at `bun install`.

`--with litestream` is now recognised by name rather than dropped, so the flag
says where the thing went instead of calling it unknown:

```
⚠ "litestream" is a server binary, not a dependency —
  see `litestone replicate` and `fli deploy:setup` — nothing to add here.
```

Verified by scaffolding `--full` for real against npm and installing: 136
packages, nine `@frontierjs/*`, no litestream anywhere in the output.

The capability behind the flag is worth having, and `FJS-242` is what it needs
first — `litestone replicate` reads one database path out of a config file
`fli new` does not write, while a schema declares many. `litestone backup`
already resolves every declared database from the schema; replication has not
caught up.

## 2026-08-14 — the API and the web can be deployed to different machines

`fli deploy` had one `server` and one `path`: the web release and the API
container went to the same box, and per-target overrides moved an *environment*,
never a *side*. `deploy:rollback` has had `--web` / `--api` since it was written,
so the rollback half already assumed a split the deploy half could not express.

`api` and `web` may now each carry their own `server` / `user` / `path`, joining
blocks that already exist (`deploy.api` had port/health/dockerfile, `deploy.web`
had domain/keep_releases/ssl). Most specific wins and a silent side inherits, so
an unsplit config resolves exactly as it did:

```
deploy[target][side]  →  deploy[side]  →  deploy[target]  →  deploy
```

```
fli deploy              # both halves
fli deploy --api        # API only
fli deploy --web        # web only
```

**A lock is per machine+path, not per run.** Two apps sharing a server are two
locks; one app split across two servers is two. A run that cannot take the second
lock releases the first rather than stranding it, and `09-cleanup` releases every
lock the run took — a split that aborted after locking both otherwise left the web
host locked with nothing to clear it.

**Both hosts are SSH-checked before anything moves**, and **a split whose hosts
are on different commits is refused**: each side builds from source on its own
machine, so divergent checkouts ship two versions under one release name. That is
the failure this feature is most likely to cause, so it fails loudly rather than
silently succeeding.

The transport already assumed nothing about co-location — the browser client
takes an absolute `url`, and `/ws` is registered beneath the router (`app.http.ws`,
not `app.get`) so it never carried `apiPrefix` in the first place. What a split
does need is CORS: Junction's default is `origins: []` deliberately, and the
WebSocket upgrade is an HTTP request, so it needs the same allowance.

Verified against scaffolded apps: the resolution matrix (unsplit, per-target,
per-side, per-target-and-side, inherited, unresolvable) and all three scopes
driven through the real command.

## 2026-08-13 — the Dockerfile matches the layout the scaffold actually writes

`FJS-232`. `make:deploy`'s template copied `api/package.json`, `api/bun.lockb*`
and `api/tsconfig*.json`, ran `bun run src/server.ts`, and never copied `db/` —
against a scaffold that writes one manifest at the app root, `api/index.ts` as
the entry, and the schema under `db/`.

**The root `README.md` § Project Structure had already ruled it** (Invariant 3),
so the template moved, not the app:

```dockerfile
COPY package.json bun.lock* ./
COPY api ./api
COPY db  ./db
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
```

`db/` is load-bearing twice: the entrypoint migrates and the pre-swap backup runs
`litestone backup`, and both find the databases by reading the schema. `fli new`
now writes the `db:migrate` and `db:backup` scripts the entrypoint calls —
`--schema db/schema.lite` also fixes the migrations directory, since litestone
resolves it as a sibling of the schema. `deploy:doctor` checks the ROOT manifest
for `db:migrate` + `start`, and warns when the Dockerfile has no `COPY db`.

**Verified by building it**: the image builds, `bun run db:migrate` resolves the
schema and creates the database inside the container, the app boots and answers
its health endpoint. Running it is also what caught the doctor rewrite leaving a
dangling `apiPkg` reference — valid JavaScript, so the parse sweep passed it.

What the build could not prove is filed as `FJS-241`: a scaffold made against
local sources carries `link:` dependency specs, which resolve on a laptop and
fail inside an image. That is why this path had never been run end to end.

## 2026-08-13 — the app backs itself up

`FJS-239`. `05-backup` shelled out to `sqlite3` on the host for the pre-deploy
snapshot. Two things wrong with that, and the second survives fixing the first.

**The binary was never installed** — `deploy:setup` provisions docker, nginx, git,
bun, rsync — and the step is `optional`, so on a server this tool set up the
snapshot warned once and the deploy went on into `06-swap`, whose container runs
migrations in its entrypoint.

**And `deploy.db.file` names one file.** A schema declares as many databases as it
likes; `example` and `basecamp` both declare `main` plus an `audit` logger. So even
with sqlite3 present, the snapshot would have copied the rows and left the trail.

Both go away by asking the app instead of reimplementing it: `docker exec
{appId}-api … litestone backup`, run before the swap so it captures the OLD
container while it is still serving. `litestone backup` reads the schema and
copies every declared database — SQLite hot through `$backup`, JSONL/logger
directories beside them. No host binary. First deploy has no container and says so
rather than failing.

`fli db:backup` had the same bug and a worse one: it backed up `development.db` or
`test.db`, names the CLI invented — a litestone app's paths come from `database`
blocks in the schema. It delegates now too, and gained `--vacuum` / `--zip` /
`--db` from the thing it delegates to.

`sqlite3` stays in `deploy:setup`, because an operator on a box running SQLite
wants a shell against it — with a comment that no longer claims the pipeline needs
it.

Pointing the deploy at `litestone backup` is also what exposed `FJS-240`: it was
reporting a partial backup as a success.

## 2026-08-13 — the deploy pipeline, swept: a leaked lock, a rollback of working code, a backup that never ran

Four defects, all on the path `fli new` → `make:deploy` → `deploy`, all found by
reading rather than by anything failing. That is the finding underneath the four.

**A step that threw skipped the cleanup step written to run on failure** (`FJS-237`).
`09-cleanup` declares `runOnAbort: true` so a bad deploy still releases
`{serverPath}/.deploy.lock` — but the runner only honoured that for the abort
*flag*, and `07-health` sets the flag **and then throws**. The throw exited the
group loop, cleanup never ran, and the next deploy refused while naming a deploy
that had finished minutes earlier. Fixed in `core/runtime.js`: a throw now records
the error, sets `abort`, lets the loop finish so `runOnAbort` steps get their turn,
and re-throws afterwards — so the exit code is unchanged and `runOnAbort` finally
means *runs on abort or throw*, for every `_steps` command. Pinned by
`tests/fixtures/cleanup-on-throw/`.

**The health check polled a path the scaffold cannot serve, and rolled back
working deploys** (`FJS-238`). `healthPlugin()` registers through `app.get()`, the
one owner of `apiPrefix`, so a scaffolded app answers at `/api/health` — and
`make:deploy` wrote `/health`. Twenty seconds of 404, then `07-health` stopped the
new container and restored the old one, reporting a healthy API as a failed deploy.
The remedy it printed could not have fixed it either: `app.get('/health', …)` moves
with the prefix too. `make:deploy` now resolves `apiPrefix` from the app's own files
and writes the full path, naming where it read it. Three downstream copies of the
same blindness went with it — `deploy:doctor` warned on every prefixed app, and
`04-build-api`, `deploy:local` and `doctor` all defaulted `dockerfile` to
`api/deploy/Dockerfile`, a path `make:deploy` has never written.

**`07-health` now prints the URL it polled**, because a rollback that names nothing
reads as the application's fault.

**`deploy:setup` never installed `sqlite3`** (`FJS-239`, still open for its shape).
`05-backup` shells out to it for the pre-deploy snapshot and is `optional`, so on a
server this command set up, the backup warned once and the deploy carried on into
migrations with no snapshot — the one step whose purpose is to run before something
irreversible was the one not running.

Verified by scaffolding both app shapes into a temp directory and running the real
`make:deploy` and `deploy:doctor` against them.

## 2026-08-13 — the deploy pipeline installs dependencies before it builds

`fli deploy` never ran `bun install` — not in any of the nine steps. The API side
was covered by accident, because its Dockerfile installs inside the image; the web
side went straight from `git pull` to `bun run build` against whatever
`node_modules` the server happened to be carrying. A deploy that adds a dependency
therefore either built against the previous tree or died mid-build with the deploy
lock already held. `03-build-web` now installs at the project root first, with
`--frozen-lockfile`, which is the point of the step rather than a flag on it: a
resolve on the server would produce a tree the lockfile never described and nothing
downstream could say so.

Found by grading the pipeline against the twelve-factor build/release/run split,
which it fails in a larger way as well — see `IDEAS/deploy-plane.md` and `FJS-232`.

## 2026-08-13 — `fli api:routes`, and the scaffold stops installing CORS twice

Asks a **running** app what it serves, via the routes list `manifestPlugin` now
carries on `/manifest`. There was no way to ask before: the HTTP surface is
emergent — services auto-mount, plugins register their own — and `hasRoute()`
answers a matching question rather than an existence one, so a route in the
wrong place stayed invisible until something 404'd. `FJS-091`.

```
fli api:routes            # everything, service templates marked
fli api:routes --raw      # only what a plugin or the app registered
fli api:routes --method POST
fli api:routes --json
```

`manifestPlugin()` is now in the scaffold, because a command about a plugin
nobody configures is not a command.

**The scaffold no longer calls `cors()` by hand.** It also declared
`middleware.cors` in `config/junction.config.js`, and `cors()` both patches the
router's middleware and registers `OPTIONS /*` — so every scaffolded app ran the
CORS middleware twice and carried two identical wildcard preflight routes. Found
by running `fli api:routes` against a fresh scaffold, on its first outing. The
config entry is the one owner now; configure it by hand only when the app also
uses `csrf()`, which has to come after it. `FJS-225` is the framework half — a
duplicate exact route is registered in silence.

## 2026-08-12 — `fli check`: architecture rules, enforced as assertions

Ten rules over the file tree — model names, resource files, and the two
configuration lines whose absence is silent. `core/checks.js` is the engine;
`fli check --list` prints the table.

```
fli check
fli check --only resource-file-name,vite-strict-port
fli check --json
```

**The membership test is that a rule is silent when broken.** A rule whose
violation already raises an error belongs in the thing that raises it. So half
the table is FrontierJS invariants that no compiler enforces — a model name is
PascalCase singular, `src/resources/` holds `.mesa`, a resource file is named for
its model, one Resource per file — and half is hazards with a long memory:
`strictPort` absent from a vite config, and the body tag written inside a comment
in an `index.html`.

**`scripts/ci.mjs` imports the same module by relative path** and runs it as a
new `structure` phase over this repo's own apps and packages. Two
implementations of one rule is exactly how a framework ends up breaking rules it
publishes, so there is one, and it is loosened for the repo only where it is
loosened for every app.

**Six findings on the first run, four of them real.** The worst is `FJS-198`:
`packages/sierra/example/web/index.html` explained in a comment that the theme
goes on the body tag, so vite injected the built `<script>` and the stylesheet
*inside* that comment and the example's production build shipped no JavaScript at
all. The build succeeded and the file looked right. Also found `leads.mesa` —
lowercase, three Resources in one file — and two packages with a fifth markdown
file at their root.

The two that were not real became rules: a Resource over no model may take its
own service noun singularised (basecamp's `Hub.mesa` is `createResource('hub')`
and is correct), and a schema with neither `api/` nor `web/` beside it is a
fixture rather than an app that got the layout wrong.

**An exception is a named entry with a reason.** There is no ignore comment;
`runChecks({ allow })` is keyed `'<rule>:<path>'`, and a stale allowance is
reported — an exception that outlives the thing it excused is an unenforced rule
nobody knows is unenforced.
