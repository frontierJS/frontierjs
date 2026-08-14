# Changes — @frontierjs/cli

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
