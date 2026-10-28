# cli (`fli`) — package map

**A markdown-native command runtime.** A command is a `.md` file: prose and
fenced code, compiled to JavaScript and run — one directory under `commands/`
per namespace. Scaffolds, deploy, the workspace/release commands and the port broker
live here.
`bun run test` (bun).

**`fli check` is the arch-test surface, and where the live-hazard catalog
executes** (`FJS-D133`). A rule reads the file tree, a dependency's shipped
`.lite`, the app's own source where the wrong spelling is a LEGAL spelling of
something else, and the NOTES against the tree — and what it may grade is a
claim with an AUTHORITY in the tree, never what a paragraph argues. **`fli
doctor` is a different question and stays one**: whether this MACHINE can run
fli.

---
## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `bin/fli.js` entry · `core/compiler.js` compiles a `.md` command · `core/registry.js` finds commands (project source overrides package in silence) · `core/runtime.js` runs steps, builds `$` and owns the journal hook.
- `core/checks.js` is `fli check`; the rules sit in `core/checks/*.js` (`app.js`, `repo.js`, `api.js`, `data.js`, `ui.js`, `lib.js`) and `core/register-check.js`, `core/invariants.js` enforces the root Invariants, `core/hazards.js` the realm skills, `core/done.js` is `fli done`, `core/proofs.js` reads `DRIVES.md`.
- `core/ports.js` is the port schema · `core/app-config.js` is what a scaffolded app is GIVEN; `core/scaffold/{app,api,web}.js` write it and `core/scaffold/surface.js` is what every UI surface's scaffold shares (`FJS-D1577`) · `core/crud-templates.js` is the one generated CRUD page.
- Deploy: `commands/deploy/` with its `_steps-*` directories (a step file's prefix is `\d+[a-z]*`), `core/deploy-plan.js`, `core/deploy-image.js`, `core/vendor.js`, `core/release.js`, `core/journal.js`.
- Workspace snapshots: `core/snapshots.js`, `core/export-pairs.js` (`ws:exports`), `core/surface.js` (what is REACHED), `core/repo-map.js` + `core/repo-atlas.js`, `core/app-entry.js` (the committed API surface). `core/html-page.js` frames every generated page (`FJS-D1582`).
- `web/index.html` is the GUI, built from strings; `console/` the TUI screens; `test/browser/specs/` their drives.

## What bites here

The dozen that bite most; the full catalog is `docs/hazards.md`, read it before
touching deploy, snapshots, the atlas or a check rule.

- **Never shell out to a bare `fli`** — that is the GLOBAL install, not this checkout. Call the module, or `bun bin/fli.js`.
- **A `process.env.X` assignment reaches a `node:child_process` child but not a `Bun.spawn` one** (`FJS-1378` for bun 1.4.2's state). Pass `env` to the spawn.
- **`context.exec` refuses an option it does not have**, and the child's stdout is read through its own `.stdout`, not a shell capture.
- **A clean compile is not proof of valid JS** (Invariant 15) and **a parse is not a run** — a free identifier parses clean and throws at the first call. Compiler tests parse AND execute what they emit.
- **A command body's `$` is Bun's shell, not bash**, and a `<script>` block sees `$` only as its parameter: module scope, no `log`, no `echo`.
- **A fenced block in a `_module.md` renders as an empty heading.** Module prose only; code goes in a command file.
- **A git question asked from a package directory answers repo-wide**; scope with a pathspec.
- **A narrower command source overrides a wider one in SILENCE** (project over package), and two commands claiming one alias is a bug the registry warns on.
- **`core/checks.js` and `core/typecheck.js` each have two callers and one is `scripts/ci.mjs`.** A change there needs `node scripts/ci.mjs --fast` too.
- **A rule belongs in `fli check` only if it is SILENT when broken, grades a claim with an AUTHORITY in the tree, and does not OVER-fire** — a false positive costs more than a missing rule. A rule proposed off a hazard paragraph is a lead, measure before writing.
- **`test` in `package.json` is an explicit file list**, so a new test file runs nowhere until named; `test-files-run` is the rule that catches it.
- **`fli deploy`: a step stops the pipeline two ways** (abort vs stop, different verdicts); `serving` is the last transition that SUCCEEDED; only `/db` survives a container swap; `revert` and `rollback` stay two commands.
- **`.dockerignore` without `**` protects the context ROOT only.**
- **`fliTmpRoot()` in `core/utils.js` is where a compiled command lands**; a test that writes elsewhere leaks across runs.

---

## The context in this package — `$`

**One, per command invocation** (`FJS-D03`). `$` is what a compiled `.md`
command body is handed: the command in progress, callable as the shell
(`FJS-D593`, `FJS-D594`).

| | |
| --- | --- |
| Created per | **one `fli` invocation**; a step gets its own callable copy over the same `$.config` |
| Carries | the resolved project (`$.paths`, `wsRoot()`, `wsRepo()`), git access (`$.git`), execution (`$.exec`, `$.stream`, `` $`…` ``), output (`echo`, `log`, `chalk`, `tty`), and config |
| Is NOT | a request. Nothing here is on behalf of a remote caller, so there is no principal, no `auth`, no `query` |

The spelling is shared with Junction's `$` (the call in progress) and Mesa's
(the component runtime) and the concept is the same one — *the thing in
progress* — in each realm's own terms. It is a parameter, never an ambient:
one function, one argument, so two concurrent web runs cannot see each other.

---

## Proving a change

`bun run test`. A change to a scaffold is proved by scaffolding into a temp
directory and running what comes out. A change to `core/checks.js` also needs
`node scripts/ci.mjs --fast`, because the repo is its other caller.

**The codegraph page has its own drive and it is not in `test`**: `bun run
test:browser:codegraph` writes the page and opens it. `test/codegraph.test.js`
asserts its script PARSES, which is a different question from whether it runs —
a `const` read before its declaration and a backtick in a comment inside the
`String.raw` block each render a page that draws its tiles and has a dead
control on it.

**The GUI has its own drive and it is not in `test`**: `bun run test:browser`
(`test/browser/`, one spec per panel, over mesa's harness by relative path)
needs Chrome. A change to `web/index.html` is proved there and nowhere else —
the page is built from strings, so every class in it is a claim about a
stylesheet nobody linked at author time, and a missing one renders as unstyled
markup that a test asking what the page SAYS reports as passing (`FJS-545`'s
shape one layer up).

**The console's screens have a drive of their own**: `bun run
test:browser:console` starts `fli gui` under a pty and opens the same
process's `/console/` in Chrome, then diffs the two frames row by row. For
`:live`, `:call`, `:data` and `:ask` it boots an app of its own with devtools on 7503,
and puts a stand-in `claude` first on the PATH for `:ask`. A change to
`console/`, `core/console.js`, `core/live-view.js`, junction's devtools or
`fli gui`'s terminal path is proved there; it needs Chrome and util-linux
`script`.

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
advisories.js AGENTS.md amend.js api.js app-config.js app.js App.mesa app-schema.js archive.js 
argv.js ask-claude.js ask-context.js ask.js ask-plugin.js assets.js bench.baseline.json bench.js 
blast.js bootstrap.js build-check.js bun-fence.js cat.js chain.json checks.js check-worker.js 
children.js ci-log.js ci.mjs CLAUDE.md claude-usage.js clipboard.js close.js cloudflare-dns.md 
cloudflare.js cloudflare.test.js codegraph.js codegraph-page.js color.js command-parse.js 
compiler.js config.js config.json console.js Console.mesa crest.js crud-templates.js data.js 
ddl.snapshot.sql decide.js decide-walk.js decisions.js DECISIONS.md deploy-image.js deploy.lite 
deploy-plan.js deps.js desktop-surface.js dev-run.js diagnose.js docker-context.js doctor.js 
done.js edge.js effects.js env-health.js env-preflight.js export-pairs.js exports.snapshot.md 
extension-surface.js file.js file-kind.js file-tree.js find.js flags.js fli.js fli.json 
frontier-member.js fs.js functions.js git.js git-history.js git-status.js global-env.js guarded-write.js 
guarded-write.mjs guard.js HANDOFF.md hazards.md health-target.js image.js index.html index.js 
install-preflight.js intent.js intent-recognizer.md ISSUES_ARCHIVE.md ISSUES.md journal.js 
journal-runner.mjs junction.config.js latency.js lib.js live-view.js lock.js machine.js 
map-model.js map-reference.js map-view.js _module.md new.md next.js one-console.md open-url.js 
outline-hint.mjs outline.js package.json parser.js pause.js pgp-words.js plan.js PLAN.md png.js 
ports.js preflight.js preview.js proofs.js prose.js prove.js proxy.js publish-view.js qr.js 
register-atlas.js register-check.js registers.js registry.js release.js release-preflight.js release-view.js repo.js 
repo-map.js repo-rings.js repo-terms.html repo-work.js repro.js requires.js revert.js runnables.js 
runtime.js scaffold-build.mjs schema-apply.js schema.lite scope.js scope.test.js seams.js server.js 
shell.js shortcuts.js signatures.js site-surface.js stand-in.mjs tell.js tell-worker.js terms.js 
text.js tidy.js tldr.js tree.js tty.js typecheck.js typecheck.mjs ui.js utils.js vaultwarden.js 
vendor.js verbosity.js vite-ask-client.js vite-ask.js VOCABULARY.md web.js widget-surface.js 
wireframe.js wireframe.md wireframe.test.js workbench.ts zip.js 
-->
