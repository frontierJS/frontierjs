# Changes — @frontierjs/cli

## 2026-10-09 — `fli desktop:install --release`: the launcher opens the release shell

Without the flag the entry ran `desktop:run --no-build` and so always opened the debug binary, even after `desktop:run --release` had built a release one beside it. `--release` writes `desktop:run --no-build --release` into Exec and refuses when no release binary exists, naming `fli desktop:run --release`. The default is unchanged. `desktopLauncher` in `core/desktop-surface.js` takes `release`. Proof: `test/desktop-surface.test.js` § what desktop:install writes, 22/22. On basecamp, `--release --dry` refused with no release build present, and the plain `--dry` still writes `desktop:run --no-build`. After `bun run build:desktop -- --release` (3m44s, a 9.5 MB binary against the debug one's 172 MB), the real install replaced basecamp's entry with the `--release` Exec, and `desktop-file-validate` accepted it. Not proved: a click on that entry opening the window.

## 2026-10-08 — `fli advise --strict` (`FJS-1825`)

Passes litestone's new `--strict` through, so a CI step or a grading harness gets exit 1 on an error or warn rule and never on a suggestion. Plain `fli advise` still exits 0 whatever it prints; the command page says why that 0 is not *clean*.

## 2026-10-08 — `threat-row`: every `THREATS.md` row names a test that is in the tree (`FJS-D656`)

A repo-scope rule, severity error. It reads the table in the root `THREATS.md` whose header has a *Proved by* column and fails a row that names no test there, a path that is not in the tree, or a path that is not a test (graded by `kindOf` in `core/file-kind.js`). A dead path in *Enforced at* is left to `doc-cites-dead`. A tree with no `THREATS.md` skips. Proof: `test/checks.test.js` § threat-row, 3/3, and the rule over this repo answers no findings across the eleven rows.


## 2026-10-08 — `fli desktop:dev`: the desktop window on the dev server, with HMR

A debug shell now loads `FJS_DESKTOP_URL` instead of the bundled page when the variable is set, and `desktop:dev` sets it to the screens' dev server: the wrapped surface's (`wraps`) or the desktop surface's own, on the port `appPorts` gives it. A release build reads neither this nor `FJS_DESKTOP_PROBE`. It is an environment variable rather than tauri.conf.json's `devUrl`, because a `devUrl` makes every debug build load the server, `desktop:run`'s and `verify:desktop`'s included. The page's origin is then the dev server's, so a CORS or same-origin fault shows only under `desktop:run`, and the command's help says so. The build compiles the shell only, unless `desktop/dist` is missing (tauri-build needs it), and then all of `deploy/build.mjs` runs. The API and the dev server are reused when something answers, and otherwise started and then stopped when the window closes. `ensureServer` / `stopServer` / `surfaceRow` in `core/desktop-surface.js` hold the start-or-reuse step, and `desktop:run` now uses them for its API rather than its own copy. Proof: `test/desktop-surface.test.js` § what desktop:dev reads, 24/24. On basecamp, the rebuilt shell requested the served URL with the variable set and nothing without it. A full `fli desktop:dev` started the API and Vite, opened the window, and an edit to `web/src/routes/_module.mesa` logged `vite:hmr [self-accepts]` followed by the window re-fetching that module. Closing the window freed 8120 and 8020. Not proved: that the swapped screen looks right — the window cannot be read from outside.

## 2026-10-08 — the deploy journal runner waits out a held lock (`FJS-2081`)

`core/journal-runner.mjs` sets `busy_timeout = 5000` before the WAL switch. Its wait was bun:sqlite's default of zero, so a write landing while another process held the lock on `deploy.db` answered `SQLITE_BUSY` at once and failed the deploy. It is the order litestone's `applyWal` owns (`FJS-D646`), restated because the runner imports nothing but `bun:sqlite`. Proof: `test/journal.test.js` § a write waits out a lock another process holds, which holds the lock from a second connection for 300ms and fails with `database is locked` when the pragma is removed.

## 2026-10-08 — `fli desktop:install`: the desktop app in the OS launcher

Linux only. It writes one XDG desktop entry, `~/.local/share/applications/<identifier>.desktop`, and `--remove` takes it out. The entry runs `fli desktop:run --no-build` from the app root rather than the binary, so a click starts the API when nothing answers, as the terminal command does. It carries the installing shell's PATH (absolute entries only, deduplicated), because a launcher starts the process without rc files and bun is otherwise not found. Name, identifier and icon are read off `shell/tauri.conf.json`. `StartupWMClass` is the crate name, measured with `xprop` as the WM_CLASS the shell's window carries; the identifier is not that class. The entry is refused unless `desktop-file-validate` accepts it, and a missing binary is refused with `desktop:run` named. `desktopLauncher` is in `core/desktop-surface.js`. Proof: `test/desktop-surface.test.js` § what desktop:install writes. On basecamp, the written entry passed `desktop-file-validate`, and its Exec line run under `env -i` opened the Basecamp window (with `--no-api`, because no API was running and starting one would have booted a second Basecamp on the live database). Install and `--remove` were round-tripped against a scratch `XDG_DATA_HOME`. Not proved: anything outside GNOME on X11.

## 2026-10-08 — `fli desktop:run`: build the desktop app, start its API, open the window

A new `desktop:` namespace (alias `fli desktop`). By default it runs the app's own `desktop/deploy/build.mjs`, since the screens are compiled into the binary and an old build shows old screens. It then reads `api` from `desktop.config.js`. If something already answers there, it uses it. If nothing does and the origin is loopback, it starts the app's `api` script on that port (`FLI_PORT_BE` and `PORT` both set, since basecamp reads `PORT`), in its own process group. Then it opens the shell. Closing the window or pressing Ctrl+C stops an API the command started; one already running is left alone. Flags: `--no-build`, `--release`, `--no-api`. `desktopBinary` (named for the crate in `Cargo.toml`) and `desktopApiTarget` are in `core/desktop-surface.js`, and `$.paths.desktop` is new. Proof: `test/desktop-surface.test.js` § what desktop:run reads; basecamp's real window opened through it against the running API, with a probe reporting `tauri://localhost/` and closing it. A scratch app showed the API started, answered the window, and was gone after both a normal close and Ctrl+C.

## 2026-10-08 — `required-system-unfilled`: a required `@system` column nothing fills, under a service serving create (`FJS-1825`)

A required `@system` column with no `@default` is out of create-mode `required`, so no form asks for it and a page sending it is refused by name; where no code fills it, every create is refused at the Data boundary. Litestone's `advise` already warned on the column under this id and cannot see code, so a schema-first build read past it. The new rule, a warning, reports such a column when a service over its model serves `create` (no `methods:`, or one naming `create`) and no non-test file under `api/` fills it: `system: [...]` naming it, `ctx.system.add(...)` naming it, or an `asSystem()` create of the model naming it. A model with no service yet is graded on nothing, for `transition-methods`' reason (`FJS-1778`). A scalar list is skipped (`FJS-2044`). Over the real apps: `example` and `basecamp` are silent (basecamp's `ApiKey.tokenHint` is filled by `system:`, and `Payslip`'s figures sit under a `methods: ['find', 'get']` service). In base44's derived apps it names `09-posthog`'s `Project.apiToken` and `Event.occurredAt` and `07-lago-stripe-billing`'s `UsageEvent.occurredAt` and `Fee.amount`. `test/checks.test.js` § required-system-unfilled; the clean tree gains `Lead.code`, filled by a hook, so the rule runs there.

## 2026-10-08 — `fli db:migrate --rename Model.old=new` and `--operations <file>` (`FJS-D603`)

Passed through to `litestone migrate create` / `migrate dev`, so a renamed column keeps its values.

## 2026-10-08 — Invariant 7's enforcer names `@hashed` and `@personal` (`FJS-D657`)

`core/invariants.js` § 7's *Covers* now matches the widened invariant: `[personal]` for `@personal`, and no `@hashed` digest in any entry. `invariants.snapshot.md` is regenerated.

## 2026-10-08 — scaffolds import the Resource from `@frontierjs/sierra/resource` (`FJS-D650`)

`fli make:model`, `fli admin:generate`, `fli web:route`, `fli new` and the tutor steps now write `@frontierjs/sierra/resource`, since sierra renamed the subpath and kept nothing for `./junction`. Proof: `test/generated-mesa.test.js`, `test/checks.test.js` and `test/ask.test.js` pass; the full suite's only other failure was a tty timing test that passes alone.

## 2026-10-08 — `deploy:doctor` checks `.env` is gitignored; templates import junction's batteries by subpath (`FJS-D639`, `FJS-D642`)

`fli deploy:doctor` fails a `.env` that `git check-ignore` does not ignore. The server pulls from git, so a tracked `.env` deploys its secrets. This is the one check from the deleted `junction setup audit` that `fli` had nowhere else (`FJS-D647`). It was driven both ways in a scratch repo. The backfill stub, `backfill:install`, `notifications:install` and the notify tutor now write `@frontierjs/junction/backfill` and `@frontierjs/junction/mail`, since junction's main entry re-exports no battery.

## 2026-10-07 — `tutor:live` and the scaffolds say *broadcast*, not *publish* (`FJS-D631`)

Junction's `publish()` hook is `announce()`, and the lesson text, `make:model`, `make:scaffold` and `project/new.md` call the thing that goes out on a channel a *broadcast*. `tutor:site` keeps *publish*, which there means what a static build ships. No generated code changes: the scaffolds emit `channel:`, never the hook.

## 2026-10-07 — `fli check` grades the `src/` layout (`FJS-1888`)

`app-layout` reported a surface in the wrong place and nothing about where a file sits inside one, so `FJS-D625`–`D627` were prose. It now warns on six things, each a path or an import: a module loose in `web/src/` other than `main.js`, `App.mesa`, `datetime.js` and declaration files; a `.mesa` outside `routes/`, `resources/` and `components/`; `app.get` or `app.post` with a `/` path outside `api/src/routes/`; a file without the loaded suffix in `services/`, `jobs/` or `notifications/` that a file in another directory imports; a `core/` file that imports junction's `Plugin` type or exports `(app: App) =>`; and a relative import from one surface's `src/` into another's. `srcLayoutFindings` in `core/checks.js` is the one place, called from the rule rather than registered beside it, so one baseline ceiling covers all six. Basecamp carries a ceiling of 11 for what it already holds. `test/checks.test.js` gained one case per rule and the `CLEAN` fixture's `.mesa` moved from `pages/` to `components/`.

## 2026-10-07 — `make:scaffold` links the list from the layout's nav (`FJS-1808`)

The scaffold ended on *Add a nav link to your layout* and nothing added one, so in 0 of 21 apps the base44 stressor generated did the page after sign-up reach a model's list. It now writes the link into the layout's `<nav aria-label="Main">`: `withNavLink` in `core/crud-templates.js`, with the list page's own URL and heading, behind `{#if session.user}` where the layout signs people in, as `fli new`'s Users link is. A second run adds nothing, and a layout with no main nav is left alone and named in the summary. `generators-run.test.js` runs the scaffold over both layouts `fli new` writes, read out of `new.md`, and compiles the result.

## 2026-10-07 — `fli new --widgets` scaffolds whole, and the first commit holds the initial migration (`FJS-1900`, `FJS-1901`)

`fli new --widgets` named its starter widget `Hello` under an empty prefix — the tag `<hello>`, which `scaffoldWidgetSurface`'s guard (`FJS-819`) refuses — so the scaffold stopped after its base files. The starter is now `HelloWidget` (`<hello-widget>`), in `new.md` and as `scaffoldWidgetSurface`'s default. The git step ran before the initial migration was written, so a fresh repo opened with `db/migrations/` untracked; it now runs after it. Both found by the ELA stressor's first command. `test/new-scaffold.test.js`.

## 2026-10-07 — `fli check` reports a File column no FileStorage stores (`FJS-1898`)

`fli new`'s `db.ts` installs only the gate, so an app that declares a `File` column parsed, migrated and passed `fli check`, and its first upload was refused. **`file-column-storage`** (warn, app) reports each `File` or `File[]` column in `db/` when no source in the app calls `FileStorage(` or declares a plugin with `fieldType = 'File'`. The finding is on the column's line and says where the plugin goes. Comments are blanked first, so a comment that only mentions `FileStorage` is not counted as installing it. The template is unchanged: `FileStorage` with no provider throws at boot outside development, so wiring it into every app would break production for apps that have no `File` column. In the base44 stressor it reports JazzHR's `resume`, Notion's `cover` and Ghost's two columns, and nothing in `example/` or Basecamp. `test/checks.test.js` § *a File column has a FileStorage to store it*; the clean tree gains `Lead.brief File?`, so the rule runs there instead of being skipped.

## 2026-10-07 — the web runner's busy button announces itself

`web/index.html` added `.loading` to the run button and never set `aria-busy`, so the spinner was drawn and nothing told a screen reader. It now sets and removes `aria-busy`, which is also what draws the spinner since `@frontierjs/css` dropped the class.

## 2026-10-06 — a generated CRUD page links the URL its directory is served at, so a two-word model's pages are reachable (`FJS-1821`)

Sierra's scanner serves a static route segment lowercased, and `make:scaffold`, `make:route --resource` and `admin:generate` linked the directory as written — `routes/searchIndexes/` got `href="/searchIndexes/create/"`, which is the 404. `routeSegment` in `core/crud-templates.js` is now the one answer to what URL a generated directory has, and every generated link goes through it: `resourceRoutePage`'s `basePath`, the admin's `_routes.js`, nav, dashboard cards, page `basePath` and its summary lines (the layout's `models` entries carry an `href`). `make:scaffold` no longer keeps its own copy of the three pages; it writes what `resourceRoutePage` returns for `<plural>`, `<plural>/create` and `<plural>/[id]`, and its `toLabel` went with it. The directory keeps the service's spelling. `test/generators-run.test.js` executes `make:scaffold SearchIndex` and `admin:generate` over a `SearchIndex` app and grades every absolute link they wrote.

## 2026-10-06 — the scaffold uses css's Grid; the viewer and the rings map rename their `.band` (`FJS-D621`, `FJS-D622`)

`fli new` wrote two hand copies of an auto-fit grid into the home and account routes, `--grid-min` and all; both now use `@frontierjs/css`'s `.grid`, and the account route keeps only its margin. `fli project:view`'s realm stripes were `.band`, which css now owns as a full-width page stripe with negative margins — they are `.realm-band`. The rings map's clickable circles are `circle.ring-band` (`.ring` was taken by the orbit drawing).

## 2026-10-06 — `fli db:backup` writes a new directory each run, and `fli db:restore` puts one back (`FJS-1786`, `FJS-1784`)

`fli db:backup` passed the fixed `db/backups/` to `litestone backup`, so every backup overwrote the last. It now passes no destination, so litestone writes a new `db/backups/<stamp>/` beside the schema. It takes an optional `dest` and passes `--schema`. The `db:backup` script that `fli new` writes into an app drops the fixed directory too. **`fli db:restore <dir> [--force] [--db <name>]`** is `litestone restore --from-backup`. `fli db:migrate` changes no code: litestone's apply now refuses a file whose DESTRUCTIVE box says `Accept data loss: no`, so the command stops at exit 1 after creating such a file, and the `db:` list says so.

## 2026-10-06 — `transition-methods` counts a move a service serves, and grades no model before its service exists (`FJS-1778`)

Junction now serves every declared move by its own name on any service over the model (`FJS-1255`), so a service with no `methods:` list reaches every move and a list reaches the moves it names, which the either-spelling test already counts. A model with no service under `api/` is graded on nothing. The schema is written first and the generator writes the service after it, so the rule refused every machine until code existed, and the only schema-side reply was deleting the machine. Still reported: a move that a `methods:` list (or `'readOnly'`) leaves out and nothing else names, and a `transition()` naming a move the schema does not declare. Five cases in `test/checks.test.js` § transition-methods. The helper the older cases share now declares a narrow `methods:` list, so they still grade the literal spellings.

## 2026-10-06 — generated list and detail pages draw a button per move (`FJS-1433`)

`make:scaffold` and `admin:generate` pages had no way to take a `@@transitions` move. `core/crud-templates.js` now draws one button per move each row's state allows, in the list's row actions and above the detail page's form, from `resource.transitions(row, session.level)` when the page runs — the template names no move, state or column, and a model with no machine draws nothing. A `@system` move gets no button; a gated move the level cannot make is drawn disabled. A button calls `resource.mutate(id, { [field]: to }, () => service.invoke(move, id))`, so every view of the row moves at once and a refusal is put back and shown in the page's Alert. A scaffold page grades against `session` from `@frontierjs/sierra/junction`; the admin keeps its `_session.js`, and its detail page now watches the level once whatever `gate` says. `test/generated-mesa.test.js` § *the moves a row may make*, plus the admin detail page compiled and parsed.

## 2026-10-06 — `project:map --as=serve` draws the state machines and walks the Warden

Two panels in the served map, beside `schema`.

**machines** draws each `@@transitions` column as a graph laid out from the schema. Nothing is placed by hand. A move's line says who makes it: a caller at the update level, only a higher level, the app (`@system`, or anything graded at 8), or a date (a `@@commitments` entry, including one declared on another model). The entry state, the final states and a state nothing moves into are marked. Clicking a move opens it in words: who may ask, the declaration, the service method of the same name and the channel it is announced on. Jobs and notifications are counted but not drawn, because neither declares the move it makes.

**warden** puts one model through the nine layers of `litestone/docs/warden.md` for a caller level picked from 0 to 8. It shows the gate per operation, the row policies, the protected fields, which moves that level may make, and the announce channel. Under the table, every model shows read · create · update · delete at that level.

- **The map carries `access`**, the output of `litestone access --json --stdout`. The JSON Schema says only that a model has row policies, never what they admit, and it has no field protection. The map shells out for it as it does for the schema, and a failure degrades to a panel saying why.
- **The layout is hand-rolled**, so the page still needs no network. A state's column is its distance from the entry and the final states share the last column. A forward move takes a slot in each column it crosses, with every from-state converging on one label. A move within a column turns at a label in the gap beside it, and a move backward arcs over the top.
- **`test/viewer-page.js`** is the page loader `viewer-issues.test.js` had inline, now shared. `test/viewer-machines.test.js` grades `buildMachines`, `layoutMachine` and `wardenAt`, with each negative paired with a positive. Mutation-checked: a gated comparison off by one fails two tests, and a label put in a state's column fails the overlap test.

## 2026-10-06 — `fli ws:atlas --as=rings` writes the work map beside the rings and links it

`core/repo-work.js` draws how work moves through the registers on one page. It shows where defects and ideas come from, the three register files, the issue loop through `/fix-next` and `fix:loop`, and the decision loop through `/frame-next` and `fli decide`. Along the bottom is what keeps them honest. Each box is clickable for its command, its file and today's count.

The rings run writes it as `repo-work.html` beside `repo-rings.html`. It is gitignored for the same reason the rings page is: it counts the registers. The rings home path and the project ring link it.

- **Only where the project has the `fix-next` skill.** Elsewhere there is no page and no link, because a map of loops a project does not run sends somebody after commands that are not there.
- **The counts are `fli next`'s and `fli decisions`'s**, read through `next.js` and `decisions.js`. The fix loop's figures come from `~/.fli/fix-loop.jsonl`, counting finished attempts and not the line that opens one.
- **Written in `@frontierjs/css`.** The stylesheet writes no hex (tested). The classes the package also defines are spelled `wk-`.

`test/repo-work.test.js` runs the page's script against a stubbed document. It clicks every box and checks the inspector answers with that box's entry.

## 2026-10-05 — a tutor lesson re-run in a kept workspace replays its facts again (`FJS-1769`)

`openTutor` handed `makeRecorder` its context under the key `$`, which it does not read, so the journal recorded no step's facts and a replayed step handed nothing on — every lesson's second step refused with *this step needs appDir* on a re-run. It passes `context: $`.

## 2026-10-05 — `fli deploy`'s edge is Caddy, and the target is an ssh destination (`FJS-D598`)

**Caddy replaces nginx.** `deploy:setup` installs Caddy as the `caddy-api` unit, the same one a fleet machine's enrollment installs. `_steps-setup/05-caddy` writes this app's routes into Outpost's `ingress` server through the admin API. It reads the whole config, merges with `applyEdge` and writes back with `If-Match`, retrying on a 412. A hostname another route holds is refused. Route ids are `fli-<app>` and `fli-<app>-api`.

- **Certificates are Caddy's.** `06-ssl` is deleted, and a `deploy.<side>.ssl` key is refused by name.
- **No reloads.** `08-release-web` and the web rollback are the symlink swap alone, with no `nginx -s reload`.
- **The pause guard** is a `file` matcher that serves the page with `status_code: 503`. `deploy:pause`, `deploy:status` and setup find it by `@id` (`guardProbeScript`). `vhostHasGuard` is now `edgeHasGuard`. `nginxGuard`, `GUARD_MARKER` and `vhostPath` are gone.
- **Per-app access logs** go to `/var/log/caddy/fli-<app>.access.log`, rolled by Caddy and excluded from its default log.
- **Setup warns** when nginx or a Caddyfile-driven `caddy.service` is running, and stops neither.

`pauseEdgeCycle` (CI `deploy` phase) now runs the step's own admin scripts inside a `caddy:2` container, beside a pre-existing Outpost route. It asserts:

- a stale write is a 412
- a hostname Outpost holds is refused
- one-origin and two-origin paths reach the app unchanged
- pause gives 503 on every name of the app and leaves the Outpost app at 200
- each route writes its own log

Removing `status_code: 503` makes it fail. `test/nginx-config.test.js` is gone; `test/edge.test.js` covers the routes, the merge and the admin read/write parsing.

**`--server` and ssh aliases.** `deploy:` declares `--server` once, as a namespace default flag. It takes an alias from `~/.ssh/config` or `user@host`, and replaces every server and user in the deploy block. `deployConfFor` in `_module.md` is the one reader, and all thirteen commands go through it. `deploy:status`, `:rollback` and `:unlock` had their own copies of the resolution, and a missing `path` crashed them; they now use `resolveDeployConf`.

`user` has no default any more. With none stated, ssh is handed the bare server, so the alias's User, Port and key apply. `deploy@` used to override them. Both resolvers return `host`. The scaffold's `your-server.com` is refused rather than dialed. A deploy block with no top-level server aborts instead of falling to the CapRover path. `make:deploy` writes `user` commented out.

**Module default flags carry their type and description, and `--help` lists them.** `runtime.js` copied only `defaultValue` from a `_module.md` `defaults.flags` entry, and `printHelp` never read the module at all, so a namespace-wide flag had no type and no help line. `withModuleFlags` in `core/flags.js` (the leaf, so the help path still imports no runtime) merges the whole declaration; a command's own declaration wins field by field. Both `runtime.js` and `printHelp` call it. An empty-string default no longer prints as `[default: ]`.

## 2026-10-05 — The rings page draws each package's icon

A package card and a package page's title now start with `brand/assets/icons/<folder>.png`. A package with no file there gets a crate drawn in its ring's color. A capturing `error` listener swaps the crate in, so `repo-rings.js` still reads no files.

The project's five cards and the pages they open also get icons. These are docs, invariants, decisions, issues and ideas. All 28 icons are cropped from the two sheets. Only a package added later falls back to the crate.

## 2026-10-05 — `docker-context.js` imports repaired

The `context` → `$` rename in the zx removal (`1de3d5e4`) also rewrote the filename `docker-context.js` to `docker-$.js` in three places, so `deploy`'s `04-build-api` step died with `Cannot find module …/core/docker-$.js` right after the build check. `04-build-api.md` (comment and import) and `tutor/_module.md` name the file again. A scan of that commit for any other `context` replaced by `$` inside a path or word found no more.

## 2026-10-05 — Command frontmatter is read by `@frontierjs/toolbelt/frontmatter`

fli had its own reader, and it read some blocks differently from sierra and mesa. `- name: x` came out as the string `name: x`. A ` # note` stayed in the value. `"a" b` was taken for a quoted string. `compiler.js`'s `splitFrontmatter` now reads through the kit and keeps its shape (`meta`, `body`, `bodyLine`, blank lines after the fence going with it). `parseYaml` and `coerceYamlValue` are gone. The other hand readers moved to the kit as well:

- `decisions.js`'s IDEAS reader
- the GUI's step list in `server.js`, whose regex returned `skip:` with its quotes still on
- `checks.js`'s skill-name rule
- the fence finders in `terms.js`, `vite-ask.js` and `outline.js`

`checks.js`'s unused `frontmatter(path)` is deleted.

**A refused block now says so.** It used to be misread without a word. Now it throws with the file and line in the message. The registry warns and leaves the command out, where its `catch {}` used to drop it with no message. `command-parses` reports it as a finding through `commandFiles`'s new `refused` entry.

Three shipped commands were outside the subset, and quoting fixed them:

- `fetch/json.md`: an unquoted `: ` in a description
- `git/stash.md`: an example with `"WIP: auth work"` inside it
- `ksite/update.md`: two examples whose ` # …` notes would have been cut off

A comparison of the old reader against the kit now agrees on all 450 `.md` files under `packages/cli`, `example/cli` and `packages/*/cli`, on 161 IDEAS papers and app `cli/` files, and on 9 files in `fjs-prototypes`.

**Writers use `frontmatterValue`**: `shortcuts.js`, `make:command`, `make:route`, `web:route`, `crud-templates.js`, `site-surface.js`, `desktop-surface.js` and `utils:note`. `compiler.js` re-exports it, so a command reaches it through `global.fliRoot`. `flags.js` no longer says the reader cannot take `[a, b]`, because now it can. `checks.js` imports `@frontierjs/toolbelt/frontmatter` too, so the one-import rule now reads *one package*.

Tests: `test/compiler.test.js` § frontmatter is the kit (a list of maps, a refusal that names the file and line, `command-parses` reporting it) and `test/shortcuts.test.js` (a description holding `: `, ` #` or `@` reads back as written). `bun run test` has 2 failures, both in `pause-journal.test.js`. Both are `FJS-1172`, which times out under load (load average 4.2 during the run) and touches no frontmatter.

## 2026-10-05 — `fli next` ranks by reach

A fourth tiebreak under severity: how many workspace packages depend on the row's package, counted through any package between, read from the manifests. +1 for every 3 dependents, capped at +3, which is below one citation (+4), so reach orders rows within a tie and never moves a row past one. Today toolbelt reaches 18, litestone 11, junction 10, mesa 8 and css 5. The largest tie in the register (S3 with no other term) went from 104 rows to 55. The manifest reader is `workspaceDeps(root)` in `core/runnables.js`, and `repo-map.js`'s `packages()` now takes its deps from it instead of reading them a second way. Tests: `test/next.test.js` checks a pair that counts reach through a package in between, and that the widest reach still loses to one citation. Docs: `register/next.md` § How a row is scored, `CLAUDE.md` layout.

## 2026-10-06 — zx is gone; `$` is the command in progress

`fli` runs under bun (`FJS-D593`): the three shebangs flipped, `bin/fli.js` refuses a node run by name, and `create-frontier` spawns `bun` rather than `process.execPath`. A compiled command's body is `run($)` — `$` is the context, callable as the shell tag — and the head imports `path` and `fs` and nothing else (`FJS-D594`); `flags, args, flag, arg, log, tty, echo, chalk, answers` are destructured from `$`. `core/shell.js` owns both: `commandContext()` builds the callable, and `` $`…` `` is `Bun.$` under fli's rules — captures unless `--verbose`, runs nothing under `--dry` through `log.dry` (the one dry owner, which `$.exec` and `$.stream` now call too), throws with the command named, `.lines()` an array. `tty.line(prompt, { default })` replaces zx's `question()` (`FJS-D595`, closes `FJS-1406`): raw mode is handed back for the line and taken again after, `--yes` answers the default, no terminal refuses by name. `core/color.js` is the one chalk; the seven chained sites are nested calls; `plainChalk` and the `globalThis.echo` shadow are gone, `echo` is on `$` in both modes. The `node_modules` symlink `fliTmpRoot()` kept for one bare import is gone with it (`FJS-166` stays closed by `test/project-root.test.js`'s bare-specifier assertion). Every `context.` in every command, step, fixture, generator and doc is `$.`; `sleep` is `Bun.sleep`; `make:factory --open` lends the screen through `tty.aside` + `$.stream`.

**`core/scope.js` + `command-resolves`** — the free-identifier check `IDEAS/shipped/scope-checking.md` costed: real lexical scopes over the unit the runtime loads, with the project's own TypeScript as the parser (no new dependency; no parser is a skip that says so). Its first sweep found 15 live `ReferenceError`s on a green tree — `log`/`echo`/`tty` reached from `<script>` helpers in `crypto:keygen`, `deploy:doctor`, `fli:validate`, `ksite:update` and the cli's own `hello:greet`, and a missing `randomBytes` import in `project/_module.md` — all fixed. `test/scope.test.js` holds this package's commands and `cli/src/routes` at zero.

**Measured, the four things no suite covers.** A running command (`fli hello:exec /tmp --dry`) is 51ms wall, average of 10, where `PROJECT_STATE.md` had recorded ~206ms for a running command with zx's ~110ms import in it; `fli list` is 42ms. `bun pm pack` + `npm i -g` into a prefix then made read-only runs `fli list` and `fli fli:doctor` with the session under `/tmp/fli-<digest>/` and no symlink. Two concurrent `POST /api/run` streams of a command that echoes three times with pauses each carry only their own lines. `fli make:factory Product --open` under a pty runs `$EDITOR` through `tty.aside` and returns.

Tests: `shell.test.js`, `scope.test.js` (new, in the `test` script), `tty.test.js` § line, `checks.test.js` § command-resolves; `stack.test.js` is bun-only now. Docs: README § The context, `CLAUDE.md` (three hazard lines), `PROJECT_STATE.md`, `IDEAS/bun-natives.md`'s *fli is node* premise reopened.

## 2026-10-05 — minimist dropped; `core/argv.js` reads the command line

`parseArgv(args, { bools })` replaces minimist and keeps all of its readings fli relies on. That includes numbers coerced by how they look, `--no-x`, clustered short flags with a value on the last one, `-p8080`, a repeated flag read as an array, and `--` ending the flags. Forty argv shapes were compared against minimist plus `dropUntypedBooleans`, with no difference. The one change is that an untyped boolean is ABSENT rather than defaulted to `false`, so `dropUntypedBooleans`, which only existed to undo minimist's defaulting, is gone. `BOOL_ARGV` moved to `argv.js`. Tests: `test/argv.test.js` (new, in the `test` script), with `short-flags` and `verbosity` moved onto the new parser.

## 2026-10-05 — an extension app no longer installs chokidar; vite `^8.3.2`

`extensionDevDeps()` follows jetty's peer ranges. jetty's dev server watches with `fs.watch`, so chokidar left the list, and vite moved to `^8.3.2` with jetty. `test/app-config.test.js` holds the two lists equal.

## 2026-10-05 — linkedom and turndown are optional peers

Only `ksite:fetch` uses them, yet every install of fli pulled both. They are now optional `peerDependencies` (and `devDependencies`, for the workspace). `core/peer.js` `loadPeer(name, forWhat)` loads one, asking the app first: a command shim resolves from fliRoot, and under bun's isolated linker a package the app added never appears on that path. When the peer is missing, the error names the command and the `bun add -d` line, rather than "Cannot find package" from inside fli.

## 2026-10-05 — stray `package-lock.json` deleted

An npm lockfile left over in a Bun workspace. `bun.lock` at the root is the only lockfile, and this one still pinned `css-what ^6` and `css-select ^5`, versions nothing here resolves.

## 2026-10-05 — the rings page opens the files it summarizes

Each key document's page, the specifications view and the ideas page now carry two links: *Open in VS Code* (`vscode://file/…`) and *View the file* (`file://…`). On the key documents list, the file name on each card is the editor link. The card became a `div` with `role="link"` so it can hold a real anchor. A click on an anchor skips the page's router, and Enter on a focused card works the way it does on a door. `renderRings(model, { root })` builds absolute links because `--out` can write the page anywhere; `ws:atlas` passes the workspace root. Without a root the links are relative to the page. Test: absolute with a root, encoded, relative without one.

## 2026-10-05 — the rings page ends on the specifications (`#specs`)

The *Brand new?* strip now ends with *Read the specifications*, after the field, and the field page's next step is the same view. It draws § *The spine* of `IDEAS/specifications.md` in rank: each entry's name, its note, and its number in § *The list*, then the bolded paragraphs after the list (what is next in line, where the first write-ups come from). The eyebrow says none is written. `collect()` gained `specs`, parsed from that section. It is an IDEAS paper and moves without the structure moving, so `structureOf` nulls it and neither committed page moves. With no spine there is no view and no link. Tests: the route renders over a fixture and this workspace, the entries come out in rank with no stray emphasis markers, home links it only when it exists, and `structureOf` drops it.

## 2026-10-05 — the rings page places FrontierJS among its neighbors (`#field`)

The *Brand new?* strip on the rings home page ends with a link after *Walk the spine*, which opens `#field`: one view in three lenses, read in order. **Who stands near** is an orbit with FJS at the center. Distance is the project's tier, the quarter is its realm (a project on two realms sits on their shared edge), dot size is influence, and color is what FrontierJS did with it, folded from the six stances into four (took it, took the idea, left it, still owed). A dot opens its relation, gap and fjsWay text. **What shape it is** counts who writes each of 18 jobs across six systems. **Where it leads and trails** is depth per capability domain against Laravel, with the switch for what counts as Laravel.

`collect()` gained `field`, read from `website/projects.json` (the register the landscape page already reads) and the new `website/comparisons.json`, which holds the two comparisons that before lived only in artifacts. Both are scored by hand, so `structureOf` nulls the field and neither committed page moves. With no projects file there is no field and no link. With no comparisons file, lenses 2 and 3 are omitted. Tests: the route renders over a fixture and this workspace, every project, system and domain is drawn, home links it only when it exists, and `structureOf` drops it.

## 2026-10-05 — an extension app names what jetty builds with

jetty now declares vite, chokidar and ws as optional peers, so the app installs them.
`extensionDevDeps()` in `core/extension-surface.js` is the list. It sits beside
`extensionScripts()` and has the same two callers. `fli new --extension` merges it into
devDependencies after the UI surface's vite, because jetty's range is the narrower one. `fli make:extension` adds whatever
an existing app lacks and says which it added. `test/app-config.test.js` checks that the ranges
equal jetty's peer ranges, so a bump on one side fails the suite.

## 2026-10-05 — `fli ws:atlas --as=rings`: the workspace for somebody opening it cold

A third page from the one model (`FJS-D223`), written to `repo-rings.html`. The home page has two doors, each a set of concentric rings read from the center out. **The packages** sit in five rings: spine, substrate, batteries, tooling, frontier. **The project** has five too: the root documents at the center, then the invariants with what proves them, rulings, open issues and ideas. A ring opens into cards and a card into a page, and the map moves into a side panel. **A ring carries its open issues as a thin arc along the bottom of its band**, split by severity the way a package page's bar is: a package ring counts the rows naming its packages (one row naming two of them counts once), and that arc is a breakdown only, the band under it being the click. **On the project side the arc breaks a ring into the groups its own page lists, and each segment opens one**: decisions by topic, issues by severity, ideas by wave, and the invariants by the machinery that proves them — checks, snapshots, drives and CI phases, each a page of its own (`#invariants-<kind>`), with `DRIVES.md`'s which-drive-proves-which-change table on the drives page. Proof is a breakdown of the invariants ring rather than a sixth ring, so the project stays five. Neighboring groups alternate two ink-leaning tints of the ring's color, because the ring's own color vanishes on its band once that band is active. **The example app has a page of its own (`#app`)**, the third step of the home page's *Brand new?* strip and the seed page's next step. It is a system map drawn from the tree: Data (`db/`), API (`api/` and the batteries the app depends on) and each UI surface, with an arrow between the realms. Each node opens an inspector with the folders under its source, the packages it runs on, the drives kept in its `test/` and the snapshots generated from it. What a surface is FOR and which packages run it is a hand-stated `SURFACE` table, filtered by what the app actually depends on. The page does not track which cards a reader has opened.

**A package's ring is a new `Ring` column in the root `CLAUDE.md` Packages table**, parsed by `packageNotes` beside the realm. A package with no ring, or with a ring the page does not define, is drawn in an *unplaced* ring and the command warns by name. `test/repo-rings.test.js` fails on any such package in this tree. A claimed folder is dealt to the outermost ring. Inside a ring, packages are ordered by dependency depth, so the spine reads litestone, junction, sierra.

**What the model gained, all derived:** each root register's `##` sections (`sectionsOf`, split out of `readmeSections`), an app seed's model names and its first model without comments, the issue severities' own labels from `ISSUES.md`'s headings, and each app's surfaces (`surfacesOf`: the folders under each one's source, with file counts) and its `@frontierjs/*` dependencies. Neither committed page reads the two app fields, and both render byte-identical with them stripped. The order the root documents are read in is the one thing stated by hand: `READING_ORDER` in `core/repo-rings.js`. A root document missing from it is appended and warned about.

**Not a snapshot.** It counts the registers and files (`FJS-D589`), so it has no generator line, is gitignored, and `--check` is refused. It is written in `@frontierjs/css` tokens with no hex: a ring's accent is a tone, and a severity uses the atlas's `severityTone`, now exported along with `stylesheet`.

## 2026-10-05 — `generatedIgnored` names the ignore rule, not the file

The `hygiene` phase allowed a hidden source file by its path, so one `.gitignore` rule needed one entry for every app it matched. `routes.build.js` (FJS-1695) failed for three apps at once, `.sierra/` failed for two more, and every new Sierra app that ran a build would have failed the same way. Each flagged path now goes through `git check-ignore -v`, and an allowance is keyed `<ignore file>:<pattern>`, so `.gitignore:routes.build.js` covers every app. The guard still works because a rule nobody has named fails, and a too-broad rule was the problem with `build/`. An entry is stale when its rule is gone from its file. Matching files can't decide staleness, because a fresh clone hasn't generated them. `scripts/ci-allowances.json` dropped from 4 file entries, plus the 5 it would have needed, to 6 rule entries. Both failure paths were run: removing the `routes.build.js` entry fails listing all three files, and a bogus rule is noted as stale.

## 2026-10-05 — a red CI phase hands itself to Claude

A failing phase row has an *ask claude* button beside *rerun*. `askAboutCi` puts the phase, the run it came from and the rerun command into the output pane, along with each failure's label, detail and the last 60 lines of its output, and each failing suite with its failed tests. It also leaves a question in the ask field, the same as the *next* panel's button. Nothing is sent until ask is pressed. The spec in `test/browser/specs/ci.spec.mjs` stubs the defaults GET, because the real one waits behind the page's other loaders and timed the spec out.

## 2026-10-05 — the committed workspace pages hold the structure only (`FJS-D589`)

`repo-atlas.snapshot.html` and `repo-report.snapshot.html` went stale whenever anyone filed an issue, wrote a ruling or added a file, so both were red on every branch and two failures were reported for one cause. `structureOf(model)` in `core/repo-map.js` sets `issues`, `decisions`, `ideas` and the file counts to null, and `fli ws:atlas` renders it for both committed pages. `collect()` still reads everything: `--json` prints it and `--live` renders it. So the deck's hub, plate heat, ⌘K rows and dossier issue lists are on `repo-atlas.live.html` only. The report's register section is deleted, since the report is the runbook. The atlas went from 1.4 MB to 545 KB and the report from 340 KB to 219 KB. `test/repo-map.test.js` files an issue, a ruling and a source file, asserts the model changed, and asserts both pages did not.

## 2026-10-05 — the CI panel says why a phase is red, and fixes a stale snapshot in one press

**A red phase lists its failures under the row.** `hygiene` and `snapshots` report keyless findings, and `latestByItem` dropped every step without a key, so the panel could say FAIL and nothing else. `fail()` in `scripts/ci.mjs` now writes the whole finding to the run log: the first line as `label`, the rest as `detail`, the captured output (4000 characters) as `output`. `phaseFailures` puts the keyless ones on their phase. The output is folded under each failure with its escapes stripped, and an unfolded one stays open when the 20-second poll redraws the rows.

**A failure can carry a `fix`, and a stale snapshot is the first one that does.** It is `{ kind: 'snapshot', file }` in the log. The server builds the argv in `CI_FIXES`, so the run log, which anything on this machine can write, never names a command. `POST /api/ci/fix` runs `fli test:snapshots --fix --only <file>` through `spawnStep` and streams the output to the console. The row then reads *regenerated* with a *see changes* button, and a phase with two or more fixes also gets a *fix N* button. A hygiene finding carries no fix, because its remedy is an allowance with a written reason. A generator that could not run carries none either, because regenerating fails the same way.

**`fli test:snapshots --only <path>`** narrows a check or a `--fix` to one snapshot, by the path a failure names. A path discovery did not find is refused rather than read as zero snapshots, all current.

## 2026-10-04 — `fli sig` prints an exported signature, so a caller does not grep src (`FJS-1547`)

`fli sig bearerClaim` answers the declaration an app imports — its head with the body cut off, its comment, `file:line` and the `import` line — where an agent used to grep `src/` and read a hundred lines around each hit (1384 greps, 2.0M characters across 77 sessions). `core/signatures.js` hands every published package's entry points (`exports`, else `main`, a `.d.ts` outranking the source it describes) to one TypeScript program and walks each module's exports through the checker, so `export *` and renamed re-exports resolve as an import resolves them. An interface or class over 40 lines is its members cut to signatures, which is what makes `CallOptions` and `App` one screen. A name with no export falls to a substring and then to the declarations that name it as a member, which is where `sessionFields` (an option) and `verifyGateLadder` (a method on the test env) live. `fli explain` was not widened: it is `db:explain`'s, a `.lite` word catalog. `test/signatures.test.js` grades a fixture workspace and the real junction, auth and litestone surfaces.

## 2026-10-04 — `fli check` sees a raw `apiKey` in a Resend mailer constructor (`FJS-1668`)

`battery-raw-secret` (warn) reads `api/` source for `createResendMailer({ apiKey … })` — the literal, an `process.env` read and the `{ apiKey, from }` shorthand alike, since all three hold the secret in a closure for the life of the process — and points at `credentials` + `apiKeyRef`. `FJS-D219` kept the raw option and named this rule as what stops it living forever. Comments are blanked first, so the paragraph describing the hazard is silent. `test/checks.test.js` pins the three shapes, the reference form and the comment.

## 2026-10-04 — the ask panel undoes any run, and keeps its log across a reload

**Every run that changed a file ends in a row with its own Undo**, in place of the one "Undo last" that a newer run took away. An older run can be undone after a newer one: its ledger already treats a later run in the same file as another writer and reverses only its own hunk. A spent Undo reads "Undone". New chat no longer clears the log, since the Undo buttons in it still work.

**The log and the panel's open state survive a full reload** in sessionStorage beside the session id, and a reload with the panel open draws it again over the log. Before, an edit HMR could not swap reloaded the page and took the diff and the Undo with it. The log keeps its last 300 entries. Run ids are now `<boot>.<n>`, with a random id per dev-server process: a saved log outlives a restart, and a bare count would have pointed an old Undo at a new run.

**`verify:ask`** edits the heading and then the paragraph of one file directly, undoes the OLDER run and asserts the file is back except the newer run's line, then undoes the newer one byte for byte. Then it edits, reloads, and undoes from the log that came back. It also checks that a panel closed before a reload stays closed. With the reopen turned off, the reload check fails.

## 2026-10-04 — the ask panel hands its conversation to a terminal

**"Continue in terminal"** in the panel's header copies `cd <root> && claude --resume <id>` for the conversation the panel holds, so the person goes on with their own session's tools and settings rather than the panel's edit-only scope. `resumeCommand(root, session)` in `ask-claude.js` builds it from the same `root` the runs are spawned in; a root a shell would split or expand is single-quoted, and anything that is not a session id gets no command. Measured on 2.1.288: `claude --resume <id>` finds a session from any directory and appends to it where it was made, so the `cd` is for the session's relative paths and its tools, not for finding it.

**Before there is a conversation** it copies what a first ask would send — the unsent instruction, each pick's source made absolute, and its HTML — for any agent. It is `editPrompt` with `followUp: true`, so the run's rules stay out; `editPrompt` now leaves out the `Change:` line when there is no instruction. `POST /__fjs/ask/handoff` answers both, and shares `readPicks` with the ask route. The clipboard is a secure-context API, so a page reached over plain http from another machine shows the text to select instead.

**`verify:ask`** clicks it after the first run and asserts the copied command, then runs that command through `sh` against the fake CLI, which records where it was started and its argv: the root, and `--resume <id>`. Then New chat, an unsent instruction, and the copied block carries it with the absolute source and the HTML and none of the run's rules. With the `cd` dropped, two checks fail.

## 2026-10-04 — the ask panel edits text with no Claude run

**"Edit text" on a pick row** lays a textarea over the element, with the element's font, and never makes the element itself editable. Enter commits, Escape or a click away cancels. `POST /__fjs/ask/text` makes the swap when `locateText` finds the old text exactly once. In a `.mesa` file the search covers only the text between the element's own open and close tags, skipping attributes, `{…}` expressions, comments and script/style. Whitespace matches any run of whitespace, a character the source wrote as an entity (`&amp;`, `&mdash;`) matches the character the page shows, and a word inside a longer word is not a hit. The edit goes through `createLedger` as one Edit whose hunk is the whole searched region, so the diff, Undo and the another-writer rule are a run's. In `.mesa`, `& < >` in the new text are written as entities.

**Anything else goes to Claude** with *Change the text "X" to exactly: Y*, and the log says which path ran: text interpolated or split by inline markup, text found twice, braces in the new text (plus Markdown's emphasis and link characters in a `.md`), or a loc the file no longer matches. A `.md` loc names the template Markdown compiles to (`FJS-1711`), so a `.md` searches its whole body after the frontmatter.

**Measured on `website/site`, all 29 routes**: 3545 of 6770 text-bearing elements (52%) take the direct path. 769 (11%) are split by markup, and 2456 (36%) are interpolated: loops, component props, `data/*.js`. Before Sierra mapped locs back to file lines (`FJS-1710`), 33 did.

**`verify:ask`** edits a static heading in place and asserts the fake CLI was never spawned, the file changed by exactly that one line, no `contenteditable` appeared, and Undo restored it byte for byte. Then it edits an interpolated heading, which falls back, is changed by the fake, and is undone. The route now has frontmatter, and the drive asserts the heading's loc is the line it is written on.

## 2026-10-04 — the ask panel takes several elements in one ask

**Shift+alt-click before a send adds to the list.** The panel shows one row per pick (its `loc`, its tag and a glimpse of its text, since two items of one loop share a `loc`), each with "Open source" and a × that leaves it out. One instruction goes out with all of them, as one run with one ledger, so one Undo puts every file back. The first pick after a send, or into a closed panel, starts a new list; a follow-up with no new pick keeps the last one. At most 10.

**`editPrompt` takes `picks: [{ loc, html, size }]`** in place of `loc` and `html`, and numbers them (`Element 1 of 2`) when there is more than one. `EDIT_MAX_HTML` is now the budget for the whole prompt rather than for each element: `shareBudget` gives a short element all of its own and splits what it leaves among the long ones. The panel cuts each outerHTML to that budget before sending and passes its whole length as `size`, so ten section-sized picks stay under the request limit and the prompt still says how much was cut. `EDIT_RULES` says an instruction can cover several elements, so `verify:ask --real` is owed once.

**`verify:ask` picks two headings in two files** (the scratch route now imports `content/parts/Lede.mesa`), leaves a third pick out again, and asserts one instruction changes both and one Undo restores both byte for byte. The fake CLI refuses unless the second pick reached the prompt; sending only the first pick fails the drive.

## 2026-10-04 — the ask panel shows its diff, creates files, and undoes whole

**An undo restores each file's original when nobody has touched it since.** `createLedger(root)` in `core/vite-ask.js` follows one run. It copies a file at the run's first Read of it. The CLI will not edit a file it has not read, and refuses one that changed since, so that copy comes before the change. When the first change to the file lands, the ledger replays that change against the copy, and a copy that does not replay to what is on disk is dropped. Undo writes the copy back only when the file is still byte for byte what the run left. Otherwise it reverses the run's own hunks as before, so another writer's work is never overwritten. This covers the three cases hunks could not: a replace-all, a deletion, and changed text that now occurs twice.

**Write is allowed, inside the app.** `EDIT_TOOLS` gains `Write`, and the one `Edit(//dir/**)` rule scopes it too. Measured against the real CLI: a Write inside the scope landed and one beside it was denied. A new file is known new by the CLI's own result ("File created successfully"), because looking at the call can lose the race with the write. Undo deletes it only if it is unchanged since Claude wrote it, then removes the folders above it while they are empty. `readAskEvent` now also reports `read`, `write` and `landed` events, which the GUI console ignores.

**The panel shows the diff**: after a run, each file the run changed, with removed and added lines and three lines of context (`lineDiff`). It also says which click does what ("alt-click opens the source in your editor · shift+alt-click asks here") and has an "Open source" button.

**`verify:ask` gains a replace-all, a new file plus the edit that imports it, and another writer's line surviving an undo**, plus the diff, the hint and the button. Five consecutive runs passed. The fake CLI now takes a reply turn after its last edit: without it, the undo landed about 20ms after the edit, the dev server's watcher reported only the first write, and the page kept the edit over a file that had already been put back.

## 2026-10-04 — ask Claude to change a picked element (`core/vite-ask.js`)

**Edit mode for `ask-claude.js`.** `askArgv({ edit: dir })` gives the tools `Read,Grep,Glob,Edit`, with `Edit(//dir/**)` the only allow rule. It also passes `--setting-sources ''`, so no allow rule in any settings file reaches past that, and `--permission-mode dontAsk`, so a call outside the scope is denied instead of accepted by whatever mode the account defaults to. Measured against the real CLI: an edit inside the scope landed, and the one beside it came back as a permission denial. It has no Bash and no Write, so every change is a hunk on a file that already exists. `editPrompt` builds the prompt from the instruction, the element's `data-fjs-loc`, its outerHTML (first `EDIT_MAX_HTML` chars) and the page URL. `readAskEvent` now reports an Edit call with its hunk, and a refused tool result by call id.

**`core/vite-ask.js` is a dev-only Vite plugin.** It serves `core/vite-ask-client.js`, which registers as the Mesa inspector's picker: shift+alt-click opens a panel, and the panel streams the reply. The plugin also adds `POST /__fjs/ask`, `/stop` and `/undo` middleware that runs the session in edit mode, scoped to the Vite root. The dev server's own watcher reloads the page. A request must carry this server's Origin and a JSON content type, so another tab's form or no-cors fetch is refused before anything spawns. One question runs at a time, and closing the tab stops it. **Undo reverses the run's own hunks**, newest first, and only where the new text still occurs exactly once. A replace-all edit, a deletion, or a file someone else has rewritten is reported as not undone. Nothing is restored whole. `test/vite-ask.test.js` covers it.

**Sierra turns it on, in every dev server whose app has the cli** (`packages/sierra/src/build/ask-plugin.js`). `website/`, `example/` and `basecamp` declare `@frontierjs/cli` as a devDependency, as a scaffolded app already does. `bun run build` ships none of it.

**Proved end to end by `website`'s `verify:ask`**: a scratch site on the `siteKit()` dev config, a real shift+alt-click in Chrome, the edit reaching the page through the watcher, and the undo putting the file back byte for byte. By default it reaches a fake `claude` on PATH; `--real` uses the CLI. The first real run passed in 7s and cost $0.03.

## 2026-10-03 — `fli new` ignores Sierra's build route table (`FJS-1695`)

The scaffolded `.gitignore` lists `routes.build.js`, the table a Sierra build now writes beside `config/routes.js` so it cannot overwrite the one a running dev server serves.

## 2026-10-03 — publishing the packages, walked in `fli gui`

**A `publish packages` screen walks `ws:pub`** in five stages — *get ready* (everything committed, a full CI run, `test:snapshots` with its `fix`, `npm whoami`), *choose what goes out* (`ws:changed`, the registry read, `ws:pub --dry`), *publish* (`ws:pub`), *check it landed* (the registry read again, and `git push origin HEAD --tags` for a run that held the push back), and *if it stops partway*, which runs nothing: re-running `ws:pub` after a partial publish bumps again and skips a version, so the step says what to do instead. Above the steps are the options `ws:pub` takes — bump, dist-tag, a 2FA code, push when done, include unchanged (`--all`), finish a partial run (`--tolerate-republish`) — and every member with its version, the version it moves to, its commits since its tag, and what npm holds once read. **An untouched selection sends no `--filter`**, and neither does one ticked back to what `ws:pub` would pick, so drawing a list never narrows a release. Changing an option clears the dry run, because a plan answered the options it ran with. Its home tile counts what is going out.

**`core/publish-view.js` owns the table and the options gate.** `ws:pub` pastes `--tag` and `--otp` into one `execSync` string, so a tag that is not `^[a-z][a-z0-9-]{0,30}$`, a bump outside the four, or an OTP that is not 6–8 digits is refused rather than escaped. A package is named only by a member's exact name, and one whose `--filter` would also select a second member (substring matching) is refused, or ticking one box would publish two. The console echoes the command with the OTP masked (`displayArgv`). `GET /api/publish` is the members and `ws:changed --json`, which loads with the page; `POST /api/publish/registry` is `ws:npm --json` and waits for a press, because it asks npm. Steps run through `/api/release/step` with `flow: 'publish'`, so a deploy and a publish share one slot. `spawnStep` is the runner both flows use, moved out of `runReleaseStep`.

**The page's step list is one `FLOWS` table**, deploy and publish, with every lookup scoped to the flow's own list — the two share the ids `commit`, `ci` and `snapshots`. Results are kept per flow.

**Not proved: a real publish from the screen.** `bun publish`'s default 2FA is a browser link, and whether it prints that link and waits with no terminal attached was not exercised. A run that only prints a code prompt is answered by the 2FA field.

Proved by `test/publish-view.test.js` (new, in the `test` list: the order, every refusal, the substring overlap, a real `ws:pub --dry` over a git fixture that leaves the tree clean, the masked display), `test/browser/specs/publish.spec.mjs` (19 assertions, including a dry run through the page and server refusals of an unapproved publish and push), the cli suite (2855 pass) and a screenshot. Whichever browser spec runs first still absorbs the `/api/check` stall (`FJS-1630`); this spec waits for it.

## 2026-10-03 — an app can name an exception to `fli check` (`FJS-1428`)

`fli check` called `runChecks({ root, only })`, so the `allow` the command's own page documents was unreachable and an app's only excuse was `--adopt`'s per-rule count, which also excused the next real finding. It now reads an `allow` object from `check-baseline.json` (`FJS-D508`) — `'<rule>:<path>'` to why, an entry with no reason ignored — and passes it to both `runChecks` calls. An excused finding prints under its reason and leaves the count; a stale entry is warned and also in `--json` (`allowed`, `stale`). `writeBaseline` carries `allow` through `--adopt` and `--update`, which would otherwise have erased it. A stale entry is judged only for a rule that ran, so `--only` does not call a live one stale. Proved in `test/checks.test.js` ("the allowances beside the counts").

## 2026-10-03 — a web-only app is an app root to `fli check` (`FJS-1617`)

`app-layout`, `surface-config`, `surface-src` and `mesa-compiles` decide *is this an app root* with `isAppRoot`: a `db/schema.lite`, or a `package.json` / `.fli.json` with at least one surface directory beside it. They used to ask for the schema alone, so a web-only, widgets-only or site-only project skipped them as *not an app root* and a `.mesa` that did not compile passed as `✓ 0 rule(s) checked`. A bare manifest with no surface is still not an app root, because every library has one. `migration-history` and `log-db-unbound` read the schema and keep that gate, now saying `no db/schema.lite` rather than *not an app root*. Proved in `test/checks.test.js` ("an app root with no schema").

## 2026-10-03 — the vanilla floor, recorded

**The vanilla floor is a recorded number.** `node scripts/scaffold-build.mjs --build --floor` weighs the scaffolded app's `web/dist` right after its first build, before `fli scaffold Note` grows it, and ratchets it against `scripts/bench.baseline.json` (`--update` / `--adopt` as above). Not in `bun run ci`: a bundler move would redden CI for a number nobody chose. First recorded: 3 requests, 55.6 kB js and 10.5 kB css first load, 128 kB brotli total.

**The floor also boots the app and sizes its database.** The vanilla API is started on an OS-assigned port and its cold start and RSS are printed (212 ms, 68 MB on the recording machine; reported, never gated). `measureDbGrowth` writes N rows of one model through the app's own Litestone client into a throwaway file and reads the size after a WAL checkpoint, because file-plus-WAL measures how many frames had not been folded back. Gated, as `db.note<N>Rows`: 0 rows 120 kB, 1,000 rows 388 kB, 10,000 rows 2.7 MB.

**Request latency, at a constant rate.** `core/latency.js` fires each case at a fixed arrival rate (50/s, 5 s after a 1 s warm-up) and counts a request from its SCHEDULED instant, so a server stall lengthens the tail instead of being skipped the way a closed loop skips it. The floor runs four cases against the booted scaffold through its own routes: a read, a 50-row list, a gated create, and a gated PATCH of the signed-in user, which `@@log(audit)` writes to the audit trail. p50/p95/p99/max are printed with RSS after load; none is gated. A case with any failed request, or no samples, is recorded as an error and printed as FAILED -- a run of 401s would otherwise print a fast p99. The boot now runs last, on a fresh database: one written before `fli scaffold Note` has no note table. The scaffold has no model with a relation, so list-with-include is not measured yet.

**The report reads as sections.** `formatBench` prints Download, First load, Disk, Database size, Memory and boot, Latency and Verdict as small aligned tables, with the regression delta in bytes, and color on a terminal only (`NO_COLOR` and pipes stay plain). A failed boot or case is a red line naming why. `fli test:bench --json` is unchanged for a machine.

**`test:bench --get <paths>` times reads while the API is up.** Comma-separated GET paths, `--rate` per second each, shown in the same Latency table. GET only: a write needs credentials and would land in the app's real database. `example/` has `bun run bench` with the boot command and url filled in.

Still not built: browser-side memory and web vitals, and latency against `example/`.

## 2026-10-03 — `test:bench` — what a built app costs

**`fli test:bench` measures a built app and gates the bytes.** Per built surface (`web/`, `site/`): file count, raw and brotli totals, js/css/html split, the largest chunk, and the first load — the local scripts, stylesheets and modulepreloads `index.html` names, with the request count. A ref the build names and the disk lacks is reported, not skipped. Disk (`node_modules`, `db/*.db`) is printed and not gated. `--boot "<cmd>" --url <u>` starts the API, waits for the url, lets it idle and reads RSS over the whole process tree (`/proc`, so Linux only; elsewhere it prints `n/a`, never 0). A url that already answers is refused.

**Bytes ratchet down only, boot is reported.** `bench.baseline.json` at the app root holds one number per `surface.metric`; `--update` writes an improvement or a newly measured key and cannot raise, `--adopt` can. A baselined metric the run did not measure is `unmeasured` and keeps its number. Cold start and RSS never fail anything — they are one machine on one afternoon (`IDEAS/performance-regression-watch.md` § What a performance claim is). It never builds.

Proved by `test/bench.test.js` (first-load parsing, an SPA's `dist/client`, the ratchet's three directions, boot against a throwaway Bun server including the already-answering and exits-early refusals).

## 2026-10-03 — `ask claude` on `fli gui`'s output panel

**The console hands what it shows to Claude Code and draws the reply under it.** `ask claude` opens a question row; `ask` posts the panel's lines, the question (empty asks *what does this output say, and what should I do next*) and where the page is — the open panel and every visible select's value — to `POST /api/ask-claude`, which starts `claude -p` in the project root with the prompt on stdin and streams the reply back: Claude's text set apart by a rule, each tool call as one muted line, then a summary (turns, cost, calls refused). The session id comes back with the first answer: a follow-up resumes it and sends only the lines that arrived since, none of Claude's own; `new` drops it; the same id is offered as `claude --resume <id>` for a terminal. One at a time, `/stop` signals the group, a foreign Origin is refused.

**`core/ask-claude.js` makes the session read-only by construction** — `--tools Read,Grep,Glob,Bash`, Bash allowed only `git status/diff/log/show`, `rg` and `ls`, and a print session denies the rest instead of prompting (measured: a `touch` came back as a denial and no file). Hooks are off (`disableAllHooks`): this repo's Stop hook would run `fli done` and keep a one-question session chasing the tree's close-out, and it records what was SHOWN beside `.git`, which an ask would have silenced for the person's own session. `--strict-mcp-config` drops the account's MCP tools; `--max-budget-usd 2` caps a press. A session id is checked as a UUID before it reaches argv.

**The row says what it does, and its words are editable.** Opening it puts the default question in the field, selected — typing replaces it, an arrow keeps it to revise. A help line under it says what is sent and what Claude may run, filled from `GET /api/ask-claude`, which serves `ASK_RULES`, the default question, the tool list and the budget from the module that passes them, so the line cannot drift from the argv. `instructions` opens the default instructions in a textarea: an edit is labeled `edited`, kept in this browser, sent as `rules` on the first question of a conversation (a resumed session already has them), and `reset` goes back. Editing them cannot widen what Claude may do — that is the argv. When a command is open, the server adds its `.md` as `command source`, looked up from the registry by title rather than taken from the page, since a command's file is its docs and its script.

**A next-up row has its own `ask claude`.** It puts the issue in the output — id, severity, packages, `ISSUES.md:<line>`, title, and a `stale?` status said as a doubt — and opens the row with *is it still real, where is the cause, what would the fix be* selected in the field. The press SENDS nothing; `ask` does, so a row is never a click that spends money unseen. `openAsk(question)` and `askAbout(lines, question)` are the seam another panel's row would use.

Proved by `test/ask-claude.test.js` (argv, prompt and edited instructions, stream reading, stdin and cwd, stderr and a missing binary, against a fake `claude`), three cases in `test/server.test.js`, `test/browser/specs/ask-claude.spec.mjs` (39 checks: what each ask SENDS, a next-up row's button on every real row, what it puts in the output and the field, and that it posts nothing, the follow-up's narrowing, the default question selected, the help line, edit/keep/reset of the instructions, the reply's rule resolving in the stylesheet), a served GUI with a fake `claude` on PATH printing the prompt it was given (edited instructions first, `command source: packages/cli/commands/workspace/publish/index.md`), and a real ask and follow-up against the real CLI (~$0.13 each).

## 2026-10-03 — the Release screen is the release, in order

**`fli gui`'s release panel is now an ordered checklist**, sixteen steps in six stages — *finish the change* (commit, `fli done`, `fli prove`), *make it green* (`fli check`, `test:snapshots` with a `fix`, a full CI run), *know what you are shipping* (`release:check`, `release:mint`, `deploy:plan`, `deploy:doctor --remote`), *ship it* (`deploy`), *watch it land* (the target reading, `deploy:status`) and *if it goes wrong* (`deploy:revert --plan`, `revert`, `rollback`). Each step shows its command, why it is there, and a status: a gate reads a panel the page already loaded (the tree, CI's last FULL run), a step run from here remembers how that run went per app and target in this browser, and anything else says `not run` rather than a guessed pass. The first step before the deploy that is not green is marked `next`, and the panel and its home tile say how many of the ten are ready. The pivot verdict and the target reading are moved INTO the steps that answer them.

**`core/release-view.js` owns the table** — `RELEASE_STAGES`, `RELEASE_STEPS`, `describeSteps()` for the page and `runReleaseStep()`, which runs `fli <argv>` as a child of the workspace root or the chosen app in its own process group. `GET /api/release/steps` serves the table; `POST /api/release/step` streams one step's output to the console and ends with its exit code, one at a time; `/stop` signals the group. The step and target are looked up by key, so nothing from the request reaches argv any other way (Invariant 8); a foreign Origin is refused; a step that changes what is serving (`deploy`, `revert`, `rollback`) is refused unless the page sends `approved`, which it does only after a confirm, and its stdin answers `y` to `deploy:rollback`'s prompt.

**`FJS-1635`** — `release:mint`, `deploy:plan` and `deploy:journal` refused a missing deploy block (and `mint`'s configuration error, `plan`'s plan error, `journal`'s unresolved target) with a bare `return`, so each exited 0; the screen grades by exit code and would have shown `passed` beside a refusal. Each sets `context.config.abort`. A refusal now ends with the runtime's bare `✗ refused`, so `release-view.js` reads a command's reason through `lastSaid`, past that marker and its color codes.

Proved by `test/release-view.test.js` (the table's order and shape, every refusal by name, a real `mint` streaming its refusal with a non-zero exit), `release.spec.mjs` (steps drawn in table order, the verdict and target blocks inside their steps, an unapproved deploy refused by the server), the cli suite (2800 pass), and a curl of the stream and a foreign-Origin refusal against a served GUI.

## 2026-10-03 — `fli gui`'s front page is tiles, and a tile opens its panel

**Home was every panel at once** — changes, proofs, ci, next up, decisions, checks, release and every runnable row, one long page of lists. It is now a `.tiles` grid (the design system's Tile, as a `<button>`), one tile per panel: a label, the headline (`17` files, `passed`, `61` findings, `reversible`), a toned line, and one muted line of detail. A tile with a reason to look — an error, a warning, a decision to pick — takes the tone on the whole tile. Pressing one opens that panel alone under a `← home` bar, at `/#<panel>`, so back and a reload land where they were; `fli` in the topbar is a way home from a command.

**No loader knows the tiles exist.** Each panel loads and renders as before; a `MutationObserver` on the panels redraws the tiles from what the loaders kept, so a panel and its tile cannot disagree past one render. Showing one panel is a class, never `hidden` — `hidden` on a panel already means *nothing to say*, and every spec that reads it still means that; an opened panel that is hidden shows its tile's sentence instead of a blank page. Proved by the browser drive (151 of 152; `checks.spec` times out because `/api/check` takes ~25s on this repo, unrelated) and screenshots of home, `#ci` and `#run`.

## 2026-10-03 — the CI run log, and a CI panel in `fli gui`

**`scripts/ci.mjs` writes what it is doing as it does it**, one JSON event per line in `.cache/ci-runs/<id>.jsonl`: the run (commit, dirty tree, flags, scope), each phase's start and end, a `begin` before every suite, lesson and mutation app, and each step's result with its time and — for a suite — its test counts. Before this the runner said nothing between a phase header and its result, and a TTY-only progress line was the whole answer to *what is it doing*. `core/ci-log.js` is the one owner of the format, the counts and the reading, imported by `ci.mjs` the way `checks.js` is.

**Counts are parsed from runner output and are honest about coverage**: bun test and vitest summaries are read and summed, a script that also runs something unreadable is `partial` (`≥`), and nothing readable is `null` — never 0, because 0 has to mean *ran nothing*, the shape of the sierra suite that imported `bun:test` under vitest and passed. The failing tests are named from `(fail)` and `FAIL` lines. The fixtures in `test/ci-log.test.js` are captured output, vitest's colors included.

**The `ci` panel on the front page** reads `/api/ci`: the run going now (phase N of M, which suite, how long against its usual median), every phase and suite with its OWN latest result and the run it came from — so a `--only` rerun answers one row and a narrowed phase says so — the last full run separately, notes, and history. `rerun` starts `--phase X`, or `--phase tests --only <pkg>` on a suite; `stop` signals the run's process group. One run at a time, whoever started it — a terminal run shows up live and blocks a second. `POST /api/ci/run` and `/stop` refuse a foreign Origin through `foreignOrigin`, now the one check `/api/decide` uses too. Proved by `test/ci-log.test.js`, three cases in `test/server.test.js`, `test/browser/specs/ci.spec.mjs`, and a real start → live poll → 409 → stop against this repo.

## 2026-10-03 — three tutor lessons run again, and `css-raw-literal` stops reading a comment as a `<style>`

**`css-raw-literal`** matched `<style\b` anywhere in a `.mesa`, so the scaffold home page's HTML comment *the `<style>` block at the bottom…* opened a block there and every `&#123;` in the markup below read as the color `#123`. HTML comments are blanked before the match, keeping every line number. Pinned in `test/checks.test.js` § *a comment that names a `<style>` block does not open one*, red before. The scaffold's own widths are `var(--grid-min, 20rem)` and `var(--auth-card-width, 24rem)` now, so a fresh app's `fli check` is clean and `tutor:tools` § *does anything fail a check* passes.

**`tutor:fleet`** had fallen behind basecamp three times. Enrollment sends the command port's certificate, made with outpost's own `cert.js` and kept in the workspace, and the outpost starts with `OUTPOST_TLS_CERT`/`OUTPOST_TLS_KEY` and an https `OUTPOST_PUBLIC_URL` (`FJS-1603`); `probe.js`'s http probes take bun's `tls` option, so a probe of that port pins the same PEM. Step 6 no longer triggers the job it just created — a one-shot job is dispatched by its create, and the second run was refused as already running whenever it raced the first. Step 7 releases `nginx:alpine` as an image source instead of building a git repository, since basecamp refuses a source nothing builds, and patches `port: null` where it sent the deleted `config` column and a `0` the column now refuses.

`tutor:test` passes with no change here — its failure was litestone's gate ladder (litestone `CHANGES.md`, same date).

**`core/color.js` read `FORCE_COLOR=0` as on** — `Boolean('0')` is true — so under CI, which runs every suite with `FORCE_COLOR=0`, `tty.keys` styled its prompt and two `test/tty.test.js` cases failed only there. `0` and `false` are off, as chalk reads them, and an empty value is unset. Pinned in the new `test/color.test.js`, red before. The pty helper in `test/tty.test.js` drops the runner's `CI`, `FORCE_COLOR` and `NO_COLOR`, since chalk honors the first two and *without NO_COLOR chalk colors* otherwise fails for CI's reason.

**`test/server.test.js`'s `/api/state` and `/api/health` cases took the first tool row**, `tool:devtools` on 8503 — the port a running app's dev API holds for devtools — and asserted it `down` or bound it, so all five failed whenever any app was in `bun run dev` on the machine. They take the first tool whose port is free now.

## 2026-10-02 — the graded `ask` questions cite open issues

`FJS-1180` and `FJS-1193` had closed into `ISSUES_ARCHIVE.md`, so two `status` questions cited rows `ISSUES.md` no longer holds; they now cite `FJS-1262` and `FJS-1404`. The outpost question is worded so it resolves to `FJS-257` alone, where `FJS-1397` had tied with it. Twelve spread-4 terms were added to `VOCABULARY.md` as `open` rows, which is what `terms.test.js` counts.

## 2026-09-30 — ports: the website's slot names frontierjs.com

The public site's domain is frontierjs.com; the comment on `website`'s project slot in `core/ports.js` said `.dev`. No number moved.

## 2026-09-30 — `ws:publish` notes a package the website holds back (`FJS-1369`)

The website names each workspace package it does not describe in `HELD_BACK`, with a reason. That list goes stale when the package gets a page or turns `private`, and never when it first reaches npm, because a build does not ask the registry. So the release now asks the question. `00-preflight` reads `HELD_BACK` from `website/site/src/data/packages.js`, which now exports it, and a planned package named there prints a `website-held-back` note with its reason and the fix: delete the entry and describe the package. It is a note, so the release still proceeds, and outside this workspace there is no file and no note. A dry run of `fli ws:pub patch --dry --filter orion` prints it.

## 2026-09-30 — `drive-opens-chrome` replaces `drive-cdp-port` (`FJS-1588`)

The rule refused only a FIXED debugging port. It now refuses any `--remote-debugging-port` in a file under `test/`, `tests/` or `bench/`, and the message points at `openChrome()` from `@frontierjs/mesa/drive`. The driver owns that flag: it picks the port, gives each run its own profile, and sweeps the browser on a throw or a signal. Port 0 fixed only the first of those.

It is the first rule with `scope: 'both'`, which `runChecks` now honors. It runs in an app's check for a client app, and in the repo run for the packages. A root leaves a nested app to that app's own run, which is how ci already splits the workspace, so nothing is reported twice. Two named allowances in `scripts/ci-allowances.json` cover the driver's own refusal test and this rule's fixture. New tests: port 0 and a fixed port are both found. The repo run reads `test/browser/` and `bench/`, and leaves a `--dump-dom` page and a nested app alone.

## 2026-09-29 — Scaffolded scripts name the bin, never `bunx` (`FJS-1586`)

The `package.json` scripts `fli new` writes, `db:migrate`, `db:backup` and `db:types`, ran `bunx litestone …`. `siteScripts` and `widgetScripts` ran `bunx sierra …`. Before `bun install`, `bunx` fetches whatever the registry holds under the bare name. They now say `litestone …` and `sierra …`. `bun run` puts the app's bins on `PATH`, including after a `cd` into a surface, so the installed copy runs. A fresh clone never fetches. It runs a globally linked copy if there is one, and otherwise fails with *command not found*. The warning printed when the first migration cannot be written now says `fli db:migrate --create-only`. The guard in `snapshots.test.js` now also matches a script key or a string that begins with `bunx`. It catches all seven old lines. The earlier entry's "Not moved" list shrinks to the Dockerfile `RUN`, `docker exec` and the tutor's `reproduce:` strings.

## 2026-09-29 — `core/browser.js` is a layer over `@frontierjs/mesa/drive` (`FJS-1588`)

The tutor's page driver was a second CDP client with its own launch, sweep and error collection. `openPage` now opens `openChrome` from `@frontierjs/mesa/drive`, a new dependency. It keeps only a lesson's shape: `eval(expr)` answers an expression, and a stale-context retry that a drive must not have, since there the evaluate may be the click that navigated. `findChrome` is re-exported from mesa, and its tests moved there. `scripts/ci.mjs` imports it from mesa directly. One behavior moved with it: `page.errors` promotes only `[Mesa]` warnings, as every drive does, rather than every console warning. The unused `chrome` and `timeoutMs` options are gone. `tutor:ui` passes on it.

## 2026-09-29 — `context.bin(name)`: no fli command runs `bunx` litestone or sierra (`FJS-1586`)

About twenty commands built `cd <root> && bunx litestone …` or `bunx sierra …`.
Examples are `db:*`, `test:*`, `release:*`, `deploy:doctor`, `site:serve`,
`widgets:*`, `project:map`, `fli:validate` and `fli new`'s first migration. On a
machine with no install, `bunx` fetches whatever the registry holds under the
bare name. `context.bin(name, from = paths.root)` sits beside `context.fli` and
resolves the app's copy through `resolveGenerator`. It returns it as a quoted
shell prefix, run under the interpreter its shebang names: node for sierra, as
`bunx` did. When the package does not resolve, the command refuses with
`@frontierjs/litestone is not installed where … can reach it`. `binCommand` in
`core/snapshots.js` is the pure half. `project:map` and `fli:validate` now pass
`cwd` rather than building `cd ${root}` into the string.

Not moved: scaffolded `package.json` scripts, the widget Dockerfile's `RUN`,
`docker exec` into an installed image, and the tutor's `reproduce:` strings. Each
of those runs where an install exists, or is printed for a person to type.
`snapshots.test.js` fails on any command body that execs `bunx` litestone,
sierra or junction.

## 2026-09-29 — `app:atlas` and `project:map` resolve junction, never `bunx` (`FJS-1571`)

`readAppAtlas` in `core/app-entry.js` ran `bunx junction atlas`, which on a
machine with no install fetches a stranger's `junction` from the registry. It
now resolves the bin through `resolveGenerator` from the snapshot's directory,
as `callArgv` does, and spawns `bun <bin> atlas`. When junction does not resolve,
it says so and spawns nothing. `test/call-argv.test.js` asserts the argv through
the injected runner.

## 2026-09-29 — codegraph: a growth sparkline per package

The codegraph page's Packages table has a Growth column. The line is source
files born per slice and the area is edits per slice, over 48 slices of one
span shared by every row, so a young package reads as young. `timelineOf` in
`core/codegraph.js` buckets the creation and edit times `parseGitLog` already
kept, so there is no second git call. Only files still in the tree count, and
sweep commits are left out of the edits. A toggle scales each row to its own
peak or every row to the project's, because per-row scaling made a package
with three edits look as busy as one with a thousand.

## 2026-09-29 — `fli call <service>.<method>` (`FJS-1560`)

`fli call orders.find '{"$limit":5}' --as alex@shop.test --tenant flagship` calls
one service method as that person through the hook pipeline and prints the
answer as JSON, with no dev server. It replaces the curl login, token copy, sleep
and kill an agent wrapped around a server it started, and it is the second half
of `FJS-1560`. The work is `junction call`'s. `callArgv` in `core/app-entry.js`
decides which app and from where: `--app <module>` from the app root, or else the
entry in the committed `surface.snapshot.md` header, run from that file's
directory. Five of the six prototype apps have no snapshot, so the typed path is
what makes it usable there. Junction is resolved through `resolveGenerator`,
now exported from `core/snapshots.js`, and not with `bunx`, which fetches a
stranger's `junction` on a machine without one.

## 2026-09-29 — the scaffold starts auth cleanup from `work()` (`FJS-D551`)

`fli new` and `fli auth:install` emit `async work() { authCleanup.start() }` in
place of `boot()`, so a new app's one-shot boots run no session sweep.

## 2026-09-29 — `fli tinker -e '<expr>'` (`FJS-1560`)

`fli tinker -e` evaluates one line and exits, over litestone's `repl --eval`. The
answer is JSON on stdout, so `| jq` reads it, and the standing prints on stderr.
It is the first half of `FJS-1560`, meant to replace the raw `sqlite3` an agent
runs against an app database. Every flag value is now shell-quoted, because the
command runs through a shell and an expression holds spaces, quotes and `$`. A
failed run passes on its exit code without the runner's `Command failed` line,
since litestone has already printed why.

## 2026-09-29 — the app's AGENTS.md reads a guide one section at a time (`FJS-1549`)

The guide table said *never read one whole* and sessions read two to four whole anyway, 88k characters across the six, all of it re-read on every later turn. The instruction is now the command: `fli outline <guide>` prints its sections with line ranges and `fli outline <guide> '<heading>'` prints one, matching on the heading's first words. No hand index was added to any AGENTS.md, since the headings already are one and `fli outline` reads them. The *3-5k tokens* estimate is gone, because nothing regenerated it. The seven stressor apps were regenerated from the template and differed from it by this section alone.

## 2026-09-29 — `register:find` and `register:amend` (`FJS-1546`)

A token audit of 77 stressor sessions counted 712 Bash calls and 1.35M characters of output spent on ISSUES.md by hand: finding a row, deduping before a filing, and about 260 Python heredocs patching one line. `fli find <terms>` searches the issue rows, the archive and the rulings for every term and prints id, status, `file:line` and title, never the body, with title hits and open rows first. `fli amend <id> --detail` appends to an open row's Detail after ` · ` and re-dates Verified. A closed row is refused, since a regression is a new row. Like `file` and `close`, a write `register:check` finds a new error in is put back. `register:overview` and the `fix-next` skill name both, and so do `IDEAS/stressors.md` and each stressor's `PLAN.md`.

## 2026-09-29 — `register:archive` ages § Closed out to the archive

Nothing ran the trim both registers describe, so § Closed reached 1,122 rows against a limit of about 40 and ISSUES.md 2.3 MB. `fli register:archive` keeps the newest 40 (`--keep`), moves the rest verbatim to the top of `ISSUES_ARCHIVE.md`, restates the archive's count line, and repoints every `.md` link that resolves to a moved anchor. A write `register:check` finds a new error in is put back, every file of it.

## 2026-09-28 — `css-token-undefined` counts the app's own stylesheets (`FJS-1532`)

The rule counted the tokens a dependency's CSS declares and the tokens a file declares for itself, so a token an app sets once in its theme and reads from a component was an error. It now also reads every `.css` and `.scss` under the app's client surfaces, `content/` included and `dist/` excluded. An app whose dependencies ship no CSS is still skipped. Found by the ksite stressor, whose `Stars.mesa` reads `--star-tracking` from ksite's own `themes/ksite.scss`.

## 2026-09-28 — `fli new` stops asking a site-only app for an encryption key

The closing hint `fli keygen aes ... ENCRYPTION_KEY  # .env needs a key before the API starts` printed for every template with a blank key, including `site-only`, `widgets-only` and `extension-only`, which have no API to start. It prints only when the app has an `api/` now. Found by the ksite stressor, Phase 0.

## 2026-09-28 — `tutor:live` opens its socket with the token as a subprotocol (`FJS-D486`)

Junction no longer reads `?token=` on the upgrade, so the lesson's raw socket would have connected as anonymous and the signed-in half of the lesson would have measured nothing. `openSocket` now offers `fjs` and `fjs.bearer.<token>`, and step 03 teaches that header in place of the URL.

## 2026-09-28 — the app's AGENTS.md names the guide a change needs, not all six

`fli new` wrote *Read before writing* over every framework AGENTS.md plus `catalog.snapshot.md` and `vocabulary.json`, about 136KB and 34k tokens an obedient agent paid before a one-line fix. The section is now a table from the kind of change to the one guide it needs, and the two generated files are named as lookups to search for one word, never read whole. `AGENT_DOCS` carries `when` and `lookup` in place of `covers` and `beside`. The stressor apps `remnant`, `portal`, `linear`, `connectteam` and `calendly` were regenerated from it.

## 2026-09-28 — `static-publishes-0` is deleted, and the site tutor declares columns (`FJS-D496`)

`publishes:` is a map of model to columns now, and Sierra's build refuses a number by type, so a rule warning about `publishes: 0` had nothing left to find. `FJS-1113`, which reported its message as wrong, closes with it. `static-publish-db` no longer says a declaration gets a route past a missing client, since none does. The site tutor's companion selects `id` and `title`, the one column its page renders plus the key, and step 06 declares `Note: [id, title]` in place of `publishes: 4`.

## 2026-09-28 — `ksite:serve` finds its sidecar again

When the command group moved from `commands/site/` to `commands/ksite/`, `serve.md` still built the sidecar path as `commands/site/serve.bun.js`, so every run failed with *Module not found*. The path now names `commands/ksite/`.

## 2026-09-28 — the fix loop's pre-brief carries the hazards, and a row found busy stays skipped while its collision lasts

Read back through `loop:review` over 30 attempts. Every high-effort session opened with the Explore brief `fix-next` §2 asked for, a quarter of the attempt's cost, and then oriented for 11–26 calls anyway. The pre-brief now quotes the realm hazard entries that name the row's specific identifiers, `@`-attributes and paths (and the bridge-index seams for a row across packages), and the skill sends no agent when a pre-brief is present. A busy attempt logs the row's dirty files, and a later run skips the row while that set is unchanged: FJS-1157 was found busy three runs running. An attempt that failed on the auto-mode check giving no verdict, with nothing edited, reruns on the same rung once instead of climbing to high; FJS-1430 paid $3 for that. An attempt that edited nothing no longer tells the next one the tree's dirty files are its own. The pre-brief's headless notes add single-quoting a pattern that holds a backtick, and `fix-next` §4 says how to mark a row blocked by a ruling that is already open, which a low session skipped and a high one was paid to write. `loop:review` no longer reads the next line's command as the file a `| head` printed.

## 2026-09-28 — the scaffolded `getLevel` grades a guest holding only a claim STRANGER (`FJS-1447`)

A resolver's claims reach the Data boundary as `$setAuth({ ...claims })`, an object with no `id`, and both scaffolded `getLevel`s (`fli new`'s `api/src/core/gate.ts` and `auth:install`'s `GatePlugin`) tested only `!user`, so a guest graded USER and a `gate: 0` method wrote as them past every `@@gate` at 4, stamping a null `@system` owner. Each now answers STRANGER for a principal whose `id` is null; every session reaches Litestone through `toDataPrincipal`, which carries one. `test/app-config.test.js` runs both generated functions rather than matching their text.

## 2026-09-28 — `css-raw-literal` sees a named color (`FJS-1432`)

The rule matched hex and color functions only, so `background: blue` passed. It now also reads each declaration value for the CSS named colors, case-insensitive; a selector's `.blue` is a class and is not read, and `transparent` and `currentColor` are not colors a theme owns. A fourth test in `test/checks.test.js` pins both halves.

## 2026-09-28 — `css-raw-literal` leaves a breakpoint alone and counts `1rem` as a length (`FJS-1430`)

A `@media`, `@container` or `@supports` condition cannot read `var()`, so a breakpoint was reported with a fix no media query can take; the prelude is blanked now. And the hairline exemption was written as *a single digit 1*, which let `1rem` and `1em` — sixteen pixels — pass beside a flagged `.5rem`; only `1px` is exempt now. A third test in `test/checks.test.js` pins both. With them the rule reports nothing across example and basecamp.

## 2026-09-28 — `fli check` sees a raw color or length in a hand-written `<style>` (`FJS-1429`)

`css-token-undefined` reads only `var()` references, so the never-a-color rule the app's AGENTS.md cites it for had no enforcement outside the generator grep. `css-raw-literal` (warn, Invariant 13) reports a hex color, a color function, or a px/rem/em length above 1px in a `.mesa` `<style>`, skipping comments, a custom-property declaration and anything inside `var()`. Warn rather than error because example and basecamp carry such literals today; each is a baseline entry or a fix.

## 2026-09-28 — `fli make:route` writes no literal color or size (`FJS-1220`)

The resource page had already moved onto `crud-templates.js` (`Alert tone="danger"`,
no `.err`), but `--layout` still wrote `<style>` with `#6b7280`, `#111` and `px`
gaps. It now writes `<nav class="cluster">` and `.navlink` with `aria-current`,
the vocabulary's own nav, and no `<style>`. `test/generators-run.test.js` greps
every `make:route` shape for a hex, `rgb()` or `px` literal, since
`css-token-undefined` reads only `var()` and cannot see one.

## 2026-09-27 — `fli check` accepts the `Lens.mesa` `fli make:resource Lens` writes (`FJS-1421`)

`resource-file-name` said *Lens.mesa should be Len.mesa* and failed CI on a
generated file, and `model-name-plural` warned on `model Lens`, because
`looksPlural` asks toolbelt's `singularize` and it answered `Len`. Fixed in
toolbelt; `test/checks.test.js` pins both rules on the generated shape, and goes
red with toolbelt's fix stubbed out.

## 2026-09-27 — the decision-rules hook fires on a write, not on a mention

The two Bash hooks in `.claude/settings.json` matched `DECISIONS.md`, `IDEAS/*.md`
or litestone's parser/catalog anywhere in a command, so `rg` over the register
drew "Register write" — an alarm that rings on reads is skipped on the write it
exists for. The four path hooks are one, `.claude/hooks/guarded-write.mjs`, over
`core/guarded-write.js`: Write/Edit graded by path as before, Bash only where the
guarded path is a write target. `test/guarded-write.test.js` pins both directions.

## 2026-09-27 — `fli check` compiles every `.mesa` in a surface (`FJS-1228`)

`bun run check`, the whole of a scaffolded app's CI, read nothing in the UI
realm's language: rules parse `.mesa` for structure, Biome cannot read one and
tsc is told not to, so an unclosed `{#if}` or a RULE 7 watch merged green and
failed at `vite build`. The new `mesa-compiles` rule (error) runs sierra's
`@frontierjs/sierra/check` in a child `bun` from each surface directory — the
compiler is async and `runChecks` is not, and resolving from the surface uses
the copy that surface builds with — and reports Mesa's own diagnostic at the
file and line. A surface that cannot resolve sierra is skipped. The clean-app
test links sierra in, so the rule RUNS over CLEAN's `.mesa` rather than
skipping; `test/checks.test.js` § mesa-compiles holds the broken route, the
frontmatter/fence/slot preprocessing and the unresolved skip.

## 2026-09-27 — `service-model` judges a service by the name junction registers it under (`FJS-1218`)

The rule read the raw file name, so `order-lines.service.ts` singularized to
`order-line`, matched no accessor, and every multi-word service with no
`model:` was an `error` saying it failed open. Junction's registry camelises
the file (`orderLines`), which singularizes to `orderLine`, and measured on the
calendly stressor the gate and validation both apply. The rule now camelises
before resolving, so it fires only where no model answers the name. Its `--fix`
went with it: a model the schema holds under the name now resolves, so there
was never a model left to write in.

## 2026-09-27 — a generated list, create or detail page lays its body out in one `.stack` (`FJS-1225`)

The three templates in `core/crud-templates.js` emitted the header, alerts,
filter bar and table as flat siblings, and nothing from `<main class="screen">`
down carries a vertical gap, so the filter bar sat flush on the table on every
generated screen. Each body is now wrapped in `<div class="stack">`, the
spatial helper `@frontierjs/css` already names for a page body.
`test/generated-mesa.test.js` asserts the wrapper on every generated page.

## 2026-09-26 — every generator that writes a Resource or a page over one is executed and graded by `fli check` (`FJS-372`)

`test/generators-run.test.js` runs `make:model --resource`, `make:route
--resource`, `web:route --resource` and `admin:generate` into a temp app and
hands the result to `runChecks`, asserting `resource-file-name` and
`resource-script` RAN and nothing fired. The page generators run after
`make:resource` and `admin:generate` beside a service, since over an empty app
each writes nothing and every rule about its output skips. Its first run found
`make:model`'s default `@@gate("0.4.4.6")` tripping `gate-unreachable`; that is
filed as `FJS-1385` and the case tolerates that one rule until it closes.

## 2026-09-26 — `deploy:setup` installs a pinned, checksum-verified litestream (`FJS-243`)

`deploy:setup` checked for docker, nginx, git, bun, rsync and sqlite3 and never
for litestream, so the replication binary reached a server however the operator
found it — and apt still serves 0.3.x, the build that loops on STRICT tables
and replicates nothing. `LITESTREAM_PIN` in `deploy/_module.md` names v0.5.17
and the sha256 of its linux x86_64 and arm64 tarballs, copied from upstream's
checksums.txt; `litestreamInstall()` fetches upstream's release, refuses it
unless `sha256sum -c` passes, and refuses an architecture with no pinned
digest. `01-check-deps` lists litestream with that script. The generated
Dockerfile never fetched litestream, so it has no digest to pin. Tests in
`test/deploy-helpers.test.js`, including a stubbed curl returning the wrong
bytes that must install nothing; the real fetch was run once by hand and
installed a working 0.5.17.

## 2026-09-26 — `fli next` tells a framed ruling from an unframed one

`fli next` printed every open decision row under *waiting on a ruling, with no
options written yet*, including rows whose id already led a bullet with options
in a paper. On this tree that was 14 rows, and all 14 had options. `rankNext`
now splits `decide` into `framed` and `rows`. `framed` is the rows a
decidable bullet names, printed under *options written — fli decide*. `rows` is
the rest, printed under *no options written yet — /frame-next*. The test is in
`test/owed-ruling.test.js`: a row is listed as unframed when it is filed and as
framed once it is argued.

## 2026-09-26 — `make:route --resource` writes the list, create or detail page its path names (`FJS-1261`)

`make:route <path> --resource <Model>` wrote one page for every path. That page
imported `$onDestroy` from the mesa runtime, which exports no such name, so the
build stopped. It also carried a raw hex on an undefined class. Every route got
the same `useStore` list: a detail route rendered the whole list under its
heading, and a create route rendered no form. A list written as `employees.mesa`,
followed by the next example in the command's own help, left `employees.mesa`
beside `employees/`, and the build refuses that pair as a route conflict.
The page now comes from `resourceRoutePage` in `core/crud-templates.js`, the
module that writes `make:scaffold`'s three pages. The last segment of the path
picks the page: `[id]` gives the detail page, `create` gives the create page
rendering `<Model />`, and anything else gives the list. The list is written as
`<path>/index.mesa`. A detail keyed by any param other than `[id]` is refused,
because the detail page reads `page.params.id`. A plain page whose directory
already exists becomes that directory's `index.mesa`. A route under `x/` is
refused while `x.mesa` exists, and the error names the move. Moving the file
for the user would break its relative imports. `test/generated-mesa.test.js`
compiles and parses all three pages. It also pins the kind, the file and the
import depth for each path shape. Stubbing the path choice turns 9 of its tests
red.

## 2026-09-26 — A resumed deploy starts the image its adopted transition recorded (`FJS-937`)

`04-build-api` runs before `04c-journal` opens, so a `--resume` always
rebuilds. It then adopts the open transition, whose `04-build-api` row
already names the interrupted run's image. `openDeployJournal` only marked
`pending` pre-journal rows done and left a recorded row alone, so the
recorded image never came back onto the run. `06-swap` started this run's
rebuild instead. A cached rebuild is the same image, so this showed only when
the build context moved between the kill and the resume. That happened when
another session was editing the tree during a CI run. The container then
served bytes the journal did not name, and a revert-of-revert restored the
recorded image, which was not the one that had been serving. The pre-journal
loop now restores a replayed step's recorded note and discards this run's
note, the same way `beforeStep` handles a skip. `restoreStepNote` now
overwrites `imageIdentity` instead of keeping the rebuild's. The deploy cycle
in `scripts/scaffold-build.mjs` now writes a file into the build context
between the kill and the resume. It asserts the resumed container runs the
image the killed run built. With the fix stubbed it goes red with *the resume
started sha256:3729f563078a, not the image its adopted transition recorded
(sha256:604775940a74)*, and with the fix the whole cycle is green.

## 2026-09-26 — A CI run links into a fence, not the machine's global `fli` (`FJS-1364`)

`fli new --source local` runs `bun link` in every package it needs, and bun
keeps one global link per name, so CI's deploy and tutor phases in a temp clone
re-pointed `~/.bun/bin/fli` and every `@frontierjs/*` link into that clone.
The standalone `scripts/scaffold-build.mjs` did the same. `core/bun-fence.js`
points `BUN_INSTALL` at a temp dir for the run and leaves the package cache
where it was, so installs stay warm. `scripts/ci.mjs` and the standalone
`scaffold-build.mjs` fence themselves at start, so every child inherits the
fence, and remove it on exit. The link bun writes into the app points at the
source tree rather than through the fence. `test/bun-fence.test.js` runs a real
`bun link` and `bun install` under a fake HOME. It goes red when the fence
drops `BUN_INSTALL`. A real `fli new --source local` run from a fenced node
parent linked ten packages into the fence and left the machine's global dir
unchanged.

## 2026-09-26 — `tutor:access` runs past its policy step on a scaffolded app (`FJS-1367`)

Step 06 put `@@auth` above User's `@@gate("4.4.4.5")` every time, and
`fli new --auth` has written `@@auth` there since FJS-737, so the push that
followed was refused as a duplicate (FJS-1174) and the lesson stopped. The
step now adds it only when no line in the schema already declares `@@auth`,
which is what its prose already said it did. Proved by running
`fli tutor:access --tmp --yes` before the change (step 06 fails on *@@auth is
declared twice*) and after it (all nine steps pass).

## 2026-09-26 — `git:status --hubs`: the amber rows as a bare list

`fli gs --hubs` prints only the edited files named by more than fifteen others,
one repo-relative path per line, most reach first, and nothing else, so it
pipes. The threshold is the listing's own amber band (`hubsOf` in
`core/git-status.js`), so the two cannot disagree about what a hub is.
`--with-new` adds untracked hubs, as it does for the listing.

## 2026-09-26 — a row can say it is for a person, and the fix loop passes over it

`fix:loop` took FJS-009, whose proof is a ten-minute CI run in a fresh clone.
The session backgrounded the run, said it would read the result later, and
ended, since a headless session stops when it stops calling tools; the attempt
cost twelve minutes and closed nothing. A row now declares `by hand` as its own
segment of the links cell, the way `blocked by` is written, and `fli next`
reports it as `byHand` and marks it *(by hand)* while keeping it ranked, since a
person reading the list is who it is for. `scripts/fix-loop.mjs` skips it. Prose
that says someone did a thing by hand is not the declaration; `next.test.js`
holds both halves.

## 2026-09-26 — a committed page is graded against the tree, not this disk

The runner annotations name the phase again, and on `573cfd30` two of the four
failures were one defect: a check reading the DISK where the question was the
tree a clone holds. `ws:seams` walked `packages/` and counted callers in
ignored build output (`basecamp/web/config/routes.js`, vscode's `out/`), so
`resource.options(field)` had six sites here and four on a runner, and the
committed page was stale on every fresh checkout. `register:check` called a
link live when `existsSync` found it, so a row linking `packages/css/dist/` or a
sibling `../fjs-prototypes/` checkout passed here and was ninety dead links
there. `core/tree.js` is the one reading of *in the tree* — tracked files plus
untracked ones git does not ignore, `null` without git so a plain directory
still falls back to the disk — and both read it. A link leaving the root is
another repository's claim and is no longer graded; `repo-map.js` had already
made the same move for its file counts. `test/register-check.test.js` and
`test/checks.test.js` each build a git fixture with an ignored file on disk.

## 2026-09-26 — a choice met mid-fix is filed and waited on, not asked and stopped at

`fix-next` met a design choice by stopping to ask, and `fix:loop` ended the
whole run on it, so one question parked every row behind it and the question
itself lived only in a log. Now the fix files it and moves on.
`fli file --sev decision` writes a row into § Needs a decision under the next
`D` id, and `--blocks <row>` writes `blocked by <that id>` into the held row, so
`fli next` sets that row aside. The options go in a paper bullet naming the id,
in `IDEAS/owed-rulings.md` when no paper argues the question. `decide` answers
such a bullet under the row's own id and closes the row in the same act (a
settle closes it citing the existing ruling), which is what lets the held row
come back with nothing edited by hand. `close.js` gives up `moveToClosed` for
that reuse. `fix-loop` reads *blocked* off the register and goes on to the next
row. `/fix-next --ask` keeps the old behavior, putting the choice to you in the
session. `test/owed-ruling.test.js` walks file → block → pick or settle →
unblocked, red with the row lookup stubbed out.

## 2026-09-26 — `fli proves` reads what changed, not what moved, and it sees new files

A test-only change listed 13 drives under `fli done`, and the `client.js` split
named 40. None of them was needed. There were four causes:

- **New files were invisible.** `changedTree` read `git diff HEAD`, which has no
  untracked file in it, and `fli done` saw only their names. So every line moved
  into a new module read as deleted from the old one. `changedTree` now includes
  untracked files with their content (`git diff --no-index` against
  `/dev/null`). It is the one reader for `test:proves`, `test:prove`,
  `test:done` and the GUI's `/api/proves`. `done.js` keeps no filter of its own,
  and `server.js` keeps no git reading of its own. `--relative` does the job the
  server's prefix code did, for a project below the repository root.
- **A moved line counted as a changed one.** `changedLines` cancels a line
  removed in one place against the same line added in another, ignoring
  whitespace and a leading `export`. It skips four kinds of line that name a
  symbol without changing it: hunk headers, comments, imports, and a bare list
  of names.
- **A symbol matched as a substring.** `find` matched `findMany` and `Product`
  matched `ProductVariant`. A symbol is now a whole identifier.
- **Every changed file fed every tier.** A test proves itself, a document names
  every symbol it explains, and a snapshot names every symbol in the repo. The
  area and package tiers now read only `changesBehavior` files. The symbol tier
  reads only code (`holdsSymbols`), because a changed line is read whole: a
  command's prose is English, and the one line of a package's test script names
  every test file it runs. A path a row names still matches any file.

Replayed over the last 40 commits, the matched rows go from 1,755 to 676. The
biggest drops are documentation sweeps and renames. On the split's litestone
files the matches go from 40 to 9: the two `client` area rows, which name the
drives that change needed, and seven rows that name only the package. `fli done`
now folds package-only rows into one count line. `fli proves` still lists them.

`kindOf` moves from `codegraph.js` to `core/file-kind.js`, so the proof table
and the codegraph read one classifier. The move also fixes it: any path under a
`build/` directory was `generated`, which took sierra's and jetty's
`src/build/` off the codegraph. That is 26 files, the build pipelines included.
A `build/` under `src/` is source now.

## 2026-09-26 — `fli register:overview`: the two register loops, with today's counts

Seven register commands, two loops and two skills had no one place saying which
comes when. `register:overview` prints the issue loop (`next` → fix → `close`,
`file` for a new defect) and the decision loop (open → framed → `decide` or
`decide --by`), each step with its command and a count read by `rankNext` and
`openDecisions`, then one *Start here* line. The `fix-next`/`frame-next` skills
and the `fix:loop`/`frame:loop` scripts are project files, not fli's, so each is
named only where the project has it. `register/_module.md` drops its hand-kept
command list for a pointer, since `fli register` already prints the list from
the commands. `test/register-overview.test.js` resolves every command and flag
the overview names against the command files (red on a renamed `--how` and on
an unknown command), and checks its counts against the readers.

## 2026-09-26 — `fli decide` with no id walks the queue, one key per question

55 questions carried options and each needed a typed `fli decide <id> <letter>
--section "…"`. `core/decide-walk.js` shows them in turn — the settled ones
first — and a key answers each: the option's letter, Enter for the
recommendation, `s` skip, `v` open the paper at the question, Esc stop. A pick
against the recommendation opens `$VISUAL`/`$EDITOR` for the reason, and an
empty save goes back without ruling. The section is a number, and Enter repeats
the last one. It writes only through `decide()` and `settle()`, so it has their
refusals and put-back. With no terminal it refuses and names the typed form.
The walk hangs off the writer rather than `fli decisions --walk`, so the read
command stays read-only, as its `GET` twin in the GUI is.

`openDecisions` gains `settled`: an open question whose recommendation names a
live ruling — the shape `frame-next` writes — carrying that ruling as `by`, and
no longer counted in `open`. `settledBy(q, live)` is the one reader;
`scripts/frame-loop.mjs` grades with it and `fli decisions` lists them. Seven
tests in `test/decide-walk.test.js` script the terminal over real register
files. Driven once in a pty, settle then pick then section, and once through a
stand-in `$EDITOR`.

## 2026-09-26 — `fli decide <id> --by <ruling>`: a question an existing ruling already answers

A question the tree had settled before anybody framed it had one way out:
write lettered options so `decide` would take it, and `decide` then minted a
second ruling id saying what the first said. `settle()` in `core/decide.js`
strikes the question in its paper citing the existing ruling and writes nothing
to `DECISIONS.md`. It needs no options. The reason is the recommendation's when
that names the ruling, and `--why` otherwise — `decide`'s own rule. It refuses
an unknown ruling, a withdrawn one, and a superseded one, naming what replaced
it, all read through `readRegisters().decisions`. It has the same
`register:check` put-back as a pick. `pick` is optional on the command, and
refused beside `--by`. Three tests in `test/decisions.test.js`. This is the
`settled` outcome the frame loop will report and the walk will confirm.

## 2026-09-26 — fli under bun writes its whole output to a pipe (`FJS-1361`)

`fli decisions --json | jq` parsed 8192 bytes of a 275 KB document. Under Bun,
once anything has touched `process.stdout`, `console.log` to a pipe makes one
write to the non-blocking fd and drops what did not fit, silently; `echo` is
`console.log`. The installed `fli` runs on node and never saw it, but every test,
CI phase, tutor step and fli-from-fli call (`config.fli`, `release-view.js`)
runs it under `process.execPath`, which is bun. `bin/fli.js` now routes
`console.log`/`info`/`debug` through `process.stdout.write` under bun, which
queues and drains. `test/pipe.test.js` echoes 2 MB behind a shell pipe — red at
8192 without the patch. A shell pipe and not `spawnSync`: the latter drains
fast enough to lose only past ~219 KB.

## 2026-09-26 — `fli prove <paths>`, the verdict printed last, and known failures named

The first loop run with `fli prove` closed a row in 19 turns, 7 of its 9.7 minutes
proving, and three things about `prove` cost most of that. It proved the whole
shared tree — eleven drives for a one-file fix — so `prove` and `proves` take
the paths to prove (`changedTree({ paths })`). It printed each failure's tail
under its ✗ line, so `| tail -15` showed a stack trace and the session reran the
set twice to find the verdict; the tails now print first and the ✓/✗ lines
last. And telling a known failure from a new one took a register search, two
reruns and a HEAD worktree; a failed drive now names the open rows that name it
(`open: FJS-1272`), `knownFailures()` in `prove.js`.

## 2026-09-26 — `fli prove` runs the drives `fli proves` names; `fli file` files a row

A headless fix spent seven of thirty turns proving: reading the *Start first*
cell, starting the API, polling its port, running the drive, stopping what it
started — spawn-and-poll written by hand, in a shell where backgrounding a
server is unreliable. `fli prove` does those steps from `DRIVES.md` in order and
prints one line per drive with the tail of a failure. `core/prove.js` owns the
order only; spawning and the process-group kill stay `children.js`'s. A server
port that already answers fails the drive by name instead of being reused
(`FJS-740`). Proved on `example`'s `verify:jobs`: seed, API up on 8110, 19
assertions, port free after, 14s. `changedTree()` in `proofs.js` is now the one
reader of the diff for both `proves` and `prove`.

The same session spent three more turns finding how to file what it had found,
then wrote the row with a script. `fli register:file` (`fli file`) takes
`--sev --area --title --detail`, mints one past the highest id the registers
hold anywhere, tops that severity's table, and is put back when
`register:check` finds a new error. `oneCell` and `isoDate` are exported from
`close.js` rather than copied.

## 2026-09-26 — `fli gs` prints one row per file, with the file's own churn

A role packed its files onto one wrapped line per directory, so
`snapshot  repo-atlas.snapshot.html repo-report.snapshot.html` had to be split
back into files by eye. Each file is now its own row — role, dim directory,
bright basename, `↑n` — with its `+added -deleted` in a column aligned down the
whole listing. `collapse()` became `splitRel()`, one path's directory and
basename; the status glyph leads the row rather than sitting inside the path.

## 2026-09-26 — `fli outline`: a file's shape as line ranges, and one row printed by name

A 4700-line module was read in guessed `sed -n` windows, three tries to land on
one function. `fli outline <file>` lists every function, method, class, type
and object literal three lines or longer (headings, for `.md`) with the lines
it spans — 135 rows for junction's `litestone.ts`, 72 for the 13,808-line
`DECISIONS.md`. `fli outline <file> <symbol>` prints that row's body numbered:
a name, a dotted path through ancestors in order (`makeTable.update`), a
substring, or a line number, which names the innermost row holding it. A body
over 500 lines prints its outline instead unless `--full`; two matches print
both paths and exit 1. A range starts at the comment attached to the row.

A row opens onto its children at 150 lines unless they average under 8 each —
a heading over forty five-line rulings is a list, reached by name. Code is read
with the project's TypeScript found by walking up from the file.

A `.lite` is its top-level blocks, found by brace depth over toolbelt's
`tokenize` — the lexer litestone parses with — so the kind is whatever words
stand before the `{` (`extend model User`) and no keyword list can fall behind
the grammar; 923 rows for the 17,716-line `erpnext.lite` in 0.4s. A `.mesa` is
its `<script module>`, `<script>`, `<style>`, markup and front matter, with each
script's functions at the file's own lines (every line outside the script is
blanked before it is parsed). A block is one opened at column 0, which all 460
tracked components do; the suite sweeps every tracked `.lite` and `.mesa`.

`functionName` moved out of `measureFunctions` so both readers name a row the
same way, and gained two answers the codegraph also gets: a constructor is
`constructor` rather than `(anonymous)`, and a suite callback is named by its
title, `test('clears on null')` rather than `test(…)`.

`.claude/hooks/outline-hint.mjs` is a PreToolUse hint — never a block — in
front of a Read with no `limit` or a `sed -n 'a,bp'` window on an outlinable
file of 1000 lines or more. Its policy is `wideRead`/`outlineHint` in
`core/outline.js`, tested in `test/outline.test.js`.

## 2026-09-26 — the `bridge-index` skill is an index; `seams.js` reads it unchanged

The skill was one 72 KB file, every word loaded on each invocation to answer
which seam owns a translation. `SKILL.md` is now one line per seam (names, what
it answers, owner) at 14 KB, and each entry's full text moved verbatim into
`references/<section>.md` beside it. `readSeams` returns the same 90 seams with
the same names, owners and sections — compared before and after — so
`seam-owner`, `seam-listed` and `seams.snapshot.md` are untouched. Only the
module's header comment changed, since it described the bullets as carrying
the prose.

## 2026-09-26 — `fli ask` reads `docs/CI.md`, `docs/TESTING.md` and `docs/PORTS.md`

The root `CLAUDE.md` moved its CI phase table, test-runner table and ports table
into those three files, and two engines — `core/checks.js` and
`core/register-check.js` — were named only in the moved text. `mapFiles` indexes
them beside the root map, so the graded set is back to every question routed.
Comments in `core/ports.js` and `core/extension-surface.js` point at
`docs/PORTS.md`.

## 2026-09-26 — `fli decisions` queues a question once, not once per register

**A § Needs a decision row whose id a live paper bullet names in its lead is
that bullet**, and is no longer queued beside it. Every row's Detail sends its
options to a paper, so each question argued there was listed twice — once as
pickable, once as *without options* — and seven rows read as undone while all
of their options were written. A ruled bullet does not hide its row, so a row
the ruling never closed stays in sight. Paired test in `test/decisions.test.js`.

## 2026-09-25 — `fli gs` lists no untracked files unless `--with-new`

Untracked files stay in the summary count (`N new`) and the per-place `?n` mark,
but are no longer listed in the groups; `--with-new` restores the full listing.
`--json` is unchanged.

## 2026-09-25 — `fli cli:build`: the `cli/` surface's release

**`fli cli:build [--target a,b]`** compiles the app's `cli/` into `cli/dist/<name>`,
with `name` from `cli/config/cli.config.js`. The build is `@frontierjs/mcp/client/build`, read
out of the app's own node_modules through `shippedFile`, so it adds no bin. A new
`cli` namespace (`commands/cli/`) holds it, a peer of `widgets:` and `extension:`.
The shared `cli/src/routes/` directory is filed as `FJS-1352`.

## 2026-09-25 — `fli register:close`: closing an issue is a command

**`fli close ELA-001 --how "…"` moves the row out of its open table and makes it
the top row of § Closed**, in that table's four columns: the id cell whole with
its anchor, the area folded in front of the title, today's date (UTC, as
`decide` writes), and a How that is `--how` followed by every link the Detail
cell held — the Detail was where the row said the defect lived. `core/close.js`
is the writer; like `decide` it runs `register:check` over the result and puts
the file back on a new error, and the before/after comparison both use moved
from `decide.js` into `register-check.js` as `errorKeys`/`newErrors`. It refuses
an unknown id, an already-closed one, an empty `--how`, a register with no
§ Closed table, and a project with no declared prefix. Trimming old closures
into `ISSUES_ARCHIVE.md` is not part of it. `test/close.test.js` runs over an
`ELA` project in `.project/`.

## 2026-09-25 — fli's amber is one export, and five terminal helpers are not built

**`amber` is exported from `core/color.js`**, where `chalk.hex('#f5a623')` was
written out five times across `bootstrap.js` and `prose.js`. The duplicate
`gray` key in the same object is gone. Output is byte-identical: the banner,
`fli help` and the help prose render the same escape code.

**`badge`, `rail`, `spark`, `bar` and an app `brand` stay out of `context.tty`.**
Each was asked for by ELA's `support:*` commands and has no second user: `badge`
is `chalk.bgGreen.black.bold(' NEW ')` (4 uses, one app), `rail` is `tty.wrap`
plus a prefix (8, one app), `spark` is one call site, `bar` has two call sites in
different shapes (a stacked bar in ELA, a single fill in `git:status`), and an
app's brand color has no origin fli can read. A `.fli.json` key would restate a
color the app keeps in its CSS. **The trigger for any of them is a second
caller hand-writing the same shape**, a fli command or another app.

**`ws:terms` no longer walks `.fli-tmp/`.** It holds a running fli's compiled
copy of every command it ran, deleted when that process exits, so a `terms.test.js`
run beside any other fli in the checkout died on `ENOENT`, and a run that
survived the race counted the words of every command that fli had run twice.

## 2026-09-25 — `fli register:atlas`: the registers as one page, for any project

**A project that keeps registers outside this workspace can now read them as one
interactive page.** `fli ws:atlas` needs a workspace, and a client app with
`"registers": { "prefix": "ELA", "dir": ".project" }` had no page at all — only
`fli next` and `fli decisions` in the terminal, and `fli gui`'s top eight.
`fli register:atlas` walks up to that `package.json` from anywhere in the app and
writes `registers.html` into the registers directory: *Next* (the ranking, blocked
rows marked), *Decide* (every question, with a button copying the exact
`fli decide … --section "…"` line, adding `--why` when the pick is not the
recommendation), *Issues*, *Rulings*, *Ideas* and *Closed*, each faceted and
filterable, every record expanding to its text, every citation jumping to the
record it names, every file opening in the editor at its line. `core/register-atlas.js`
reads through `readRegisters`, `readDecisions` and `rankNext` and parses nothing.
A register link is relative to the file it is written in, so each one is resolved
there and then re-expressed from the page's directory — asserted in
`test/register-atlas.test.js` by checking every link names a file that exists,
from three output directories. The stylesheet is the tree's own, else the one this
`fli` carries, since a client app installs no `@frontierjs/css`. **Not a
snapshot**: the ranking reads git history, so the page carries no generator line,
is git-ignored here, and the command warns when it lands somewhere that is not
ignored. `test:browser:registers` drives it in Chrome over a fixture and over this
workspace (13 assertions). `terms.js` exports its page-theme names for it, and
counts `registers.html` among the generated files it keeps out of its corpus.

## 2026-09-25 — `fli ws:atlas` reads a project's declared registers

**The atlas draws a project that is not a monorepo.** `repo-map.js` kept its own
issue reader with `FJS-` in it, and its decisions and ideas readers looked at the
root; all three now go through `registerLayout`, and the model over this repo is
identical key for key. The command takes the root from `findWorkspaceRoot`, then
`findRegisterRoot`, then `wsRoot()`'s prompt — so a project with no `packages/`
(`elitelawncare/ela`, registers in `.project/`) renders its registers instead of
asking for a workspace. The idea ranking still reads only `## Wave N — …`
tables, so a project whose `overview.md` ranks under another heading shows its
papers and no ranking.

## 2026-09-25 — `cli/` is a surface to the two lists that name them

Basecamp grew the first `cli/` (`FJS-D397`, Invariant 3). `core/git-status.js`'s
`SURFACES` groups a change under `packages/basecamp/cli/` as that app's CLI surface
rather than as repo files, and `core/doc-audit.js`'s `AMBIGUOUS` stops grading a
prose path like `cli/src/routes/` as a file this repository must have — it names the
app being built, the way `web/src/` does. `packages/cli/` is unaffected: `packages/`
is held whole before either list is read.

## 2026-09-25 — `context.tty`: a command that holds the terminal, and gives it back

**A command that stays open — a keypress menu, a status line, the screen lent
to an editor — no longer writes raw mode, escape codes and signal handling by
hand.** `core/tty.js` is `context.tty`, destructured in the compiled body the way
`log` is: `keys(question, { y: 'yes', … })` takes one keypress (Enter picks the
first choice of a question, shown `[Y]es`; Esc only when a choice is named
`esc`; a `null` question listens without taking the footer, and has no default,
so Enter at a menu does nothing), `live(render)` pins a footer
whose array parts drop from the right to fit, `aside(fn)` lends the screen to
`$EDITOR` and holds this process's output until it returns, `onExit(fn)` runs on
a return, a throw, Ctrl-C and SIGTERM under a 3s cap, and `title`, `wrap` and
`width` cover the rest. **Output prints above the footer with nothing routed
through `tty`**: `process.stdout`, `process.stderr` and `console` are patched
while it holds the terminal, and `console` separately, because Bun's writes to
the fd without calling `process.stdout.write`, which a first run under a
pseudo-terminal showed as `log` lines landing on the footer's line. **The
terminal is put back on every path**: `Command()`'s returned functions close the
tty in a `finally`, the runtime's SIGINT/SIGTERM handlers await `settleTtys()`
before exiting, only a second SIGNAL skips onExit, and a bare `process.exit`
still restores raw mode and the title on the `exit` event. `context.stream`'s
own signal branch goes through the same stop, since a child killed by the Ctrl-C
reached `process.exit` first and cut onExit off, and inside `aside` it rejects
instead, because that Ctrl-C was the child's. `context.exec` cannot yet — it is
synchronous, so the handler never runs first (`FJS-1350`). With no terminal, or
under `fli gui`, `tty.interactive` is false, `live`, `title` and `aside` add
nothing, and `keys` refuses by name or, given `--yes`, answers its first choice.

**zx's `chalk`, the one a command body gets, now follows fli's color rule.** It
colored a terminal with `NO_COLOR=1` set, and it colored every PIPE through
`chalk.hex`, `rgb` and the `bg` forms: zx wraps chalk in a Proxy whose `get`
answers `store[key] || default[key]`, so a level of 0 reads back `undefined`, and
`undefined <= 0` is false where chalk decides to style: a piped body's
`chalk.hex('#9fc612')('l')` printed `\x1b[33ml\x1b[39m`, and `project:map` is one
command that calls it. Setting `chalk.level = 0` cannot fix it,
since the 0 is what gets lost, so `runtime.js` imports `zx/globals` first and,
wherever `colorEnabled` is false or chalk found no color, replaces the global
with a chalk that styles nothing, chains and `hex('…')` included.
`workspace:publish` kept its own `context.config.tty` boolean for *is there a
terminal*, which now collides with the destructured name and is
`tty.interactive`, which is also false under `fli gui`, where the old boolean
was not. `test/tty.test.js` is the fakes-level half and runs under `script`:
Ctrl-C at a keys prompt, during `context.stream`, and inside `aside`, and chalk
in a pipe and under `NO_COLOR` at a terminal, each mutation-checked red. ELA's
`support:online` was moved onto it and driven in a pseudo-terminal against a
stand-in API: list, open, Esc, help, Enter, `q`, with *away* posted by onExit.

*Decision rules* (answered late: the proposal priced every piece and was
approved before these were written). Origin: one — the terminal state lives in
the tty, and `interactive` replaces a boolean the publish command computed for
itself. Concept: one noun, `tty`, chosen over `ui`, which already names a realm
and a package. Complexity: the problem's — raw mode, a redrawn line and signal
ordering are what the terminal is; the badge, rail, sparkline and bar helpers
were cut until a second app wants one. Predictability: `keys` answers `yes` the
way `prompt.js` does and marks the Enter choice upper-case, as `confirm`'s
`(Y/n)` does. Derived: `interactive` is computed once from `emit` and both
streams' `isTTY`. Owner: `prompt.js` still owns line prompts, and `tty.js` owns
keypresses, the footer and exit; the signal path stays the runtime's `_stop`,
which the tty feeds rather than replaces. Boundary: named on `context`, and an
author's own `tty` variable fails to compile at its `.md` line through
`command-parses`. Failure: `keys` with nobody to answer refuses, since a hang is
the worst outcome, while `live` without a terminal is silent, since a missing
status line destroys nothing. Silence: a terminal left in raw mode must be put
back on every exit, and `tty.test.js`'s pseudo-terminal runs fail when it is
not; the `exec` path is `FJS-1350`. No § IV row is in tension beyond
*preservation vs. evolution*, which renamed publish's `config.tty` without an
alias. Tier: Map (README § The context, package `CLAUDE.md` layout) and
Register (this entry, `FJS-1350`).

## 2026-09-25 — the registers read any project: a declared prefix and a declared folder

**A project that is not this one can keep `ISSUES.md`, `DECISIONS.md` and
`IDEAS/` and have every `register:*` command read them.** The root
`package.json` declares `"registers": { "prefix": "ELA", "dir": ".project" }`
(`dir` defaults to the root), and `registerLayout()` in `core/registers.js`
turns it into every id pattern the readers use — the issue row, the ruling
heading, the prose lead, the trailing id, `supersededBy` and the citation scan
— so `FJS-` is no longer written into a regex anywhere in the register path.
`decide` mints `<PREFIX>-D<n>` into the declared folder and links the paper
from there; `next`'s `blocked by` reads any prefix and keeps the ones naming an
open row. A record's `file` is relative to the project root, so `dead-link`'s
two readings — from the record's file, and from the root — hold unchanged for a
register in a folder. The four `register:*` commands find the project with
`findRegisterRoot`, the nearest `package.json` declaring `registers`, so a run
from inside a package or a surface reads the project's registers rather than
refusing. This repo declares `FJS`; the reader's output over it is byte-identical
to the hardcoded one (6.2 MB of records compared). `test/register-layout.test.js`
is an `ELA` project in `.project/` through the reader, the check, `next` and
`decide`.

*Decision rules.* Origin: `package.json`, not `.fli.json` — that file is
`findProjectRoot`'s marker, and one at a monorepo's root would claim every
nested app beneath it. Concept: no new noun; *register* and *prefix* were
already the words. Derived: the patterns are built from the one declaration.
Failure: an undeclared or malformed prefix is refused by `register:check` and by
`decide` with the key named, never defaulted to `FJS` — a default is how an
`ACME-` register graded clean (`FJS-916`). Silence: a row under another prefix
is still counted as unparsed. Not done: the file-per-record migration
(`IDEAS/registers.md`), which would remove the prefix patterns entirely.

## 2026-09-25 — `effects` and `confirm: human`: a command says what it does, and who must say yes

**A command that reaches past this machine can say so, and one that must not run
unattended is refused.** `effects: sends a message to a customer` is printed by
`--help`, the namespace listing and the GUI form, and arrives in `fli list --json`
with the rest of the frontmatter. `confirm: human` adds enforcement in `Command()`,
before the body: at a terminal the run goes ahead, and anywhere else — an agent's
shell, a pipe, `fli gui` — it is refused unless `--approved` is passed, a flag fli
adds to that command rather than one it declares. `fli list` marks the command
*a person confirms*; the GUI asks on Run and sends `approved` on a yes. `--dry`
does not skip it, since a dry run's harmlessness is the command's promise. The GUI
runs a command in process, whose stdin is whatever terminal `fli gui` was started
from, so a run with `emit` is never counted as a terminal. `core/effects.js` holds
the rules; `confirm` has one value, `human`, and any other, a `confirm` without
`effects`, or an `approved` the command declares itself is refused on every run.

*Decision rules.* Origin: the frontmatter; every listing reads it. Concept: two
keys, `effects` and `confirm` — `effects` alone is useful for any command with
consequences, and `confirm` says who approves. Complexity: the problem's — a
message to a customer cannot be unsent, and the rule lived only in an agent
skill's prose. Predictability: a pre-run refusal beside `requires` and required
arguments, and `approved` is fli's the way `dry` is. Derived: `--approved`
comes from `confirm` and is never declared. Owner: `Command()`, which already
owns the refusals before a body runs. Boundary: the gate precedes `run`, so no
body can forget it. Failure: a refusal, since the mistake is irreversible (§ IV
*ergonomics vs. strictness*). Silence: a `confirm: human` run without a terminal
or `--approved` fails `test/effects.test.js` and
`test/browser/specs/command-confirm.spec.mjs`; an agent passing `--approved`
itself, and a command with consequences that declares none, are `none` — the
first is the agent host's permission rule to hold.

## 2026-09-25 — JSON is `--json` on every command (`FJS-D401`)

**Five commands offered the model as `--as=json` and 32 as `--json`.** The five
move: `ws:atlas`, `ws:terms`, `project:map` and `project:codegraph` keep `--as`
for the pages a person reads, now declared with `choices`, and gain a `json`
boolean; `app:atlas` had one page, so its `--as` is gone. `--json` beside a
non-default `--as` is refused, since the two are different answers to one run.
`project:map --as=Serve` used to be lowercased and is now refused — the
`choices` compare is exact — and its unknown-value refusal set no exit code,
which the runtime's refusal does.

**`flags.js` refuses an `as` offering `json`**, and `--as=json` against a
command with `--json` ends its refusal with *the model is `--json`*. The
repo-report footer names `--json`.

## 2026-09-25 — a flag is named for what it does, and declares its bounds

**`no-push` is no longer a declaration.** Minimist reads `--no-push` as
`{ push: false }`, so a flag declared `no-push` needed `getConfig` to translate
the negation back, and one thing had two spellings. The translation is gone and
the eleven declarations are positive booleans with `defaultValue: true`:
`push` (`git:release`, `ws:pub`), `changelog`, `commit`, `check`, `build`,
`git`, `images`, `routes`, `resource`, and `tests` for `npm:release` — not
`test`, which is the built-in NODE_ENV switch and hidden from help. What is
typed is unchanged, apart from `npm:release --no-test`, which is `--no-tests`
now. A `no-*` declaration is refused on every run, naming the flag it should
have been. `--help`, the namespace listing and Tab completion print a boolean
that defaults on as `--no-push`, and its description says what that spelling
does.

**`choices`, `min` and `max` replace `options`.** `options` mapped each allowed
value to a replacement, had one user — the built-in `--test`, whose every reader
checks it for truthiness only, so `flag.test` is `true` now rather than
`'NODE_ENV=test'` — and refused any value mapping to `''`. `choices` is a list,
`min`/`max` bound a `number`, both ends inclusive. A value outside them is
refused with a message written from the declaration, each value of a `multiple`
flag is graded, and help prints the bound beside the type (`(number 5–90)`,
`(string table|json)`). A broken declaration is refused on every run, not only
on the one that passes the flag. `core/flags.js` is the leaf that owns all of it,
and the shipped sweep asserts no command declares a flag `getConfig` refuses.

**The GUI could not turn a default-on switch off.** An unchecked box sent
nothing, so the default came back. A switch now sends its state when it differs
from the default and the previewed command line says `--no-push`;
`test/browser/specs/command-form.spec.mjs` drives it. `choices` draws a select
and a range is the number input's own `min`/`max`.

`decision-rules`, before the first edit. **Origin** — the allowed values stay in
the declaration, and help, completion and the GUI derive from it. **Concept** —
`options` out, `choices`/`min`/`max` in, the second spelling of a boolean gone.
**Complexity** — the problem's: ELA checked a 5–90 range by hand. **Predictability**
— every boolean reads the same way, and `--no-x` means one thing everywhere.
**Derived** — the error text and the help text are both written from the
declaration. **Owner** — `getConfig` already graded types, and grades these;
`flags.js` is the one spelling for the three listings. **Boundary** — a broken
declaration is refused by name. **Failure** — refuse, as a wrong type already
does: a value outside a declared range is a mistake, not a preference.
**Silence** — must stay true: a declared bound is enforced and shown; fails
when it stops: `test/runtime.test.js`, `test/flags.test.js`, the shipped sweep,
and the form spec. Adjudication: *preservation vs. evolution* — no alias for
`no-push`, `options` or `--no-test`. Tier: map (`README.md` § Frontmatter).

## 2026-09-25 — `ctx-params` reports `ctx.client`, and `ws:terms` excludes Battery, Create and WebSocket

**`fli check`'s `ctx-params` flags `ctx.client` as well as `ctx.params`.** The
field is `ctx.caller` (`FJS-D392`), so an app still reading `ctx.client.ip`
reads undefined, which is the same fail-open the rule exists for.

**`terms.js` classifies Battery and Create as common English and WebSocket as
external** (`FJS-D394`). Their open rows in `VOCABULARY.md` are gone, since an
exclusion here is how a word is said not to be a term.

## 2026-09-25 — only a fence runs, and `fli check` parses an app's commands

**An indented block in a command's prose is prose.** The compiler took
markdown's indented code block as code, so an example indented in a paragraph —
what a status line looks like — compiled as JavaScript and broke its command; a
list item's indented continuation did the same. A command written in the ELA app
had to wrap its examples in ` ```text ` fences to load. The state is gone from
`transformMarkdown` and from `extractSegments`, which kept its own copy, and no
command anywhere depended on it: the 372 files under `commands/`, `example/cli`
and the ELA app's twelve were scanned before it went.

**`command-parses` is a `fli check` rule** (Invariant 15). It compiles every
command and step file under the app's routes directory the way the runtime does,
WITH its namespace module, runs `node --check` over each, and reports the `.md`
line: the command's, or its `_module.md`'s when the broken line came from there.
A name declared in both scripts is a SyntaxError only the pair shows, and the
finding says the module shares the scope. `compileCliWithMap` answers `locate`
for this, because its offset maps the body only — a `<script>` block moves to
the head and the module is pasted above it. An unclosed bracket is reported by
V8 at the compiler's next line, so the rule walks back to the last line an
author wrote. `core/command-parse.js` holds the pairing, and the shipped sweep in
`test/compiler.test.js` now uses it too, so all 372 shipped files are parsed
with their modules for the first time; none failed.

**One reader of a script block.** `_module.md`'s script was taken with a
non-greedy regex of its own while commands used first-open-to-last-close, so a
module that wrote a closing script tag lost everything after it. `scriptBlockOf`
is the one reader now, and `loadModuleFile` records `scriptLine`. Every module
in the tree, `example` and ELA extracts byte-identically under it.

## 2026-09-25 — a Release's configuration is called configuration

*Binding* now means a Mesa template binding, so the Deployment realm gave the
word up. `deploy.bindings` in `frontier.config.js` is `deploy.configuration`,
per target as well; `bindingSet()` and `BindingError` are `configurationSet()`
and `ConfigurationError`; the Release's `bindingsHash` is `configurationHash`;
the revert refusal `bindings` is `configuration`, overridden by
`--onto-current-configuration`; and the plan, the mint and the revert print a
`configuration` row. No old spelling is accepted, so an app that declared
`bindings:` now declares nothing until it is renamed.

It cost two things. **Every Release id moved**, because the configuration hash
is seeded with the word and the id carries that term, so an unchanged tree mints
a new id once and a redeploy after this is not a no-op. **The journal went from
format 2 to 3**: `binding_set` is `configuration_set` and `release.bindingsHash`
is `release.configurationHash`. The table is not renamed in place. The runner
sends the current DDL before any migration, so an empty `configuration_set`
already exists and a rename collides with it. The rows are copied across and
the old table dropped, and the column is an ordinary `RENAME COLUMN`. The oracle
in `test/journal-migration.test.js` now compares indexes as well as tables,
because a table rename leaves its index under the old name and a comparison of
tables cannot see that. A row held in the old table is asserted to survive.

## 2026-09-25 — bash completion completes past a colon

`fli env:<Tab>` offered nothing. Bash splits `env:g` into `env`, `:` and `g`, and
the script filtered the full names against `g`. It now takes the word from the
raw line and strips the part up to the last colon from each reply, because
readline replaces only the text after it. Pinned by `test/completion.test.js`,
which runs the generated script in a real bash. A shell that installed the old
script picks this up on its next start through the `eval` line.

## 2026-09-25 — css's tier is a UI row's `Under`

The css register now carries each term's tier as `under` (`Block tier`) with
`home: 'UI'`. `placed()` merges it into a root row only when that row's Home is
also UI and its own Under is blank. So `Table` (Data) and `Surface` (Framework)
keep their own sense, and `Switch` keeps `Select task`. Fifteen hand-written
tier cells were removed from `VOCABULARY.md`, and `Base tier` and `Layout tier`
were added so every css tier has a row. A label placed this way carries
`underFrom: 'css'`.

## 2026-09-24 — `VOCABULARY.md` is read by column name

`authoredVocabulary` matched exactly four cells, so the file's new `Home` and
`Under` columns would have made every row unreadable. It now reads the header
row and finds each column by name, and a row carries `home` and `under`. Nothing
consumes those two yet.

## 2026-09-23 — `fli gs` groups an app by its surfaces

`git:status` knew this workspace's folders by name, so in an app checked out on
its own every path fell into `(root)`: `api/`, `web/` and `db/` were one row
with the surface repeated on every line. Zones are now read off Invariant 3's
layout. A path whose first segment is a surface (`db api web site widgets
extension desktop tests`) is that surface. A path whose second segment is one
(`example/web`) is `<app>/<surface>`. `packages/<pkg>` stays whole. Any other
top folder is its own place, which replaces the list of `website`, `scripts`,
`IDEAS` and the rest. The workspace's own rows are unchanged. An untracked
directory (`web/`) stays at the level above rather than becoming a place with
no file name.

## 2026-09-23 — `commitment-swept`: a job still making a move a commitment owes

Once a model declares `@@commitment`, junction's `commitments()` makes that
transition at each row's due time. A job left making the same move is a second
owner, and nothing said so: the from-state lock turns whichever runs second into
a no-op, so both look like they work while the job's cron decides when rows move.
The new app rule reports a `*.job.*` file under `api/` that names the model (by
accessor, or a service resolving to it) and makes the move — by its name, by
another move of the same model from a shared state into the same state, or by
that state. The second spelling is the one that mattered: the sweep
`@@commitment(abandon)` replaced made `cancel`, because `abandon` was declared
after it. `declaredMoves` now records each move's from-states. A warning, since
a job can make the move for a reason that is not the clock.

`transition-methods` reads the same declarations: a move a `@@commitment` owes
is driven by `commitments()`, which no file under `api/` names, so it is no
longer reported as a move nothing reaches. Found by `example`'s
`Invoice.remind`, whose only caller is the commitment.

Proof: `test/checks.test.js`, six cases on real shapes — the deleted
abandoned-orders sweep, a relation target (`subscription.lapse` declared on
`Invoice`), and four silences each paired against the sweep; the clean tree
declares a commitment and a job, so the rule runs there. Dropping the
same-state spelling, the model check, the relation resolution or comment
blanking each turns one red. Over `example` with the three jobs steps 3, 4 and
6 of `IDEAS/ontology.md` deleted put back, it reports three of them;
`subscriptions-renew` swept `Subscription`, a model the commitment that
replaced it does not move, and no rule reading the schema can connect the two.

## 2026-09-22 — `fli make:wireframe` turns a screen into components

A **wireframe** is a screen written in `@frontierjs/css`'s vocabulary — a JSON
tree whose every node is a term, with the text the screen showed. What repeats
is a component, and what differs between its copies is its props: the command
writes one `.mesa` per component (kit components where the app has them, class
markup where it does not), the page with the screenshot's data lifted into
those props, and `tones.js` where a tone followed a value. Beside the wireframe
it writes `<Screen>.draft.lite` — models, enums and relations read off the
components, every field saying on a `///` line what on screen it came from, and
every gate marked as a placeholder. Nothing loads the draft.

**It grades what it writes** with the app's own mesa (compiled, then parsed)
and litestone, and exits non-zero on either. An unknown term or an unknown key
in the wireframe is refused by name. It refuses to write over an existing
output directory. `core/wireframe.js` is pure; `test/wireframe.test.js` drives
it over a real screen with the names invented, and holds its two copied lists
— the terms that take a tone, the props passed to kit components — against
their sources. `IDEAS/wireframe.md` is the design and what is not built,
starting with the step that writes a wireframe from a screenshot.

## 2026-09-22 — `fli proves` reads a script with an argument

A `DRIVES.md` row naming `` `test:browser geofield` `` looked the whole string up
as a script name, found nothing, and graded it `unknown` — the same answer a
drive renamed away gets — which failed the suite's real-table check
([`FJS-1273`](../../ISSUES_ARCHIVE.md#fjs-1273)). The script is looked up alone now and
the argument rides on the offered command.

## 2026-09-22 — `fli dev` gives every app its own ports

Every app `fli new` writes is project 0, so two of them derived the same
8000/8100 and the second `fli dev` refused, naming the first app's server. The
broker meant to separate them had never handed out a port that survived
([`FJS-1148`](../../ISSUES_ARCHIVE.md#fjs-1148)): a dynamic claim asked for project id 10
where the formula has one digit and the table has used all ten, and `fli claim`
released its session the moment it returned.

**An unnamed app takes a SERVICE digit.** `fli dev` claims a slot per app root
before its port check — 8000/8100, then 8001/8101 — and hands the ports to the
dev script as `FLI_PORT_FE`, `FLI_PORT_BE`, `FLI_PORT_WIDGET`, `FLI_PORT_SITE`
and `FLI_PORT_DESKTOP`, as `env:` on the exec, since a child under bun does not
see an assignment to `process.env`. The desktop template reads
`FLI_PORT_DESKTOP` now; the others already read theirs.

**The slot is remembered.** A new root skips a digit something is listening on;
a root that has run before gets its digit back, and when that digit is busy it
is refused rather than moved, because the usual holder is its own stale server
with the database still open. An app whose configs ignore the variables stays
at 0, since the probe would move and the server would not.

`fli claim` is gone, and `DYNAMIC_PROJECT_FLOOR` with it. `fli ps` and the GUI's
ports panel list the slots keyed by app root, *running* or *idle*, and
`--clean` forgets the idle ones.

## 2026-09-22 — `fli check` refuses a drive that pins Chrome's debugging port

`drive-cdp-port`, an error rule beside `vite-strict-port`, which is the same
hazard at the server end. It reads every file under an app's `test/` and names a
nonzero `--remote-debugging-port`, because only the first browser binds one:
every later drive is answered by the browser already there and asserts against a
page it did not open. Seven of `example`'s drives carried it and nothing
reported them — a drive on the wrong browser is green whenever the two runs
happen to agree ([`FJS-1265`](../../ISSUES_ARCHIVE.md#fjs-1265)).

CI's `structure` phase runs the same engine, so the next drive written cannot
reintroduce it quietly. The rule does not reach `packages/*` — those browser
harnesses are not apps.

## 2026-09-21 — the vocabulary corpus is four file kinds, and any of them can be switched off

`ws:terms` read `.md` and nothing else, so *which concepts does this framework
write about* was the only question it could answer. *Which ones does the code
actually name* is the more interesting half — a term explained at length and
named by nothing is the shape worth finding, and it is invisible while the
corpus is prose alone.

Four kinds: `markdown`, `code` (`.ts .js .mjs .mts`), `framework`
(`.mesa .lite`) and `web` (`.css .html`). 739 files became 3,104, and the scan
still takes under two seconds.

**A source file is read WHOLE**, comments and code together. That is a trade
rather than a free win — `Int` at 7,546 and `Math` at 143 now rank as concepts,
and a term the api lens already counts is counted twice across two tabs. The
chips are what undo it, and the page says so where the numbers are rather than
leaving a reader to wonder why `String` outranks `Resource`.

**A concept row carries the joint breakdown, `owner|kind`.** Switching a kind
off recomputes count AND spread rather than hiding rows, which is what the
source chips beside it already do — and spread is a count of owners, so how many
are left once a kind is off is not recoverable from two separate tallies. The
api and language lenses read declarations rather than the corpus, so the chips
do not apply and the row hides on those tabs.

**The audit stays on the prose it was calibrated on.** Every question in it is
about the authored registers. Asking them of the wider corpus changed what each
one MEANS with nothing saying so, measured on the first run: *not in
VOCABULARY.md* went 0 → 123 by counting identifiers as spread, dead doctrine
went 4 → 0 because no blessed word is rare once code counts, and the forbidden
column 18 → 28. All three are back to their original numbers.

**Nothing this workspace generated is corpus.** Three markers, because there is
no single one: `.snapshot.` in the name, a `generated by:` header for
`ws:atlas --live`, and one named file — `repo-terms.html`, this command's own
page, which carries neither by design (it is ungated, so it has no generator
line to be rechecked by) and at ~2 MB was the largest file in the tree matching
a corpus extension.

Driven in Chrome as well as tested: unticking markdown takes `Card` from 166/12
to 124/9 and markdown-only to 42/7, which the `--kind` flag answers identically
— the two implementations are kept to the same shape because one of them runs in
a browser over data attributes and cannot be shared.

## 2026-09-21 — `VOCABULARY.md` is the root register and not the only one

`ws:terms` read two authored halves — `ARCHITECT.md` § 2 and `VOCABULARY.md` —
and reported every term named nowhere else as `unnamed`. `@frontierjs/css` has
56 of them, defined with an element and a meaning each and graded against the
real CSSOM in both directions by its own spec, and all 56 read as vocabulary
nobody had defined. So did `Treatment`, `Anatomy` and `Density`, which are the
axes Invariant 13 is written in.

The register is READ. Copying 56 rows into `VOCABULARY.md` is the restatement
that file already says it is not for — *defined in one place and measured in
another* — and it is stale the first time css renames a term.

**Named rather than discovered.** `PACKAGE_REGISTERS` is one row, keyed by path;
a `*/vocabulary.json` glob would adopt any file with that name. Same argument
`phrases` already makes about a multi-word term: declaring one is a claim
somebody makes, so it is scanned from the authored halves rather than found.

**The root file outranks it, except where the root row says `open`.** That is
the file's own word for *seen and not yet decided*, so it was outranking a real
definition while carrying none — the one place the precedence read as an answer
and was not. Those 22 go to the audit as `undecidedButDefined` rather than being
handed to whichever register spoke last, because most of them are one spelling
over two realms: a Table is a `<table>` in css and a database table in
litestone, a Field is a control and a column. § 2 already carries that case for
`Channel`, and what is owed is which sense the root file names.

The count each register contributed is printed. A register that stops resolving
returns every one of its terms to `unnamed`, which is indistinguishable from a
package that never named anything; nine tests, and removing the one table row
reds eight of them — the ninth is the control asserting the degraded path, which
must pass either way.

## 2026-09-21 — `db:studio`'s flag descriptions name Litestone Studio

The `--port` and `--open` descriptions said *Studio*, where the command's own
`description:` already said *Litestone Studio*. Five `db/*.md` prose mentions
follow the same rule — the full name on first mention, the bare word after.
`packages/litestone/CHANGES.md` has the ruling.

## 2026-09-21 — the suite directory is `test/`

**`tests/` is a surface, not a suite.** In an FJS app it sits beside `api/` and `web/` and holds
what belongs to no single surface, while a surface's own tests are its `test/` (Invariant 3). A
package is not an app — it has one `src/` — so its suite is `test/`, and this one moved. Eight
packages spelled it plural and eleven singular with nothing in the tree deciding between them,
which made the directory name a coin flip on every file added.

The `test` script names its files one at a time, so all seventy-odd moved with it.

## 2026-09-21 — the vocabulary scan learns whose word it is, and that a term can be two

**A term can be more than one word.** `Data realm` is vocabulary where `data` alone is too generic
to be any, and until now only § 2's own multiword entries were scanned at all — `Gate ladder`,
`Chain of Responsibility` — and only to be counted for the dead-doctrine column. A phrase named in
either authored half is a row in the concepts table like any word, with its spread, its status and
its meaning. **And the scan proposes candidates**: every adjacent pair the prose writes, in three
or more packages, filtered for the shapes that are sentences rather than terms — a participle in
front (`Verified state`), a verb behind (`Litestone emits`), a joiner between. `Data boundary` in
17 packages, `Litestone client` in 15, `Data realm` in 11, none of them named anywhere. Proposing
is all it does: what makes a pair a term is somebody writing the row.

**Somebody else's nouns are named, and the concepts tab is this framework's again.** `Apache`,
`SvelteKit`, `Vixie`, `Kysely`, `Shopify`, `Kubernetes`, `Fowler`, `Berlin` — a web server, a
meta-framework, the author of cron, an ORM, a vendor, an orchestrator, a citation and a time zone —
all read as concepts OF this framework, because the only thing separating them from `Resource` was
a capital letter. 313 of them are classed `external` now, grouped by what they are: databases,
platforms, frameworks, vendors, web-platform APIs, people, places. Concepts 1,141 → 822. They are
not deleted — `external` is a class and the Classified out tab holds every one, which is what makes
a word in the WRONG class findable. Month and day abbreviations joined the dropped list beside the
full names they already sat next to.

**A component was posing as a coined concept, and now the api lens carries it.** A Mesa component
is an identifier nothing writes as an export — the FILE is the declaration and the caller types the
basename — so `EmptyState`, `StatCard`, `FilterBar` and 140 others reached the prose scan with
nothing to say they were code. `apiTerms` reads `*.mesa` under each package (and no longer skips a
package for having no `src/`, which is `@frontierjs/ui` entirely: its components ARE the package).
Identifiers 1,661 → 1,809. **A COMPOUND identifier is then classed `api` rather than `concept`** —
`EmptyState` is the component a screen mounts, `Empty state` is the condition it handles, and only
the second is vocabulary. A one-word identifier is left alone, because `Plugin`, `Channel` and
`Store` are English this framework also exports and § 2 rules two of them; a word § 2 blesses or
VOCABULARY.md defines is never reclassed. Concepts 723 → 692, and both audit columns that ask *what
is widespread and undefined* are empty for the first time.

**`Writable derived` is the same shape and is named.** Every one of `Writable`'s five capitalized
uses is the head of that phrase — mesa's `$: name = expr` — so the single word was a term that
meant nothing on its own. The row matches case-insensitively, which is what makes one row cover
`writable derived`, `Writable derived` and `Writable Derived` as the docs actually write them: 13
uses across two packages.

**`data` is dropped and the two terms under it are named.** 19 packages, 495 uses, and no meaning
anybody could write in the Means column — while `Data boundary` (17 packages, 353 uses) and
`Data realm` (11, 59) are the things the prose was actually saying. Both are VOCABULARY.md rows
now, which is a thing a single-word scan could not hold. Every other `Data X` in the tree is
one-off prose: `Data half`, `Data side`, `Data tier`, each a paraphrase of realm, none above five
files.

**A definition the scan cannot match is reported.** Dropping a word is a one-line edit in
`terms.js` and it silently orphans a row in `VOCABULARY.md` — the file goes on carrying a term
nothing measures, which is the one failure an authored half plus a generated half exists to make
impossible. *Defined here, seen nowhere* is the new audit section; it is empty today.

**Generic programming English is dropped too, and doctrine is what decides the edge.** `async`,
`await`, `variable`, `method`, `interface`, `module`, `factory`, `instance` — words that would be
the same in any repository, which is the test. What is NOT dropped is anything § 2 rules: a blessed
word (`Context`, `Event`, `Signal`, `Target`) whose disappearance would hide dead doctrine, and a
forbidden one (`State`, `Store`, `Flow`, `Payload`, `Pipeline`) whose disappearance would take the
drift column with it — a word forbidden by doctrine and still in live prose is the whole reason
that column exists. Concepts 822 → 722.

**Ordinary English is DROPPED rather than classed out.** `DROPPED` in `core/terms.js` holds 122
words grammar capitalizes — `the`, `every`, `run`, `set`, `request` — and they are removed before
the classifier runs, because a class is a row a reader has to read past and the reason for reading
one, a word in the wrong class, cannot apply to `the`. A plural is dropped with its singular: the
fold merges into a HOST row and a dropped word leaves none, so `Views` and `Requests` would
otherwise survive as terms of their own. `COMMON` is filtered against the list at definition, so
one word cannot sit in both. **What was dropped is counted and printed** — 122 words, 1,506
occurrences, a tile of its own on the page — since a list quietly eating a real term is the one
failure an exclusion can have.

**A row prints its class in a column beside its status.** `external` was
always a class — 103 words this framework does not define and only names, `JavaScript`, `Vite`,
`Docker`, `Feathers` — but it lived in the row's data and nowhere on screen. It is a column now — term,
spread, count, status, class — and a `class` select sits beside `status` in the filter bar. It
stays a CLASS rather than becoming a fifth status in
`VOCABULARY.md`: a status is the stance this framework takes on a word, and there is no stance to
take on somebody else's product name — a status saying so would be a second origin for what the
`EXTERNAL` list in `core/terms.js` already holds.

**The `mesa:` language words are read off the two declarations rather than grepped.** A grep over
mesa's source answers `mesa:frobnicate`, which is the compiler's own example of a name that does
not exist, and `mesa:line`, which is a source location — so the vocabulary held its own
counter-example. The list is now `MESA_ELEMENTS` in mesa's compiler plus `MESA_SLOT_TAG` in
sierra's slot rewriter, both read as TEXT because the cli depends on neither package; the source is
still grepped for USAGE, so a declared element nobody has written yet shows a count of zero rather
than being absent. A grep with no declaration left to read is the fallback, and `grepped` on every
row is what says so, because an empty language tab would read as Mesa having no words.

**The corpus walk skipped a source directory because of its NAME.** `build` is on the
output-directory skip list and sierra's compile-time rewriters live in `src/build/`, so 74 api
identifiers and every use of `mesa:slot` were invisible — the count read 1, out of a comment in
mesa. A directory under a `src/` is source whatever it is called. API identifiers 1,587 → 1,661.

**Neither is § 2.** A phrase is matched as plain text, so leaving ARCHITECT.md's own Use/Not table
in the corpus let `Gate ladder` gain a use by being blessed. The section is cut at the boundaries
`architectVocabulary` already reads it by; the rest of the file is ordinary prose and stays.

## 2026-09-20 — `fli ws:terms` counts the vocabulary this workspace asks a newcomer to learn

*How many words must somebody hold to read this repo* had no answer, and the two §V questions that
ask it — *does this enlarge the concept budget*, *does it introduce another origin* — were the two
with no artefact behind them ([`FJS-1211`](../../ISSUES.md)). `ws:terms` is the exploratory half of
the answer: one model, three presentations (`--as=list` · `--as=page` · `--as=json`), the shape
[`FJS-D223`](../../DECISIONS.md#fjs-d223) already ruled for the atlas.

**Three vocabularies, never one number.** Concepts (a mental model is built from these), language
words (`.lite` from its own catalog, Mesa grepped and marked as grepped), and api identifiers
(1,587 declared, 741 of them at an entry point a consuming app can reach). A single frequency count
averages three things learned three different ways and describes none of them.

**Ranked by spread rather than count**, because a term in twelve packages is core vocabulary and
three hundred hits in one file is local jargon.

**Nothing is excluded — a non-concept is CLASSIFIED.** Measured before the module was written: the
noise in a prose scan is not stop words, it is proper nouns, with `Vite`, `Chrome` and `Java` all
outranking `Resource`. A dropped word leaves nothing behind to notice, so `product`, `external` and
`common` are classes somebody can open and disagree with.

**Two measurements were wrong until they were run.** Counting every occurrence of a word § 2
forbids reported `table` 2,490 times — markdown tables — so the drift column counts a forbidden word
only where it is used AS A TERM, capitalized mid-sentence, with words § 2 blesses in another sense
left out entirely. And a dash, colon or semicolon was allowed to precede a term until the list
filled with `An`, `Whether` and `For`: this house opens a clause with them, so the next word is
capitalized by grammar.

**The page is driven in a real browser, and that is what found the styling bug.** `.tile` carried
`var(--border)`, which `@frontierjs/css` does not define, so the whole declaration was dropped and
the tiles rendered borderless with nothing reported. It now uses the package's own tile anatomy and
only tokens that exist.

**Every path the page prints opens in the editor.** `vscode://file/<absolute>` on each file in the
where column, each forbidden word's top files, and each language word's source — 4,495 of them,
every one asserted to resolve to a file that exists, because a baked-in path that has gone is a link
that silently opens nothing and is the one failure the page cannot show on screen. The absolute path
is what makes the written page local to the machine that wrote it, which this one already is: it is
ungated and gitignored, and that is exactly why the links belong here and not in a committed
snapshot, where they would point at somebody else's home directory. No line number — the scan reads
a document with its code spans and fences stripped, so an offset into what it read is not an offset
into the file.

**A source chip counts per LENS, and the Language tab was inert until it did.** The chips were built
from the prose scan alone, so unchecking the IDEAS folder moved Concepts and Classified-out, did
nothing to API — correctly, since no source file lives there — and did nothing to Language, which
was a real gap: a language word carried no owner at all, so nothing could reach it. A `.lite` word
now declares litestone and a Mesa block declares mesa, and switching litestone off takes that tab
from 134 rows to the 11 Mesa blocks. Each chip shows what its source contributes to the VISIBLE
vocabulary and dims where that is zero, because IDEAS reading `2,985` on the API tab describes
nothing the reader is looking at, and an inert control reads as a broken one.

**A source can be switched off, and the numbers are recomputed rather than the rows hidden.** Every
row carries where its count came from, so unchecking `IDEAS/` — design records for work not started,
whose vocabulary is proposals rather than the framework — recounts each term against the reduced
tree: `Data` goes 19/494 to 18/339, `Homestead` 6/21 to 5/14, and 268 terms that exist only there
leave the table. Hiding the rows instead would have kept a term read forty times in `IDEAS/` and
twice in a package at its old spread, which is the number a filter then answers against. Both
filters gained an upper bound too, which is how a term used everywhere is excluded to see what is
left.

**The register is not its own corpus.** `VOCABULARY.md` is a list OF terms rather than prose that
uses them, so it is out of the scan — labelling a word must not raise the count that argued for
labelling it.

**`VOCABULARY.md` is the authored half and it holds only real vocabulary.** The file carries term,
status, meaning and a note; `ws:terms` reads it and joins each row to what the tree does with the
word, so a term is defined in one place and measured in another. A word that is NOT a term of this
framework is not labelled there — it is excluded in `core/terms.js`, where the classifier can act on
it, because a row saying *this is not a term* would be a second way of saying what a list in the
scanner already says and nothing would read it. § 2 outranks the file where they disagree. Seeded at
spread ≥ 4: 87 terms, 11 of them already ruled in § 2.

**Plurals fold rather than being excluded.** `Users`, `Resources` and `Releases` are neither separate
vocabulary nor noise, so a plural merges into its singular when the singular was also seen, carrying
its count and its packages — and a word that merely ends in an s and stands alone is left as written.
That took the spread ≥ 4 band from 115 to 87 and surfaced six terms that had been split in half by
their own plurals: `Channel`, `Job`, `Suite`, `Component`, `Page` and `Rule`.

**Filters are one reader over every tab.** A row declares term, status, spread and count, so
spread ≥ N, count ≥ N and a status pick work the same on concepts, language words and identifiers —
a tab with a new column costs no filter code. A tab whose rows have no spread declares `0` rather
than omitting the attribute, since a missing one and a zero both read as `NaN` and would hide the
whole table. Driving it found the API table capped at 1,200 rows while its own tile counted 1,587:
a filter answering about a set the reader cannot see. Uncapped.

**The page follows the reader's OS into the dark, and a theme name is not a luminance claim.** The
light/dark default is `press` and `field` — the package's own pair, where `field` is an ink ground
written for the pages a project generates about itself and `press` says in its own header that it is
the same discipline on the opposite ground. Reading the NAMES would have picked `midnight`, which is
a light theme with a purple accent, measured at `rgb(245,245,245)`. The class goes on `<html>` and is
set by a script in `<head>`, because a theme applied after the first paint is a white flash on a page
somebody opened to read in the dark; the picker then persists a choice that survives a reload. Driven
under both emulated OS preferences: ink ground at `rgb(12,14,13)` dark, paper at `rgb(232,226,212)`
light.

**Ungated on purpose.** The page carries no `generated by:` line and is not named `*.snapshot.*`, so
the `snapshots` phase does not adopt it — the exclude lists are still being refined and a gated
artifact would fail the build on every tuning pass. `FJS-1211` is where the gated `ws:dictionary`
this becomes is filed.

## 2026-09-20 — `fli new` prints 54 lines instead of 130, and `--verbose` is the way back

A scaffold composes five commands, and each of those is a whole command elsewhere: its own banner,
its own next-steps, its own tutorial. Five endings inside a command that has one, and the two lines
anybody acts on — `cd`, `bun run dev` — were somewhere in the middle of it.

**`runFli` captures the child's stdout and lets its stderr through.** That is not a volume dial: it
is the severity split the logger already makes, since `log.warn` and `log.error` write to stderr. A
child's warning is still live and in order; its chatter is not. The captured buffer is printed when
the child exits non-zero, which is the only time it was worth having. `bun install` gets the same
treatment and its summary line — how many packages, how long — comes back out.

**`log.detail` is the new level and `--verbose` is the new global flag.** Gating `log.info` was the
obvious lever and the wrong one: every command in this package uses it for lines a reader needs, so
a level a call site opts into is the only shape whose blast radius is the call sites that asked.
`--verbose` also travels to a composed child. It replaces `log.debug`, which printed
unconditionally, had one caller, and collided by name with `--debug`, which asks for stack traces.

**Three things the scaffold said that were not true.** `⚠ no project root found` was the first line
of the command that CREATES the project. `✓ ✓ calendly created` — `log.success` prepends the mark and
the string carried a second. `notifications:install` announced *Pushing schema to database* and then
called `db:push`, which announces it again.

## 2026-09-20 — health is declared in two places and both readers only knew one

`fli new` writes `plugins: { health: true }` into `api/config/junction.config.js`. `fli make:deploy`
and `fli deploy:doctor` both grepped the API SOURCE for `healthPlugin(` — so the scaffold warned, in
its own output, that the app it had just written answers nothing at `/api/health`, and the doctor
agreed. The app was fine. Advice that is wrong about a working app is worse than none, and this one
was printed by the command that caused it.

**`core/health-target.js` is the one owner of both questions** — *where does this app answer health*
and *does anything serve it* — because the two readers asking them separately is how they came to
disagree. It reads the plugin call, the config declaration and a hand-written route literal, grades
the literal against the CONFIGURED path rather than a bare `/health`, and answers which file decided.

**It also catches the clash.** Junction refuses a plugin configured by hand AND declared in config at
`start()`, by name — an app that builds, ships and exits on boot. `deploy:doctor` fails on it now
rather than the deploy finding it.

## 2026-09-20 — the proxy's refusal is read rather than waited for, and CI runs the bun everyone else does

**`bun-version` in `.github/workflows/ci.yml` moves to 1.4.2.** It was pinned at
1.3.11 while every machine here had moved on, so three suites were red locally
and would have been green on the runner — which is the worse direction: the
thing that is supposed to catch a break was the thing insulated from it.

**One test was leaning on the old runtime.** *An upgrade to a name nothing
claims* opened a socket, added no `data` listener and waited for `close`. A
socket nothing reads stays PAUSED, so the FIN is never processed — under 1.4.2
it emits nothing at all, and the test spent its full two seconds before calling
the timeout a pass for the wrong reason. It reads the answer now, which is also
the stronger assertion: the upgrade is refused **by name** with a 404 rather
than merely dropped, which is what tells somebody staring at a dead socket why
it is dead. The proxy itself was correct throughout.


## 2026-09-20 — `fli doctor` grades the bun VERSION, not just its presence

Every published package here declared `engines: { bun: '>=1.0.0' }`, a floor nobody had moved since
it was written, and an engine range is advisory anyway — bun installs and runs an app whose floor it
does not meet. So a machine one minor behind reports the feature it cannot reach as MISSING rather
than reporting itself as stale, which is how `Bun.Image` was first measured as absent on a tree that
requires it. The floor is `1.4.0` now in every package that declares one, and `BINARIES` carries a
`min` beside the `required` flag: bun on PATH but below the floor is an error whose hint names the
found version, the wanted one and `bun upgrade`.

**A version the probe cannot READ is not a version that is too old.** `binVersion` returns null when
`--version` will not parse, and null passes — failing it would block a working machine on this
probe's own blind spot. `compareVersions` truncates a prerelease (`1.4.0-canary.3` compares equal to
`1.4.0`) rather than ordering it, because ordering it right is semver's hardest corner and being
wrong there refuses a machine that works. The probe is injected the way `has` already was.

## 2026-09-20 — question scaffolding stops scoring

The first phrasing tried outside the graded set — *why is there no formatter* — tied four rulings and
never surfaced `FJS-D32`, whose title is the only one containing the word *formatter*. `no` and
`there` were scoring like real words.

`core/intent.js` strips filler already and its set is deliberately small, because that corpus is a
customer describing a feature and the noise there is `every` and `per`. This corpus is a contributor
asking a question, where what survives the trigger strip is `is`, `there`, `no`, `does`. **Two sets
because there are two corpora**, not because one was copied. `is there`, `do i` and `can i` join the
trigger strip.

No movement on the graded set, which is the point: a fix that only helps the questions it was written
for is a fix to the questions.

## 2026-09-20 — recipe went 2/4 to 4/4 on four headings, and no router change

The graded set's two misses were both `recipe` — *how do I declare a job*, *how do I contribute a
control* — and the tuning had been stopped there, because the last three scorer changes each traded
one question for another. The reason was measurable and it was not in this package.

**`recipe` works exactly where a package map has a heading named after the task.** litestone has 54
headings and answers *how do I make a computed field* out of `## Computed fields` in 210 tokens.
`caravan`, `ui`, `toolbelt`, `orion` and `jetty` have three each — `Layout`, `What bites here`,
`Proving a change` — so every fact in them sits in one block named after nothing, and a component
listing under `## Layout` mentions more of a question's words than the one bullet that answers it.

Four headings were added, two to each of `caravan` and `ui`, over subjects those sections already
turn between. No sentence moved and nothing here changed: **2/4 → 4/4, 22/24 → 24/24 on the set.**
Median tokens-to-fact 60 → 63.

**A heading is an index entry**, which is the finding rather than the fix. The other five intents
resolve against a register built for them — `DECISIONS.md`, `ISSUES.md`, `DRIVES.md`,
`seams.snapshot.md` — and *how do I* has none, so the package map is the index and its headings are
the keys. `IDEAS/intent-recognizer.md` records the same shape for a screen.

**What this does not show is generalization.** The headings were chosen knowing the two questions.
They are defensible as structure — those sections do turn where the headings now sit — but the set
is 24 questions that the router and now the corpus have both been fitted against. The baseline in
`test/ask.test.js` ratchets at 24 and the next honest number comes from questions written cold.

## 2026-09-20 — every seam names an owner, and a key is graded by where it is MINTED

`seams.snapshot.md` shipped with 26 of 85 owners and the file said the rest were not a gap: *no line
anywhere declares `x-version`, so which file owns it is the wrong question*. **That was wrong about
the question.** A key has no declaration, but it has a minter — one place that writes it — and a
producer is exactly what Invariant 4 means by one owner per translation. It is the ownership least
visible to anybody grepping, because there is nothing to grep for.

All 87 seams now name one. Twenty-six were already written, forty-one callables were filled from the
tree, and the last eighteen are keys resolved to where each is minted: `x-version`, `x-values` and
`@label` to `litestone/src/jsonschema.js`, `retryable` to junction's `toFrameworkError`,
`x-fjs-build` to `core/build-id.ts`, `$after` to the one row in `toolbelt/src/directives`,
`page.query` to sierra's `router/page-fields.js`.

**One closed itself.** `$context.form`'s bullet had named `ui/components/forms/Form.mesa` since it
was written, and the path pattern only admitted `.js` and `.ts` — Invariant 18 makes a `.mesa` source
in this workspace, so the owner had been there all along and was refused by a regex.

**`seam-owner` grades a key or the eighteen would have been unfalsifiable**, which is the thing this
module exists to prevent. It asks the only question a file can answer about a string that is never
declared: does the owner contain it. The receiver is dropped first — `ctx.`, `$.`, `client.` and
`page.` are where a key is READ — and an extension segment with it, since `*.mount.js` is about
`mount` and asking for `js` asks every JavaScript file.

**Ten of those checks are marked weak and the mark is the point.** Asking whether junction contains
the string `log` proves nothing; `x-fjs-build` is nearly a proof. `invariants.snapshot.md` already
settled how to write that down — a partial enforcer names its half, because a row claiming the whole
check while holding a corner of it is the most misleading thing the file can carry.

`client.auth.*` reduces to `*`, a quantifier with nothing to repeat, and threw the moment that seam
was given an owner — a key had never reached the re-export read before. Escaping is one helper now
rather than a `$` special case.

## 2026-09-20 — `fli ws:ask` answers with a citation and says what the answer cost

`PHILOSOPHY.md` §III claims you should know where something lives before you go looking for it. That
has been true by assertion since it was written, because nothing ever put a number on it. **This is
the number: what it costs to get one fact out of this workspace, and whether the fact came back
right.**

Six intents, each naming ONE committed artefact — **owner** and **locate** over `seams.snapshot.md`
and the maps, **ruling** over `DECISIONS.md`, **status** over `ISSUES.md`, **blast** over
`DRIVES.md`, **recipe** over a package's own `CLAUDE.md`. They are separate because *why is X this
way* and *is X broken* both name X and land in different registers, and a router that treats them as
one returns the ruling that CLOSED the defect somebody is still hitting. The intent picks the
artefact and the subject picks the row; no model is in it, so a question answers the same way twice.

**The answer is a citation, never prose** — a path, an `FJS-D##`, an `FJS-###`, a drive id — so
grading is a string compare with no judge model, which is the only way the score means the same
thing in six months. It also forces the useful shape: *where does this live* is answerable and
*summarize this* is not.

**Two byte counts, and only one of them is the metric.** `read` is the SPAN a reader must take in to
have the answer; `scanned` is what had to be opened to find it, which is what says whether a small
model could have taken the same walk. Measured over the graded set: **median 60 tokens read, 22 of
24 carrying the right payload, 24 of 24 citing the right document, 14 MB scanned.**

**`read` counts the payload and never the pointer, and the first version of it did not.** Counting
what came back made `recipe` the cheapest intent in the table at six tokens — for a citation to
`packages/litestone/CLAUDE.md`, which is 39,000 tokens to then read. A metric that rewards the
shallowest possible answer measures nothing, and `ruling` and `status` had the same shape one size
down, citing a heading line and a truncated title. So a row carries a `payload` — the ruling's body,
the issue's row, the paragraph that answers — and `line` is only how it prints. The honest numbers
are higher and they are the first ones that mean what they say: owner 25 tok, blast 5, locate 69,
status 85, recipe 229, ruling 731.

**A citation pins the document and, for a recipe, not the answer** — the router was 4/4 on the file
while handing back a component listing for *how do I contribute a control*. So a question may carry
`contains`, a phrase read out of the tree that the payload must hold. It can only ever make the
score worse, which is the direction an assertion may be added in without tainting the key.

**The key is written against the tree, in its own file, and it was not touched.** `core/questions.js`
holds twenty-four questions whose citations were resolved by reading the artefacts before the
resolver existed — the ordering is the whole value, since an answer key written after the code is
green passes by construction, which is the failure `decision-rules` names for the nine questions and
is the same failure here. The set went 17 → 20 → 21 → 22 → 23 → 24 across six fixes and **not one
question was reworded**; a question the router misses is a fact with no home or with two, which is
`IDEAS/intent-recognizer.md` § *Read it backwards* pointed at prose instead of a seed.

**What the misses were is the part worth keeping.** A substring is not a match — `port` matched
inside `transport` and `export` thirty-eight times in `CLAUDE.md` alone, the same defect a `-w`
fixes in ripgrep, arriving through a different door. A key is a NAME and is compared the way inflect
compares one, so `port` reaches `ports.js`. A two-letter name is a name: `ui` was being dropped as
noise. A compound matches as a UNIT — `pay run` scored against a key of `verify:pay` and beat
`verify:payrun`, which is a substring match one level up. Trying seams before the maps and returning
on any hit is a precedence nobody declared, and it answered *where does the port formula live* with
junction's devtools plugin, because `devtools({ port, auth })` is a seam. And two rows naming one
answer are not ambiguous — a drive has a row in each of `DRIVES.md`'s two tables and they tied with
each other.

**Two of those were findings about the corpus rather than the code.** `DRIVES.md`'s second table —
what a CHANGE needs, in the words somebody would use — is the half written for exactly this
question, and the walk was reading only the first. No Covers cell contains the phrase *pay run*; the
mapping row does. And a package map is not paragraphs: `packages/ui/CLAUDE.md` § What bites here is
34 KB with TWO blank lines in it, so the unit these documents are written in is the top-level bullet
— *bold the claim, then say what it cost* — one fact each.

**`recipe` is 2 of 4 and the tuning stopped there on purpose.** The last three scorer changes each
traded one question for another, which is overfitting to twenty-four questions rather than improving
a lookup. The other five intents ask *which row* and have exactly one right one; *how do I* does not,
because no register holds how to do things — it is prose in a package map, and several blocks partly
answer. That is the same gap `IDEAS/intent-recognizer.md` records for a screen: an index that does
not exist. The number is a baseline in `test/ask.test.js` that may rise and may never fall.

## 2026-09-20 — `fli ws:seams` resolves the bridge index against the tree

`CLAUDE.md` § Bridge index and the `bridge-index` skill are one list written twice — a key list at
the root, eighty-five explained bullets in the skill — and nothing compared them or graded either.
Twenty-six bullets open with *reach for them before grepping* and then name the file to reach for,
which is advice: it rots the way `invariants.js`'s enforcers rot, and a reader who greps a stated
path and finds nothing concludes the seam is gone rather than that the sentence is stale.

`fli ws:seams` writes `seams.snapshot.md` — one row per seam, its stated owner, whether the name is
declared there, and how many other files declare it. **The list derives and the owner does not**:
the bullets are the seams, so a copy here would be the restatement the framework is a bet against,
while *`$setAuth` belongs to `client.js` and not to one of the four type declarations that also
carry the name* cannot be read off a tree where all five sites declare it. **`none` is an answer** —
a bullet naming no owner is the gap the file publishes, and failing on it would be a red build for a
piece of honesty.

**Twenty-six bullets named an owner when the resolver first ran and sixty-seven do now.** Every
CALLABLE seam has one; the eighteen left are not callables — a `$` on a wire, a schema keyword, a
header — and no line anywhere declares `x-version`, so an empty cell is the answer rather than a
gap. Thirty-one were unambiguous, one declaring site each, and the other ten had the bullet's own
signature to pick with: `mount(label, Component, {props, root})` is mesa's and not jetty's because
jetty's takes `(root, app, props)`.

Two `fli check` rules, both `scope: 'repo'`, both serving **Invariant 4**, which had no enforcer
before this. `seam-owner` grades the claim two ways, neither of them a judgement: the path is not in
the tree, or the path is there and the name is not in it. The second is the one that reads as
correct from every angle, because a re-export puts the name in a module's surface while the
declaration lives elsewhere — so where it was forwarded FROM is reported, the fix being unusable
without it. `seam-listed` grades the copy: a seam the skill explains and the key list never named.

**Both found something on their first run.** `matchesQuery` moved to `@frontierjs/toolbelt/match`
under `FJS-D26` and its bullet still named `sierra/src/junction/field-rules.js`, which only
re-exports it — `CLAUDE.md` had recorded the move and the skill had not. `signIn` has carried its
own bullet and its own ruling since `FJS-D261` and the key list had never named it, so the one
question that section exists to answer was answered no. A third came out of the fill: the reactive
seam had cited `mesa/runtime.js` since before there was a `src/`, and no file of that name has ever
existed. All three are corrected here.

**Each was found by a resolver bug, which is the honest way to say it.** Owning the other fifty-nine
took four passes over what counts as a declaration, and every pass was a false answer first: a
`.d.ts` is a restatement by construction and can never be an owner; a named function expression is
where the thing is written, which is how the whole `$` family is declared; a comment is code-shaped,
and this module's own comment quoting `return function $levelOf` was read as declaring it; and
`sierra/src/build/` is source rather than output, so skipping `build/` reported `appSrcDir` as
declared nowhere. The last one is the general shape — **what separates a path from the three other
things spelled like one is whether the first segment NAMES A PACKAGE**, which is read off the tree,
so `build/schema-plugin.js`, `@frontierjs/ui/utils.js` and `@/api.js` cannot become owners.

The restatement count is carried because it is the only place that cost is visible.
`IAuth.verifySession` is declared in thirteen files and `$setAuth` in seven: Invariant 1 forbids the
import that would let junction and orion share litestone's types, so each hand-declares the shape it
holds. That is not a defect the rule can grade — it is the price of the dependency direction, and it
had never been counted.

## 2026-09-20 — `fli gs` groups the working tree instead of forwarding it

`git status` answers in one flat alphabetical list. In this repo that is 102 paths sorted by first
character, interleaving nine packages, six example surfaces and the root registers — the reader
re-derives the grouping by eye on every single run. `git:status` was a passthrough and added nothing.

It now groups by **where** (package, surface, root folder) and then by **what the file is to that
place** — schema, src, ui, test, config, deploy, snapshot, record, docs. Both fall out of the path
alone, so there is no package list to keep current. Heaviest place first, because that is what a scan
is looking for; a conflict outranks any amount of churn. Within a place a directory prefix is printed
once and the basenames follow it, so the eye lands on what differs.

**The grouping is cosmetic and the count is not.** A role rule that stops matching would drop a file
from a listing somebody is reading to decide what to commit, and a dropped row looks exactly like a
clean file — so `test/git-status.test.js` asserts every input path comes out exactly once, and that
every role a rule can answer is in the renderer's print order.

`core/git-status.js` is pure — the three git readings in as strings, a model out — so the command
only renders and `--json` prints. `-z` rather than newline-split: a path with a space is quoted and
escaped in the default output. A rename carries two NUL fields and consuming one leaves the old path
as a phantom entry. An untracked DIRECTORY arrives as one entry ending in `/`, which cut at the last
separator gives an empty basename — the row printed its glyph and no name. `--short` hands over to
plain `git status -s`; `--all` was considered and cut, since collapsing a directory hides the prefix
and never a name.

**The summary prints below the listing.** On a hundred-file tree a header has left the screen by the
time the last place is drawn, and the totals are what the eye should land on when the scroll stops.

**A file named by more than three others carries `↑n`.** The listing knew what changed and never
how far it reached, so a diff touching `parser.js` — named by 77 files here — read exactly like one
touching a leaf. `core/blast.js` is the tally and it computes nothing: `referenceGraph` in
`core/codegraph.js` is the one answer to *who names this file*, and the bands are its `BLAST`, so a
file the codegraph page draws as a hub is marked in the listing too.

**Past band 3 the whole name goes amber, not just the mark** — but state wins where there is one.
What you DID to a file outranks how far it reaches: deleting something 77 files import is red before
it is amber, and the `↑77` beside it stays amber either way, so both facts survive on the one row.
That split also fixed a nesting bug — the reach used to sit INSIDE the painted word, and an inner
color's reset ends the outer one, so a red deleted hub went plain from its own `↑` onward.

**The threshold is the feature.** Every file carries a reading and most are 0 — measured on this
tree, 23 of 113 changed files are named by anything at all and 16 clear band 2 — so marking them all
would be a column the eye learns to skip. `null` is kept apart from 0 throughout: *nothing names
this* is a fact about the file, *nothing read this* is a fact about the tally, and a renderer that
saw 0 for both would mark a hub as safe on the run where the index failed to build.

**It costs ~0.4s, taking `fli gs` to ~0.8s, and that was the decision.** The full codegraph is ~6s;
the difference is the TypeScript function measurement, which this question does not need. The scan
cannot be narrowed by target — knowing who names `parser.js` means reading everyone. Two cheaper
readings were measured and refused: `git grep -F` per changed file is slower (60 spawns, ~1.3s) and
is a second answer to the same question, and prefiltering texts by the target's BASENAME is unsound,
since `@frontierjs/toolbelt/inflect` resolves through `exports` to `src/inflect/index.js` and the
importing text contains `inflect` and never `index.js`. A cache was considered and cut: it is the
one option that can be silently wrong, and 0.4s does not buy an invalidation story.

`buildStatus` takes a `blastOf` FUNCTION rather than the index, so `core/git-status.js` stays pure
and fixture-testable — a listing that had to import the codegraph to be tested would not be testable
at all.

**`fli gui` reads the same model** — `GET /api/status`, the panel above *what proves this change*,
which is the order the two questions are asked in. Two renderers of one question is how the page
comes to disagree with the terminal about what is dirty, so the grouping, the ordering and the roles
are decided server-side and the page re-derives none of them. The bar is the kit's own Progress with
a muted tone rather than a styled div (Invariant 13); `test/browser/specs/tree.spec.mjs` asserts
that and asserts the count — **the page groups by its OWN role list**, so a role the engine answers
and the list omits drops those files in silence while the note goes on counting them. That spec
failed on its first run: `.dir` prefix spans are siblings of the file spans, so the files carry a
`gui-file` marker now instead of being counted by position.

## 2026-09-19 — `fli check`: a static root serving uploads says so

`untrusted-upload-root`, warn. A local `FileStorage` writes objects into a directory and a `static`
mount publishes them; the handler cannot tell those bytes from the app's own, so the app says
([FJS-D314](../../DECISIONS.md#fjs-d314)) — and this is the rule that fires when it has not.

**It is the half that makes the ruling hold.** A declaration somebody forgets is this framework's
oldest failure shape, and the standing answer is a declaration plus a rule that fires on its absence;
shipping the flag alone would have been the half that reads as done. Where the mount and the provider
name the same identifier the message says so and names it. An S3/R2 provider SKIPS — the bucket
serves those bytes and junction never sees them, and a rule that fired there would be telling an app
to mark a mount carrying no uploads.

Verified by breaking it: removing the flag from `example` fires the rule naming `STORAGE_ROOT`. The
clean-app fixture gained a marked mount, because `checks.test.js` asserts nothing SKIPPED — a green
run over a tree the rules could not see is what that file exists to prevent.

## 2026-09-18 — the date `fli decide` stamps a register row with is UTC

`isoDate` read the host's wall clock, so a decision recorded at 23:30 in Auckland and one recorded
twenty minutes later in Los Angeles were dated two days apart, in a file whose whole job is to say
when something was settled. Found sweeping for local-clock readings alongside `FJS-1150` and
`FJS-1151`.

## 2026-09-18 — `fli ask` takes the current Sonnet, and an OAuth profile

The default model was `claude-sonnet-4-6`, a generation behind and priced at
$3/$15 against Sonnet 5's $2/$10 for the same 1M context; the `--model` example
named an equally stale Opus. Credentials were `ANTHROPIC_API_KEY` or a refusal,
so the machine that had run `ant auth login` — no key to manage, the Console
account the SDKs already read — was told to export one. It now resolves in the
order the SDKs use: the key, `ANTHROPIC_AUTH_TOKEN`, then the stored profile's
access token. An OAuth token travels on `Authorization: Bearer` with the
`oauth-2025-04-20` beta header rather than `x-api-key`, so sending one the old
way is a 401 that names neither the header nor the token. The refusal says a
Claude.ai subscription is not an API credential, because that is the guess
somebody makes once and cannot check.

## 2026-09-18 — `fli update` upgrades an fli that came from npm

`fli update` only knew the shape this repo's contributors have: fli inside a git
checkout, pulled and re-linked. Anyone who installed it the documented way — `bun
add -g @frontierjs/cli` — got *No git repo found above …* and a suggestion that
fli must live in a checkout, which is a refusal to do the one thing the command
is named for. It reads which shape it is in instead, derived from whether there
is a `.git` above fli and, failing that, from where the package sits: a
`.bun/install/global/` path is bun's, a `lib/node_modules/` path is npm's, and
anything else is REFUSED with both commands printed rather than guessed at — an
upgrade run through the wrong manager installs a second copy and leaves the one
on PATH exactly where it was. The version is read before and after from the same
`package.json`, so an upgrade that changed nothing does not read as one that
worked. No second command (`self:update`) for the same sentence: which install
shape you have is derivable, and a name you have to choose between is not.

## 2026-09-18 — `ws:pub` asks about npm once, where the answer still costs nothing

`--interactive` carried two things: a bump menu per package, and the pause the
npm 2FA prompt needs. Only the second is what anyone reached for it for, and
the first was answering a question the release cannot honor anyway — `bun
publish` rewrites a `workspace:*` dependency from the LOCKFILE, so every
version is written and committed before anything is published, and a per-package
bump pins siblings to versions the run has not published yet. The menu is gone;
one bump applies to the run, `--filter`/`--except` hold a package back, and
`--interactive` is now pacing alone. **Every run stops once before the FIRST
publish** on a terminal, which is where a person gets logged in and their
authenticator up before eighteen OTP prompts arrive. And preflight asks `npm
whoami` before a version is spent: `bun publish` reads npm's credentials, so a
logged-out release used to fail at the registry with the commit and eighteen
tags already written, where the recovery is a reset rather than a login.

## 2026-09-18 — `ws:pub` holds back a package nothing has touched

`--affected` was the flag that limited a release to packages with commits since
their own `<name>@<version>` tag, and the release everybody ran did not pass it:
a bare `fli ws:pub patch` bumped and published all eighteen public packages,
sixteen of them identical to what the registry already held. A version spent on
an unchanged package cannot be taken back, and a run that publishes sixteen
no-op tarballs looks exactly like one that worked. The filter is now the
default and `--all` (`-a`, the flag `--affected` held) turns it off, for the
republish that IS the point — a failed run finished by hand, or a packaging fix
that changed no source. The sibling `ws:run` and `ws:version` keep `--affected`
as an opt-in, because there the wrong answer costs a wasted test run rather
than a burned version.

## 2026-09-17 — `--fix` says why a generator would not run

`fli test:snapshots --fix` printed `could not be regenerated` and the rerun
command, and swallowed everything the generator had written to stderr — the
stderr tail was shown only for a snapshot being written for the FIRST time. So a
basecamp app whose database was missing a migration failed three snapshots with
`Plugin "orion" boot failed: no such table: flow` on the floor, and `--fix` read
as a command that does nothing. The tail is shown for any generator that was
asked to WRITE and could not; a stale `--check` still prints just the rerun,
where the diff is the whole answer.

## 2026-09-17 — the cognitive cuts are moved by hand, over the distribution they cut

A threshold is a claim about where a project falls off, and four numbers do not argue for themselves.
Picking **cognitive** from `more` now brings a strip and three sliders: the strip is the distribution,
one bar per doubling — the values run 1 to 4730, and on a linear axis that is one bar and sixty empty
ones — so the drop-offs are visible before anything is dragged. Dragging then says what each cut
costs: the band counts, the strip and the map all redraw live, which is the whole point, since a cut
is right when the picture stops changing much as you cross it. A cut cannot pass its neighbours, and
**reset** returns the shipped `10 · 30 · 100`.

This is the one metric re-banded in the browser, and the page says so: the PNG still draws the shipped
reading. Every other band is graded in node, so the page cannot lay out or grade a file differently
from the picture beside it.

**And the page has a drive now** (`test:browser:codegraph`, a row in `DRIVES.md`). Both ways this page
has broken were invisible to everything that existed: a `const` read before its declaration, and a
backtick inside a comment inside the `String.raw` block, which closed the literal. Each rendered a
page that draws its tiles, looks right, and has a dead control on it — and the suite only ever asserted
that the script PARSES. Twelve assertions: the map, all four layouts, the `more` menu, the sliders
moving the bands, the strip and the map repainting, reset, and no page errors. Both of those defects
were caught by writing it.


## 2026-09-17 — the codegraph reads the functions inside a file, borrowing the project's own parser

A file is not where complexity lives. `client.js` is large because ONE function in it is 1342
branches deep, and *big file* and *one monster* take different work — so `core/functions.js` reads
functions: **cyclomatic** (decisions plus one), **cognitive** (a decision costs 1 plus however deep it
is nested, so ten flat guards are cheap and three loops inside each other are not), max nesting, and
lines. A one-line arrow is not counted: it puts the median at 1 and buries the file under its own map
callbacks. The cognitive measure is an approximation of Sonar's and says so — no recursion increment,
and an `else if` costs what an `if` costs.

**This package gained no dependency and its tarball no bytes.** The TypeScript parser is looked for in
the PROJECT being drawn, under the rule `core/app-schema.js` already states for a shipped `.lite` —
*installed HERE*, not *resolvable from here*, because bun's `require.resolve` falls back to its global
install cache and memoizes the answer (`FJS-666`). `fli new` already writes `typescript` into every
scaffolded app, so the fallback is for a project that is not one. Measured on this repo: 260 ms to
load, 3.2 s to parse 1687 files, 30 442 functions read.

**The fallback cannot hide, which is the condition for having one.** A file nothing parsed has
`cognitive: null` — no band, grey tile, and a readout saying which of the three reasons it was (no
parser here, the parser reads no `.mesa`, or nothing long enough to call a function). Complexity
itself is untouched: it stays the indent reading on every file, in every project, so the absolute
bands still mean one thing. `cognitive` is a metric of its own behind `more`, banded on
`COGNITIVE = [10, 30, 100]` — Sonar calls 15 the point where one function is too complex, which sits
inside band 1, so a file holding one reads warm rather than red.

Also: every file carries its **bytes** now, and the *each package* layout writes each square's totals
under its name — `102 files · 1.2 MB · 4,310 fn`. Only there: elsewhere a region is a stripe of the
curve, and a number under its name would read as belonging to the tiles beside it.


## 2026-09-17 — a type query is not a dynamic import

`import('./app.ts').App` in a type position and `await import('./app.ts')` are the same eight
characters, and the codegraph's import reader counted both as a runtime edge. They part on what
follows — a member access that is not a call — which is now how it reads them. Measured: 187 of these
in this repo and every one a type (`App`, `SessionContext`, `ILogger`), against 920 real dynamic
imports, every one awaited.

What it was hiding: junction's 32-file knot is 28 files joined by TYPE edges alone, which tsc erases.
Its runtime ring is **4 files and 7 edges** — `litestone ⇄ service ⇄ channels`, plus `bridge`. Depth
and the page's cycle band are unchanged, because a compile-time dependency is still a dependency;
what moved is what the `typeOnly` flag on an edge means, and it was wrong on every one of them.


## 2026-09-17 — the codegraph separates what the project ships from what is built on it

A kind, `private`: source in a package this workspace does not publish. basecamp and orion are code
built ON the framework rather than code that ships as it, and counting them under `source` was
overstating what a release contains — measurably, not academically. Source falls 932 → 662, and the
headline it carries moves with it: **34% of source complexity untested becomes 9%**, and files
scoring over 9 fall from 47 to 18. Both of those numbers were mostly the two applications.

Derived from the manifest's own `private`, never a list of names, so orion crosses back the day it
publishes — which is the day it IS the framework. The root manifest is private too and means
something else there (nobody publishes a workspace), so it is not a package for this. It is asked
only where the answer would have been source, so a test in basecamp is still a test and its README is
still a doc.

`private` is CODE, not a second `example`: it is graded, scored, and counted as use, because a hot
untested file is worth the same look wherever it lives. So the page splits its two readings — the
facts tile answers *what does this project ship* from source alone, while every list and every score
step counts both, since a file that is graded and then hidden is the one shape the page did not have.
The chip is off by default, and the echo line names each unpublished package with its count.


## 2026-09-16 — the codegraph reads imports, and draws the stack they make

`core/codegraph.js` gained a second graph. `referenceGraph` answers *who names this file* and stays
loose on purpose — a string that looks like a path counts, wherever it sits — which is right for a
usedBy tally and wrong for a layer. `importGraph` reads statements instead: import, export-from,
dynamic import and require, comments blanked first, and a specifier resolving to nothing in this tree
dropped. Measured over this repo the difference is not a rounding: the loose reading gives 2715
edges, 21 cycles and one **99-file** knot spanning toolbelt, litestone, junction and auth; the
statement reading gives **2227 edges (221 type-only) and 8 cycles, the biggest 32 files**. The fake
knot was two comments and a string literal — `toolbelt → junction` and `litestone → junction`, both
of which Invariant 1 forbids.

`layerGraph` grades that graph into a `depth` and a `cycle` count per source file. Depth is the
**longest** path down, not the shortest, because what a file sits on is the whole tower; each cycle
collapses to one node first, which is what keeps the longest path finite. This repo runs 23 layers
deep, from `toolbelt/inflect` to `basecamp/api/index.ts`, and 48 files sit in a cycle.

The page shows both. **by depth** is a fourth layout — one band per layer, the deepest at the top, so
the picture is the stack itself: the app's entry alone on the top row, 344 files that import nothing
spread over the bottom seven. **cycle** joins age, churn and tested behind `more`, graded on
`CYCLE_SIZE`, with a pair as the mildest thing it can say and still be true; a file in no cycle has
no band rather than a quiet one. The readout names both per tile.

## 2026-09-16 — two NUL bytes removed from `core/proofs.js`

`splitRow`'s escape sentinel and the runnable-key separator were written as literal NUL bytes. grep
and ripgrep treat a file holding one as binary and skip it with no message, so the module behind
`fli proves` — the one that reads `DRIVES.md` — answered no repo-wide search at all. Written as
`'\x00'` now: same byte at runtime, ordinary text on disk. CI's `hygiene` phase grades every tracked
source file for it, so this cannot come back silently.

## 2026-09-15 — a codegraph tile's corners are one constant

`TILE_RADIUS` in `core/codegraph-page.js` is the corner rounding, `0.25rem`, and it takes any CSS
length — measured through a laid-out ruler element rather than parsed, so `rem` tracks the page's own
type scale. It is clamped to half a tile, past which a square is a circle, and the 2×2 view clips its
four quadrants to the tile rather than rounding each one. The PNG is untouched: at one pixel a tile
there is no corner to round.

## 2026-09-15 — `fli ws:atlas --as=report` lists every capability in one scroll

A package plate answered *what does this one do* and nothing answered *what does the framework do*,
so the question kept being asked of the website's hand-written copy — which had gone fourteen
packages stale with nothing saying so. The report grew a section: 312 rows across 23 packages, one
per file under a package's `docs/` and one per `##` heading in its README, flattened from the same
`topics` and `sections` a plate already shows. It invents nothing, so a wrong row is a wrong
document. A package with neither is a row saying so, because *undocumented* and *absent* look
identical from anywhere else.

## 2026-09-15 — the scaffolded `getLevel` is synchronous

`fli new`'s `api/src/core/gate.ts` exports `function getLevel`, not `async function`: litestone
refuses a Promise from a gate resolver ([`FJS-D296`](../../DECISIONS.md#fjs-d296)), because a row
policy reads the level as `auth().level`.

## 2026-09-15 — the intent pick test names `Invoice.dueOn`

[`FJS-1171`](../../ISSUES_ARCHIVE.md#fjs-1171). `test/intent.test.js` reads `example`'s real schema, and
`Invoice.dueAt` became `dueOn` there; the pick asked for a field that no longer existed and the
verdict was `unhomed` on every run. The paired unpicked ask still misses, which is what the test
is for.

## 2026-09-14 — the codegraph page copies its map as a PNG

**Copy image** puts the map on the clipboard as a PNG, as drawn — view, layout, kinds, filter and an
isolated package — without the hover and pin rings. Driven in Chrome over CDP with clipboard access
granted, the clipboard read back is `image/png` at the canvas's own size; with the page unfocused the
write is refused and the button says so rather than failing silently.

## 2026-09-14 — `fli new` writes `web/src/datetime.js`

A scaffolded web app gets the file that binds `@frontierjs/toolbelt/datetime` to
a clock and a zone once, with `at()` and `ago()` beside it, and the account page's
sessions list reads through `at()` rather than a `toLocaleString()` of its own.
The kit reads no clock and keeps no settings (`FJS-D268`), so without an app-level
binding the first screen that wants *5 minutes ago* writes one inline, and the
second writes another. The header says where the viewer's zone stops being the
answer — a date that belongs to a place takes that place's zone.

`@frontierjs/toolbelt` was already an app dependency. **A real `fli new` against
npm needs toolbelt published with `/datetime`**: 0.1.4 does not carry it, and
the `scaffold` phase cannot see that because it packs the working tree. The
scaffold build here — pack, install, build, the app's own `check`, the
declared-imports walk — is green with the file in it.

## 2026-09-14 — the codegraph page names its packages, lays each as its own square, a package stays one block, and its closed menu stays closed

**Each package** is a third layout beside core at center and path order: every region a square of
its own, side `ceil(√files)`, a cell of ground between squares, largest first, and every square
named. `packageGrid` packs them in shelves and tries every width for the squarest picture — a width
guessed off the total area drew this repo's source 36×49 and half empty, and the search draws it
37×42 at 60% in 3ms. It lives in `core/codegraph.js` and is serialized into the page like
`coreLayout`, so it is tested in node.

**A package laid across the seam of its quadrant's L is one block now.** The room around a core
square is two bands, and each was walked by the curve from its own origin, so the band below ended
far from where the band beside began and the package being laid when the first ran out came out in
two pieces — `cli`, `css` and `jetty` on this repo. The L is one path now: the first band ends on its
outer corner at the seam and the second starts on the cell across. Over 2496 packages in generated
layouts, 834 were in more than one block before and 2 are after — a 2×odd strip, whose curve ends one
cell short of its corner. On this repo every package is one block.

Each package under `packages/` has its name set faintly over its tiles, on a halo of the ground, so
the map reads as places without a legend. Set under slightly transparent tiles first, every tile gap
and region edge cut through the letters, and fading them further only made that worse. A name sits
at the region's own cell nearest its centroid — a region laid as an L has its centroid outside
itself — is sized to the run of that region's cells along that row so it does not spill into a
neighbor, and is capped so the largest packages do not shout. A region nested inside a package is
named for the package: `orion/mockup/api-engine` reads `orion`.

The **more** menu drew over the kind buttons while closed: `.popover` sets `display`, which beats the
user agent's `[hidden]`, so the page hides it by id.

## 2026-09-14 — `fli done`: is the change in the working tree finished

The close-out of a change was five engines and three conventions nobody asked together, and each
step was remembered or not: a new test file absent from the `test` script, snapshots stale after a
docs edit, no `CHANGES.md` entry, a new module missing from the layout map. `core/done.js` asks
them all of `git diff HEAD` plus untracked files. Three checks are new — a `## ` heading added to the
`CHANGES.md` of every directory with a changed file, and a new module or command named in its
`CLAUDE.md` or `_module.md` when that document already names most of its siblings, which reads the
rule off each document rather than imposing one no directory keeps. The other three reuse
`test-files-run`, `register:check` and `checkSnapshots`; the drives `fli proves` names are listed and
not graded. `fli test:done` (`fli done`, `--json`) exits 1 while anything is unfinished.

`.claude/hooks/fli-done-stop.mjs` is a Stop hook over the same report. `stopVerdict` is its policy and
is tested: nothing runs while the tree is unchanged, an unfinished item blocks once and is not
repeated until HEAD moves, and `stop_hook_active` answers nothing, so a shared tree with another
session's work in it costs one block per new item rather than every stop.

## 2026-09-14 — `fli next`: the open register ranked, with its reasons

Of 112 open rows, 68 are S3, so severity alone orders most of the register by file position.
`core/next.js` adds three terms under it, each derived or declared where it holds: how many live
records cite a row, how many open rows declare themselves `blocked by` it, and whether a code file
it links is in the working tree or the last ten commits. Markdown and snapshots do not count as
touched, since a register session touches them every time, and a `blocked by` reference is scored
once as blocking rather than again as a citation. A blocked row leaves the ranking until its blocker
closes. The prose was searched for dependency language first and yielded no edges, which is why
blocking is a declaration. `fli register:next` (`fli next`, `--pkg`, `--json`) prints every row
with its terms, and `fli gui`'s front page has a *next up* panel over `GET /api/next`. Proposals
are not ranked; `IDEAS/overview.md` still ranks those by hand.

## 2026-09-14 — `fli decisions` and `fli decide`: the owner's queue, and answering it without a session

`ISSUES.md` § Needs a decision held one row while the IDEAS papers held about 180 open questions
under `## Open questions`, so *what is waiting on me* had no answer short of asking an agent to read
forty papers. `core/decisions.js` reads both as one queue and grades each question ruled (the papers'
existing `~~**…**~~ **Answered**` convention), decidable (the bullet carries `**A** —` / `**B** —`
sub-bullets and a `**Recommend X** —` line) or open. `core/decide.js` is the one writer: the next free
`FJS-D` id, a ruling prepended to the chosen `DECISIONS.md` section, the question struck in its paper,
and both files put back if `register:check` finds a new error. A pick against the recommendation is
refused without a reason. `fli register:decisions` and `fli register:decide` are the commands, and
`fli gui`'s front page has a *waiting on you* panel over `GET /api/decisions` and `POST /api/decide`,
which refuses a request whose `Origin` is not the page's own host — the server answers CORS with `*`.

`test/checks.spec.mjs` graded the checks panel's severity order over the machine's own row too,
which is placed first whatever its severity; it failed only on a machine that is not ok while the
project had an error, and grades the project's rows now.

## 2026-09-14 — `fli project:tiles` is `fli project:codegraph`, and a tile reads risk

The command, its two modules, its test file and its outputs are `codegraph` now — `codegraph.png`,
`codegraph.html`, `codegraph-badge.png`, `codegraph.json` — with no alias for the old name.

**A tile's four quadrants changed, and dark means look here in every one.** Measured on this repo the
old four overlapped: age and churn ranked −0.38 against each other and churn 0.42 with complexity,
since a big file collects commits for being big; age drew 414 of 1230 source files in its darkest
band because the repo is five months old; and dark age meant *recent*, the one quadrant where strong
was not a warning. The tile is now **heat** (commits, each counting half as much every 30 days, so
one number says *changing now*), **blast radius** (the used-by count, −0.04 against age and the most
independent reading there was), **complexity**, and **exposure** — complexity × (1 − coverage), on
complexity's bands, so the bottom two squares match when nothing tests a file. Commit times come out
of the same `git log` pass, which is also what gives each file `created`.

**The score** folds exposure, heat and blast radius into one number per source file, as a product of
levels that pass through the band cutoffs, so a file is red only when several things are wrong at once
and a tested file scores 0. Snapped to whole bands it zeroed 756 files and left three in the top two
steps; continuous, the steps hold 683 · 50 · 66 · 39 · 46 · 29 · 12 · 3, and 44 files score over 9.
Its color is one tone, `danger`, turned in hue from purple to orange and mixed further off the ground
each step; `secondary` could not be the purple, since it is navy, green or rust by theme and nearer
the ground than danger on a light one. The climb is tested over every theme the stylesheet ships. A
hotspot is heat and exposure both in their top two bands, which took this repo from 122 to 40.

The page opens on the score, with the 2×2 tile, each quadrant alone, and age, churn and tested under a
**more** menu — the package's Popover over `.items.menu`. It lists the highest scores and the widest
blast radii.

Code under an `example/`, `examples/` or `website/` directory is its own kind, `example`, rather than
source. Counted as source, this repo's kitchen-sink app was the largest package on the map and
decided which packages read most used: `@frontierjs/junction`'s entry fell from 141 users to 76, sierra
left the four core packages for basecamp, and untested source went from 503 files to 274. A test, doc
or config file inside one keeps its own kind.

The map and the page are laid **core at center** by default. The PNG has no other layout; the page
keeps **path order** one click away.

## 2026-09-14 — `fli project:tiles` draws a project as one tile per file

A picture of where a project is fresh, busy, untested and heavy, read statically from any git
project. Each tracked file is a 2×2 tile: age since its last commit and lifetime churn from one
`git log -M` pass, tested and complexity (indent summed in levels) from the files. Files are laid in
path order along a generalized Hilbert curve sized to the file count, so a package is one region and
a boundary line marks where it ends. `--as=map` writes the PNG, `--as=badge` a 63-pixel summary of
four 4×4 waffles over source files, `--as=json` the model with the rules it was graded by. The map
draws source files by default, the set the badge counts, because TESTED is grey on every other kind;
`--all` draws every tracked file, and is refused beside `--as=badge` or `--as=json`.

`--as=page` writes one HTML file to explore the same map: hover for a file's readings, pin, one metric
at a time, kinds on and off (which reflows), a path filter and a package row (which dim, so nothing
moves while somebody looks), and the hotspots. It is written in `@frontierjs/css`, inlined, and every
color is a tone: age `success`, churn `info`, complexity `warning` and tested `danger`, each mixed over
the theme's ground at four strengths, three for tested. The page states that as `color-mix()` and the PNGs compute the same oklab mix off the
theme's tokens, so `--theme` (and the page's own switcher) moves all of them, and `TONES` and `MIX`
are the one place a color is chosen.

Tested prefers a `coverage/lcov.info` found under the project for every file it names, and warns
when a report is older than a commit to a file it covers; otherwise a test must name the file, and a
file it imports reads as partly. A commit touching more than a tenth of the tree is a sweep and
counts for neither age nor churn — on this repo 10 of 130 commits, without which every file reads
fresh. Bands are absolute, so badges from two projects compare. It is not a snapshot and writes no
generator line.

Every source file also carries **used by**: how many source files name it, and how many of those sit in
another package. A package imported by its own name now resolves through its `package.json` —
`exports` with Node's subpath patterns, then `main`, then its directory — where it used to resolve
only `@frontierjs/<pkg>/<sub>` by guessing a folder; the 185 bare `@frontierjs/junction` imports on
this repo counted for nothing before, and `packages/junction/index.ts` is now the most used file at
141. The same fix reaches TESTED, since a test importing a package by name now names its entry: 48
source files moved off untested. The page adds a *Most used* table and a line in the readout.

The page's **core at center** layout puts the four most important regions in the middle of the map,
one per quadrant: `coreRegions` ranks by share of source lines plus share of use from other regions,
since size alone crowns an app nobody imports and use alone a kit nobody edits — on this repo ui,
junction, litestone and sierra. `coreLayout` grows each outward in square rings, diagonal first and
most used file first, so four regions of one size are exact mirror images and an asymmetry on screen
is an asymmetry in the code. Every other region joins the quadrant of the core region it imports most
and is laid by the curve through the L its core square leaves — poured ring by ring, as the first
version did, a package came out as a line wrapped round the middle. A region goes whole to the best
quadrant with room and is split only when none has; the square grows twice before a split is
accepted, and on this repo nothing splits. Page only for now; the PNG still draws path order.

The PNG writer that lived inside `core/desktop-surface.js` is `core/png.js` now, with a compressed
mode beside the stored one the desktop icon still uses byte for byte.

## 2026-09-14 — the drive tables live in `DRIVES.md`

The drives table and *Which drive proves a change* were 60% of the root `CLAUDE.md` (100 of 172 KB),
which is loaded on every agent turn, and a turn that proves nothing never reads them. Both moved,
byte for byte, into a root `DRIVES.md`; `core/proofs.js` owns the path as `DRIVES_FILE` and
`core/preflight.js` imports it, so `fli proves`, `fli gui`'s panel, the atlas and the three rules
(`proof-target`, `proof-drive-named`, `drive-preamble`) read the new file with no second path
anywhere. The root `CLAUDE.md` keeps a pointer to `fli proves`. `test/proofs.test.js` fails if
either table header reappears in the root `CLAUDE.md`, where nothing would read it.

## 2026-09-14 — `fli test:snapshots --fix` writes the snapshots an app does not have yet

A fresh `fli new` app had no snapshots, so `--fix` found no headers and reran nothing, and
`fli project:map` and `fli app:atlas` refused for want of `surface.snapshot.md` while naming a
`junction surface` command the developer had to type out. `expectedSnapshots` in
`core/snapshots.js` gives the first command for each register an app's layout calls for, found by
probing the tree: the four Data-realm ones beside `db/schema.lite`, surface, jobs and principal when
`api/src/app.ts` exists (plus notifications when the app depends on the package), and a route table
for `web/` and `site/`. `--fix` writes whichever are missing. The junction ones go at the app root,
because a scaffolded app keeps `.env` there and its module refuses to load without it; one committed
under `api/` counts as present. After the first write the file's own header is the generator again.

Check mode lists the missing ones and does not fail, because a zero-snapshot app used to read as
*0 checked* and clean. CI never passes `write`, so the repo's `snapshots` phase is unchanged. Its
first run over `packages/basecamp` names a `notifications.snapshot.md` the app never committed.

## 2026-09-13 — the first-run command has a copy button

The sign-in page's first-run hint put `fli auth:create-user you@example.com --role admin` in an
inline `<code>`, which wraps mid-command in a 24rem card and has to be selected by hand. It is a
`@frontierjs/ui` `<Code>` now. A scaffold against npm needs a `@frontierjs/ui` published with
`components/display/Code.mesa`, or the page fails to build.

## 2026-09-13 — a scaffolded app tells an agent how to write it

`fli new` writes `AGENTS.md` and `CLAUDE.md`. An agent asked to write code in a fresh app arrived
knowing the ecosystem and nothing here, and the scaffold said nothing back: the package references
that existed sat in `node_modules` with no pointer to any of them. Junction, sierra and mesa ship
one now too, beside litestone's and css's.
**`AGENTS.md` is the framework's and `CLAUDE.md` is the app's** — the second is one `@AGENTS.md`
import, so a developer's notes are never mixed into text the framework owns.

It restates no reference (`FJS-D163`). `appAgentsMd` in `core/app-config.js` points at the shipped
AGENTS.md of each package the manifest names, lists the generators, and states the rules a generic
habit breaks with the `fli check` id that grades each — one says `[not graded]`, because nothing
can see a hook doing the schema's job. Three sources hold it: `AGENT_DOCS` against
`exports.snapshot.md` in both directions, the cited ids against `RULES`, the commands against the
registry. The `scaffold` phase asks the installed app whether every pointer resolves, which is the
only place the published bytes are read. `doc-commands.js` grades an `AGENTS.md` now, which it had
not for either package that shipped one.

## 2026-09-13 — a scaffolded app is written in `@frontierjs/css`

`fli new` imported the design system and then styled its four screens by hand — 25 hex colors
across the layout, the home page, sign-in and register (Invariant 13) — so a theme reached none of
them. They are vocabulary now: Shell, Topbar, Navlink with `aria-current`, Badge, Card, Facts, Steps,
Alert, Field, Btn. `<body class="app">` is new and not cosmetic: the package has no bare `body` rule,
so every line outside a component rendered in the browser's serif. The tutor's selectors followed —
`.topbar` for the shell, `.auth-card` for the sign-in scope, and `09-mesa`'s anchor.

The nav's `aria-current` read `page.route` with no `$:` watch over it, so the highlight was set at
mount and never moved on a client-side navigation; the build's own warning named it. The topbar
also carries a theme switch — `theme` in `sierra.config.js`, `theme-default`/`theme-dark` following
the OS, keyed per app because every scaffold shares `localhost:8000` — and an unknown URL renders
`[...404].mesa` instead of the layout around nothing.

## 2026-09-13 — a scaffolded app with auth has an account page and a way back in

`fli new --auth` wrote sign-in and register and nothing after them, while its README advertised
password reset and email verification — whose callbacks logged a bare token that no page accepted.
**`/account/`** changes the name (only where the example `users` service exists, since that is the
one way the app writes a `User` row), the password, and ends other sessions; the topbar's address
links to it. **`/reset/`** is both halves: without a token it asks for an address, and the link that
request produces opens it with one. `onPasswordResetRequested` prints that link — a clickable
`WEB_URL/reset/?token=…` — because there is no mailer, and the page says so in dev: the route answers
the same for a registered and an unregistered address, so the terminal is the only place a reset is
visible. **`WEB_URL` is new in `env.ts`**, defaulting to `FLI_PORT_FE`: the API's own origin has no
page for a link to land on. Driven in a browser: rename, change password, *sign out everywhere else*
(the other token then answers 401), and a full reset from the printed link, after which the old
password is refused.

## 2026-09-13 — a scaffolded app has a first test, and its API follows the port broker

**With auth, `fli new` writes `api/test/access.test.ts`** and `bun run check` runs it last: who may
list, rename, promote, edit and delete a `User`, every refusal paired with a caller allowed the same
thing, graded by the app's own resolver. That needed the resolver out of `db.ts` — importing `db.ts`
opens the app's database — so it is `api/src/core/gate.ts`, exporting `getLevel` (what
`fli tinker --gate` loads) and `gate`. Removing `role`'s `@allow('write', …)` or lowering `User`'s
read gate each fail exactly one test. The env takes a throwaway `encryptionKey`, because `.env` is
gitignored and a CI run has none. Without auth nothing is written and `check` names no test:
`bun test` over a directory with no test file exits 1. `tutor:test`'s doors test now installs the
gate too — its prose said `actingAs` ran the app's resolver while the env it built ran the default.

**The API ignored `FLI_PORT_BE`.** `vite.config.js` proxied `/api` to it while `env.ts` read only
`PORT`, and the generated `.env` set `PORT=8100` besides — so a broker-assigned port left the proxy
forwarding to nothing, or the API colliding with another app on 8100. `PORT` and `APP_URL` default to
`FLI_PORT_BE` now and are commented out of `.env`; a deploy sets `PORT` explicitly and is unaffected.

## 2026-09-12 — the API on a domain of its own

`FJS-1089`. **`deploy.api.domain` puts the API at its own origin** — `api.example.com` beside
`deploy.web.domain` — and `core/edge.js` is the one reader of both: `deploy:setup` writes a web block
that serves the SPA and proxies nothing plus an API block that proxies every path, the web build runs
with `VITE_API_URL=https://<api domain>`, the SSL step checks each side's certificate, and the report
names both. The build refuses a bundle that does not contain the origin, since a `sierra.config.js`
that never reads the variable builds clean and calls its own origin. A domain that is not a hostname is
refused by key. Unset is one origin, as before. `make:deploy` writes the key commented out.

**Every API call through the one-origin vhost had been a 404** (`FJS-1100`): `proxy_pass` carried a
URI, which makes nginx replace the `/api/` prefix, and a scaffolded app registers its routes under it.
The vhost moved out of `_steps-setup/05-nginx.md` into `core/edge.js` so a real nginx can load what
setup writes: `pauseEdgeCycle` now runs the generated file in both shapes against an upstream that
echoes the path it received, beside a control copy with the URI put back that answers the stripped
path.

## 2026-09-12 — a scaffolded app is one a browser offers to install

`fli new` writes `web/public/manifest.webmanifest`, `web/public/icon.svg` and the two `<link>`s, and
sierra's build grades the manifest. The `scaffold` phase asserts the build prints
`manifest.webmanifest — installable`, because the grade is a warning and a template change that
broke it would otherwise exit 0. Its first run found that `fli new` had never created `web/public/`.

## 2026-09-12 — `intent.js`: a miss is unhomed, and a fact may pick off the menu

Run 2 (`IDEAS/run-intent-recognizer-2.md`) put a hundred messages through the resolver against a blind
key and 21 of its 41 wrong answers were built on words that found nothing — *private note* missed
`Customer.notes` and answered *you can do this* off the `@@extensible` pool. **A miss now answers
`unhomed`** for every kind; `needs us` comes only from a positive fact (no state machine, two known
states with no edge, a declaration the model lacks), and the pool is a note rather than a verdict.
**`menu(index)`** lists every entry with its label and schema comment, and a fact may carry **`pick`** —
one id off it, refused otherwise — so a translator matches meaning and the verdict is still decided here.
Each fix is paired in `test/intent.test.js` with the words that must still hit.

## 2026-09-12 — `fli intent`: a candidate resolved against the app's own seed

The middle of `IDEAS/intent-recognizer.md`, and the part no model is allowed to do. `core/intent.js`
takes a candidate — a claim (`question`, `change`, `broken`) and facts in plain words with a kind — and
answers one of six verdicts per fact, the deepest cost class, a citation into a committed artefact, and
the resolved identity requests dedupe by. It reads the parsed `db/schema.lite` and the text of the
`surface`, `routes` and `notifications` snapshots, and nothing else.

- **A candidate carrying an identifier is refused.** `Customer.notes` from a translator is a fact it
  invented; the identifier in an answer is always one this module produced.
- **Words matching two things resolve to nothing** and name both. A foreign key and the relation it
  backs are indexed as one fact, which the first run against `example` needed.
- **A `@system` move is checked against the surface before it is declined**, which is run 1's one
  wrong answer (A24, `invoices.settle`) — asserted, and red with the surface lookup removed.
- **What a screen shows is not indexed**, so a UI fact resolves its data half and reports the screen
  as `unverified`.

`fli intent` loads the app's OWN litestone through its `exports` map, so this package still depends
on no database. `test/intent.test.js` asserts fourteen run 1 rows against `example`'s real artefacts.

## 2026-09-12 — `fli make:desktop`

**`core/desktop-surface.js` owns the `desktop/` surface** (`FJS-D263`), and `example/desktop/` is now
its output rather than a hand-written shape: `test/desktop-surface.test.js` regenerates it and
compares every file byte for byte, so `verify:desktop` — the only thing that builds a shell — proves
what the generator writes. `--wraps web` writes the config, `deploy/build.mjs` and the Tauri crate
under `shell/`; without it the surface also owns `src/`, a Vite root and a dev server on the new
`desktopDev` port category (8800 for a scaffold). The crate, product name and identifier derive from
the app's name, and the scaffold warns that the identifier is where the OS keeps the app's session.

Three things moved with it. `build.mjs` refuses any config with no `api`, not only a wrapped one —
a desktop app owning its screens had the same same-origin trap — and `api: null` is how an app with
no API says so; it builds the screens from their own directory, since a scaffolded `web/` leaves its
Vite root to the working directory. The binary's name is read from `Cargo.toml` rather than
restated. And `surface-config` names `desktop.config.js`, so a config left at the surface root is
reported as it is for every other surface.

## 2026-09-12 — `desktop/` is a surface `fli check` reads

**The surface list is one constant in `core/checks.js` now, and `desktop/` is on it** (`FJS-D263`).
Ten rules each restated which directories are surfaces, so a surface missing from one copy was
source that rule never read with nothing saying so. `SURFACES` and `CLIENT_SURFACES` replace all ten.
A desktop-only app — `desktop/src/` beside `db/` — is graded as an app rather than skipped as a
fixture, and every rule reading client source reads `desktop/src` as it reads `web/src`; the three
rows in `test/checks.test.js` go red with `desktop` taken back out of the list.

## 2026-09-12 — a rule answering the wrong shape throws instead of passing

`FJS-1049`. `runChecks` read `out.findings ?? []`, so a rule returning a bare array — which is what
a body building `findings` reads like — contributed nothing, was listed as having run, and had 0
written into `check-baseline.json` as its ceiling. `verdictOf` now requires exactly one of
`{ findings: [...] }` or `{ skipped: 'why' }` and throws naming the rule otherwise. Its first run
found `detail-read-dead` answering both keys on a tree with nothing to read; the array was always
empty there, and the rule now answers `{ skipped }` alone.

## 2026-09-12 — a deploy asks where the jobs database is before it throws it away

`FJS-1095`, measured: with Caravan's path left at its default, the running app
held `/app/db/jobs.db` — inside the container — and a container swap turned one
pending job and a pause into none of either, while the same swap with the file on
`/db` kept both. That was every app wired by `fli outbox:install` or
`fli backfill:install`, whose hints passed no `db`.

**`_steps-docker/05b-jobs-volume` runs before `06-swap`**, against the container
about to be replaced, and asks Caravan's own bin which database it has open. It
is silent when the file is under the volume, when there is no container, no
Caravan, or no open database. Outside the volume it prints what the swap will
lose, with counts, and **refuses only when a pause is in force** — that deploy is
a migration about to run with every queue claiming. Pending work alone warns,
because refusing would deadlock: binding the path is itself a deploy.
`CONTAINER_DB_DIR` is the one spelling of `/db`, read by `swapContainer`'s
`--volume` and by the check. Both install hints now resolve the jobs database
beside `DATABASE_URL` against the app root, and the Dockerfile template lists it
beside the audit trail as a thing that must live under `/db`.

## 2026-09-12 — a pause drains the queues, and an unpause gives back only its own

`FJS-D262`. `fli deploy:pause` stopped callers and left every job, cron and
outbox delivery running in the container it kept up, which is the half that
matters for the migration a pause is usually taken for. Two steps join Caravan
now: `03b-queues-pause` drains every queue once the edge answers 503, and
`02a-queues-resume` resumes them before the guard file is removed.

**Neither step writes Caravan's tables.** Each runs Caravan's own
`caravan queue drain|resume` inside the serving container through
`docker exec -w /app` — `05-backup`'s shape — so the code writing the pause row
is the code the app reads it with, and nothing in `fli` knows where the jobs
database is. `core/pause.js` gains the three pure halves: `queueScript` (the
script, which always exits 0 and prints the bin's JSON last, since a non-zero
exit carries a reason `capture` would throw away), `queueVerdict` (ok, note,
warn or fail, from that JSON) and `queueStateLine`, which `deploy:status` prints
beside the edge as `queues:` with drift named — an edge paused over claiming
queues, or a deploy's queue pause over a serving edge. The pause is held by
`fli:deploy`, so an operator's own pause survives the unpause and is printed.
**Only a REFUSAL fails the transition** — two jobs databases open in one
container, output nobody can read. No Caravan, no container and no open database
are reported and succeed, because nothing is claiming jobs and a failed pause of
an app that is down asks somebody to fix what is not broken. A refused pause
leaves the edge paused and is finished by running it again; a refused unpause
leaves the edge paused too. `03-verify`'s *jobs, crons and the outbox go on*
warning is gone, since it stopped being true.

The actor reaches the bin as one argument whatever it contains, asserted by
running the arguments through a real shell rather than reading the text; with
the quoting reduced to plain single quotes, two tests fail. `queue-operator-verb`
also refuses `app.jobs.pause()` — the every-queue form — in a service or job
file. `scripts/scaffold-build.mjs` `pauseQueueCycle` is the crossing, in CI's
`deploy` phase.

## 2026-09-12 — the scaffolded sign-in page asks for a code

`fli new`'s `routes/login/index.mesa` did `await signIn(); goto('/')`, so an account with two-step
sign-in landed on `/` signed out with nothing said. It renders the code box from
`session.awaitingCode` now, sends it with `submitCode`, and offers *Start over*, which drops the
pending attempt through `signOut`. The page is emitted from a string in `commands/project/new.md`,
which `test/generated-mesa.test.js` does not reach — it was compiled and its output parsed by hand;
the `scaffold` CI phase is what builds it inside a real app.

## 2026-09-12 — a scaffolded app can name its API origin at build time

**`fli new` writes `junction.url` as `VITE_API_URL` when the build sets it**, and the page's own
origin otherwise. The origin alone assumed a proxy in front of the API, which is true under Vite
and under `fli deploy`'s nginx and false for an API on a domain of its own (`api.example.com`
beside `app.example.com`) and for a build a native shell bundles, where the page is
`tauri://localhost` and every call went to the shell. `VITE_API_URL` is the name `example/site`
already read for the same question. Unset, the built bundle is unchanged — measured on `example`
and basecamp, which carry the same line.

## 2026-09-12 — `skill-pointer` reads a skill's own tables

A skill can cite skills — `which-skill` is nothing else — and a name renamed out from under it
left every other line reading correctly. Every `.claude/skills/*/SKILL.md` is now read for a table
with a `Skill` column, the way the root `CLAUDE.md` already was; prose in a skill is not, because it
is full of backticked words that are not skills. Its first run over the router found a real one:
`discovery` is a per-user skill under `~/.claude/skills` and absent from this repo, so the router
cites it in prose that says so rather than in a graded table. `test/checks.test.js` carries the
pair plus the frontmatter case reported once however many skills cite it; removing the new reader
reds the first.

## 2026-09-12 — a generated list page is one `list()` call

`core/crud-templates.js`'s list page reads its state through `resource.list()` (sierra) and wires
none of it: no store subscription, no `load()`, no bare `$: page.query` watch, no `apply` or
`sortBy`, and no `@frontierjs/sierra/router` import at all. The bar is handed `list.query` and
`list.directives`, the table `list.rows` and `list.directives.orderBy`, and **a *Load more* is
rendered while `list.hasMore`** — keyset `more()` was built, correct and called by no page, so
every generated list stopped at the server's page size with nothing saying there was a row 21.

The two silent failures the hand-wiring carried are tripwires now rather than comments: a page that
wires a load by hand or subscribes to the store itself, and a page that never offers the window.
`generated-mesa.test.js` asserts all four per generated list; the `scaffold` CI phase builds a
scaffolded model's page against packed tarballs.

## 2026-09-12 — an app can be taken down on purpose, and the journal can migrate

`IDEAS/release-transitions.md` § Phase 3b. Until now the only way to stop serving
was to stop the container, which the journal reads as a crash: `readState` goes on
answering that Release R is serving while nothing answers at all, and the pipeline
cannot deploy in that state either, since `06-swap` runs the migrations in the
container's own entrypoint.

`fli deploy:pause` and `fli deploy:unpause`. A pause is a `TransitionKind`, not a
flag — it names the Release already serving, mints none, and *is this app paused*
is the kind on the last succeeded transition rather than a column. The refusal
happens at nginx, which is the only place that can answer for the SPA and the API
at once while the app keeps running; the guard is `core/pause.js`, tested per
request, so neither direction needs a reload or sudo.

**The cost was not in the pause and this record did not predict it.** The DDL is
`CREATE TABLE IF NOT EXISTS` throughout, so a target that has deployed once holds
`CHECK ("kind" IN ('deploy','revert'))` that no new DDL can reach, and
`Journal.formatVersion` shipped able to refuse a journal from the future and
unable to reach the next format at all — a version field that could only refuse.
So the first half of this is a migration path: `migrationPlan` walks format to
format in one transaction, the runner takes `foreignKeys` as a stated connection
setting, and the `journal` table loses its `formatVersion` default on the way
past, because a default that has to move on every format change is a table whose
shape moves forever.

**Two things were found by running it rather than by writing it.**

`PRAGMA foreign_keys = OFF` was being set before the DDL, and the DDL snapshot
opens with `PRAGMA foreign_keys = ON` of its own — so the caller's answer was
discarded, `DROP TABLE "transition"` cascaded, and the rebuild deleted every step
of every transition ever recorded while reporting success. The negative control
is what caught it: `test/journal-migration.test.js` runs the same statements with
keys on and asserts the steps are gone, which is the only way *the flag works* can
be told from *nothing was ever at risk*.

The guard has to sit AHEAD of the http→https redirect. Both are rewrite-phase
returns and the first one wins, so a guard placed after it answers 301 to every
plain-http caller of a paused app — the app looks up, over a scheme somebody is
really using. Asked as a pair in CI's `deploy` phase, against a real nginx.

`core/revert.js` had to be told about the new kinds: `chooseTarget` reads
`succeeded[0]` as serving and `succeeded[1]` as the previous, so with pause rows
counted both shift by one and a revert offers the Release already running — which
`same-bytes` then refuses, on the day a revert is wanted, in words that read as a
bug in the revert. `servingHistory` filters inside both readers rather than at the
call site, because forgetting it produces a plausible answer rather than an error.

**`already` is graded on both answers, not on the journal.** The first version
refused an unpause whenever the journal said serving — which is exactly the state
of a target somebody paused by hand, the one case `deploy:unpause` documents
itself as existing for. A journal saying paused over a missing file must accept
another pause, and a journal saying serving over a present file must accept an
unpause, because in each the refused command is the one that fixes the drift.

**`openPauseJournal` is called for real in `test/pause-journal.test.js`**, by
evaluating `_module.md`'s script block against a `localhost` machine and a temp
journal. A destructure that did not land left `filePresent` undefined inside it,
every test that compiles the file stayed green, and the first thing to notice was
the deploy cycle four minutes into CI. The new file kills that mutant.

`fli deploy:status` prints the journal's answer and the edge's side by side and
reconciles neither. The two rows that matter are the ones where they disagree:
recorded but not in force, and paused by hand.

**It is `unpause` and not `resume`** because `fli deploy --resume` already means
*continue an interrupted transition*, and two different operations one keystroke
apart in the command somebody types during an incident is worth an uglier word
for.

**What a pause does not do**: the container is up, so jobs, crons and the outbox
go on. It stops callers, not the app, and `03-verify` says so at the moment
somebody has just taken the app down rather than in a document they read
afterwards.

## 2026-09-10 — a generated list page's URL watch, and why it is still stated twice

The list page carries two `$:` lines naming the same two properties: the handler that reloads on a
navigation, and a bare `$: (page.query, page.directives)` above the const. The bare one exists only
to mark `page` a watched import, which is what makes the filter bar's query a derivation rather than
a value read once — [`FJS-1065`](../../ISSUES_ARCHIVE.md#fjs-1065).

**It was removed and put back the same day, which is the entry.** That defect is fixed in mesa's
working tree, so the handler form alone now promotes and the line looked redundant. An app does not
run the working tree: `core/app-config.js` pins `@frontierjs/mesa` at `latest`, and the latest
published mesa does not have the fix — so a scaffolded app's filter bar merged each new filter over
the query the page had ARRIVED with, and every filter appeared to replace the last. Found by
dogfooding a scaffolded app, not by a suite, because every suite here resolves mesa to
`packages/mesa/` and cannot see what npm serves.

The line comes out on the release that publishes the fix and not before. `test/generated-mesa.test.js`
gained the assertion that grades it either way — a generated page that hands a query to a filter bar
must compile that query as a derivation — and it belongs there rather than in mesa because the claim
is about EMITTED code, and a generated page is a string inside a `.js` file until somebody scaffolds
an app.

## 2026-09-10 — a generated resource stops turning on what is already on

`createResource` reads its payload pipeline as `!== false`, so `coerce`,
`blankToNull` and `validate` have been on by default for some time. Every
generator here went on writing all three out as `true` with a paragraph of
comment each, which is a scaffold teaching a new reader that a resource is a
place you switch things on — and the sierra README still called them
*default off* three times, which is the half that is not merely noise.

All three writers drop them: `core/resource-template.js` (behind
`fli make:resource`, `fli web:resource` and `fli make:scaffold`),
`fli make:model --resource`, and `fli admin:generate`. A generated resource is
now a service name and a model, and what is left of the comment is the one
thing that still changes a decision — that each half takes an explicit `false`,
which is what `validate: false` on a form that cannot see a required column is
for.

## 2026-09-10 — a scaffolded app hands Junction its db client instead of wiring it

`fli new` wrote `createApp({ auth, config })` with no `db`, then scoped the
client by hand out of a generated `core/hooks.ts`. Junction installs that
scoping from `createApp({ db })` and, in the same branch, four things with no
other install site: the write announcement that reaches open tabs
(`FJS-010`'s complaint), the request context on every audit row, the audit
metrics, and the query telemetry the devtools console reads. With no `db` the
branch is falsy, so a hand-scoped app got the scoping alone — and each of the
four is silent when it is missing.

Both templates pass `db` now and `core/hooks.ts` is gone, its only export
having been the hand-wired hook. Measured in a real scaffolded app:
`GET /api/metrics` answers an `audit` key with `db` passed and does not
without it (`FJS-1069`).

## 2026-09-09 — a scaffolded app declares its middleware and plugins, and writes neither

`fli new` wrote both halves of every one: `junction.config.js` declared
`middleware.helmet`, `requestLogger`, `correlationId` and `plugins.health`,
`manifest`, and `api/src/app.ts` then configured four of them by hand. The
config half was inert (`FJS-1066`), so the file every new app starts from taught
the wrong surface and shipped six keys that did nothing.

Under `FJS-D256` the declaration is now the whole of it: the scaffold's app.ts
carries no middleware and no plugin registration, and the explanation of what
belongs where lives in the config file that holds them. Proven by the `tutor`
phase — `tutor:app` is the only thing that boots a scaffolded app and probes
`/api/health`, which is a route the config file now asks for.

## 2026-09-09 — a generated list page's filter bar was a control that did nothing

Three defects in a row, each of which alone leaves every filter and every sort
dead, and none of which reports anything.

**The router dropped the query.** `apply()` navigated with
`goto(page.path + encodeQueryString(query))` — one string — and `buildUrl` runs
`normalizePath` first, which STRIPS the query because the same function answers
what a route matches. With `params` empty there was nothing to put back, so
`goto('/notes/?title[contains]=alpha')` navigated to `/notes/`: the URL it was
already on. Nothing moved, nothing threw. `buildUrl` now keeps a query — and a
hash — the path already carries, and `params`, when it has anything to say,
REPLACES rather than merges, because a caller handing over a whole query means
that query and merging would resurrect a filter somebody had just cleared.

**The call site was wrong in a second way that only shows on the second
filter.** `page.path` already carries the search, so concatenating built
`/notes/?a=1?b=2`. It is `goto(page.path.split('?')[0], query)` now — the
documented two-arg form, over a path stripped of its own query, which is also
what makes Clear clear.

**And the page never watched the URL.** `resource.load(page.query, …)` ran once
at setup; the router does not remount for a query change on the same route — it
moves `page.query` and expects the page to be watching. Every hand-written list
in `example` and `basecamp` has `$: page.query, page.directives, () => load()`
and the generated one had nothing.

**A fourth thing is filed rather than fixed** ([FJS-1065](../../ISSUES_ARCHIVE.md#fjs-1065)):
that handler-form `$:` does not mark `page` a watched import, so `urlQuery`
compiled to a plain const and the BAR stayed frozen even once the rows moved —
no Clear button, no box reflecting the URL. A bare `$: (page.query,
page.directives)` promotes it, and the template now carries both lines.

**`tutor:ui` types into the bar now.** The lesson stood on the list page and only
ever asked whether a row was drawn, so every control above the table was
untested — which is why this shipped. Three assertions, because three things can
fail apart: the bar writes the URL, the URL has exactly one `?` in it, and every
row left is a match. Not asserted over HTTP: a signed-in app holds a socket, so
the read rides a WS frame and the network panel shows nothing, which is what made
this look like *no request was made* from the outside.

## 2026-09-09 — a scaffolded detail page never left its spinner

**The generated `[id].mesa` subscribed to nothing.** It wrote
`const unwatch = row.subscribe(v => record = v)` over a `row` the same script
declares — and a `const` whose initializer CALLS a local binding is a lazy
derivation ([FJS-D212](../../DECISIONS.md#fjs-d212)), so the memo computed only
when something read `unwatch`, and the only reader is `$.onDestroy`. The
subscribe never ran, `record` stayed `null`, and the page drew `Loading`
forever: 200 on the wire, nothing in the console, nothing thrown, valid
JavaScript. The handle is a `let` and an assignment now, which is what every
hand-written detail screen in `example/` and `basecamp/` already wrote — the
asymmetry is why no drive here ever saw it and only a scaffolded app was broken.

**The spinner was also drawn from the wrong question.** `{:else if !failed}`
over `record == null` cannot tell *still loading* from *the read came back with
nothing*, so a row that does not exist and a row the caller may not read both
spun with nothing said — and `record().ready` RESOLVES `null` for both, so the
`.catch` beside it could never fire ([FJS-1063](../../ISSUES.md#fjs-1063)).
There is an explicit `loaded` flag now, set in a `.finally`, and a sentence for
the null.

**`tutor:ui` now asks what the detail page drew, which is why this shipped.**
The lesson already asserted the save NAVIGATED to `/notes/<id>/` and then went
to the list, so the one screen in a scaffolded app nothing ever rendered was the
one the scaffold got wrong. Asked as the input VALUES rather than the visible
text — `innerText` does not carry them, so a form drawn over a null record
passes any assertion about what the page says. Measured: with the old template
restored, `tutor:ui` reds on *the detail page drew the record*.

## 2026-09-09 — a scaffolded app claimed to be signed in, and had nobody to sign in as

**`fli new --auth` wrote a nav with an unconditional `Sign out` button.** A
stranger opening the app saw a shell that says it holds a session, clicked
`Users`, and was answered *Authentication required* by the Data boundary — a
working app reporting itself broken on its own front page, and the second time
that sentence has been paid for (`index.mesa` said `connecting…` forever for the
same reason). The layout now reads `session.user`, offers `Sign in` when there
is nobody, names the account when there is, and hides `/users/` from a caller
`model User`'s gate of `4` will refuse. `session.checked` gates all of it, or a
cold load of a signed-in caller renders the signed-out shell while the restore
is still in flight.

**And there was no way in.** The scaffold wrote `/login/` over an empty `user`
table: nothing to sign in as, no register page, and no link to one. The API has
mounted `{apiPrefix}/auth/register` since the first `--auth` scaffold, so the
missing piece was a screen — `/register/` is now written beside `/login/`, the
two link to each other, and the login page names the other door
(`fli auth:create-user … --role admin`, the only one that mints an ADMINISTRATOR)
behind `import.meta.env.DEV`. `fli new`'s closing block says both, because
`auth:install` already said one of them several hundred lines up the scroll,
which is where advice goes to not be read.

**The tutor's sign-in helper is now scoped to the login form, and grades the
shell it is standing on.** `clickText` searched the whole page for the text
`Sign in`, and the nav's new link is above the form in document order — so the
lesson would have clicked the link, navigated to the page it was already on, and
reported a sign-in that never happened. Standing on `/login/` is also the one
moment a lesson knows for certain that nobody is signed in, so it is where the
signed-out shell is asserted; the signed-in half is asked as the ACCOUNT rather
than as the absence of `Sign in`, because a page that rendered nothing passes
that. Measured: with the old layout restored, `tutor:ui` reds on *the nav says
nobody is signed in*.

**A note about running it.** `tutor:ui` defaults to the dev slot for project 0
(8000 / 8100) and ADOPTS whatever already answers there, so with an app of your
own running it grades that app and reports the lesson broken —
[FJS-1061](../../ISSUES.md#fjs-1061). Pass `--api-port 7100 --web-port 7000`,
which is what CI does.

## 2026-09-09 — `ws:pub --interactive`

**A release is now walkable one package at a time** (`-i`). npm's 2FA opens a
browser and is asked once per publish, which the batch loop could not pace: it
handed the OTP prompt to whichever package came next while the person was
reading a different one, and a failure partway through left versions on the
registry, tags in the tree and nothing pushed — the state step 02's own warning
describes.

Interactive is a FLAG on `ws:pub` rather than a command of its own. A second
command would be a second implementation of what a release is, and `release:` is
already a noun here — a Release is what `fli deploy` mints, not what npm holds.

**It does not bump per package, and cannot.** `bun publish` rewrites a
`workspace:*` dependency from the lockfile, so all versions are written, the
lockfile is refreshed once and the commit is made before anything publishes;
bumping one at a time would pin every sibling to a version the run has not
published yet. So the pauses are where a person can actually answer: choosing
the candidates and their bump levels, approving the preflight before a version
is spent, each publish, and the push.

A declined publish is a SKIP rather than a failure, because by then the version
and tag are already written — the run reports which packages are versioned and
unpublished, and the `bun publish` that finishes one.

**The release commit now regenerates the snapshots the bump invalidated.** A
version is a fact about the workspace and both atlas pages state it, so a commit
that bumped and did not regenerate was stale the moment it was written — and the
`snapshots` phase runs in the `pre-push` hook, so the push was refused AFTER the
packages reached the registry. That is the one ordering this pipeline cannot
recover from by re-running: the version is spent, the tag is local, and the
remedy was a command nobody was told. `checkSnapshots({ write: true })` runs
between the bump and the commit, which is the only place with no person standing
in it. A snapshot already edited in the working tree is named and left alone,
since step 01's rule is that an unrelated edit is not part of this release.

## 2026-09-09 — `fli ci`, and the atlas had been publishing twelve of thirteen phases

**`fli ci` runs the workspace CI from anywhere in it** (`FJS-D255`). An alias and
nothing more: everything after the command name is handed to `node
scripts/ci.mjs` untouched, so there is one flag set, one phase list and one exit
code, and a flag this command has never heard of is refused by the runner rather
than dropped here. `bun run ci` is a root script and answers only from the root,
while a phase is most often wanted from inside the package that just went red.

An app has no `scripts/ci.mjs` and gets told so, naming `bun run check`. The walk
up for the runner is by hand rather than `context.wsRoot()`, which prompts when
it finds nothing — a prompt hangs a job that reached the wrong repo by mistake.
The `ci` alias came off `completion:install`, which nothing referenced.

**`node scripts/ci.mjs --help` used to run the whole build.** Unrecognized flags
were ignored, so asking the file what it does started a fifteen-minute run that
touches Docker. Flags are a table now — with a takes-a-value column, without
which `--base-ref origin/main` reads its own value as an unknown flag — and an
unknown one exits 2 naming itself. `--help` prints every flag and every phase
with its tier, generated from `PHASES` and `FULL_ONLY` rather than written out.

**Which cost `main()` its call sequence, and that found a defect.** The phase
order was stated twice, as the `PHASES` table and as the calls; `main()` now
iterates the table. `core/repo-map.js` was parsing those calls with
`^\s*(\w+)\(\)$`, which does not match `await registry()` — so
`repo-atlas.snapshot.html` and `repo-report.snapshot.html` have been publishing
**twelve** CI phases for a workspace that runs thirteen, with `registry` absent
and nothing saying so. It reads the table and the tier set now.

## 2026-09-08 — `money-rendered-raw`, and the generated list rebuilds its URL

**A new `fli check` rule.** A `@money` column holds MINOR units, so printing it
is a price a hundred times too big — with no error, no warning and nothing
looking wrong, which is what `FJS-D242` was ruled about. The authority is the
SCHEMA: the app declared the column, so *this number is cents* is a fact in the
tree rather than a claim a paragraph makes.

Two narrowings decide what it can say. A name declared `@money` on one model and
plain on another is DROPPED — a `.mesa` says `{order.total}` and nothing in it
says what `order` holds, so reporting an ambiguous name is advice that is wrong.
But a `view` column is not evidence, because a projection is a SELECT and there
is nowhere on it to write the attribute: counting it as plain dropped `total` for
every model that DID declare it, which is exactly what happened on this repo's
own example app. And only TEXT position is reported — `value={row.total}` is
handing the column to something whose job is rendering it, which is what
`<Cell value={row.total} column={c} />` is, so flagging it would report the fix
as the bug.

**A generated list page rebuilds the whole URL query** (`FJS-1047`).
`splitParams` takes every `$` key out of `page.query` and into `page.directives`
under an unprefixed name, so the bar was handed the filters alone: no sort, no
page size and no search to show, and a query missing them on the way back.
Sorting a column and then typing in a filter dropped the sort, in silence. The
page recombines with `directiveParams`, `parseDirectives`' inverse off the same
table, so it cannot go stale when a directive is added.

## 2026-09-08 — `route-part-prefix`

A new `fli check` rule, error. A co-located route part is named whatever the app
likes; a dotted lowercase prefix is a CLAIM about the folder that owns it, and a
fork that copies a folder keeps the source's prefix — so
`routes/contacts/_clients.Row.mesa` is false about its own location
([`FJS-D250`](../../DECISIONS.md#fjs-d250)).

The convention itself is deliberately not adopted: both apps in this tree hold
four `_*.mesa` files and all four are `_module.mesa`, so a mandate would fail the
apps we ship on the day it landed. `_module` is reserved, `_Plural.mesa` and
`Row.mesa` claim nothing, a `[id]/` segment is a folder no prefix can match, and
an app writing no dotted prefix never sees the rule.

## 2026-09-09 — the `scaffold` phase asks whether the app names what it imports

`FJS-1045` shipped through a green `scaffold` phase and was caught by one
tutorial lesson, because the two install the app differently
([`FJS-1048`](../../ISSUES_ARCHIVE.md#fjs-1048)). `vendorWorkspacePackages` writes an
`overrides` entry per packed package — it has to, or the framework packages'
dependencies on EACH OTHER resolve from npm — and bun installs and hoists all
seventeen. So the app resolves a package it never declared, and the phase whose
whole job is *does a scaffolded app work* passed on a tree where it did not.

The overrides are load-bearing and were not the thing to remove. The step is:
**every `@frontierjs/*` the app's own source imports must be named in its own
`package.json`**, both dependency fields, since `cli` and `config` are
legitimately dev ones. It runs after `fli scaffold Note`, so the source it reads
includes the four files that command generates — which is what makes it the
other end of the unit guard in `test/app-config.test.js` rather than a copy:
that one reads the TEMPLATES against the catalog, this reads the app that was
actually WRITTEN against its own manifest, and neither set contains the other.

**The first version of this step passed against a deliberately broken manifest**
and that is the part worth keeping. `readdirSync` was never imported by
`scaffold-build.mjs`; the walk's own `catch` turned the ReferenceError into
silence, and an empty result reads exactly like a clean app. So the count of
packages SEEN is now asserted before the list of undeclared ones — *nothing is
wrong* and *nothing was read* are the same answer otherwise, which is this
phase's own hazard one level in.

Measured by re-running the whole phase with the `FJS-1045` fix stubbed out: it
names all four sites, including the `users/` page that started it, and passes
with 7 packages seen once the fix is back.

## 2026-09-09 — a scaffolded app is given every package its generated pages import

Every CRUD list page `fli scaffold` and `fli admin:generate` write imports
`encodeQueryString` and `directiveParams`, and `toolbelt` sat on
`FJS_PACKAGES`'s *deliberately absent* list — so a freshly scaffolded app could
not resolve its own pages and `bun run build` exited 1
([`FJS-1045`](../../ISSUES_ARCHIVE.md#fjs-1045)). The front door.

The comment listing the absence already argued the case against itself: it says
`ui` is IN because a scaffold without it *produces pages that cannot resolve
their own imports*, which had become exactly true of toolbelt. It now states the
rule rather than the instance — **a package a GENERATOR imports is not a product
decision.** `testing` and `email-kit` are absent because an app is offered them
or not; adding a generator import is a change to that list.

**Nothing in the repo could see it.** The `scaffold` CI phase builds a
scaffolded app and passes, because it packs seventeen tarballs and swaps nine
dependencies to the working tree, so a transitive toolbelt is resolvable however
the app declares it. Bun installs into `.bun/` with symlinks, so a package an app
does not NAME is not resolvable by name from its own source — which is the
difference between that phase and a real `fli new`. Only `tutor` walks the
registry path, and it caught both this and `tutor:ui` one lesson later.

The guard is the cheap half of that, in `test/app-config.test.js`: scan what
the template modules write, and hold it against the catalog AND against the
`useUI` block read out of `new.md` rather than restated. Two halves, measured
separately — dropping toolbelt from the catalog reds 1, dropping it from the
deps block reds 1 — because a package can be offered and not written.

**A guard separating template text from a module's own imports was tried and
thrown away.** It cannot be done line-shaped: `widget-surface.js` carries an
import from `@frontierjs/sierra/build` at column 0 inside a template literal, so
it is indistinguishable from a real one, and the heuristic read as working only
because there was nothing for it to skip. The test counts both and says why that
is sound — a framework package the cli imports is one an app is already offered,
and the only over-report would be `testing` or `email-kit`, which is worth a
look rather than a false alarm.

## 2026-09-09 — `register:check` grades a row's section against its id

`ISSUES.md` holds two registers in one file. The reader tells them apart by
SECTION; the conventions table tells them apart by PREFIX — `FJS-D##` is a
ruling, `FJS-###` is a defect — and nothing compared the two, so five closed
defects sat in § Needs a decision and every rule passed over them
([`FJS-1033`](../../ISSUES_ARCHIVE.md#fjs-1033)).

**Both existing rules are blind there by construction.** `row-shape` grades on
the CELL COUNT and both tables declare four columns, so a closed defect parked
among the questions reads as a decision whose Question cell holds a date. And
the status branch is only reached for a row carrying a severity, which a
decision-section row never does — so `closed-in-open`, written for exactly this
direction, is skipped for exactly the table where the misplacement is invisible.

`id-section` is an error rather than a warning because the two cases need no
judgment: a defect id under the decisions heading, a ruling id under a severity
one.

**§ Closed and the archive are exempt in both directions, and that is the
lifecycle rather than a loophole** — a question that gets its ruling closes as a
row under the id it was asked under, and twenty-seven `FJS-D##` rows
legitimately sit in this repo's own § Closed. A rule reading the prefix
everywhere would report the normal end of every decision as a fault.

Each firing case is PAIRED with the legitimate shape one prefix away, and the
live row over this repo's own register is load-bearing rather than decorative:
the five were fixed by hand, so a green answer has to mean the placement is
holding. Measured — stubbing the prefix test reds 3 of 4, the § Closed control
passing either way by design.

## 2026-09-09 — `tutor:fleet` enrolls the machine instead of handing it a fleet key

The lesson gave the Outpost a fleet-wide `OUTPOST_SECRET` that basecamp had
stopped accepting, so the first heartbeat was answered 401 and the lesson died
at step 5 — taking the `tutor` CI phase with it
([`FJS-1041`](../../ISSUES_ARCHIVE.md#fjs-1041)). The app was right and the lesson was
stale, which is the class the phase exists to catch.

`05-outpost` now runs the exchange `install.sh` runs on a real machine, minus
Docker, Bun and a systemd unit: `issueEnrollment` mints a single-use token,
`POST /servers/{id}/enroll` spends it, and the machine starts on the key it got
back. **Two calls because they are two callers** — the operator at gate 5 saying
this machine may join, and the machine, unauthenticated by definition, spending
what it was given. One call would be a control plane handing credentials to
whoever asks.

The negative control is the claim rather than tidiness: the SAME token is
replayed and must answer 401. A token that still worked would pass every other
row and leave the burn — a conditional update on the hash column — untested.

`outpostSecret` is threaded to 06 and 07, which restart the machine when nothing
is answering. Measured: reverting the one line reds step 5 and blocks 06-08, 19
checks against 25.

## 2026-09-08 — `fli check` read comment text as schema

Three of `core/checks.js`'s line scans skipped a line that STARTS with `//` and
read one that ends with it. The rules read `.lite` as text on purpose — they
must answer with no database, no migration and no installed litestone — so
comment text arrived as content to a regex.

**Found on basecamp**, where `transition-methods` reported
`transition(…, 'loseContact')` as *"a call that has never worked, found by
whoever asks for it first"* — about a move declared on the line below the note.
The clause split is on top-level commas and the six-line comment above it
carries three, so the move was cut in half, its name lost, and a STATE appeared
among the moves the rule listed as declared. Measured: strip the comment lines
from that one block and the finding goes 1 → 0 with the schema otherwise
untouched.

**Two siblings had it and one was worse.** `declaredGates` read a trailing
`// was @@gate("7") once` as a declaration, so `gate-unreachable` reports a rung
nobody can reach that nobody wrote. `declaredColumns` counts braces to decide
where a model ENDS and counted them in comment text — an unbalanced `}` in a
note closes the model early and every field after it goes invisible to
`package-model-drift`, which then compares half a model against a package's
whole one. Four columns became two.

**One owner**: `withoutComments(line, inBlock)`, dropping both of the language's
forms the way litestone's own lexer does, read by all three. A quoted string is
not lexed, and that is stated rather than handled — the alternative is a string
lexer inside a scan whose whole point is needing no parser.

Nine tests, each a pair, and the pairs took two attempts: the first version of
the `declaredColumns` rows used a note carrying BOTH braces, which nets to zero,
so they passed either way — the failure the test file's own header exists to
prevent. The brace is unbalanced now, and the row that fires is separated in
writing from the control that legitimately does not.

**Why it matters more than a warning count.** `core/checks.js` is the shared
engine — CI's `structure` phase and every client app's `fli check` — and house
style is heavily-commented schemas, so it fired exactly where the style is
followed. A check that is wrong is worse than no check.

## 2026-09-08 — `app:atlas` and `project:map` stay two commands, and stop parsing one file twice

**Ruled `FJS-D240`: they are not [`FJS-D223`](../../DECISIONS.md#fjs-d223)'s shape.** D223's test is
ONE READER, and it states it as a measurement — `core/repo-atlas.js` performs no filesystem reads at
all, so `ws:map` and `ws:atlas` could only ever have been two renderings of one collection. These are
two collections that overlap: `app:atlas` collects `describeAppModel` off a built app, `project:map`
collects a file tree, the committed snapshot, migrations, packages and the environment and folds in
three of the model's four halves. A merge would offer no second presentation — only a flag naming
which model to build.

**`--atlas` is a COLLECTION flag on `--layer`'s axis and `--as` is a presentation flag.** Folding a
second command in would put a third value on the collection axis and call it a presentation, which
reads D223 backwards. Measured on `example`: `--no-atlas` 278 ms, the default 637 ms, `app:atlas`
488 ms — one command means the file-only read pays a boot on every run, or the flag that avoids it
is the *which model* flag.

**What was real is the duplication.** `core/app-entry.js` and `commands/project/_module.md` each
carried `SURFACE_FILE`, `SURFACE_DIRS`, a `surfaceFile()` walk, the `generated by:` header parse and
`surfaceMissingHint`. **One had already drifted**: the same missing-file sentence read *Services are
read off a built app* in one copy and *The app is read off a built app* — a tautology — in the other,
and nothing graded that they agreed. A snapshot format with two parsers grows two answers.

`readApiSurface` moves whole into `core/app-entry.js` and CALLS `surfaceFile` and `generatedBy`
rather than restating them, which is the half that makes the collapse permanent rather than tidy.
141 lines leave the command module for 11. `project:map` imports it the way it already imports
`readAppAtlas`, so one module answers both of that command's questions about the app.

**The test stopped reaching a parser through a regex over a `<script>` block.** Two of the three
helpers `test/project-helpers.test.js` used to extract are a plain import now; only
`extractResourceMeta`, which genuinely lives in the namespace module, is still extracted. Measured:
13 of its 31 rows red with the moved parser stubbed.

One stale comment fixed on the way — `app-entry.js` justified returning a failure rather than
throwing by *`project:map`'s whole property is that it needs no bun and no boot*, which stopped being
true the day `--atlas` began defaulting to true. The degrade is still right, for a different reason:
the model is one section of a report whose others are files.

## 2026-09-08 — `ws:pub --tolerate-republish`

**A publish run does not stop at the first failure — it collects them and throws at the end.** So a
run that loses its auth window partway leaves some packages on the registry and some not, and both
recoveries were broken: re-running the same command bumps again and skips a version, while resetting
and re-running hits `bun publish` exiting 1 on every package that already went out. Step 02's own
comment promised *fix the failure and re-run*, and that advice did not survive the case it was
written for.

**It is a flag rather than the default, and that is the decision rather than the caution.** A version
the registry already holds normally means the bump did not happen — and a release that quietly
published nothing looks exactly like one that worked. Silencing that by default trades a loud
failure for a silent one, which is the wrong direction for the one command here that cannot be
undone.

The partial-failure warning now names both recoveries and which one costs a version, because the
moment it prints is the moment somebody has to choose between them.

## 2026-09-07 — `fli test:snapshots --fix`

**The remedy for a stale snapshot was 26 commands a person rebuilt from a failure message.** The
list was never missing — every snapshot carries the command that wrote it in its own header, and
`findSnapshots` has read that since the phase was built. What was missing was the WRITE: the engine
appended `--check` unconditionally, so the one thing it could not do was the thing you wanted after
it failed.

`--fix` is the same argv with one fewer argument. Nothing new reaches a shell, so `SNAPSHOT_BINS`
and the plain-flag-or-path rule still govern what may run.

**It regenerates and then RECHECKS**, rather than trusting the write. A generator that exits 0
having written nothing is exactly the shape a stale snapshot already has, and the two failures are
reported as different sentences — *did not run* against *ran and did not settle*, the second being
a bug in the generator rather than a stale file.

**A list was the obvious answer and it was the wrong one.** A hand-written set of pre-push commands
is a second origin for something already derived, and it fails OPEN: add a kind of snapshot, forget
the list, push stale. `snapshots.js` exists so that adding a kind costs a generator and never an
edit here, and a list would have quietly repealed that.

Found two stale snapshots on its first run, both left by the same day's spelling sweep —
`example/db/ddl.snapshot.sql` and `example/site/routes.snapshot.md`, where a storefront page title
still read `Catalogue`.  <!-- spelling-exempt — naming the string that was fixed -->

**And `scripts/hooks/pre-push` said something untrue.** Its header claimed *hygiene, coverage and
typecheck only*; the fast tier runs ten phases, `snapshots` among them. So push-time detection was
already wired and the comment was talking anybody who read it out of relying on it.

## 2026-09-07 — `american-spelling`, and the sweep it exists to make unnecessary

**[`FJS-D192`](../../DECISIONS.md#fjs-d192) had no enforcer, so it re-drifted.** The ruling flipped
this repo from British to American, prose and identifiers alike; nothing graded it, and five weeks
later the sweep was **1,131 replacements across 285 files** — `normaliseOrderBy`, `summariseDiff`,  <!-- spelling-exempt — a ruling quoting the spelling it retired -->
`SerialiseError`, `memoise` in twenty-nine files, and `catalogue` 421 times against a CLI command  <!-- spelling-exempt — quoting the spelling this rule retired -->
already spelled `catalog`.

`american-spelling` is a `scope: 'repo'` warning. Three things about it are the design rather than
the implementation.

**It is a word list and not a suffix rule.** `parenthesis`, `synthesis` and `initialism` all carry
`-is-` and none is British, so every entry carries enough letters that it cannot match one. This is
not hypothetical: a suffix sweep once rewrote `analyses`, the plural of `analysis`, in
`toolbelt/inflect` AND in the test that guards it, in one commit — leaving nothing to fail. The
comment there is a warning, not history, and this rule is written to respect it.

**It grades what this repo WROTE.** `test/fixtures/corpus/` is exempt because those schemas are
fetched from real projects so the importers meet input nobody here wrote — `Organisation` is  <!-- spelling-exempt — quoting the spelling this rule retired -->
Documenso's own model name, and correcting it would edit somebody else's schema and destroy the  <!-- spelling-exempt — a ruling quoting the spelling it retired -->
property the corpus exists for. Build output, `*.live.*`, the two append-only archives and
`checks.js` itself are exempt too; the last because a dictionary rule that read its own table would
report every word it exists to find.

**`spelling-exempt` is the inline escape, and the sweep is what proved it necessary.** Litestone's
catalog SYNONYMS table deliberately carried both spellings of one word — the comment beside it says
so and names this ruling — because that table holds what a SEARCHER types rather than what this repo
writes. The sweep collapsed the pair into a duplicate and `catalog.test.ts` caught it: *a synonym
belongs to one row — two owners is a coin toss*. Correcting input is deleting the entry, so the
marker takes a reason on the same line and the rule skips that line.

## 2026-09-07 — `project:map` and `project:view` are one command

They were two readings of one tree and they disagreed. `project:map` assembled
its model inline, `project:view` had a `buildMap()` of its own, and the two
answered **54 models against 42** over `example` — one counted `$defs` by shape
and the fix for that landed only in the other (`FJS-1016`). They also collected
different fields: env health and the app atlas existed in the page's model and
nowhere else, so *what does this project contain* had two answers depending on
which command you asked.

`FJS-D223` one scope down, and applied rather than re-argued — **one axis, so one
flag**, and `--as` absorbs `--json`:

```
fli project:map                the terminal report
fli project:map --as=serve     FJSChain in a browser
fli project:map --as=json      the model
fli project:map --out m.json   a destination, on its own axis
```

`project:view` is deleted with no alias; nothing outside this tree depends on the
spelling. `buildProjectMap` in `_module.md` is the one reader. `--layer` narrows
what is COLLECTED rather than what is shown, so a narrowed run is cheaper and its
JSON says only what it looked at.

**`--as=serve` does not exit.** Every other `--as` value anywhere answers and
stops; this one is a server. It is in the flag description rather than left to be
discovered.

**`fli project:map --json | jq` was broken for the life of the flag.** One
`Reading schema...` line went to stdout above the object, while the flag's own
prose said to use it to pipe output to tooling. Progress notes are suppressed
whenever stdout is the document — the same defect `junction atlas` had on its
first run, one package over.

**The report gained what only the page had**: jobs, crons, notifications and the
principal realm, plus a warning for a required secret that is not set. A field
the model carries and one presentation drops is the shape this merge removes
(`FJS-927`).

**One trap found by moving code.** A `<script>` block in a `_module.md` compiles
to MODULE scope, above `run()` — so `log` there is zx's global, a function with
no `.info`, and the server threw `log.info is not a function` the moment it was
lifted out of a command body. Everything the namespace helpers need is a
parameter now; `deploy/_module.md` already did this on all 18 of its `log.*`
calls, which is what says it is the pattern rather than a workaround.

`pview` becomes `pmap` on port 8501, with the tutor's `tools` lesson and
`test/pview-state.test.js` renamed with it. 1995 passing.

## 2026-09-07 — `project:view`'s 33 warnings were all false, and the React viewer is gone

**The gateAuth check was inverted.** `collectIssues` read the per-method `before`
chain for `gateAuth`, which is an `around.all` hook `createBaseService` installs
unconditionally — measured, zero occurrences in any `before` chain of any
snapshot in this repo and one in `around · all` on every service. So it fired on
exactly the 22 services that expose a write method and called *ungated* the one
thing gated on every path: a feature list dressed as a security finding
(`FJS-1017`). It is DELETED rather than repaired, because the hook is
unconditional and the question has no varying answer per service. Where it does
vary is the raw routes, which run below the pipeline, and `fli app:atlas
--ungraded` is where that is asked.

**The other 11 were `type` declarations.** Models were filtered out of `$defs` by
shape, so eleven payload shapes were warned about for a `@@gate` they cannot
carry. They are filtered on the stated `x-litestone-kind` now — litestone's half
is `FJS-1016`.

**Both survived because `collectIssues` had no test**, which is the finding under
the findings. `test/viewer-issues.test.js` grades it, every negative PAIRED with
a finding that must still fire — a function returning `[]` satisfies the
negatives alone. Measured against the code it replaced: restoring the shape
filter reds 2 and restoring the gateAuth check reds 1. Its DOM stub exists only
to get at the two pure functions; nothing in it asserts on the page.

**The `test` script is an explicit file list**, so the new file ran nowhere until
it was added to it — a test that exists and is never run. Every other file in
`test/` was already named; this one was the exception and briefly the proof.

**24 `info` rows left Issues for the services panel.** *No resource binds to this
service* is coverage, not a defect — an API-only service is correctly bound by
nothing — and 24 of them pushed the real findings off the page. It is a
`resource` column now, with the sentence saying a dash is not a problem.

**`--legacy` and `web/viewer/legacy.html` are removed.** The React page it kept
for comparison was the last thing here that loaded from a CDN, and the injected
env-health panel — ~110 lines of script, its `/__envhealth.js` route and the tag
splice — existed only to serve it, since the current page has that panel in it.
`project:view` now has one viewer, needs no network, and `modelCount` stopped
making the same shape guess the page did.

## 2026-09-07 — `project:view` reads three panels off a built app, and the surface parse is graded against real files

**Three panels no file can answer.** A job registers itself by being autoloaded,
a notification takes its type from its own file name, and a principal resolver is
installed in code — so jobs, notifications and the principal realm were in
neither `project:view` nor `project:map`, and the two commands between them
covered one of the four registers. `--atlas` (default on) boots the app once
through `junction atlas` and folds the other three in.

**It degrades rather than fails, and that is the point of the flag.** This
viewer's property is that it needs no bun and no running server; booting an app
needs bun. So a missing bun or an app that will not build costs three panels and
leaves every file-derived panel beside it untouched — measured: with `bunx`
stubbed to exit 127 the map still carried 38 services. The page prints WHICH of
the three reasons it was, because an app with no jobs and an app nobody could
boot must not draw the same empty table. `--no-atlas` skips the boot outright.

`readAppAtlas` in `core/app-entry.js` is the one owner of the spawn, because two
spawns of one command is how two views come to disagree about which app they
described. It RETURNS a failure rather than throwing one: `app:atlas` has nothing
without the model and stops, `project:view` renders around it, and only the
caller knows which it is. Its spawner is injectable, which is what lets all three
paths be exercised with no bun, no app and no boot.

**And the surface parse is now graded against the files it actually reads.**
`readApiSurface` had only the fixture in `test/project-helpers.test.js`, which
describes itself as *a trimmed copy of the real shape* — a copy is frozen at the
moment it was written, so the only failure it could catch was one somebody
hand-typed into it. The oracle is each snapshot's own `N services · N routes · N
plugins` summary, written by the renderer straight off the model and never read
by the parse, since it sits in a code fence above the first `##`; two halves of
one file grade each other and no number is kept in step here.

**Measured, and this is the hole**: moving the service heading in a real snapshot
reds exactly ONE test — the new one — while every fixture test stays green. The
files are discovered with `git ls-files` so a new app is covered without an edit,
and the count is asserted first, because discovery alone fails open. No drift
today: the parse agrees with both apps exactly (38·38·12 and 34·31·11). 1988
passing.

## 2026-09-07 — `fli app:atlas`, and the entry read off a header rather than probed

Four committed registers answer four questions about a built app, and the fifth —
*what can this app do, how is each of those reached, and what graded it* — cost
opening all four and joining them by hand. `app:atlas` is that join, rendered
from one model junction computes (`junction atlas`, one boot, one walk).

**It renders and does not read.** Importing the model was impossible rather than
merely unwanted: this package declares no junction dependency and cannot gain
one, since junction is Bun-only and `fli` runs under node — and a junction living
here would be a DIFFERENT junction than the one that built the app, which is
version skew no byte compare can see. Spawning the four existing snapshot tools
instead means four boots and four rendered pages to re-parse, which recovers a
cross-register column by matching names.

`core/app-entry.js` is the entry, and **it is never probed**. Guessing
`api/src/app.ts` is wrong for an app booting from its root (`packages/basecamp`),
wrong for one naming an `--export`, and silently wrong rather than absent — it
would describe an app running on junction's defaults. The committed
`surface.snapshot.md` already carries the answer in its `generated by:` header,
which is the same line the `snapshots` CI phase reruns, from the same directory.
The command travels as argv against an allow-listed binary, because it comes out
of a file and a file in a repo is not a string somebody typed.

**There is deliberately no per-service *what graded it* column.** It was written,
measured and removed: `gateAuth` is a derived around hook `createBaseService`
installs unconditionally, so every service in both apps here carries it — 38 of
38 in `example` — and a column whose only possible value is *fine* is a check
that can only pass. Where the question has an answer that varies is the raw
routes, 21 in `basecamp` and 28 in `example`, each running below the pipeline
with no `gateAuth`, no `autoValidate` and no envelope; `--ungraded` lists them.

What it cannot answer it says: which SERVICE a job calls is in the job's source,
not in the built app, and reading source is the scan this view exists instead of
(`FJS-254`).

## 2026-09-07 — the container a deploy runs is named for its tier

`core/ports.js` exists so a test-tier run and a dev-tier one can share a machine.
The container name was `${appId}-api` at ten call sites with no tier in it, and
`tutor:deploy` names its app `my-app` for every run — so `bun run ci` on 7103 and
a person on 8100 wanted one name, and the loser died on
`Conflict. The container name "/my-app-api" is already in use`
([`FJS-1013`](../../ISSUES_ARCHIVE.md#fjs-1013)).

Both directions were seen the same day: a CI run refused because a hand-run held
the name, and a hand-run whose container CI removed then failed its health check
with *No such container*, which reads exactly like a broken deploy.

`apiContainerName(appId, port)` is the one owner, and it lives in `ports.js`
because the name is a function of the tier and the two must not drift again.
`deployJournalCycle` had already solved this for itself by naming its app
`fjsjrn${pid}` — the two halves of the deploy testing disagreed about whether
concurrency was allowed.

**Only the test tier is suffixed.** Every deployed container is `<app>-api`
today, and stop, logs and revert all address the name, so renaming them would
orphan a running container mid-upgrade. The collision that happens is CI against
a person, which is the tier boundary exactly.

The tenth copy is the lesson worth keeping: `tutor:deploy` derived the name
independently, so fixing the nine pipeline sites left the deploy creating
`my-app-api-test` while the lesson looked for `my-app-api` — nine sites correct
and the feature broken. Proven in both directions against a real daemon.

**There was an eleventh**, in `scripts/scaffold-build.mjs`, and it is the same
lesson a third time: `deployJournalCycle` wrote `${appName}-api` by hand while
its port is test-tier, so the pipeline created `-api-test` and every assertion
in the cycle looked for a container that did not exist. Ten sites correct and
the phase red.

Its wreckage is the argument for suffixing only the test tier, made concrete: the
failed run's teardown could not remove its own container — it looked for the
unsuffixed name — so an orphan held port 7102 and every later run died on
`port is already allocated`, which reads as a deploy defect. A test-tier orphan
costs a `docker rm -f`; the same mistake in production is an outage nothing can
reach.

**And the cycle now asks whether its port is free before it builds an image it
cannot run.** `tutor:deploy` already refused a busy port by name; the cycle went
ahead and let docker answer three minutes and one image build later. A held port
is a SKIP rather than a finding, the verdict the tutor phase already gives, since
this phase refuses a busy port rather than moving to a free one — so a collision
is a fact about the machine. Measured: 30s to a named skip, against 3 minutes to
a docker error.

`portFree` moved into `scaffold-build.mjs` and `ci.mjs` imports it rather than
keeping its own copy. `core/probe.js` keeps the async one for the shipped CLI —
not merged, because unifying them means changing the shape of one of the two
callers, which is more than the question is worth.

## 2026-09-07 — a rule that reads code stops reading the prose beside it

`FJS-1004`. `resource-file-name` matched `model:` anywhere in a resource file,
so the first one written over a `view` — whose header cites
`createResource('lenses', { model: 'Lens' })` as the escape it is taking — was
reported as naming a model it does not use. Comments are blanked before any of
the matching now, in `stripComments` rather than in the branch, because the next
rule to match on code has the same problem; the test that keeps it honest is the
pair, a real `model:` one line below a comment.

The other half is that the rule knew only models. A Resource over a `view` is
Invariant 19's second half with a declaration behind it: a projection is named
like an accessor, so no PascalCase filename can BE its name and the file takes
its SERVICE noun singularized. Accepted only when the stated name is a declared
view AND the filename is that noun — a misnamed projection file is still an
error, rather than a branch that stops looking.

## 2026-09-07 — A name for a command line you type often

`fli make:shortcut go-time "fli ws:atlas --open --live"`, and `fli go-time` runs
it from the project root with anything typed after the name appended verbatim.

**It writes an ordinary command file, and that is the whole design.** A registry
of name → string would have been a second place a command name comes from, and
every reader of the first one — discovery, `fli list`, completion, `fli edit`,
the doc rules — would have had to learn it. A file under
`cli/src/routes/shortcut/` is already all of those things for free, and a
shortcut that grows into a real command is an edit to that file rather than a
migration out of a table. `core/shortcuts.js` is the one owner of the shape.

The noun is `shortcut` rather than `alias` because `alias:` in frontmatter
already means *a second name for one command file*, which is exactly the job it
does here: the generated `shortcut:go-time` carries `alias: go-time`.

**The refusal is the reason it is a command rather than a convention.** A
project command overrides a core one in SILENCE — the authoring model, and the
wrong default for a name typed from memory, where `fli make:shortcut new "…"`
would eat `fli new` and say nothing. The registry is asked before anything is
written, and the refusal names what holds the name.

Two smaller decisions, both about being wrong invisibly. A leading `fli` is
rewritten to `${context.fli}`, the absolute path of the fli that is running: a
global install and a workspace checkout are routinely both present, and a
shortcut resolving off PATH would reach the other one with nothing printed. And
the argv tail is forwarded raw rather than re-serialized from `flag`, because
minimist has already folded fli's own defaults into that object and a shortcut
would have sent `--dry` and `--test` to a command that never asked for them.

`mode: passthrough` is new beside `mode: strict` and the default, and the
generated file declares it — an undeclared flag on a shortcut is one the target
declares, so announcing it would print on every run.

## 2026-09-07 — How big is this package, on both pages

A plate said what a package IS and never how much of it there is. Two numbers
now, and they are deliberately on different pages.

**Tracked file count, on the committed atlas.** It moves when a file is added or
removed and never when one is edited, which is the only shape of size that does
not churn a byte-compared page. Read from one `git ls-files` for the whole tree
rather than a call per package, and **it has to be tracked**: a directory walk
counts what is lying around, so basecamp reads 272 against 216 and vscode 56
against 33 — SQLite files and a write-ahead log in one, a built `out/` and two
`.vsix` in the other. Those are untracked and local, so a walk would give this
machine and CI different answers about a committed page. No git, no number: the
field is absent rather than guessed.

**Shipped size, on `--live`.** `files:` decides what goes in a tarball, so what
an app installs is a different fact from what the repo holds — litestone is 269
tracked files and ships 52. Read as `dist.unpackedSize` and `dist.fileCount`,
which npm has already measured, so nothing is fetched or unpacked. Registry
data, so it can only live on the page that holds a clock, and rounded, because
an exact byte moves every release and nobody compares one.

The rounding has a floor: a small package reads `1 KB` rather than `0 KB`, since
*empty* and *small* are different claims and one of them is a package that
failed to build.


## 2026-09-07 — `pascalOf` and `singular` were the sixth and seventh copies

`core/checks.js` derived a model name twice — `pascalOf` for the service rules
and `singular` for the `.mesa` filename rule — each hand-rolled beside the
`singularize` it already imported from `@frontierjs/toolbelt/inflect`. Both are
the kit's `modelName` now, which splits on humps and whitespace as well, so the
rule that GRADES a model name and the litestone readers that PRODUCE one can no
longer disagree about `order-item` (`FJS-975`).

## 2026-09-06 — `doc-cites-dead` stops accepting a link that is dead to the reader

A link was resolved against three bases — the repo root, the document's own
directory, and the package root — and ACCEPTED on any hit. So
`](packages/litestone/src/core/ddl.js)` written inside `IDEAS/` passed, and is
`IDEAS/packages/…` to anybody who clicks it: the rule was correct about the tree
and wrong about the reader (`FJS-750`). **Measured blind first** — planting one
defect of each class left the finding count at 6, unchanged.

A link resolves from its own document now. The other two bases are still probed,
because *the file is there and the link does not reach it* is a different finding
with a different repair, and the message computes and prints the `../` spelling
rather than describing it. Inline CODE keeps all three bases on purpose: it is a
name a reader navigates by, not a link a tool follows.

**The rule's own header was the doctrine and it was wrong.** It said all three
spellings are in use and none of them is wrong; two of the three are dead in
every renderer, editor and browser. Hearing held (§ IV, doctrine vs discovery)
and the comment corrected with the code.

**A `file.ext:N` label is now graded against its own `#Lm` anchor.** Two
statements of one line number in one string, so they compare with no parser —
which is what separates this from *does line N hold that symbol*, the half that
wants a resolver per language and stays in `IDEAS/claim-checking.md` § 3. It is
also the rule that would have caught the corruption this row's own hand-repair
introduced.

5 tests, 2 red with the base check stubbed and 1 with the anchor check. **Three
of the five are controls**, because a grader has two ways to fire on everything
here — report every link, or report every `#L`. Tree unchanged at 6 findings.

## 2026-09-06 — `fli ws:pub` refuses before it spends a version number

`npm publish` is close to irreversible — a version is gone the moment it lands —
and the publish path had no preflight at all. It would publish from a dirty
tree, in alphabetical order, with peer ranges it never read.

`core/publish-preflight.js` answers **all** the reasons a release must not
proceed, each with the flag that overrides it, the way `core/revert.js` already
does on the other pipeline: a checker that stops at the first refusal makes an
operator discover the rest one flag at a time.

**A dirty tree is refused** (`--allow-dirty`). npm packs the working directory
and not the commit, so uncommitted files ship under a tag whose tree does not
contain them.

**A peer range this release steps outside of is refused** (`--allow-peer-drift`).
Below 1.0 a caret pins the MINOR, so `^0.1.0` excludes `0.2.0` — and nothing in
the publish path rewrites a peer range. Nothing inside the workspace can notice
either: a `workspace:*` devDependency answers first, so the range is never
consulted until somebody installs from the registry. Peers are read across every
member rather than the release set, because the package that breaks is the one
DECLARING the peer and it is usually not one being bumped.

**A range it cannot decide is refused too**, under its own name. `satisfiesRange`
decides exact, caret and tilde and answers `null` for everything else rather
than guessing — a range parser here would be a release decision made by a regex,
and a check that cannot tell and stays quiet is indistinguishable from one that
approved.

**Publish order is now the dependency graph** rather than the order the filter
happened to produce. It was alphabetical, so `auth` published before the
`litestone` and `toolbelt` it resolves against; it is now
`toolbelt → litestone → junction → auth → …`. A cycle is a note rather than a
refusal — refusing over one would refuse most real workspaces, and the packages
still have to go out in some order.

24 tests. Every refusal is paired with the shape one character away that must
still be allowed, because a preflight that refused everything would satisfy any
test asking only about the refusal.

**`--except` lands with it**, because one `ws:pub` applies one dist-tag to
everything it publishes — so a package that needs a different tag has to be held
back from the run rather than tagged differently inside it. `@frontierjs/outpost`
is the case: a fleet agent whose `/exec` runs shell and whose secret is shared
across the fleet ([`FJS-257`](../../ISSUES.md#fjs-257)) should not be reachable
by a bare `npm i`, so it goes out under `next` in a run of its own.

An `--except` that matched nothing WARNS by name. Silently publishing the
package it was meant to hold back is the one outcome the flag exists to prevent.

`--filter` and `--except` are one rule asked in two directions and now share
`matchesSelector` rather than each carrying a copy — two would have drifted the
first time one learned about scopes and the other did not.

**Deliberately not here yet**: the `files:`/entry-point check and parsing every
shipped `.lite` before it goes out (the `FJS-921` class). Both are real, and the
first belongs to `fli ws:exports`, which already answers it and has no engine to
call — extracting one is the prerequisite, not a second copy of the question.

## 2026-09-06 — a pivot the journal could not store

`fli deploy` died at `04c-journal` on every deploy in the repo — the deploy
cycle's first deploy and `tutor:deploy` at the same step — with
`FOREIGN KEY constraint failed` ([`FJS-952`](../../ISSUES_ARCHIVE.md#fjs-952)).

litestone ranks a pivot `unchanged < expand < unknown < contract` and answers
the first rung when a release moved no schema. `db/deploy.lite` declares three
of the four. `recordRelease` is an `INSERT OR IGNORE`, and IGNORE silently drops
a row that violates a CHECK, so the `release` row was never written and the
transition's foreign key failed one statement later — naming neither `pivot`
nor the word that was refused.

`mintRelease` normalizes `unchanged` to `expand`, before the id hash. Pivot
answers one question — can Release N-1 still serve this database — and both
rungs answer yes. Doing it after the hash would give one Release two ids
depending on which word arrived.

The test that matters reads the CHECK out of the shipped `ddl.snapshot.sql` and
puts every rung of litestone's ladder through the mint, so a fifth rung fails
loudly rather than being dropped in silence. All three new tests are red with
the mapping removed.

## 2026-09-05 — `fli gui` can open the pages it could already regenerate

A snapshot generator is a runnable row, so the front page had a start button for
both pages `ws:atlas` writes and no way to READ either. A `file://` link from an
http page is refused by every browser, so `GET /api/page/:id` serves them off the
project root the server already knows.

**The id is looked up, never joined.** What arrives is compared against the rows
`runnables()` computed, and a row that is not a viewable snapshot answers 404
with the same wording as one that does not exist — so no caller-supplied text
reaches a path, and `..` is not a case to handle because there is nothing for it
to traverse. Whether a row has a page is `viewable` on the row, decided in
`core/runnables.js`, because a page re-deriving *is this openable* from a
filename is a second owner of one rule and only one of the two ever gets fixed.

The link is not `data-open`, which stays hidden until a row answers on its port:
a committed file is there whether or not anything is running, and a link that
appeared only while a server was up would be absent exactly when somebody wants
to read what the tree looks like. `test/browser/specs/view.spec.mjs` asserts the
bytes that come back carry the generator line, because the GUI serves its own
dashboard for any path it does not recognize — so a wrong route reads as a
working link until somebody looks at what loaded.


## 2026-09-05 — `ws:map` and `ws:atlas` become one command

Ruled by `FJS-D223`. They were never two things: `collect()` in
`core/repo-map.js` is the one reader and `core/repo-atlas.js` performs no
filesystem reads at all, so the split was a rendering choice wearing a command's
clothes — and it cost what a second surface costs. Six of seventeen model fields
were rendered by only one of the two pages, and the reader that had silently
gone to zero was found by asking what the other page showed (`FJS-927`).

One axis, so one flag: `--as=atlas|report|json`, the deck by default. It
**absorbs `--json`** rather than sitting beside it, because a boolean and an
enum selecting along one axis are two spellings of one question, and the pair is
what invites a third — the next presentation is a value here, not a second flag.
An unknown value is refused by name with the ones that exist listed, rather than
falling back to the default, since a typo that quietly writes the deck is a
person diffing the wrong file. `--live` is refused against anything but the
deck, before git is read.

`ws:map` is deleted with no alias and `repo-map.snapshot.html` is renamed to
`repo-report.snapshot.html`. Nothing here has shipped, so there is no call to
keep working; the rename is one `removedSnapshots` entry, and the `snapshots`
phase needed no edit because it reads each file's generator out of its own
header.

**Where a section goes is decided by reading mode, not size** — a report is read
across, an atlas is navigated. That is the rule that keeps the report from being
defined as *the small one*, which is the definition under which the next person
trims it.


## 2026-09-05 — The map shows all three registers, and what proves a change

`ws:map` collected seventeen model fields and rendered nine. Six were read on
every run and dropped — `apps`, `proofs`, `invariants`, `checks`, `decisions`
and `ideas` — and one of them was also broken: `decisions()` was a hand reader
predating `core/registers.js` that matched only the legacy bold-lead ruling, so
after the register migrated to `###` headings it answered 0 of 208 and the
section vanished. `ws:atlas` reads the same field and had been printing
`0 settled` in the Rulings card of its own hub row. Both committed snapshots
carried it (`FJS-927`).

The rulings now come through `core/registers.js`, the one owner, and the
duplicate is gone. **The three registers are one section** — what is wrong, what
is settled, what is not started — because the question they answer together is
answered by reading across them. Open rows are still listed in full; the other
two are counted and pointed at, with the newest ruling per section quoted, since
this page is a printout somebody diffs and 208 rulings would drown the eight
lines that moved.

**`proofs` gets a section, resolved.** Eighty-eight rows of *which drive proves
a change*, parsed from `CLAUDE.md`, with each target graded through the same
`resolveRun` that `fli check`'s `proof-target` uses — so the page and the rule
cannot disagree about what is missing. Rendering the prose alone would have
added nothing to the markdown; what a generated page can add is that a row
naming a drive that has been renamed reads exactly like a row that is right.

The old *Which file answers which question* section keeps its content and is
`root-docs` now: it is about what KIND of statement a root file may hold, which
is a different subject from the three registers and was one id away from them.


## 2026-09-05 — `tutor:fleet` releases something, and finds two reasons it could not

Half B. The lesson stopped at *a command from the control plane ran on this
machine*, which is the smaller half: a **release** is the thing a control plane
exists for. Step 7 gives the app a git source — a repository made on disk, since
`POST /deploy` hands `source.repo` to `git clone` and a path is a legal git URL
— creates a Deployment, and waits for the pipeline that basecamp dispatches to
its own queue.

**The assertion is the digest, and then the agreement.** `Deployment.builtImage`
has to carry a `sha256:` the MACHINE reported (a stub answers `null`, which is
why it is asked), a container has to be running here under the app's name, and
the two have to be the same bytes. A release that cannot say which bytes are
serving has not been shown to have released anything. `BASECAMP_STUB_OUTPOST` is
never set.

**Two defects, both of which made a real release impossible, and neither of
which any suite could see** — basecamp's own drive injects a fake docker:
[`FJS-919`](../../ISSUES_ARCHIVE.md#fjs-919), outpost addressing a locally built image
as `name@<image-id>`, which docker reads as a pull; and
[`FJS-920`](../../ISSUES_ARCHIVE.md#fjs-920), basecamp omitting `app_id` from `/deploy`,
so the container was named for the deployment while every other route addressed
the app.

Two environment facts are stops rather than failures, the shape step 1 already
uses for a missing basecamp: no docker at all, and a workspace the DAEMON cannot
read — a private `/tmp` makes `docker build` answer *unable to prepare context*
about a directory that is plainly there, and the lesson says which flag fixes it
rather than reporting a broken release.

## 2026-09-05 — `fli notifications:install`, and the resolver three commands got wrong

`--with notifications` added the dependency and stopped, so every app that took
it copied `model Notification` out of `node_modules` by hand or found out at the
first `app.notify()` that `notification` is not a table in this schema. Now that
the package ships the model ([`FJS-910`](../../ISSUES_ARCHIVE.md#fjs-910)) there is
something to install, and `fli notifications:install` appends it, retargets
`@@db(main)` under `--db`, pushes, and prints the wiring — the mailer first,
because the plugin refuses the wrong order at startup. `fli new --with
notifications` runs it; an app that adds the package later runs it itself, which
is the case that had no answer at all.

**Appended rather than imported**, and the command says why: `OutboxMessage` is
machinery an app never writes, so `fli outbox:install` imports it by name;
`Notification` is the app's, and `userId`'s type follows the app's own user key.

**Found by writing it — the fourth copy of a function only one copy of which was
right** ([`FJS-918`](../../ISSUES_ARCHIVE.md#fjs-918)). `fli outbox:install` and `fli
backfill:install` resolved with `createRequire(<app>/package.json).resolve(spec)`,
which `fli auth:install`'s header already documents as unsound: bun answers it
out of its GLOBAL INSTALL CACHE. Measured here, in an app with no `node_modules`
at all — the old form answers `~/.bun/install/cache/@frontierjs/auth@1.0.3/db/user.lite`
and `shippedFile` answers null. `core/app-schema.js` owns the question now, all
three commands call it, and the reasoning lives on the function instead of in
one command's header where the other two could not read it.

## 2026-09-05 — Two ways a workspace tool answered for a tree it had not read

`fli register:check` graded a register it could not parse. The readers are keyed
to the `FJS-` prefix, so a project keeping its registers under another one parses
to nothing — and every rule below is asked of the records that parsed, which
makes a file none of them came from a file all of them pass: an `ACME-1` table
was answered `0 open · ✓ every register agrees with itself`. `readRegisters`
reports `unparsed` now, and `unparsed-record` is an error naming the line. The
refusal already there separated *no register at this root* from *an empty one*;
this separates an empty one from an unreadable one, which is the state an
adopting project starts in. Counted, never parsed — a record minted out of a line
the reader rejected is a guess at the thing the report exists to name
(`FJS-916`).

`fli ws:map` rendered the static port assignments into whatever workspace it was
run from, so a page titled after somebody else's monorepo carried `example` at
8010 and `basecamp` at 8020 as that project's own. The table is a source file of
one workspace: the section now renders only where that file is in the tree being
mapped, and is omitted the way every other absent source already is. `ws:atlas`
reads the same model through `model.ports?.rows` and matches by card key, so it
never showed the wrong numbers — which is why the leak survived on the page
nobody diffs (`FJS-917`).


## 2026-09-05 — The backup step names no cause of its own

`05-backup` printed *the container must carry db/schema.lite* under a failure
the container disproves: the schema is plainly there, and the command that read
it is the one that reported (`FJS-574`, `FJS-232` cited wrongly). `litestone
backup` prints which database it could not copy and why, immediately above, and
it is the only thing that knows — so the step points at that rather than
restating a diagnosis that outlives every change to the reasons. The by-hand
line is now the command that actually ran, not `--help`.


## 2026-09-05 — `fli ps` answers the question its name asks

It read `~/.fli/sessions.lock` and nothing else, so it printed *No active
sessions* while a port was genuinely held. Every tool in the reserved
8500–8509 block is that shape — `fli db:studio` binds 8502 as a literal and
claims no session — and so is any app somebody started by hand, which is most
of them. The one command for *what is using my ports* was blind to the case that
sends people looking in the wrong place.

It now reports two things: **what is holding a port**, from probing every port
the schema can name and decoding each hit back into *env · category · project*
with the process named; and **what the broker handed out**, as before.
`--sessions` is the old output alone, `--json` returns `{busy, sessions}`.

`knownPorts()` is the reserved block plus each assigned project across every
category and env at slot 0 — not the 3,000 numbers the formula can produce,
because a port nothing would ever hand out is not this schema's to report on.

**One `lsof` rather than 250 socket probes.** The first cut probed each port with
`isPortInUse` and took 4.4s, which is not a status command; `listeningPorts()`
takes one `lsof -nP -iTCP -sTCP:LISTEN`, runs in 1.16s, and hands back the pid in
the same call so there is no second pass. It returns `null` rather than an empty
map where lsof cannot be run, because *nothing is listening* and *nobody asked*
have to be told apart — the second falls back to the socket probe. Output is
sorted by port so two runs can be diffed by eye.

`pidsOnPort` and `describeProcess` moved out of `commands/utils/killnode.md` into
`core/ports.js`, which `fli kill` now imports. Two implementations of *what is
holding this port* is how the command that kills it and the command that lists
it come to disagree about the same number.

## 2026-09-05 — two rules that disagreed about one column

`@frontierjs/notifications` began shipping its model
([`FJS-910`](../../ISSUES_ARCHIVE.md#fjs-910)), which put `package-model-drift` in front
of a case it had never seen: an app that has taken `polymorphic-subject`'s
advice. That rule asks an app to constrain a bare `String` discriminator, and a
package cannot ship the constraint because it cannot know the app's set — so the
constrained column then read as drift, and `example` was the first app to be
told off for doing the recommended thing. A bare scalar the app tightens into an
enum or a declared set is not drift now. **Nullability is**: `String?` → `String`
refuses a write the package legitimately makes, which is exactly what the rule
is for, and so is a different scalar or a dropped attribute — three controls,
because a fix that accepted every difference would look like one that worked.

`package-model-drift`'s advice also stopped being auth-shaped. It said *import
the model instead*, which is right for `Credential` and wrong for the two models
a package means an app to COPY — advice that fails when taken, one tier down
from `proof-target`'s argument. It names both shapes now.

## 2026-09-05 — `deploy:local` builds from any directory, and the journal cycle can reach the resume

`FJS-544` and `FJS-595`, re-probed against a real daemon.

`docker build` was given an ABSOLUTE context and a RELATIVE `-f`, with `context.exec` carrying
no `cwd`, so it inherited the process's. Docker resolves `-f` against the caller's cwd, so the
build worked only when somebody happened to be standing in the app root and failed everywhere
else with `resolve : lstat deploy: no such file or directory`.

What made it read as something else: the existence check three screens above resolves the same
path absolute, so the check passed and the build failed — which looks exactly like *the
Dockerfile was written and docker cannot read it*. Measured, the absolute form builds from
anywhere to the identical digest, so the fix cannot change the image. The `--dry` line printed
a different command from the one that runs, and now prints the same one.

`04-build-api` keeps its relative `-f` deliberately: it runs on the target with an explicit
`cwd` and a relative context, where the two agree. Grading both call sites the same way is how
a correct one gets *fixed* into a broken one, so that is an assertion of its own now.

**And the pipeline could not reach its own sharpest test.** `deployJournalCycle` — the only
thing in the repo that runs `fli deploy` at all — refused at step 2 of 12, because
`01b-env-check` found `AUDIT_PATH` missing from `.env.production`. The key list was written by
hand beside a comment saying it was named there on purpose, and it drifted the moment the
scaffold gained that key: the tutor's copy of the same recipe was updated, this one was not.
The check stays on — a deploy that skips it is not this pipeline — but the cycle now READS the
declared keys out of the app's own `.env.example`, so the list it seeds and the list the check
compares cannot disagree. Only the values that must be real are still written by hand, and a
key already set keeps what it has.

With that cleared the cycle runs all twelve assertions with zero findings, including *the rerun
continued the same transition rather than opening a second* — which is `FJS-595`, fixed on
2026-08-29 by `readLiveTransition` and left open in the register for a week because nothing
could run far enough to see it.

## 2026-09-05 — the debt an inherited schema comes with, and the rule that could not see it

`tutor:adopt` ended with the app serving a legacy row and said nothing about
what happens next, which for an adopted app is always the same thing: rules the
app was not written against. `check-baseline.json` existed, `--adopt` and
`--update` existed, and no lesson mentioned either.

Step 6 is the one finding the adopted app has, and the lesson does NOT fix it.
`ActivityLog.subject_type` holds the name of whatever a row is about, and that
set grows with every model the app gains — which is the case the rule's own
message names as legitimate. So it is debt, kept deliberately, and the step is
about keeping it without letting it grow: `--adopt` records it, a second pair
fails the check naming the number it was allowed, `--update` is offered the same
rise and refuses it, and taking the model out again leaves the ceiling at one.
Five assertions, all measured before they were written — including that the
finding **still prints** under a baseline, because a baseline that silenced it
would be the wrong mechanism.

`--adopt` and `--update` are two verbs because they are two decisions, and the
lesson says so where the difference is visible rather than in a flag
description.

**And the panel had to learn the same word** ([`FJS-913`](../../ISSUES_ARCHIVE.md#fjs-913)).
`fli gui`'s check panel counted raw findings, so the app this lesson leaves —
green by its own `bun run check`, carrying one recorded finding — was reported as
broken by the surface beside it. `/api/check` reads the baseline per scope now
and answers `ok`, `baseline` and a `within` on every finding; `tutor:tools`
grades the verdict rather than the count. It surfaced because the course re-runs
lesson 2 after the last lesson, which is the only place the two orders meet.

**A third substring guard, in the step above.** `05-serve` appended the adopted
models unless the schema already said `model Order` — so a second run against a
DIFFERENT legacy database adopted nothing while every assertion above it passed.
It keys on the block's own marker now and REPLACES it, which is what made the
new step's finding appear on a re-run at all.

**Found by writing it: `polymorphic-subject` was blind to snake_case**
([`FJS-912`](../../ISSUES_ARCHIVE.md#fjs-912)). It matched a camelCase pair only, so the
legacy `activity_log(subject_type, subject_id)` the lesson adds — the shape a
Rails polymorphic association has, and what `litestone introspect --no-camel`
emits — was not a pair as far as the rule was concerned. The population the rule
exists for was the one it could not see, and the tutorial's own step is what
surfaced it: the check that should have reported the new table reported nothing.
Both spellings now, with the id looked up in the SAME one, and the mixed pair is
the control that keeps the fix from over-reaching.

## 2026-09-05 — a lesson for the thing an app has to SAY

`@frontierjs/notifications` had no tutorial coverage of any kind, and neither
did the mail path under it: `app.notify`, `defineNotification` and `IMail`
appear in no lesson. `tutor:notify` is eight steps and twenty assertions, and it
sits after `tutor:jobs` — the two are the same argument from different ends, and
the last thing this one asserts points back at the other.

The four beats are chosen for what a reader cannot find out by reading:

**One send, two transports.** A single `app.notify(...)` writes a row through
`asSystem()` and renders an email, and the row's `type` is `NoteAdded` — a
string that appears nowhere in the file that produced it, because the FILE names
the notification. Asserted as the row's type, not as a row count.

**Renaming the file renames the type, silently.** `type` is a column, and every
row already written keeps the name it was written under. The lesson renames the
file, sends again, and reads a database that now has two names for one thing —
then states `type:` and watches the loader report the divergence in its own
words. Nothing warns about the rename itself, which is the point: it cannot tell
a deliberate one from a typo.

**A transport with no formatter refuses before anything is delivered**, so a
two-transport notification cannot half-land. The assertion is an ABSENCE
measured against a count taken a moment earlier — no row, no mail — paired with
the identical request once the transport is taken out again, because a refusal
with no control beside it is also what a broken app does. And the response
carries `data: { committed: true }`: the note the hook fired on was written
before the hook ran and is still there, which is the argument for putting work
that can fail in a job.

**An app can be asked what it can send with nothing sent** — `app.notifications`,
a claim, read through a route the lesson writes.

The mailer is written in the lesson rather than installed, nine lines, appending
JSONL: `IMail` is one method, and mail a lesson cannot read back is not an
assertion. Swapping it for `createSmtpMailer` changes nothing that sends.

**Found by running it.** The step that states `type:` guarded on
`src.includes('type:')`, and the file's own header comment says *the file names
the type: NoteAdded* — so the guard read as already-done, the edit never
happened, and the failure surfaced two assertions later as the loader being
blamed. Same shape as the `editSchema` substring bug the course run found: a
guard that asks a whole file whether it contains a string is asking the wrong
question. It matches the statement now.

**And found by the course**, which is the half a lesson run alone cannot see:
the model the lesson writes tripped `fli check`'s `polymorphic-subject` —
`contextType` says what `contextId` points at, and with no foreign key nothing
refuses a value naming nothing. It surfaced two lessons later as `tutor:tools`
failing its *the check panel is clean* assertion, blaming a panel that was
telling the truth. The lesson constrains the one column that can be and says
why; `@frontierjs/notifications`' README now says the same, since the model it
hands out is the one every app copies ([`FJS-910`](../../ISSUES_ARCHIVE.md#fjs-910)).

The insert renumbers `site` through `adopt` — the heading in each lesson, the
`Lesson N done` line in each finish step, and the next-lesson pointer out of
`tutor:jobs` — which `fli check`'s `tutor-order` and `tutor-lesson-named` grade,
so a missed one is an error rather than a stale sentence.

## 2026-09-04 — the tutorial is taken as a course, and four things only that could find

Every lesson ran in a workspace of its own, and the documented way to take the
tutorial is `--workspace ~/somewhere`, kept, twelve lessons in order — which
nothing ran. The `tutor` phase now does both: each lesson alone under `--tmp`
(does it work from a clean start), then the whole course in ONE workspace, then a
replay and a `--restart` over the app the twelve left behind.

**Four failures on its first run, and every one of them was invisible to the
isolated runs.**

**A lesson destroyed the workspace's `.env`.** `tutor:deploy` wrote the
CONTAINER's environment over the app's own — a freshly minted `ENCRYPTION_KEY`,
`DATABASE_URL=/db/app.db` (a path inside a mounted volume, not on this machine)
and `NODE_ENV=production`. Fine while that lesson was the only thing in the
workspace; in a course it makes every later `fli db:*` open a database at the
filesystem root, changes what the app will do, and makes every `@encrypted`
value an earlier lesson wrote unreadable. The container's environment is written
beside the workspace now, which is where `05-origin` copies it from, and the key
is KEPT where there is one.

**`fli tutor:adopt` was broken for every user.** Its second step opened the
legacy database with `await import('bun:sqlite')`, and `fli` runs on NODE — its
own shebang. It worked in CI because CI invokes `bun fli.js`, and failed for
anybody who typed `fli`, with an ESM loader error naming a protocol rather than
the lesson. `probe.sqliteExec` is the write half of `probe.sqliteRow`, through
the same `bun -e` subprocess, so both directions are runner-independent.

**A deploy after `fli db:push` refuses, correctly, and nothing said so.** Lesson
1 builds its model with push, which writes tables and no migration file — push's
own output says exactly that — and a deploy replays FILES, so the container died
with *the migration history does not build the schema this app declares*. The
lesson catches the history up where the app was already there, with
`db:migrate --create-only` and `db:baseline`, and says why.

**Two lessons had assertions keyed on a gate a later lesson raises.**
`tutor:test` wrote a test that read back through `env.db` — a stranger — and
hard-coded *Note reads at STRANGER(0)*; both are true of a scaffolded app and
false three lessons on. The read goes through `env.system` now, for the same
reason the factory writes through it, and the level is READ OUT OF THE SCHEMA
rather than written down, which is what the lesson is arguing for in the first
place.

**`editSchema`'s *already done* test was a substring search over the whole
file.** It asked whether the TARGET text appeared anywhere before deciding there
was nothing to do — so the moment another model carried `@@gate("0.4.4.6")`,
which `tutor:adopt` gives the models it adopts, it returned `already` and edited
nothing. Two lessons steer on that call, and both then read their verdicts
backwards. *Already done* is a question about `from`, not about `to`: absent
`from` with `to` present is still `already`, which is the case the guard was
written for.

**`tutor:change` left the app's schema ahead of its database.** Every step there
edits `db/schema.lite` and nothing writes a table, so `priority` was declared and
not built — and the next thing to write a Note through the API, three lessons
later, was refused with `table note has no column named priority` by a page that
has nothing to do with that lesson. It applies the expand at the end now, which
is what the verdict it just printed says to do; and its baseline step normalizes
the column out first, so a second run in one workspace does not compare against
its own result.

**A scaffolded app's audit trail was written inside the container.**
`fli check`'s `log-db-unbound` fires on every app the scaffold writes as soon as
`make:deploy` gives it a deploy block: `database audit` had a LITERAL path, so
the deploy cannot point it at the mounted volume and the next swap takes the
trail with the rows in it. Nothing fails while it is wrong. The scaffold writes
`path env("AUDIT_PATH", "./db/audit/")` now, `.env`, `.env.example` and
`defineEnv` carry the variable, and the generated Dockerfile says to bind it
beside `DATABASE_URL`.

`tutor:adopt`'s last assertion also went stale in the good direction:
[`FJS-761`](../../ISSUES.md) landed, so the camelCase reading is clean under
`--strict` and `@map` is applied. The beat now asserts the two halves that have
to be true together — it passes `--strict`, AND it records the rename — because
a reading that camelCased a column and forgot to say so would also exit 0 and
would name a column that is not there.

## 2026-09-04 — the register reads newest first, and now says so

`DECISIONS.md` ran newest-first in seven sections of nine and stated it nowhere,
so the other two had drifted: the original ascending run sat at the foot with
every later ruling prepended above it, 24 adjacent pairs out of order across 182
rulings. The convention is in the file's preamble now, together with the fact
that makes it necessary — **ids are not in date order and never were**, since an
id is issued when a question is filed and the ruling can answer it weeks later,
so the date on the heading is the only ordering fact a reader has.

The sections were sorted by date, descending and stable. The reorder was proved
rather than eyeballed: the multiset of lines, the byte count and the set of
ruling ids are each identical before and after, so nothing but position moved.

`ruling-order` is the rule that keeps it, a **warning** rather than an error
because the register does not contradict itself here and a ruling deliberately
placed beside the one it amends is a legitimate reason to sit out of order that
no rule can see. Reported against the later ruling, which is the one that moves
up, and reset at every section boundary — sections are subject areas and have no
order between them, which is its second negative control.

Two smaller ones alongside. The format example at the top of the file used
`FJS-D40`, a real id, so a grep for that ruling found two hits; it is `FJS-D00`
now. And § Open closed on a hand-written count of the rows waiting in
`ISSUES.md`, which was three short — deleted rather than corrected, since
nothing regenerates it.

## 2026-09-04 — a ruling that is in force says nothing

`PHILOSOPHY.md` §VII required a status word on every ruling. Nothing enforced it
and no ruling carried one, so the rule sat at the tier that governs every other
document and graded nothing. Implementing it as written meant stamping
`accepted` on 180 of 182 headings — a restatement of the file's own name, and
one that would leave the ruling which has stopped being true reading exactly
like the 179 around it (`FJS-D196`, which amends §VII in the same commit).

**Absence means in force.** `RULING_STATUS` is `superseded-by`, `amended-by` and
`withdrawn`, written under the heading and nowhere further down, because a
register is read by scanning headings and a retirement announced in paragraph
nine is one the reader has already walked past. `proposed` is not in the set: an
undecided question lives in `ISSUES.md` § Needs a decision, so it has no referent
in `DECISIONS.md`.

**A retirement names what replaced it**, a ruling or the issue that moved it —
`FJS-690` narrowed what `FJS-D74` ruled and closed with no ruling id, and forcing
one into existence for every such fix is ceremony. The citation is graded like
any other, so a status naming an id no register holds is `unknown-ref`.

The `ruling-status` rule reports the two ways a written status can be useless: a
word outside the set, and a retirement naming nothing. `withdrawn` is exempt from
the second because nothing replacing it is the content. Absence is not graded at
all, which is the half that matters — a rule firing on it would print 180
findings and be removed within a week.

**Six rulings were believed retired in prose and four were.** Each was verified
against the amending ruling and the code before anything was marked, and two of
the six did not survive: `FJS-D64` refuses an `afterCommit` PHASE and never the
method, so `ctx.afterCommit` existing is not a contradiction; and the ruling
thought to have amended `FJS-D132` rules an adjacent question, while the one that
really amends it is `FJS-D135`, which `VISION.md` §17 already records. `FJS-D62`
supersedes a ruling that was never committed, so it now says so rather than
citing something no reader can find.

## 2026-09-04 — a check that could only pass

`fli register:check` answered `0 open · 0 rulings · ✓ every register agrees
with itself` from any directory holding no register — which is every package in
this workspace, and the root `CLAUDE.md` tells everyone to cd into a package
before running anything. From the repo root the same command reported 70 open
and 180 rulings (`FJS-768`).

**The tolerance was deliberate and the hole was underneath it.** `readRegisters`
treats a missing register as absent rather than fatal, because a consuming app
has no `IDEAS/` and inventing one is worse than reporting none. What it could
not say is the difference between a register that is empty and a register that
is not at this root: both are three empty lists. It now reports `sources` — the
register files the root actually holds, asked of the tree rather than inferred
from what parsed — and `runRegisterCheck` refuses a root holding none of them,
naming the directory and what it looked for.

**The refusal is in the engine rather than in each caller**, because a caller
that has to remember to ask is the same hole one layer up. The two callers are
the command and `scripts/ci.mjs`; CI passes the repo root, so CI was the only
invocation that was ever honest.

Asserted as a pair: a project keeping only `ISSUES.md` is graded on it and
passes, a directory with none is refused. A check that rejected a thin register
would be as wrong as one that passed an empty directory, and from the refused
side the two look identical. The report now names what it read, so a small count
reads as a small register.

**`cross-register-id` is the second hole, and it is the one the first fix could
not see.** `duplicate-id` keys on `kind:id`, so a `FJS-D##` appearing once as
the question in `ISSUES.md` and once as the ruling in `DECISIONS.md` is exempt —
an exemption that assumes the pair are the same subject. `FJS-D183` was the
encryption envelope in one file and the transaction scope in the other, and every
rule passed it (`FJS-D195`). The new rule reports an open decision question whose
id already names a ruling, without trying to tell the two causes apart: either
the ruling answers this row and nothing closed it, or it answers something else
and the id was issued twice. Both are wrong, the fixes differ, and only a person
can say which it is — so the message names both. Its negative control is an open
question with no ruling of its own, which is the ordinary state of every
unanswered one.

## 2026-09-04 — `fli tutor:ui`, and a page the cli can open

Lesson 3, and the first thing in the tutorial that renders anything. Eleven
lessons taught Data, API and Deployment by asking the running world, and the UI
realm — three packages — had one step in lesson 1: a person finished the course
having never seen a form.

**The lesson's spine is a before and an after.** It opens `/notes/create/` in
Chrome and asserts the generated form — one control per writable column, the
control each TYPE implies (asserted as a map, because three controls of the
wrong kind is the same number as three of the right kind), and nothing for
`id`, `createdAt` or `updatedAt`, which reach the client read-only. Then it adds
**one attribute to one column** of `db/schema.lite`, touches no `.mesa` file,
and reloads: `minlength="3"` and `maxlength="80"` are on a real `<input>`. The
same empty submit that was a legal write before the attribute is now refused in
the browser — and the assertion is not that a message appeared but that **the
row count over HTTP did not move**, because an error message is renderable by a
page that also wrote the row. Last step types into the three boxes and reads
the row out of the DATABASE, then checks the list page draws it.

**`core/browser.js` is a page driver, and it is small on purpose.** Mesa's
`test/browser/drive.mjs` is a spec RUNNER and is not published (`files:` is
`src` and `mesa-vite`), so an app that installed the framework has no harness at
any path — and what a probe needs is one question and one answer. Launch,
navigate, `eval`, close, plus the page's own exceptions collected, because a
component that throws while rendering still leaves a partial tree and every
assertion about what IS on the page walks past it. `probe.pageEval` and
`probe.pageClean` are the two probes over it, and both take an already-open page:
a lesson that launched Chrome per assertion would be five browsers.

Three traps it encodes. `--remote-debugging-port=0` with the URL read off
stderr, since a fixed 9222 is the developer's own Chrome and attaching would
drive their real profile. A temp profile swept on exit and on a signal. And a
single silent retry when an evaluate lands in a navigation — a form flow
navigates by design, and that failure is about the CONTEXT rather than the page,
which reads to a caller as the assertion being wrong.

**`$FJS_CHROME` is authoritative rather than preferred**: somebody who names a
binary names it for a reason, so a variable pointing at nothing answers null and
the lesson stops naming the variable, instead of silently running a different
browser. No Chrome at all is a `stop` and not a failure — a fact about the
machine — and CI skips the lesson by name with `FJS_CI_REQUIRE_CHROME=1` to make
that fatal.

## 2026-09-04 — the tutorial's order is graded against itself

`fli tutor` is a course, and a course is an ORDER. That order was written in
three places that could disagree: `index.md`'s LESSONS array, each lesson's own
`## Lesson N —` heading, and each lesson's finish step naming the next one to
run. Nothing held them together, and inserting a lesson at position 2 cost
twenty hand edits across eleven files.

`core/tutorial.js` reads the course — the reader/renderer split `proofs.js` and
`preflight.js` already make — and two rules grade it, split the way the proof
table is and for the same reason. **`tutor-order`** is an error: naming a lesson
that has no command file, a heading whose number is not the index position, a
pointer at the wrong lesson, a non-final lesson that names none, or a final one
that points onward. There is no reading of any of those that is correct — a
wrong heading misleads and a wrong pointer is advice that fails when it is
taken. **`tutor-lesson-named`** is a warning: a lesson the index does not list,
a `steps:` directory that is not there, a `_steps-*` nobody claims. A lesson
reached another way can be deliberate.

**It found a real dead end on its first run.** `tutor:fleet` named no next
lesson, so a person following the pointers stopped at 10 of 11 — and the
*where to go from here* block was on lesson 10 rather than on the last one,
along with a reference to "the journal in lesson 3" that had meant `tutor:deploy`
before the renumber. All three fixed.

## 2026-09-04 — `skill-pointer`, and skills in the document corpus

The root `CLAUDE.md` moved three of its sections behind `.claude/skills/` and
kept a name for each. A skill loads by that name, so a renamed directory leaves
the pointer reading as it did with nothing behind it — `proof-target`'s failure
one document up — and nothing graded it. `skill-pointer` resolves every name
CLAUDE.md gives, in prose and in the realm table's Skill column, to a `SKILL.md`
whose frontmatter `name:` agrees, because the Skill tool registers under the
frontmatter and not the directory.

`docCorpus` now walks `.claude/skills`, so the ids, paths and Invariant numbers a
skill cites are graded by the same rules as any document, and `SKILL.md` is
map-tier for `doc-map-narration`. Before this a skill could cite a retired id or
a renumbered Invariant with the `registers` phase green.

## 2026-09-04 — `fli tutor:tools`, and a scaffold that stops warning about itself

Lesson 2, on the four surfaces whose whole job is to report on an app: `fli gui`
(8500), `fli db:studio` (8502), junction's `devtools()` console (8503) and `fli
project:view` (8501). Twenty assertions, ~5s warm, and it is the only thing in
the repo that starts any of them and then asks them something.

**The GUI is the front door and the lesson says so** — it is the one surface that
knows about the other three, lists everything startable in the project, probes
which of them is up, and runs `fli check` without anybody remembering the
command. Its liveness assertion is graded by AGREEMENT rather than by `up`: the
port comes out of the ports table, so the GUI knows where the API is supposed to
be before the app has ever started, and running the API elsewhere makes `down`
the correct answer. The lesson probes that same port itself and requires the two
verdicts to match, which is false for a page reporting whatever it was told last
— in either direction, and at any port, which is what lets CI run it off the
assigned slot.

The other three each carry the failure they exist for. The studio is asserted on
the FILE and the ROW together, because either alone is satisfiable by a studio
pointed at the wrong database — an empty one has a path and a stale one has
rows. The console is asserted on a PAIR, one call allowed and one refused,
because a feed that reported everything as fine and one that reported everything
as broken look identical from a single call. The viewer is asserted on the chain
and on the environment panel, after writing the `surface.snapshot.md` it reads —
services are read off that snapshot and never scanned for, because a hook chain
resolves at construction.

**Every tool is shown reporting a FAULT as well as a clean state**, which is the
same rule the refusal pair follows: a dashboard saying *nothing wrong* is
indistinguishable from one that cannot say anything. The GUI's check panel is
handed a `.mesa` in `src/resources/` holding only markup — neither PascalCase
singular nor carrying a `<script module>`, so it breaks two named rules at once
— and the file is removed and the panel asked again. The studio's drift panel is
asked before an edit, after one, and after the revert; the edit is a COMMENT, so
nothing about the database moves and what is being shown is the real thing
behind *I added a column and the app cannot see it* — the running process is on
the schema it read at boot.

`--no-open` is threaded through `fli db:studio` (the flag was accepted and
answered *flag not defined — ignoring*), and `startServer` in the tutor's module
learned an `argv` form, since a tool is run against an app rather than from
inside it and there is no package script to name.

**Found by running it**: every app `fli new` writes carried a `fli check` warning
about itself. The generated `api/src/core/db.ts` passed its schema PATH under
`createClient({ schema })`, which litestone reads as a path and `schema-in-memory`
reports on the key — all a source reader can see. The two keys are not synonyms:
a schema STRING has no directory, so a relative `import` in it resolves against
nothing and is dropped. Now `path:`, which is the spelling litestone's own error
message asks for, and a fresh scaffold reports no findings.

## 2026-09-04 — a build context docker cannot read, refused where it is decidable

A deploy failed with `open Dockerfile: no such file or directory` about a file
the shell reads in the same directory in the same script. The filed cause was a
dot-prefixed directory anywhere in `path`. It is not: one tree copied to eight
paths and built on docker 29.6.1 shows `~/vis/.deep/app` building and
`/tmp/vis/app` failing, and what separates them is that docker here is the
SNAP, whose `home` interface grants everything under the user's home except a
hidden directory directly under it, and nothing outside home at all.

The two readings disagree in both directions, which is why the string rule was
the wrong remedy — it passes `/tmp/build`, which fails, and refuses
`/srv/.apps/myapp`, which builds on the docker.com packages. And the machine
that decides is the builder, which under a declared `deploy.builder` is not this
laptop.

So `04-build-api` asks it, before the vendor and the upload: `docker build
--check` resolves and parses the dockerfile and builds nothing. Graded on the
error text rather than the exit status, because `--check` also exits non-zero
for a lint warning and an older docker refuses the flag in different words. One
cause has two sentences depending on how far the read got, so what is graded is
*docker says no such file* about a path the shell has just read.

`deploy:doctor` was named in the finding and is not the owner: it never contacts
a machine.

## 2026-09-04 — `fli tutor:adopt`, the door for a database you already have

Lesson 10. Six steps, ~3s, and the only lesson that does not begin with
`fli new` writing your models: it begins with a SQLite database made by raw SQL,
with plural `snake_case` tables and rows already in it.

It reads that database into a schema, and the half worth the lesson is the
second output — every construct the reading could not carry, graded `changed`,
`lost` or `noted`, with `--strict` failing on `changed` alone. Then it checks
the reading against itself: build a database from the schema, read THAT, and
require the same text. That property catches what a substring assertion cannot
— a default whose quotes double on every pass, a predicate that nests deeper
each time — and it is run against the learner's own database rather than
described.

The payoff is `GET /api/orders` answering the row written in step 2 by raw SQL,
through a schema read out of the database that held it, with nothing migrated:
adopting is not a schema change.

Its last assertion is a **refusal**. `migrate baseline` is how you eventually
say *this database already holds what these migrations build*, and it compares
before it records — here it declines, naming the two lines the reading did not
get to the letter. One is cosmetic (`INTEGER PRIMARY KEY` is nullable as
declared) and one is not (`@default(now())` writes ISO-8601 where the column has
been writing SQLite's own format), which is what the first hour after an import
is for.

Writing it found four defects in `litestone introspect` and two in the scaffold.
`fli new --no-auth` printed `fli keygen aes --name ENCRYPTION_KEY --env` as the
next step — and keygen defaults to **base64** while litestone parses that
variable as **hex**, so following the instruction gave a key that decodes to
zero bytes and an app that still would not start. Advice that fails when taken
is worse than none; the hint says `--format hex` now.

## 2026-09-04 — an option `context.exec` does not have

`FJS-537`. 1755 + 39 pass. Typecheck clean.

`config.exec` spread its options straight into `execSync`, where an
unrecognized key changes nothing — the child writes to the terminal under the
default `stdio: 'inherit'` and the call answers `null`. It is refused by name
now, the way `createClient` refuses an unknown option: a typo in an options bag
is a statement the author just made, and forwarding it makes the mistake
indistinguishable from the default. The message names every unknown key, and
for `capture` it names the pipe it was reaching for.

**Writing the corpus guard found a second live instance, which is why one is
worth writing.** `allowFailure: true` is passed by `deploy/doctor.md` and
`deploy/_module.md` and was never implemented either, so `execSync` threw on the
non-zero exit and `config.exec` rethrew: `fli deploy:doctor` died with a stack
trace exactly when its migration check should have said *fail*. Measured both
ways against a scratch app whose `db/migrations/` does not build its schema.
The same call site read `probe?.exitCode ?? probe?.code`, neither of which
`execSync` puts anywhere, so on the path that did not throw the code read `0`
and the check could only ever pass.

`allowFailure` is implemented: the thrown error IS the answer, `status` the exit
code and `stdout`/`stderr` what the child wrote, so a caller reads the same two
keys on both paths. A signal still stops everything — Ctrl+C is not a probe
result.

The corpus half is the one with teeth. Commands are markdown, so a compile is
not a run; every `exec({…})` in every shipped command is read and its keys
graded. It needed rewriting mid-flight: a line scanner passed when
`capture: true` was put back on a ONE-LINE call, which is the shape that started
this, so it is a character scan over key position that skips strings and
template literals.

## 2026-09-03 — `fli tutor:test`, and something that grades the checks

Lesson 8. Six steps, ~20s, no server and no browser — every assertion is a real
database built from the app's own schema.

Its subject is the thing that is unusual here: most of what you would write
tests for has already been **declared**, and a declaration can be executed. Four
calls run every gate at every declared level for read, create, update and
delete; every `@guarded` / `@encrypted` / `@secret` column, read back; every
validator, either side of its boundary; every `@@allow` / `@@deny`, against rows
on both sides of its predicate. No fixtures, no assertions to author.

Then the step that grades those: `litestone mutate` breaks the schema on purpose
and runs the checks derived from the ORIGINAL against a database built from the
mutant. A survivor is a hole and it names itself — on a scaffolded app, 40
mutants, 70% killed, and the twelve survivors printed with their kinds.

Two things it teaches that a reader would otherwise meet as a bug.

**A factory writes through a real client, so it is graded.** `Note` creates at
USER(4) and a factory with no principal is a stranger, so `.asSystem()` is not a
shortcut — a fixture belongs below the boundary, or a gate that refuses the
caller refuses the arrangement too.

**`actingAs` is handed a session, not a row.** The scaffolded resolver grades on
`isAdmin` and the table has `role`; `sessionFields` is what turns one into the
other, and it runs at sign-in rather than when a test hands a row over. So
`actingAs(adminRow)` grades 4, and a test asserting a refusal there passes for
entirely the wrong reason. The lesson writes both spellings and asserts they
differ.

`tutor:fleet` becomes lesson 9. `probe.command` is new — an argv, its exit code
AND what it printed, because `bun test` with no test files exits 0 and
`litestone mutate` exits 0 whatever the score.

Found while writing it: `tutor:jobs` anchored its edit on the literal
`app.configure(channels())`, which the scaffold no longer writes.

## 2026-09-03 — a scaffolded app gets the auth that is installed

`fli new` links and installs BEFORE it composes its sub-commands, and
`auth:install` reads `user.lite` out of the app's own `node_modules` rather than
asking the resolver for it.

Every scaffolded app was running an auth schema nobody had installed. The
appended `model User` came from `@frontierjs/auth@1.0.3` in
`~/.bun/install/cache/` — `accountId Int?` where the tree says `String?`, and no
`@@auth`, which leaves every claim in every policy ungraded: a misspelling then
compiles to NULL, read as *nobody* by the SQL half and *everybody* by the JS
half (`FJS-759`, `FJS-666`).

Three defects, each hiding the next:

**The order.** `auth:install` ran before the link and the install, so the app had
no `node_modules` when the model was read — `FJS-741` one step earlier in the
same command.

**Bun resolves out of its cache.** `fli` runs on bun, and bun's
`require.resolve` falls back to the global install cache when an app has no
`node_modules`. The *is it installed* test therefore passed against a package
that was not, answering whatever version the machine happened to have downloaded
once. Nothing said a word.

**Bun memoizes a resolution for the life of the process**, so re-resolving after
`auth:install`'s own `bun install` returned the same cached answer — which is
why checking the directory and resolving anyway is not a fix.

`resolveFromApp` now reads the `exports` map from
`node_modules/@frontierjs/auth/package.json` and joins the target itself. A
`link:`ed package is a symlink there and is read through it, so the question is
*installed here* rather than *resolvable from here*.

`fli tutor:access` loses the step that was adding `@@auth` by hand.

## 2026-09-03 — a scaffolded app joins its own channels

`fli new` writes **`api/src/core/channels.ts`** and wires it into `api/src/app.ts`.

Before this the scaffold declared `channel:` on every generated service,
configured the `channels()` plugin, and joined no connection to anything — so
every write announced into an empty set. Both halves of that are silent: a
publish to a channel nobody joined succeeds and reaches nobody, with no error
and no log, and the symptom is a screen that never updates. The generated
README pointed at `api/src/core/channels.ts` for the fix, which the scaffold did
not write (`FJS-752`).

**It joins every channel a service declares**, read off `app.services` at
connection time rather than from a list kept by hand — `fli scaffold` writes
`channel:` into each service it generates, and a second copy of those names goes
stale on the first new model. Only the string form: a function `channel:`
computes its target per publish, so there is no name to join ahead of time.

Joining everything declared is the right default only because joining is no
longer a GRANT. A broadcast is not a `SELECT`, so an `@@allow` cannot reach one;
junction grades and shapes every frame per recipient at the Data boundary
(`FJS-631`). The generated comment says that. The one it replaced told the
author to work around behavior junction has not had for a release — and the same
stale sentence was on `publishToChannels` in junction's own source, corrected
there too.

`fli tutor:live` taught the gap on purpose and now teaches the mechanism: step 4
asserts the frame arriving out of the box and names the two files that make it,
and step 5 is its negative control — the callback taken back out, the same
publish from the same caller reaching nobody, and the file restored on every
path out including a refused probe.

## 2026-09-03 — the tutorial waits for you

**The default is a walk-through.** Every step now prints its prose, says what it
is about to do, and waits:

```
  Start the two servers and prove they answer — ready? (Y/n) ›
```

Before this a lesson ran eleven steps to completion while you were still reading
step two, which is a transcript rather than a lesson. `--yes` runs a whole
lesson without stopping — what CI passes, and what a second run through material
you have already read wants. `--step N` does not ask either: naming one step is
already the answer to *which one*.

The question is the step's own `description:`, so it is about that step rather
than a generic *continue?*, and there is no second place for it to go stale.

Three things it took to be correct rather than merely present.

**One reader per lesson, not one per question.** A piped stdin is DRAINED by the
first reader, so a second one waits on a stream that has already ended — a
`printf 'y\ny\n' | fli tutor:change` hung after step 1. It is created in
`openTutor` and closed by the finish step, which runs on the success path and on
a refusal; the decline path closes it itself, because a `stop` skips that step.

**A declined step is not recorded.** Nothing throws when you answer `n`, so the
runner hands the recorder `succeeded` — after which the resume skips the one
step you stopped at. The row is dropped instead: absent is what a step that has
not run looks like, and `resumeDecision` already answers that correctly.

**`context.log`, not `log`.** The bare binding exists inside a step body and not
in the namespace module, so the decline path threw `log.info is not a function`
over the sentence explaining how to resume.

Answering `n` is a `stop` and not an `abort` (`FJS-589`): it exits 0, stops the
servers this run started, and prints where the app is and the command that picks
up from there.

## 2026-09-03 — Four more lessons, and the surface nothing had ever run

`FJS-752`, `FJS-757`, `FJS-758`. The tutorial is eight lessons now: **live**,
**jobs**, **site** and **change** join app, access, deploy and fleet, and the
order is the arc rather than the order they were written — build, secure, then
real-time, background work, the public half, the deploy, the schema change after
it, and the fleet.

**`tutor:live` (8 steps)** — a write reaching a second client, and who it does
not reach. It meets the silence first: the service announces, the publish
succeeds, and nothing arrives, because a channel is a set of connections and
nothing has joined it. One file later the same publish lands. Then two sockets
against one publish — signed in and anonymous — before and after the read gate
goes up, which is the pair the lesson exists for. A refusal on its own proves
nothing: a grader that delivered to nobody would satisfy it.

**`tutor:jobs` (6 steps)** — a queue that is a SQLite file, a job named by its
own filename, and a dispatch from an `after` hook. The assertion is the
**order**: the response is read before the work is done, and the row changes
afterwards. A test that checked only the final state would pass with the work
done inside the request.

**`tutor:site` (8 steps)** — one HTML file per page with the data already in it,
and a build that **refuses** to emit a page whose `load()` read something gated.
You watch the refusal and then the `publishes:` line that gets past it. The last
step changes a row and reads the file again: still the old value, which is what
prerendered means.

**`tutor:change` (6 steps)** — month two. An optional column is an **expand**; a
required one is a **contract** that comes back with the three-deploy split and
the column that has to be backfilled; and a raised gate touches no column and is
a contract too, marked `narrows`. No server, no Docker.

`probe.httpText` (a body as text) and `probe.eventually` (any probe, until it
holds) are new, and `openSocket`/`bothSockets`/`fliJson`/`addNoteField` are the
lessons' shared halves.

### What writing them found

**`FJS-752` — a scaffolded app's real-time is wired everywhere and delivered
nowhere.** Every generated service declares `channel:`, `fli new` configures
`channels()`, and nothing ever calls `app.channel(name).join(conn)` — so every
write announces into an empty set, with no error and no log. The generated
README points at `api/src/core/channels.ts`, which the scaffold does not write.
Beside it, the generated service's own comment was **stale in the dangerous
direction**: it said `@@allow` is not re-checked per subscriber and told the
author to work around that, which was `FJS-631` and is closed. The comment now
says what is true — nothing is delivered until a connection joins, and joining
is a subscription rather than a permission. `tutor:live` teaches the gap
deliberately; that is not a substitute for closing it.

**`FJS-758` — every file `fli make:site` generated was broken, and nothing had
ever executed one.** Four defects, found in order: `fli site:build` ran `bunx
vite` (node) while the scripts the same generator writes say `bun --bun` with the
reason in a comment beside them; both commands `cd` into the surface, so bun
auto-loads `.env` from the wrong directory and a client with a required variable
refuses to load at all; `site/src/main.js` imported `mount` from the compiler,
a virtual id that does not exist and a component path that does not exist, and
passed `mount()` an id where it takes a node; and the scaffolded client passed
`schema: './db/schema.lite'`, resolved against the process — so the site build
opened a **new, empty database** under `site/db/` and prerendered every page with
no rows in it, exit 0, which is `FJS-449` exactly. All four fixed. The class has
no fix: `scaffold-build.mjs` builds `web/` and nothing runs a generated `site/`.

**`FJS-757` — `release:check --from <path>` drops the baseline's imports.** A
baseline copied anywhere but beside the schema loses every imported model and the
comparison reports the imported package as newly added — three fabricated
contract findings on a scaffolded app. `FJS-670` one layer up, in the command
whose whole job is to classify a difference.

Also fixed on the way: the `after`-hook envelope. `ctx.result` inside the
pipeline is `{ kind, object, data }`, so `ctx.result.id` is `undefined` with no
error — the job was queued with an empty payload and the patch was refused as a
bulk write. `resultData(ctx.result)` is the unwrapper junction exports for it,
and the lesson says so where somebody meets it.

## 2026-09-03 — Mesa, in the lesson and in the app it scaffolds

**`tutor:app` gains a ninth step and the scaffold gains a front page.** The
tutorial taught the seed, the API and the database, and said nothing about the
language every screen it generated is written in. Two halves, on purpose:

**The lesson** — `09-mesa` — states the five things that carry almost all of
Mesa (state is a variable, a `$:` line re-runs when what it read changes, blocks
are markup, styles are scoped to the file, everything the runtime offers is on
`$`), then writes a component with a prop, a derived value and an `{#if}`,
imports it into the home page, and **asks the dev server for the compiled
module**. That is the assertion, and the only one available without a browser: a
file that compiles is a fact about the compiler, not about the file.

`?import` on that URL is load-bearing and cost a run to find. Vite decides
whether to transform by EXTENSION, and `.mesa` is not one it knows — so the
bare path is served as a static file and answers **200 with the source**, which
reads exactly like a component that compiled to itself. The query is what Vite
appends when a module imports a file it cannot recognize. A file that does not
compile answers 500 carrying the compiler's own sentence, which is why
`probe.httpText` reports a status separately from a missing needle.

**The app** — `fli new`'s `web/src/routes/index.mesa` is now a running tour of
the same five points rather than three lines and a health check. A counter for
state, an input for `bind:` and `$:`, an `{#each}` over the three realms, and a
link to the repository with the two documentation directories named. Every
point does the thing it describes, which is the only form of this that cannot
go stale silently: the page has to compile to render at all.

`probe.httpText` is new — the body as text, for the things that are not JSON.

**A third authoring trap for literate commands**, found by writing the step: a
`.mesa` sample cannot be shown whole in prose. `matchScriptBlock` takes the
first line-leading `<script>` in the file and everything down to the **last**
closing tag, so a sample carrying one is hoisted to module scope and executed as
JavaScript — the step failed with `plenty is not defined`, naming a variable
that only exists inside the example. The two halves are shown apart, and the
step says why.

## 2026-09-03 — `fli tutor:fleet`, and a column nothing writes

`FJS-743`. Lesson 4 of four, and the tutorial is complete.

**Lesson 4 is the other release story.** Lesson 3 is you holding the key,
deploying one app to one machine with `fli deploy`. This one is a control
plane: basecamp holds the fleet as rows, an Outpost is the process a machine
runs so the control plane has hands on it, and nobody types a deploy — somebody
clicks one, and a job sends a signed command to a machine that agreed to take
orders. Seven steps, twenty-nine assertions, **3.1s in CI** — no Docker and no
network, because the heartbeat reads `/proc` and the Outpost's disk report is
allowed to fail.

It starts a real control plane on a database of its own, sets it up, creates the
machine as a row, starts a **real Outpost** against it, and then sends a command
that really runs here. The last one is the lesson: four rows have to exist
before there is anywhere to send it (`Project → Environment → App → AppServer`,
then `Job`), and the assertion is a **nonce minted in this process a second
earlier**, read back out of the `job_run` row the control plane wrote. A canned
answer, a stubbed executor or a command that never left the control plane all
fail it. The negative control was run by hand: with the Outpost stopped, the
same trigger fails `ConnectionRefused`.

**What the lesson teaches that no row can say** is what *reachable* means. The
heartbeat moves `status` to `online` and fills `lastHeartbeatAt`, and neither of
those is what anything outbound consults: the address becomes a Conduit target
called `outpost:<id>`, and `resolveExecutor` asks the registry. **Online and
unreachable is a real state**, and the two are different failures.

Which is how `FJS-743` was found. `Server.outpostUrl` is declared, migrated, and
named by the executor's own refusal — and written by nothing. The heartbeat
carries the address and registers the target with it, then omits the column from
the update three lines above. Measured: the row read `online` with a version, a
health block and a timestamp, and `outpostUrl: null`, while the registry held
the real address. Nothing reads the column either, so it is dead on both ends —
and an operator reading a null there finds it agreeing with a sentence that is
false.

**Basecamp is `private: true`, so the lesson stops rather than fails** for
anybody who installed from npm: step 1 looks for the two packages beside the CLI
and exits 0 with a sentence and a clone command. Proven by running the CLI out
of a copy with no siblings.

Two smaller things it forced. `startServer` takes a `logs` directory, because a
lesson that runs basecamp out of the checkout must not write its log beside
somebody's source. And both of basecamp's databases are redirected, not one:
the audit trail is a second `database` block with a relative path, so it follows
the process CWD, and setting only `DATABASE_URL` writes the lesson's rows into
the developer's own trail — which is `FJS-633`'s stated fix, applied to a third
drive.

`bun run ci`'s `tutor` phase runs all four lessons now; fleet takes 7120 and
7180, basecamp's and outpost's own test-tier slots.

**And the phase's first full run found an environment fact rather than a
defect.** `tutor:deploy` under `--tmp` failed at `docker build` with
*`lstat deploy: no such file or directory`* about a directory that is plainly
there — this shell's `/tmp` is private to it, which is exactly the class
`scaffold-build.mjs` already names for the `deploy` phase, down to the regex.
With `FJS_CI_WORKDIR=$HOME/fjs-ci-work` the lesson is green at 71 assertions.
`daemonBlindHint` is exported now and the tutor phase's failure says the same
sentence, because two paragraphs about a private `/tmp` is how the second one
ends up not mentioning the variable that fixes it.

## 2026-09-03 — `fli tutor:deploy`, and the deploy pipeline did nothing under node

`FJS-738`, `FJS-741`. Lesson 3 of four.

**Lesson 3 deploys to this machine and takes it back.** A deploy target may be
`localhost`, so the ten steps are the real pipeline — a real journal on disk, a
real image, a real swap, a real health poll, a real revert. Point the app at a
machine, write the release baseline (without it every change grades as a
contract and the revert would be refused, correctly), clone the app into a
`server/` directory as its own origin, deploy, change a line and deploy again,
then **revert, and revert the revert**. Eighteen assertions; the ones that
matter are against the image id the container is on, because a pipeline that
reported success while leaving the old container up passes everything else.

**And it found the largest defect of the day.** `execSync(cmd, { input, stdio:
'inherit' })` **ignores `input` on node** and honors it on bun. Every command a
deploy sends travels on stdin to `sh -s`, and `core/machine.js` defaulted to
`stdio: 'inherit'` — so under node the `mkdir` that makes room for the journal
runner, the container swap, the lock release and the nginx write all reported
success and **did nothing** (`FJS-738`). Measured: `fli deploy:unlock --force`
printed `Dropped …` with the lock still on disk. `bin/fli.js` is
`#!/usr/bin/env node`, so that is what a global install gets; CI never saw it
because the deploy phase runs `bun <fli>` explicitly. Fixed as
`stdio: ['pipe', 'inherit', 'inherit']`. The suite runs under bun, where the bug
does not reproduce, so the shape is asserted first — stdin piped, stdout and
stderr not — and then the real `createMachine` is run under `node` and asked
whether the script actually ran. All three fail against the old default; the
file's existing executed tests missed it because every one of them passed
`stdio: 'pipe'` explicitly.

**Behind it, an app that developed against one auth and deployed another**
(`FJS-741`). `fli auth:install` ran a bare `bun add @frontierjs/auth`, so a
`--source local` scaffold had six `link:` siblings and auth from the registry —
while `deploy:vendor` packed the workspace copy into the image. The container's
`db:migrate` refused with a diff showing the tree's `Verification.id` as a uuid
and the installed one as an `Int`. The spec is read off the app's own manifest
now.

The `tutor` phase gained lesson 3 on port 7103, skipped by name without a
daemon, with the deploy phase's `FJS_CI_REQUIRE_DOCKER=1` escalation. The deploy
transition cycle was re-run after the `machine.js` change and is still 12 of 12.

## 2026-09-03 — `fli tutor:access`, and the tutorial is a CI phase

`FJS-736`, `FJS-737`. Lesson 2 of four, and `bun run ci`'s thirteenth phase.

**Lesson 2 changes one line of `db/schema.lite` at a time and shows the answer
to the same HTTP request changing.** Nine steps: two callers (an ordinary
account through the API, an administrator through the CLI — `role` is
`@allow('write', auth().isAdmin)`, so the first admin cannot come from the API,
and that asymmetry is the lesson arriving early); the gate as it already is; the
read level raised from `0` to `4`, after which the request that answered 200 a
moment ago answers 401; a row policy, where two accounts get 200 from one list
endpoint and one of them cannot see the row; a field policy, where both callers
send `done: true` and only one of the two rows carries it; and `fli test:access`,
read back to check it agrees with the schema. **Every refusal is asked twice** —
once by a caller who should be refused and once by an otherwise identical caller
who should not — because a rule that refused everybody looks the same from the
refused side. ~18s from an empty directory.

Every answer in it was measured against a real scaffold before a word was
written. Two came back different from what the plan assumed: raising a read gate
answers **401**, not 403; and a field `@allow('write')` on a required column with
no default is a **500** from SQLite rather than a refusal at the boundary, which
is why the lesson adds `@default(false)` and says why.

**The `tutor` phase** runs both lessons `--tmp --yes` on test-tier ports
(7100/7000). It is the phase for the document that had no compiler behind it:
`docs/QUICKSTART.md` §7 exited 0 on every command it named and had never put an
app on a server. What it catches is a command renamed out from under a step, a
scaffold whose default gate moved, an answer the framework changed — none of
which any suite here can see. No Docker, no network. A port already held is a
named SKIP rather than a finding, because refusing a busy port is the lessons'
own rule; `knownTutorFailures` ratchets like the rest.

**`fli auth:*` had rotted through five layers** (`FJS-736`) and lesson 2 is what
found it, because it needs `auth:create-user` to make an administrator. Each
layer hid the next: a free `loadEnv`, then a `createClient` signature litestone
stopped having, then `sys.users` where the accessor is `db.user`, then
`context.exec({ capture: true })` — not an option, so the default `inherit`
stood and **`auth:create-user` created the account and reported failure** — then
`take:` where litestone names it `limit:`. Two files in this tree already carry
a comment saying `capture: true` is not real. All five parse; nothing had run
them against an app since litestone's API moved, and `tutor:access` is that
caller now.

**And `@@auth` was missing from the User model auth ships** (`FJS-737`), so
every scaffolded app graded its policy claims against nothing and printed
litestone's warning about it on every boot. A misspelled claim there is a
lockout on read and an open door on create. The lesson teaches the line rather
than assuming it.

## 2026-09-03 — `fli tutor:app` runs end to end

`FJS-735`. Lesson 1 of four, and the first one that can be run.

Six steps landed on top of the three that existed: start both servers and prove
they answer, register an account and keep the token, scaffold a model, push it
into the database and restart the API through it, write a row and read it back
out of `db/app.db`, build, and stop what was started. `fli tutor:app --tmp --yes`
is **green end to end in about 7 seconds** with a warm bun cache, and re-running
it replays every finished step into a no-op.

**Three things a running server forced.** A process is the one thing a journal
cannot hold — the row says `succeeded` and the port is dead — so `makeRecorder`
takes `ephemeral`, a list of steps that are recorded and never replayed;
`04-run` and `10-finish` are named there. Whatever a run starts, that run stops:
`openTutor` traps `exit`, `SIGINT`, `SIGTERM` and `SIGHUP`, because `--step N`
never reaches the teardown step and a Ctrl-C reaches nothing at all — without it
a lesson leaves the dev server that its own step 1 then refuses on, and blames
the person for it. And a step that talks to the API asks for it (`ensureApi`)
rather than assuming: `needs()` covers a missing FACT and cannot cover a missing
process, which is what made `--step 8` report an expired token.

**`fli new`'s refusals exited 0** — nine of ten, `log.error` then a bare
`return`, where the ruled refusal is `context.config.abort` (`FJS-589`).
`--restart` is what surfaced it: the scaffold refused, `context.exec` saw
success, and the step's file probes then passed against the previous run's
files. That reaches past this repo — `npm create frontier` forwards to this
command.

Smaller, all measured rather than assumed: the ports are `--api-port` /
`--web-port` and every printed URL comes from them, since a machine with a busy
8000 could not run the lesson at all; `httpJson` returns the PARSED body beside
the truncated `detail`, because a caller reading a token back out of a 400-character
diagnosis fails on a correct response that is longer than the cut; `writeJournal`
answers `null` for a workspace that has been swept, which is the order the
teardown step and the runner actually run in; `needs()` maps each missing fact to
its own step; and step 3's gate sample is `4.4.4.5`, which is what a scaffolded
`User` carries — the `0.4.4.6` it claimed is the scaffolded `Note`'s, three
steps later, and asserting both is now the point of the pair.

## 2026-09-03 — five commands that could not run, and the check that found them

`FJS-730`, `FJS-731`, `FJS-732`. Design record: `IDEAS/shipped/scope-checking.md`.

`FJS-726` was a free identifier, so the obvious next question was how many more
there are. A prototype answers it: parse the compiled unit the RUNTIME builds —
namespace module script prepended — and resolve every identifier against real
lexical scopes. Over **237 command units** it found **four live defects on a
green tree**, and a fifth stacked behind the first.

**Four `fli auth:*` commands and `make:schema` threw on a free name.**
`loadEnv({ path: envPath })` is a `core/utils.js` export, not a global and not a
zx global, so `auth:list-users`, `auth:create-user`, `auth:revoke-sessions` and
`auth:rotate-key` all died at the line that reads `.env` — and the call was
redundant besides, since `bootstrap.js` loads the project's `.env` with override
before any command runs. `make:schema` did the same with `resolve`, inside an
`await import(…).catch(…)` where the throw is evaluating the argument and the
catch never sees it; the binding it imported was unused.

**`fli db:schema` could not load at all.** The `db` namespace module imports
`existsSync` and `resolve`, and the command imported both again — one module, so
a duplicate declaration and a `SyntaxError`. A `_module.md` helper reaching for
a binding by importing it breaks every command in that namespace that imports
the same name, which is why `requireAuthInstalled` now says `fs.readFileSync`.

**And behind the first, a signature that had moved.** All four auth commands
generate `createClient('<path>', { encryption: { key } })`; litestone takes one
object, `createClient({ path, encryptionKey })`, which `auth:install`'s own
generated `db.ts` already writes correctly. Two defects stacked in one command is
this class's normal shape — `FJS-726` hid `FJS-727` exactly the same way —
because code nothing has ever run accumulates faults in layers and only the
outermost is visible.

Two things the prototype measured rather than assumed. A flat *declared anywhere
in the module* set **misses `deployConf`**, since it is a parameter of three
sibling functions in the same file, so this class needs real scope chains or it
needs nothing. And resolving a step's namespace from its own frontmatter title
rather than its orchestrator's reports **27 free names instead of 0** — the unit
is the join, not the file.

Nothing is committed but the fixes and the write-up: the checker itself is
`IDEAS/shipped/scope-checking.md` 0.10, and its one open decision is a parser dependency.
The tree now answers 0 free identifiers and 0 parse failures over 237 units,
which is what would let a rule go in at zero rather than at a baseline.

## 2026-09-03 — the deploy pipeline could not deploy, and a scaffolded app could not start

`FJS-726`, `FJS-727`, `FJS-725`. 1648 pass (35 new).

**`swapContainer` named a variable in no scope it could see.** `dockerLogArgs(deployConf)`
was a free identifier — the function's options are
`{ host, container, image, apiPort, dbPath, envFile, build, log }` and neither
caller passed it, though both had it in their own scope. The throw lands while
building the `docker run` line, which is AFTER `docker rename <c> <c>_replaced`
and `docker stop`: measured against the pre-fix source, two commands are already
on the machine, so a deploy took the running app down and never put anything up.
`_steps-revert/03-swap` calls the same function, so the way back was broken the
same way.

Three things kept it invisible, and they compose. The parse sweep parses and
does not resolve scopes, which is `FJS-269`'s class one layer along; both callers
read correctly on their own, because each has its own `deployConf`; and
`deployJournalCycle` is the only thing in the repo that runs `fli deploy` at all.
It was failing here, which is why every assertion past this line — the journal,
the resume, the revert — had never run.

`deployConf` is an explicit option now, like every other value the function
takes. The eight new tests drive the real function through an injected
`context.exec` and assert what the failure destroyed: that a `docker run` line is
produced at all, the rename → stop → run ORDER, the log driver reaching the
command, and that `logs: false` still starts a container. The capture reads
`input` rather than `command`, because the script travels on stdin to `sh -s` and
a test watching the command line sees nothing but `sh -s`.

**Behind it, every scaffolded app refused to start.** `fli new` writes
`cors: { origins: ['*'], credentials: true }`, and junction refuses that pair at
CONSTRUCTION (`FJS-689`) — so `runStartPhases` throws, the container exits 1, the
health poll fails and the deploy rolls back reporting *health check failed* about
an app the framework declined to run. Two layers of never-executed code, the
second invisible while the first threw earlier in the same step. A scaffolded app
authenticates with a bearer token and never needed a credentialed request.

**And a step's `printPlan()` rendered the orchestrator's prose.** `stepContext`
is spread from the orchestrator's, so `filePath` and `printPlan` named `index.md`
inside every step. Rebound in `runOneStep`, with a fixture and four tests
captured off stdout — the prose renderer writes to the terminal directly, so no
event assertion could have seen it.

**New, and the reason all three were found:** `core/prompt.js` (one prompt engine
over a TTY and a pipe, `--yes` never opening stdin), `core/probe.js` (the
assertions a tutorial step ends with — http, ports, files, sqlite, docker — every
one answering rather than throwing, so a refusal goes through `context.config
.abort` and the teardown still runs), and `core/tutor.js` (a lesson's workspace,
its resume journal, and `pointAtLocalServer`, which `scripts/scaffold-build.mjs`
now imports rather than keeping its own copy of).

## 2026-09-02 — `-d` is `--dry`

`FJS-653`. 1566 pass (7 new).

`fli db:import -d` ran the real import against production.

`run()` parses with `boolean: ['help', 'h', 'dry', 'd']`, so minimist emits a
value for every one of those names whether or not it was typed: `-d` arrives as
`{ d: true, dry: false }`. `getConfig`'s short-char promotion reads a DEFINED
long name as *the long name was given* and drops the short one, so `flag.dry`
stayed false and all five steps executed their `context.exec`. `--dry` was never
affected, which is why nothing here could see it.

Fixed at the parse rather than at the promotion — treating `false` as unset in
`getConfig` would make `--no-dry -d` mean two things. `dropUntypedBooleans`
compares minimist's output against the argv actually typed and deletes the
defaults nobody asked for; the promotion keeps its one meaning. It lives beside
`defaultFlags` in `runtime.js`, which is where the flag vocabulary already is.

**Two more were underneath, in the command.** `if (!server) { log.error(…);
return }` is a bare return, and a bare return does not stop `_steps/` — the run
went on to build `ssh undefined "…"` and `rm -f undefined/development.db*` with
the guard already printed. It sets `context.config.abort` now. A refusal raised
before any step has run also blamed `01-prepare`, which never ran; `refusedBy`
starts at *the command* when the body has already refused. And three steps
logged `Downloaded backup` / `Local DB restored from backup` under `--dry` — a
success line for something that did not happen.

## 2026-09-02 — a register row is graded against its own table's header

`FJS-647`. 1594 pass (2 new).

`register:check` could not see a row that disagreed with the table it was in,
and it went wrong in both directions at once.

**Narrower.** `registers.js` infers a row's shape from its CELL COUNT, so a
four-cell row in a six-column table fell to the decision-shaped branch and was
handed a status nobody wrote. Four closed rows sat in § S3 that way, invisible
to `closed-in-open`, and two rows that are still OPEN sat in § Closed where
every count read them as done.

**Wider.** Markdown drops every cell past the header's width — measured with a
renderer rather than reasoned from the spec. For § Closed that cell is *How*, so
137 rows displayed no citations at all while the links sat in the file.

`row-shape` grades the count against `headWidth`, read off the header rather
than written into the rule. The first probe was the DATE column and it was
wrong: it fired on a cell reading *last tuesday*, which is a bad value in the
right column and belongs to `malformed-date` — one mistake reported twice,
pointing at the wrong fix. Every real case disagreed on width as well, so width
alone is both sufficient and exact. 181 findings against the pre-fix file out of
git, 0 after.

## 2026-09-01 — the API's snapshots are read out of `api/`

`readApiSurface` looks for `surface.snapshot.md` in **`api/` first and the app
root second** (`commands/project/_module.md`). `project:view` and `project:map`
are the callers; both are unchanged.

**A snapshot belongs in the surface it describes.** `db/` holds the Data
realm's four, `web/` and `site/` hold their route tables, and everything in
`surface.snapshot.md` — the services, the mounted routes, the hook chain, the
plugins — is a fact about `api/`. The four that junction writes were the only
ones sitting at the app root, and `example` has moved them.

**The app root stays a candidate rather than being dropped.** The file is
written by a command an app already runs, so an app that has not moved it is
not broken; and an app whose API is not in `api/` is a shape this cannot rule
out. First hit wins, and an app holding BOTH reads the one beside its API —
two copies of one surface is itself the defect `scripts/ci-allowances.json`
records, where a root-generated copy disagreed with the real one by six routes.

The hint names both places it looked, because *no snapshot* and *a snapshot
somewhere else* read identically otherwise.

## 2026-09-01 — the derived JSON Schema has one home, and it is not committed

`db/schema.json` moves to **`db/.json/schema.json`**, is gitignored, and has one
owner: `core/derived-paths.js`.

**It was a committed artefact that nothing gated.** It carries no `generated
by:` header and is not named `*.snapshot.*`, so the CI snapshots phase never
looked at it — while `db/jsonschema.snapshot.md` sitting beside it holds the
same information in the form that IS rechecked. A second copy that everything
can outdate and nothing grades. It happened to be current when this was
written, which is the only reason it had not already gone wrong.

**Four commands touched the path and each held its own literal**: `db:push`
regenerates it after applying a change, `db:jsonschema` writes it on demand,
`validate` regenerates it AND reads it back, and `project:view` tests whether it
is there. `validate` is the one where a divergence is worst — it would have
regenerated one file and validated another, which is a clean pass over a schema
nobody looked at.

**`litestone jsonschema` now creates its output directory.** `--out` is treated
as a directory only when that directory already EXISTS, so `--out <db>/.json`
writes a file literally named `.json` on a fresh clone, and a nested path fails
with ENOENT naming the FILE rather than the missing parent. The path is stated
as `…/.json/schema.json` for that reason and `mkdirSync` covers the rest.

The dot-directory is this repo's existing mark for a derived thing that is not
committed — the same one `api/src/emails/.preview/` wears.

## 2026-08-31 — `schema-in-memory` — the app runs models the committed artefacts cannot see

`FJS-626` — the half the entry below opened and could not take. That one taught
`fli check` and `fli admin:generate` to MERGE what a package ships, which is the
right answer for a CLI reading an app from outside. It cannot help litestone's
own four artefacts, because those are generated FROM the schema and an app that
assembles one in memory has no file for them to read. So this closes it from the
other end: the app puts the models in the file, and a rule catches the next app
that does not.

193 checks tests pass; `fli check` clean on `example`, one fewer finding on
`basecamp` after the test-file control.

Every schema tool takes a PATH. An app that appends a package's shipped fragment
to its schema text at boot runs models no tool can read, and `access.snapshot.md`,
`release.snapshot.md`, `ddl.snapshot.sql` and `jsonschema.snapshot.md` then all
describe a schema that is not the one serving. Measured on `example`: 39 models
ran, 32 were in each artefact, and the seven missing were the identity model and
the credential store.

**The cost is the deploy gate.** `release:check` compares release surfaces, so a
contract on `Session` was in neither and graded EXPAND — the deploy read as
reversible. The `snapshots` phase passed the whole time, because it re-runs the
same command from the same directory and gets the same incomplete answer.

**It carries no list of fragment-exporting function names**, and two rejected
drafts are why that matters. The first compared each dependency's shipped models
against the ones the schema file reaches, and reported junction's `BackfillRun` —
a feature `example` does not use, and a dependency imported for `createApp` says
nothing about whether its models are wanted. The second fired on basecamp's
`db/test/schema.test.ts`, where an inline schema is simply how a test is written.
What survives is the call itself: `createClient`/`createTenantRegistry` handed a
`schema:` string while `db/schema.lite` exists. Both rejected shapes are controls
in the suite, beside a comment mentioning the hazard — this rule's own prose
describes what it matches on, so it reads through `readCode`.

`test/checks.test.js` § `schema-in-memory` (6) · [checks.js](core/checks.js)

## 2026-08-31 — the schema a tool reads is not the schema an app runs

1549 + 35 tests, 0 fail. Closes [`FJS-625`](../../ISSUES_ARCHIVE.md#fjs-625); opens
[`FJS-626`](../../ISSUES_ARCHIVE.md#fjs-626) for the half that cannot take this fix.

**An app's seed is not `db/schema.lite`.** It is that file, plus fragments a
package ships and the app appends in memory (`authSchemaFragments()`,
`outboxSchemaFragment()`), plus `extend model` in files of its own. Every tool
here read the first and called it the answer, so the models none of them could
see were exactly `User`, `Session` and `Credential` — the identity layer.

Two readers, failing in opposite directions, which is why neither had been
noticed. **`fli check`'s `service-model` failed closed**: a correct
`users.service.ts` stating `model: 'User'` was reported as naming a model that
does not exist. A rule that fires on a correct app is a rule people baseline.
**`fli admin:generate` failed open** and had since it was written: it generated
a complete admin panel with no Users screen in it, silently.

`core/app-schema.js` is the one owner now — `appSchemaModels`, `appServices`,
`serviceForModel` — read by both, for the reason two implementations of one rule
are always the wrong number. A dependency's `.lite` files are found through its
own `exports` map and never a guessed path, which is the rule
`package-model-drift` already followed and the one litestone's own resolver
follows.

**The cost is stated rather than hidden**: a service naming a package model the
app never actually assembled now resolves instead of being reported. That is
the fail-open direction the rule exists to close, and it is accepted because the
alternative is a false error on the documented in-memory install — the shape
both apps in this repo use.

### What running the generator found

`FJS-372` says no test in this repo executes a generator. `example`'s new
`verify:users` drive does, and then opens the pages in a browser. Three defects
in the first ninety minutes, none of which a reading would have caught:

**A service name is a FILENAME and was being derived.** junction autoloads the
directory, so `shipping-methods.service.ts` answers on `/shipping-methods` —
and `servicePlural('ShippingMethod')` is `shippingMethods`. Five of `example`'s
generated screens called a URL the app does not serve: a 404 with the page
rendering normally around it. The services directory is read now; the
derivation is the fallback for a model that has none.

**A model with no service was generated and then warned about**, which is the
wrong half — the route rendered and `load()` failed. Nothing is written for one
now. Filtering it out of the TARGETS alone was not enough, and that is the part
worth remembering: the layout and the dashboard are built from the full model
list on purpose, so that a `--model` run does not drop the sections an earlier
run added. The nav went on linking two sections that had never been generated —
the panel advertising a screen that 404s, the same defect one layer up.

**The export name took the service string.** `export const shipping-methods =
createResource(…)` does not parse. Kebab could not reach the export before this
change, so it is a defect this change introduced and the first end-to-end run
caught — which is the argument for the drive in one line.

**Also settled: `@@gate(8+)` models are skipped by name.** Reading the whole
seed means seeing a package's machinery. `asSystem()` itself grades 8, so a page
over `Credential` would ask forever, and would be an editor for password hashes
if it did not. What separates machinery from domain is the gate, and the gate is
in the schema — so the rule reads it rather than carrying a list of names.

## 2026-08-31 — a log nobody can read back

1549 + 35 tests, 0 fail. Closes [`FJS-622`](../../ISSUES_ARCHIVE.md#fjs-622) and
[`FJS-623`](../../ISSUES_ARCHIVE.md#fjs-623).

**The vhost `deploy:setup` writes declared no `access_log`.** A server block
without one falls back to nginx's machine-wide default, which is a working
config, a green `nginx -t` and a serving site — the only symptom is that the
file cannot be read back, because nothing in a line says which app took the
request. On a box with two apps, which is the normal case for a fleet machine,
neither one's traffic is attributable.

The path now carries the app id, and **the directory is load-bearing**:
`/var/log/nginx/*.log` is the glob the packaged logrotate rule already rotates,
so the files are bounded by a rule that is on the machine rather than by one we
would have to write. Anywhere else and this would have been
[`FJS-616`](../../ISSUES_ARCHIVE.md#fjs-616) one layer up while looking like a fix.
`combined` is stated rather than defaulted because it is the format an analyser
reads unasked; a custom `log_format` cannot be declared here at all, being
http-level only.

Found designing `IDEAS/traffic-analysis.md` against CapRover's GoAccess
integration, which needs exactly the per-app log this was not writing — so the
gap was a precondition rather than a phase, and went in ahead of the design.

**A test waited for a file to exist when it needed the pid inside it.**
`children.test.js` spawns a shell that writes its pid with `echo $$ > f`;
`echo` creates the file before it writes, so `existsSync` is the wrong signal
and an empty read parses as `0`. It fired on the full suite and passed in
isolation — the signature that reads as somebody else's change breaking it —
and only the success path removed the file, so `/tmp` held nine of them
including a **0-byte one**: the failure state on disk, waiting for a run whose
pid recycled onto the same number. Now waits for a parseable pid and clears the
path before the spawn as well as after.

## 2026-08-29 — a refusal is not a success

1531 + 35 tests, 0 fail; `deployJournalCycle` 12/12. Closes
[`FJS-589`](../../ISSUES_ARCHIVE.md#fjs-589).

A step refuses by setting `context.config.abort` and returning. Every later step
then self-skipped and the command exited **0** — so seven of the deploy
pipeline's nine refusal sites reported success, `deploy:revert`'s six named
refusals among them, which are the whole safety argument of the Release realm.

**`abort` fails the command; `stop` is the deliberate early exit that
succeeded.** Both skip every later step and they differ only in the verdict.
Fail closed, so the next refusal somebody writes is loud without being told to
be — `--plan` is the one shape that had to say otherwise, in three places.

Asked on BOTH return paths. A command with steps runs the orchestrator then the
loop; one without steps returns `config.run` directly, and `deploy:logs`,
`:status`, `:run` and `:unlock` are that shape.

The throw is `quiet`: the refusal has already printed its reason and the ways
out, so `bin/fli.js` prints one line naming the step and nothing else.

**`runOnAbort` now means run on a REFUSAL.** A cleanup step undoes a half-done
run, and a deliberate stop did not start one — `fli deploy --plan` printed its
plan and then reached `09-cleanup`, which opens a connection to the target to
release a lock nothing took. Measured: five minutes hanging, now two seconds
and exit 0.

Doctor's trailing abort was deleted rather than converted. It protected nothing:
doctor declares no `steps:` and is not `index.md`, so no step folder is ever
discovered for it.

## 2026-08-30 — `--resume` adopts the transition it finds

`fli deploy --resume` took the lock over and then deployed from the beginning,
because the transition it was continuing could not be found. `readAttempts` keys
on `releaseId`; a Release id is content-addressed on the image digest; and a
**local image ID is not a content address** — measured, one Dockerfile over one
unchanged file gives `1f021e1eccf8` cached and `a9c17ea37ed9` with `--no-cache`.
So an interrupted deploy rebuilt, minted a different Release from identical
bytes, matched nothing, and opened a second transition. Every resume did this,
and the machinery underneath it — `resumeDecision` skipping a succeeded step,
`restoreStepNote` replaying the image `04-build-api` recorded so `06-swap` can
start it — was unreachable in the one case it exists for (`FJS-595`).

`readLiveTransition` asks the question a resume means: **what is open here**.
Scoped to one app, one environment, and to the kinds that can be continued, so a
revert in flight is not picked up by a deploy. It answers the transition AND its
Release, because adopting one without the other resumes the old transition
against the bytes this run just built.

**Only under the flag.** An ordinary deploy still keys on the Release, because
there *different bytes are a different Release* is the right question — the
lookup was not wrong, it was being asked in the one place it does not fit.

Two documents were carrying the reasoning that made this a bug and both are
corrected: `04c-journal.md` said Docker's cache produces the same digest twice
for an unchanged tree, and this package's `CLAUDE.md` still described the older
design where a Release carried no digest at all and concluded that *resume works
BECAUSE the id does not depend on a rebuild being reproducible*. That sentence
was right about the mechanism and had stopped being true of the code.

Found by clearing `FJS-544`, whose private-`/tmp` failure had masked the whole
journal cycle since it was written — so `deployJournalCycle`, the only thing in
the repo that runs `fli deploy`, had never reached this.

## 2026-08-30 — the Release realm gets a surface

`core/release-view.js` and two routes put the pivot on `fli gui`'s front page,
beside *what proves this change* and *checks*. Until now the whole realm was
terminal: you learned that a change crosses the pivot by typing `release:check`,
which is a thing people type once something is already wrong. Its first run
reported this repository's own tree as **contract** — twenty findings, all of
them real — which nothing anybody looks at had been saying.

**Two halves, and the split is the design.** The verdict per app READS THE TREE,
so it loads with the page: free, offline, no side effect. What is SERVING
reaches a machine over ssh, so it is a button and never a poll — a panel that
ssh'd while a page loaded would be the monitoring agent this realm refuses. They
are separate functions behind separate routes so the distinction cannot erode
into a `setInterval`.

**Nothing here re-derives a verdict.** `classifyPivot` is litestone's and the
revert refusals are `core/revert.js`'s; both are reached by running the command
that owns them and reading what it printed. A second implementation is how the
GUI ends up disagreeing with the terminal about whether a deploy can be undone,
which is the one disagreement that costs a database.

Three things it cost to get right, each caught by running it rather than reading
it:

- **The refusal was thrown away.** The first version used `execFileSync` and
  kept stderr only from the catch — but a deploy command that refuses exits 0
  ([`FJS-589`](../../ISSUES_ARCHIVE.md#fjs-589)), so the success path handed the panel an
  empty string and it reported *the journal answered nothing* about a command
  that had said exactly what was wrong. `spawnSync`, both streams, every path.
- **`.select` is defined by nothing.** The panel was written with it; the class
  is `.field`. That is `FJS-545`'s shape one layer up — markup that looks styled
  and is not — and it is invisible to any assertion about what the page SAYS.
  `test/browser/specs/release.spec.mjs` probes computed style against a bare
  element, with a negative control that fails if the probe stops catching
  `select` and `stack-sm`.
- **A count in a badge is a Pill.** `badges.css` says so at the top and notes
  that the failure is silent, which it was.

The first attempt at that class check walked `document.styleSheets`; `cssRules`
throws for the served stylesheet, so it reported every class in the page as
undefined — `.badge` included, one assertion above the one measuring `.badge` as
styled. A check that fails on correct markup is worse than no check.

## 2026-08-30 — one deploy is one build, on both sides of the wire

`03-build-web` stamps `VITE_FJS_BUILD=<commit>` so vite inlines it into the
bundle, and `06-swap` passes `FJS_BUILD=<commit>` into the container so the API
states the same value. A browser can then tell it is running the previous
deploy's code ([`FJS-D160`](../../DECISIONS.md#fjs-d160)).

The env goes in the SCRIPT rather than the exec options — the script is piped to
the target's shell, so an env option would set the operator's — and the commit is
asserted to be a sha before it is interpolated into a command line, because
Invariant 8's reasoning applies to a shell exactly as it does to SQL.

`deployJournalCycle` gained a twelfth assertion, and it is the only thing that can
make this claim: two packages have to agree, the cli decides the value and
junction states it, so it asks a DEPLOYED container what it answers and compares
that against the commit the deploy built.

## 2026-08-30 — the binding block stops being vacuous, and a refusal that reports success

**`bindingsHash` covers a DECLARATION, and now says so.** `deploy.bindings` and
`deploy.secrets` feed the Release id and their values are applied by nothing —
`fli` writes no `.env` on a target, the operator owns that file, and the
container is started with `--env-file` against it. `formatRelease` prints
`(declared)`, `release:mint`'s term table says *as declared*, and
`core/release.js` carries the reason. Half of [`FJS-585`](../../ISSUES.md#fjs-585);
the values half is still open and is two different features.

**The keys are now graded against the target.** `01b-env-check` reads the
declared binding and secret KEYS alongside `.env.example`, reports which source
named a missing one, and a declared block turns the check on by itself. That is
what stops the declaration being a statement nothing checks — the values stay the
operator's, and the keys become a per-target assertion in a file that is
reviewed. `bindingSet` is asked rather than the two objects re-merged here,
because per-target-beats-app-wide is its rule.

**And it found [`FJS-589`](../../ISSUES_ARCHIVE.md#fjs-589), which is larger than what it
was looking for.** `runtime.js` re-throws a step's ERROR, so a step that throws
fails the command — but a step that refuses by setting `context.config.abort` and
returning only makes the later steps self-skip, and the command exits **0**.
Seven of the pipeline's nine refusal sites do it that way, `fli deploy:revert`'s
six named refusals among them: the whole safety argument of the Release realm,
each one telling a script the revert succeeded. Filed rather than fixed — a
blanket *abort ⇒ non-zero* is wrong (`--plan` prints a plan and stops, which is
success), so 34 abort sites each need the *refused* / *stopped on purpose* call
made, and it should fail closed.

`deployJournalCycle` gained an eleventh assertion, and it is the first thing here
to run a step that refuses without throwing — which is why nothing had seen this.
It asserts the pipeline STOPPED and the refusal named the key and its source,
and gains `status !== 0` when 589 closes.

## 2026-08-29 — a failed health check shows the container's own words

`healthOrRestore` printed the URL it polled and a hint about `apiPrefix`, then
rolled back. That hint is right when a running app serves health at a path the
deploy block does not name, and **wrong in every case where the app never came
up at all** — a missing attachment binding, a bad encryption key, a port already
taken. In those the app had already said exactly what was wrong, clearly, in its
own output, and the operator saw none of it: the sentence was in `docker logs`,
where nobody looks at 3am because nothing said to.

`showContainerTail` tails 40 lines on a failed health check, labeled as the
app's own words. Tailed rather than dumped: an app that started and is merely
unwell has written thousands of lines, and burying the one that matters is the
same failure one layer along. A stopped container still answers, which is the
case that matters most — it is the one that exited. It never throws; this runs on
a path that is already failing.

It is called from `healthOrRestore`, so the REVERT path gets it too — a revert
whose health check fails is a target with no working release on it, which is the
worst moment to be told only that a URL did not answer.

**`deployJournalCycle` gained a tenth assertion**, and it is the one that proves
phase 2 of `IDEAS/release-transitions.md` end to end: an app declaring an
attachment nothing binds, deployed for real, must fail the deploy, carry the
app's own refusal naming the service into the operator's terminal, and leave the
release that was serving still serving. All three at once, which no unit test on
either side can reach ([`FJS-D158`](../../DECISIONS.md#fjs-d158)).

## 2026-08-29 — `polymorphic-subject`: the one thing an open pair can still be told

`(subjectType, subjectId)` is the ruled answer for a target set that is open —
no foreign key, no cascade, no `include`, and the target deliberately not an
input to the access-control compiler (`IDEAS/shipped/polymorphic-relations.md`). None of
that changes.

**What changed is that the discriminator was carrying no rule at all.**
`subjectType String` accepts a value naming nothing, forever, and nothing
objects — not a migration, not a seed, not `asSystem()`. The fix is not a
feature: an `enum` there emits a table CHECK, which holds where every other
constraint holds, and reaches the browser as a set `controlFor` renders as a
picker instead of a text box. `@@check("col IN (…)")` is the same enforcement
where the values are not identifiers. The rule asks for one of the two.

**A warning, because the exemption is real and it is named.** A set that grows
with every model — an audit trail keyed by the service that wrote the row — must
stay a String, since an enum there refuses the first row a new service writes.
`check-baseline.json` is how an app says it means it, and basecamp's now does.

**The evidence it is worth asking at all comes from the corpus.** Across seven
published schemas ERPNext is the only source that DECLARES which kind each of
its polymorphic fields is: 17 closed, 61 open. Reading the 61 is the finding —
`party_type` is declared CLOSED twice (Customer, Supplier, Employee) and left
open sixteen times in the same codebase, and `invoice_type`, `voucher_type`,
`reference_type` and `document_type` all do the same. **Openness in the data is
mostly an author not bothering rather than a domain requirement**, which is why
the default here is to ask.

Its first run reported five sites across this repo's two apps and every one was
real, including two a hand grep had missed (`Server.providerKind + providerId`,
`AuditEvent.actorType + actorId`). Four are enums now and the fifth is the
baseline entry.

Shape detection is a line scan here rather than litestone's
`src/import/polymorphic.js`, which finds the same pairs to ask a different
question — *which of the three answers did you mean* — and importing it would
make an engine that must run in a client app with only `@frontierjs/cli`
installed depend on a framework package to answer a question about text.

`test/checks.test.js` grows a correctly-declared pair in its CLEAN tree, so the
rule RUNS there rather than skipping — the discipline that file already applies
to `transition-methods`, `capability-ladder` and `service-as-system`.

## 2026-08-29 — the split's middle step is checkable

`fli release:check` refuses a contract on a required column and hands back
*expand → backfill → contract*. The middle line used to read *fill `x` for the
rows that predate it* — a sentence between two commands.

`litestone release` now puts the FACT on the finding (`needsBackfill: { model,
field }`) and stops there, because which mechanism fills a column is a question
about the running application and litestone sits below the package that answers
it. `fli release:check` reads the app's own source for a `defineBackfill` naming
that model and field, and prints either where it is declared or the stub to
write:

```
The middle step — every column that needs a value before its contract can pass:

  ✗  Order.shippedAt — no defineBackfill names this column
```

Read as SOURCE rather than by a directory convention, the way the thirteen
source-reading `fli check` rules already work: a rule keyed on a path reports a
correct app as missing one. `core/backfills.js` counts braces rather than
matching them with a regex — a `fill` is a function body and holds braces and
quotes of its own, so `defineBackfill\({([^}]*)}` stops inside it and the
`field` after it is never seen.

**What no command here can answer is whether it has RUN**, because that is a row
in the deployed database and this has no target. It says so, and names
`app.backfills.status()`.

`fli backfill:install` is the sibling of `outbox:install`: it imports
`@frontierjs/junction/backfill.lite` by name rather than copying it, pushes the
schema, and prints the declaration and the two lines to configure.

## 2026-08-29 — the deploy lock says who holds it and how far they got

1456 tests, 0 fail. `FJS-573` closed, ruled as [`FJS-D156`](../../DECISIONS.md#fjs-d156).

Two records of a run in flight, and in the one case the whole Release design
exists for they disagreed. The journal knew a killed deploy had left a `running`
transition and `resumeDecision` graded exactly how to continue it; `.deploy.lock`
refused the run that would. The only way through was to delete a file by hand,
and the message telling an operator to do that named a pid.

**The pid was a lie by construction and that is what settled the design.** The
lock script wrote `$$`, expanded by the `sh -s` that ran it — a shell that exits
the instant the file is written. It cannot be fixed by recording a better one:
`fli` runs on the operator's machine and reaches the target one command at a
time, so there is **no process on the target to point at**, and no probe can be
built on one. `deploy:status` did not even parse its own format — it split
`<pid>:<iso>:<target>` on `:` and had been reading the hour as the timestamp for
its whole life.

So the lock records what is true: the run, who started it, when, and **which step
it is inside**. That last one is the fact that makes the duration beside it mean
something — four minutes in `04-build-api` is a build, four minutes in `06-swap`
is a run that died. It comes from a `beforeStep` announcement in the step runner,
which is the only place it can: the build is the longest thing a deploy does and
it runs BEFORE the journal opens (`04c-journal`), and a timer cannot serve it
either, because `execSync` blocks the loop for the whole of a step.

Neither register judges liveness, because that is a fact about a process this
machine cannot see. The refusal reports and names both ways out, and they are not
the same choice:

```
Deploy already in progress on deploy@box
  held by sam deploying production, started 9m ago
  in step 06-swap — 7m in it

  If that run is dead:
    fli deploy --resume    continue it — the journal knows how far it got
    fli deploy:unlock      drop the lock and start over
```

`--resume` takes the lock over; `deploy:unlock` drops it and settles nothing, so
a transition the dead run left open stays resumable. A resume was always safe
without a liveness probe — a succeeded step replays into a no-op, a step is
claimed compare-and-set, and different bytes are a different Release and
therefore a new transition. The lock was only ever what made it unreachable.

**A freshness check on `--resume` was built and then removed, and the reason
generalizes.** *A lock whose step moved seconds ago is a live run* looks sound and
is not: the recorded time is when a step STARTED, and nothing records one ending
or a pulse inside it — so a fresh timestamp is equally consistent with a run three
seconds into a five-minute build and with a run killed three seconds into it. It
was measured that way round, by the cycle: the crash it exists for leaves exactly
that lock. A sound version needs a heartbeat within a step, which `execSync`
forecloses. **Nothing was lost by removing it**, because the fact is already on
screen — *in step 06-swap — 3s in it* — where a person can weigh it and the
machine does not pretend to.

**A TTL was considered and refused.** It is the shape the field uses and the one
caravan uses one layer down (`FJS-294`), but the heartbeat can only tick per
step, and a step is minutes long — so the TTL would have to exceed the longest
build, putting an operator whose deploy was killed in a fifteen-minute wait to
reach a feature that is already safe to reach immediately.

`core/lock.js` is one format, one parser, four scripts and three readers, where
`deploy`, `deploy:status` and `deploy:doctor` each used to `cat` the file and read
it their own way. The format it replaced still parses and says it is legacy. Two
things are proved by execution rather than compared as strings: `set -C` genuinely
refuses a second writer, where the `[ -f ]` guard it replaces was two operations
with a window between them; and a refresh carrying another run's id does not
clobber. The `sh -n` guard over the deploy pipeline gained a second source, because
these scripts left its text corpus by moving into a module — which is the shape of
a check going quiet.

`deployJournalCycle` used to `rm` the lock itself to reach the resume it was
testing. It now asserts the refusal names the step the lock is holding and offers
`--resume`, and resumes with it.

Two other things the run turned up. `daemonBlindHint` is now one owner for *the
daemon cannot see our work directory* — it matched the classic builder's wording
only, so under BuildKit the same environment failed the journal cycle looking
exactly like a broken Dockerfile. And `test/lock.test.js` was written and not
run: it is in the `test` script now, which is the rule `fli check`'s
`test-files-run` already publishes and the reason it exists.

## 2026-08-29 — a dev surface has a name

1430 tests + 99 browser assertions, 0 fail. `IDEAS/shipped/control-surface.md` §10.6,
`IDEAS/overview.md` 5.19.

`example.localhost` rather than `localhost:8010`, and it is worth having only
because the derivation was already here: `core/ports.js` knows that project 1 is
`example` and that 8010 is its frontend, so a name is a RENDERING of the table
that already owns the numbers. The frontend takes the bare label and every other
surface is a subdomain of it — which is what makes the cookie property real,
since `example.localhost` and `api.example.localhost` are a parent and a child
where `:8010` and `:8110` are one origin sharing one jar. Tools live under
`fli.localhost`, so no app can shadow `studio`.

`fli proxy` is the half that is not free, and two measurements shaped it.

**It is a TCP proxy and not an http one.** The first cut piped an http request
upstream and handled `upgrade` by piping sockets. It works under node and is
silently broken under bun, which is what `fli` runs on: bun's `node:http` emits
`upgrade`, hands over a socket that reports `writable: true`, and nothing
written to it ever reaches the client — measured, with the upstream seeing the
handshake and the browser waiting forever. Junction's live layer and vite's HMR
are both sockets, so that is a page that loads and then silently stops updating.
At the TCP layer there is nothing to be compatible about: read the first head,
pick the target from its Host, pipe bytes.

**Nothing is rewritten.** The Host was going to be swapped to `localhost:<port>`
for vite's DNS-rebinding guard, until the guard was read: it allows
`hostname.endsWith('.localhost')` in both the 5.x and 8.x this workspace
resolves. Which matters, because junction READS the host — `resolve subdomain`
tenancy is nothing else — so rewriting would have made every tenant one tenant
to appease a check that was never going to fire.

**One bound, stated rather than hidden.** The target is picked from the first
request on a CONNECTION and kept, because routing per request means parsing
every request on a keep-alive socket. No real client reaches it: a Host is
derived from the URL, and a browser pools per origin, so two names are two
connections. Asserted as its own case.

**Strictly additive.** Every number keeps working, a tile's `open` is still the
port, and the name is shown as text beside it. `fli check`'s **`dev-host-unique`**
(error) refuses two packages whose names reduce to one label — `strictPort`'s
failure one layer up, and silent in the same way: the page works, and it is the
wrong app.

Proven end to end against the live `example` web on 8010 and its real vite HMR
socket, which answered 101 through the proxy.


## 2026-08-29 — the Release names the artefact

1406 tests, 0 fail. `IDEAS/deploy-plane.md` §2.3f, the half that was owed.

**The Release id had no digest in it**, because the journal opened before the
build: a transition cannot be minted around bytes that do not exist yet. So two
deploys of different source minted the same id, and `fli deploy:revert` looked
its target's image up by that id, got the newest transition carrying it — the one
serving — restored the bytes it was reverting from, and reported success.

`01c-journal` is `04c-journal`. The transition opens after the artefact exists,
which is the ordering the whole row turns on. What it costs is that a build
failure now records nothing, and that is the right answer rather than the price:
no artefact, no Release, nothing transitioned. The steps ahead of the journal are
marked done when it opens — `_steps-revert/02-decide` already did this for the
two ahead of it — and their notes come with them, because `04-build-api` records
which bytes it built and a revert reads that to find a startable image.

`fli deploy --plan` says its own Release id is **provisional**, since it builds
nothing and the digest is a term of that id.

### `deploy.builder` — built once, shipped by content

A machine, resolved like every other side, defaulting to the api target — so an
app that declares none behaves exactly as it did. Declared, the image is built
there and shipped with `docker save | docker load`, which preserves the image ID.
No registry: the record keeps three distribution strategies open and makes none
of them the definition, and this is the one that needs no infrastructure.

Not built here by default, deliberately: `fli` is a laptop CLI, and building
locally trades server drift for developer-machine drift, which is worse. The
builder is a declared machine with an identity.

### What running it found: the WAL was in the image

An unchanged redeploy kept minting a NEW Release, which under the new ordering
means the bytes really did move. They did: the container writes `db/app.db-wal`
into the mounted volume, the volume is inside the build context, and the
scaffold's `.dockerignore` said `db/*.db` — which never matched a sidecar. So
**every deploy after the first copied the running app's write-ahead log into the
image**, and moved the digest with it.

`02b-build-check` exists to catch exactly this and was blind to it: `isStateFile`
graded `.db-wal` as state and `CONTEXT_FIND` looked for `*.db` and not the
sidecars — two lists for one fact, with the finder's own comment claiming it was
*the same list spelled for `find`*. The finder is built from the list now, and a
test asserts every extension the classifier grades is one the finder looks for.
The scaffold writes the `**/` forms basecamp already had (`FJS-555`).

### The proof

`deployJournalCycle` gained the assertion this row is about — **an unchanged
redeploy mints the same Release** — which was trivially true while every Release
was identical and means something now. Its resume assertion changed with the
ordering: what a resume IS, is one transition continued rather than a second
opened, so that is what it counts.

## 2026-08-29 — the rules, and the machine, where somebody looks

1396 tests + 99 browser assertions, 0 fail. `IDEAS/shipped/control-surface.md` §10.5.

`fli check` is the arch-test surface and `fli doctor` asks whether this machine
can run fli at all. Neither was anywhere a person looks, which for a set of
rules that are silent when broken is most of the value gone. One panel on the
front page now carries both, kept as two questions: a missing `sqlite3` is not
an architecture finding, and a model named in the plural is not something `apt`
can fix.

**`core/doctor.js` is new, because that engine did not exist.** It was a hundred
lines inside `commands/fli/doctor.md`, interleaved with the `echo`s that printed
it, so the only way to ask was to run the command and read a terminal — and the
front page, the second caller, could not ask at all. The command is now the
rendering of it and gained `--json`; `has`, `env` and `home` are injected, for
the reason `@frontierjs/outpost` injects its docker runner, so a missing
`docker` and a present one are both a test.

**Both are asked in process**, never spawned and never parsed out of `--json`:
`core/checks.js` is the same engine `scripts/ci.mjs` runs, so there is one
answer to each question.

**A clean project says so.** The proves panel above hides on a clean tree
because *nothing changed* is noise; *this project passes its own rules* is not,
and hiding it makes `clean` and `never ran` the same screen.

**The machine goes first when it has something to say**, graded on whether it
STOPS fli rather than on whether something is absent — `blocked` counts system
and config only, because a missing `CLOUDFLARE_TOKEN` blocks `cloudflare:` and
nothing else, and counting it makes almost every machine read as broken.

One thing the paper did not predict: `runChecks` is synchronous and one scope is
~half a second, so five in a row froze this server — the state poll missed,
every badge on the page emptied, and a start button did nothing for a second and
a half. A yield between scopes does not make it faster; it makes the server
answerable while it runs. The browser drive found it, and two assertions that
had been passing on timing were rewritten to ask for the poll they depend on.


## 2026-08-29 — answering is not working

1375 tests + 82 browser assertions, 0 fail. `IDEAS/shipped/control-surface.md` §10.4.

The state badge is a socket that opened, which is equally true of a Junction app
whose database probe is failing and of a process that bound the port and wedged.
`GET /api/health/:id` asks the thing on that port what it says about itself, and
a third badge carries the answer: *healthy*, or *1 check failing* with the check
NAMED and its error printed on a click.

**The fli server fetches it, not the page.** The page is on 8500 and the app on
8110, so a browser fetch is cross-origin — an app whose CORS does not name this
origin answers a network error indistinguishable from the app being down, which
is the opposite of what this is for.

**The path is probed and the answer says which one worked.** `apiPrefix` moves
every route an app registers, `/health` included, so where it lives is a fact
about the app's config rather than about its port. Probe, or be told — never
derive, which is Invariant 3's rule for the same class of question.

**A row that answers nothing shows nothing.** A Vite dev server is up and has no
opinion about its own readiness; rendering that red would leave every web
surface on this page permanently wrong, which is how a signal gets ignored. A
200 of something else is not a health answer either — without the shape test an
index page reads as a healthy API.

Polled at a fifth of the state rate, and the verdict is dropped the moment the
port stops answering: a row that goes down and comes back is a NEW process, and
without that the badge shows the previous one's failing check for up to fifteen
seconds. Both of those were mutation-checked twice — the first pair of
assertions passed against both mutations, because each was written against a row
that was DOWN and hidden one branch earlier.


## 2026-08-29 — the deploy pipeline runs, and nine of its ten shell commands were broken

1398 tests, 0 fail (+115), plus `deployJournalCycle` in CI: deploy → deploy →
crash → resume → revert, against a real machine with a real Docker daemon.

**Nothing had ever executed `fli deploy`.** The `deploy` CI phase runs
`fli deploy:local`, which is a different command — it builds an image and runs
it, and never touches `_steps-docker/`, the journal, the swap, the health poll
or the revert. The journal's own unit tests drive the real runner against real
SQLite, so the runner was proven and the pipeline around it was not. Phase 1
shipped ~1250 green tests over a path that had run zero times.

It had run zero times because it needs a server. So the first move was to give
*run a command on that machine* one owner, and let the machine be this one.

### `core/machine.js` — the script travels on stdin

Twenty-eight call sites across twelve step files each spelled
`ssh ${host} "${cmd}"` by hand. `context.exec` is `execSync`, which is
`/bin/sh -c`, so every one of those scripts was parsed TWICE — once here and
once there. Measured against the health check that shipped:

```
ssh HOST "for i in $(seq 1 10); do; STATUS=$(curl -s -w "%{http_code}" …
```

`$(seq 1 10)` ran on the operator's machine and arrived as literal text.
`$(curl …)` also ran locally, polling the operator's own `localhost:3000`. The
nested `"` closed the outer quote. `"$STATUS"` expanded here to empty, so the
target received `[  = 200 ]`.

**Nine of the ten multi-line commands in the pipeline were shell syntax errors
on the target**, for a second reason on top: `.replace(/\n\s*/g, '; ')` turns
`then` into `then;` and `do` into `do;`, and sh refuses both. The deploy lock,
the container rename, the stop, the health poll, the restore, the cleanup, the
rollback and both revert steps were all in that set — `sh -n` on the exact text
each one sends, which is what `test/deploy-scripts.test.js` now runs over every
script the pipeline can produce.

A tenth was worse than a syntax error: `deploy:setup` wrote its nginx config
through a heredoc nested inside ssh's double quotes, so the local shell ate
every `$host`, `$remote_addr` and `$proxy_add_x_forwarded_for` on the way past.
The file that landed said `proxy_set_header Host ;`.

A script is never interpolated and never joined now. It goes to `sh -s` on
stdin, where no shell but the target's own ever reads it.

**`localhost` is a transport, not a simulation.** Same script, same `sh -s`,
minus the ssh prefix — the real docker commands against the real daemon.
`deploy.transport` overrides the inference for anybody testing their own sshd.
`tty` and `pipe` are separate verbs because stdin can only carry one thing and
`docker exec -it` and the journal runner each need it for something else.

### What running it found

**`fli deploy:revert` restored the bytes it was reverting FROM**, and reported
success. Under build-on-target the Release id carries no digest, so two deploys
of different source mint the same id — and looking the image up by release id
answers whichever transition is newest, which is the one serving. Revert targets
the previous *transition* now, and a seventh refusal (`same-bytes`, no override)
catches the rest. What is running is asked of the machine rather than the
journal: a revert transition has no build step, so after one revert the journal
cannot say.

**A resumed deploy started `undefined`.** A replayed step contributes nothing to
the run, and one of those contributions is load-bearing — `04-build-api` records
which bytes it built and `06-swap` starts them. The step row carries the note;
the projection the resume reads did not select `output`.

**A revert could not itself be reverted.** `imageFromSteps` matched the step by
name, and a revert has no `04-build-api`. It reads any step that recorded an
image now, last one wins, and `_steps-revert/03-swap` records what it started.

**`fli deploy --plan` could not grade `01c-journal`** — the journal step itself.
Its predicate reads `context.flag.dry` and the plan's synthetic context carried
only `config`, so it threw. Reported honestly (*it will RUN*) rather than
silently, which is why it was findable at all.

A failure now names the script and the machine. `execSync` says
`Command failed: sh -s`, which names every script this module runs and
distinguishes none of them — and that string is what the journal recorded, so a
failed step could not be attributed afterwards.

### Also

The deploy lock has one definition, shared by deploy and revert: two copies that
drifted on the file name or the format would each hold a lock the other could
not read. `context.exec` takes `describe`, so `--dry` prints the script rather
than `ssh host sh -s` twelve times.

Filed rather than fixed: `FJS-573` (a crashed deploy strands its lock, and the
pid in it is the pid of the shell that wrote it) and `FJS-574` (every deploy of
a freshly scaffolded app fails its backup, and blames the container).

## 2026-08-29 — the dashboard answers *does it pass*, not only *is it running*

1282 tests + 64 browser assertions, 0 fail. `IDEAS/shipped/control-surface.md` §10.2.

The child table held an exit code and sixty lines of output and threw both away
— `stopRow` deleted the entry and `startRow` overwrote it — so every drive and
every suite read `unknown` forever. Honest about whether it is running, and no
answer at all to the question somebody actually has about a drive.

A row now carries a second badge: `passed · 4.2s · 2m ago`, `failed (1)`,
`stopped`, with the kept tail behind a click. **Two badges, one fact each** — a
single one saying `exited 0` had to choose between *is it running* and *did it
pass*, and chose the one that disappears.

**`stopped` is not `failed`.** A SIGTERM looks identical whoever sent it, so the
stop is marked BEFORE the signal and the exit handler reads it. Without that the
page tells somebody their drive broke when they are the one who stopped it.

**The words are the page's and the facts are the table's.** `children.js` keeps
when, how long, what it exited with, and whether the stop was asked for; the
page chooses the vocabulary, because it differs by kind — a suite that exits 0
passed, and a dev server that exits 0 on its own did something nobody has a word
for.

**In memory, session-scoped, and the badge says *here*.** Persisting would claim
a verdict about a tree that has moved on since, and it would still know nothing
about the runs somebody did in a terminal — so a row nobody has pressed shows
nothing rather than *never passed*.

`outputOf` falls back to the finished run's tail, which is the whole of why a
run is kept: sixty lines saying why a drive failed are worth nothing if they are
dropped the moment it does.


## 2026-08-29 — one button starts the whole thing

1269 tests + 51 browser assertions, 0 fail. `IDEAS/shipped/control-surface.md` §10.1.

`verify:live` needs `db:seed`, then `api` and `web` — three rows pressed in
order, with the order living in prose and in the drive's own exit 1. The drive
row now carries its preamble, shows it before anything is pressed, and one
button walks it.

**Read, rather than declared or asked.** §7 weighed a declaration beside the
script (rejected: a third copy that drifts) against `verify:live --preflight`
(preferred: one owner). What shipped is neither and it dominates the first on
the first's own argument — `core/preflight.js` reads `CLAUDE.md`'s *Start first*
column, which adds no copy at all because it is the copy people already
maintain. Same move `proofs.js` made on the table beside it. What it does not
close is drift against the drive's own check; what it does close is a renamed
script, which is the half that bites, and `fli check`'s **`drive-preamble`**
(error) grades every step against the directory that would have to run it.

**The order is the content and grouping is dropped.** The cell is ordered prose
— *`db:seed`, then `api` + `web`* — and `+` means *these may run at once*.
Running them in sequence instead loses only concurrency nobody asked for, and
two rows say `api` + `build:site` where the second genuinely needs the first, so
a parser that honored the `+` would race them.

**The sequence is on the page, not on the server.** Each step lights up as it
goes, so *the API is still coming up* and *the API failed to start* are
different things to look at — and the server stays a set of verbs, which is what
keeps a start an ID and never a command. A step already answering is **skipped**,
which is what makes this the only start button a drive needs.

Two things fell out of it. `tasks()` read the workspace root's `package.json`
alone, so `db:seed` and `build:site` — what most drives begin with — **were not
rows at all**, and the one thing a start button may be handed did not exist for
them; it now reads the workspace and its apps, with a script already claimed by
a surface or a drive left to that kind, so one script is one row. And the walk
refuses a step the table names that its directory does not declare, by name:
without that it POSTs a null id and the person reads `no runnable called null`.


## 2026-08-29 — the dashboard answers *what proves this change*

1235 tests + 35 browser assertions, 0 fail. `IDEAS/proof-map.md` step 4, which
is `IDEAS/shipped/control-surface.md` §10.3.

`GET /api/proves` and a panel above the tiles. Every answer resolved to a
runnable row renders as the same start button the tile below it carries, which
is the whole reason the map ends up on this page rather than staying a printout.
A target that resolved to something else says which — a script to copy, a file
to read, or `gone`, the finding `proof-target` exists for, on screen where
somebody is about to take the advice.

**Three decisions, none of them in the paper.**

**The endpoint takes no parameter.** `fli proves --from <ref>` takes a ref
because the person typing it chose it; a ref arriving over HTTP is
caller-supplied text on a git command line. So the panel is the working tree,
`execFileSync` with a fixed argv, and there is nothing to validate because there
is nothing to send.

**It is not polled.** A port's state goes stale while nobody is typing and a
diff cannot, so this is read once per dashboard load and on a button — and the
button re-runs git, because a refresh answering a cached read is a broken
refresh.

**A clean tree hides the panel; an uncovered change does not.** *Nothing
changed* on every page load is a panel people learn to skip. *These files
changed and no row covers them* is the one thing this panel reports that nothing
else does.

Also: git answers paths from the repository root, which is the project root only
when the two are the same directory. A project one level down was matching
against paths carrying a prefix its own table never writes — nothing, or worse,
the wrong row. The endpoint rebases onto the project, and `test/server.test.js`
runs that branch by default, because its `projectRoot` is `packages/cli`.


## 2026-08-29 — `fli proves` — the change-to-drive table becomes something that runs

1231 tests, 0 fail. `IDEAS/proof-map.md`, steps 1–3.

`CLAUDE.md` § *Which drive proves a change* is thirty-six rows of the most
expensive knowledge in this repository — each paid for once, usually by a defect
that got through — and it was prose. Nothing read it at the moment somebody had
just changed sierra's router, and nothing checked it, so a row naming a drive
that has been renamed was indistinguishable from a row that is right.

`core/proofs.js` resolves both columns. `run` becomes runnable ids, graded `row`
(pressable) · `script` (a real script that is not a row — `sierra`'s
`test:widgets`) · `file` (a test file, with NO command, because the runner
differs per package and guessing `bun test` for a vitest package is worse than
silence) · `unknown`. `changed` becomes a matcher over a diff, graded `path` ·
`area` · `symbol` · `package`, and **the tier travels with the answer** so a
weak match reads as a weak one.

**The `area` tier is what made it usable.** Four rows name sierra, so a package
match answered *run everything*; the narrowing was already in the rows —
`sierra prerender/islands/static-safety` against `src/build/prerender.js` — so
it is read rather than declared. On a 139-file tree that moved 13 package
matches to 1 path, 3 area and 6 symbol.

**Two rules grade the table itself, and this is the half that paid first.**
`proof-target` (error) — a row naming a drive that is gone. `proof-drive-named`
(warn) — a drive no row names. The first run: zero unresolvable targets, and
**seven drives of twenty-eight that no row named**, `verify:catalog` and
`verify:tenants` among them, so nobody changing a `File` column or tenancy was
being told to run either. Six rows were written to close them.

**It is not a build graph and must not become one.** `nx affected` and Tilt
derive what to rebuild from what imports what; half these rows are not import
edges at all, and the moment edges are inferred, the rows that are statements
about what a drive can SEE become exceptions to a mechanism rather than the
content.

**`findApps` moved to `core/runnables.js`**, where the other tree readers live —
it had to, because the rules now read the runnable list and two modules importing
each other is a cycle. `checks.js` re-exports it. And `repo-map.js` reads the
proof table through the new parser rather than its own copy: the rendered model
is identical, asserted against the old implementation over the same tree.

**Two small things found while wiring the command.** `context.wsRoot()` is
ASYNC, and an unawaited one reaches `execSync` as a cwd — which fails with a
message about a type, three steps from the cause. And a command's `<script>`
must not import `resolve`: the compiled shim imports `zx/globals`, so it is
already in scope and the redeclaration is a parse error at run time.

## 2026-08-26 — `fli deploy:revert`, and phase 1 of the Release realm is complete

Phase 1f. It reads the journal, restores the pair (Release, Generation), and
refuses by name when it cannot. `core/revert.js` holds the decisions; the swap is
journaled as a `kind: 'revert'` transition of its own.

**The refusals are the feature, and there are six.** The design record predicted
two. A rollback that puts the previous image back and says nothing is what every
other tool ships, and it is wrong in exactly the situations somebody reaches for
it:

    pivot          a deploy since then crossed it            --past-pivot
    retention      it stopped being a target, with the date  --past-retention
    bindings       restores the code and NOT the config      --onto-current-bindings
    no-image       nothing recorded which bytes it ran       no override
    in-flight      a transition is still open                no override
    nothing-prior  this is the first release                 no override

**All of them are reported, never just the first.** An operator deciding whether
to force needs the whole picture; a checker that stops at the first makes them
discover the rest one flag at a time, mid-incident. The three with no flag say so
on the line — *not a judgement call* — rather than leaving it to be found.

**`bindings` is a refusal rather than a fix**, and that is the one the record
under-specified. Serving state is the pair, and `fli` writes no `.env` on a
target — the operator owns that file. So once the generation has moved a revert
genuinely cannot restore the pair; it can only put old code onto today's
configuration, which is the documented Fly failure the generation counter exists
to refuse. `--onto-current-bindings` is the operator saying a different sentence
on purpose, and the journal records which sentence happened.

**`revert` and `rollback` are both kept.** `deploy:rollback` puts the previous
image back with no journal and no questions, and works on a target that has never
deployed through one. `deploy:revert` restores the pair. The second never
silently becomes the first: with no journal it says so and names the other
command, because that degrade is precisely the behavior this phase exists to
replace.

**Two extractions, for one reason.** `swapContainer` and `healthOrRestore` moved
into `deploy/_module.md` and now have two callers each. The going-back path is
the one nobody exercises until the day it matters, so `_steps-revert` calls the
same functions `_steps-docker` does rather than a copy that would be discovered
to have drifted at the worst possible moment.

**The build output is JSON now.** A revert finds its image in the `04-build-api`
output of the transition that put that release into service — the consequence 1e
predicted, since the digest is not a term of the Release under build-on-target. A
row an older `fli` wrote as prose is reported as unreadable rather than scraped: a
revert that ran the wrong bytes is the worst outcome available here.

38 tests. What is still owed is the same debt 1e left — the `deploy` CI phase
gaining deploy → deploy → kill → rerun → revert, which is the stated proof for
both steps.

## 2026-08-29 — `fli dev` refused on ports it was never going to bind

The preflight asked `appPorts()`, which answers **every surface directory that
exists** (Invariant 3). What `fli dev` then runs is the app's own `dev` script.
Those are the same set in a scaffolded app — `fli new` composes every surface
into one `dev`, so the question never comes up — and they are not the same set
in any app in this repo. `example` has five surfaces and a `dev` of
`bun run api & bun run web & wait`.

So a storefront left running on 8610 refused `fli dev` with:

```
  Port already in use:

    8610  site  (bun run dev:site)
```

naming a port nothing the command was about to start would have taken. The
refusal is unactionable in the worst way: it is *correct* that something is on
8610, and stopping it changes nothing about whether `bun run dev` can run.

`devPorts()` is the fix, and it is a second function rather than a change to the
first, because both questions are real: `runnables.js` wants the catalog, and
the preflight wants what this command binds. It narrows `appPorts()` to the
surfaces the `dev` script actually runs, resolved transitively through its
`bun run` targets.

Anchored on `run`, never on a bare token that happens to name a script — `cd web
&& vite` holds a `web` that is a directory, and an app whose web surface script
is also `web` would match it and reintroduce the bug. A surface matches on
**either** spelling (`api` or `dev:api`), not just the one `appPorts` chose to
print, since an app may declare both and run the other.

**A `dev` that runs no other script is not narrowed**, and that is deliberate:
`fli new` writes `dev` as the surface command itself when there is one surface,
so there is nothing to walk and every surface the app has is one it starts.
Narrowing to nothing there would skip the only check worth making.

Nine cases in `test/ports.test.js`, including the cycle, the indirection, and
the `cd web` false positive. `FJS-568`.

## 2026-08-26 — the deploy journal executes

Phase 1e of `IDEAS/release-transitions.md`. 1d built the rows and printed them;
these write them, on the target, as the deploy runs. `core/journal.js` and
`core/journal-runner.mjs`, opened by `_steps-docker/01c-journal`, settled by
`09-cleanup`, read by `fli deploy:journal`.

**No new dependency, and measuring the target is what settled it.** This step was
expected to force `packages/cli` to depend on litestone. A deploy target has
docker, nginx, git, **bun**, rsync and sqlite3 — `deploy:setup` installs them —
and `02-pull` leaves a git checkout with **no `node_modules`**, because the build
happens inside Docker. So litestone cannot be imported there. It does not need to
be: the schema stays `db/deploy.lite`, its DDL is now a committed snapshot
(`litestone ddl --schema deploy.lite`), and what ships is that file plus a runner
whose only import is `bun:sqlite`. The `snapshots` CI phase found the new DDL and
began checking it with no CI edit at all.

**The brain is local and the runner is dumb.** Every statement and every verdict
is a pure function in `core/journal.js`; the shipped file binds parameters and
returns rows and decides nothing — the same split `@frontierjs/outpost` makes
with `createDocker({ run })`, and for the same reason. It is also what lets the
suite drive the REAL runner against a temp database rather than asserting SQL as
strings against the author's memory of SQLite.

**Eleven step files became journal rows without being edited.** The hook is on
the step RUNNER: `core/runtime.js` calls `config.journal?.beforeStep/afterStep`
around every step of any command that installs one, and knows nothing about
deploys. A twelfth step is journaled for free.

Three things it decided:

**The recorded Release carries no digest, and must not.** The id is
content-addressed on the digest and these bytes do not exist until step 04 —
minting around one that arrives later would change the id halfway through the
transition it names, so a resume would compute a different id and open a second
row. What step 04 built is that step's output instead. The consequence is worth
stating plainly: resume works BECAUSE the id does not depend on a rebuild being
reproducible, which a build on the target cannot promise. That is a sharper
argument for `2.3f`'s second half than the roadmap made.

**`serving` is the last transition that SUCCEEDED**, not the last transition. A
failed deploy leaves the previous release up. `09-cleanup` settles on both paths
for the mirror reason — an aborted deploy leaves `failed`, not a `running` row
the next run reads as a crash worth resuming.

**`attempt` is answered** — the term `--plan` could only mark provisional.
Counted off the rows by COLUMNS, because the number is inside the id, so asking
by id could only find the attempt you already guessed.

Refusals rather than reconciliation throughout: a journal belonging to another
app or another host, a format written by a newer `fli`, and a precondition that
moved between planning and running each stop the deploy by name. The two answers
came from two intents and picking one is a guess about which person was right.

45 tests, 19 of them against a real SQLite file through the shipped runner.

## 2026-08-29 — `fli check` grades a doc against what the package ships

Two repo-scope rules, `docs-index` and `roadmap-shipped`, both warnings. The
register rules already cover a register that contradicts itself; nothing covered
a page that is merely out of date, which is the same silence one layer over and
is what actually cost a session a day.

**What it cost.** `packages/litestone/docs/roadmap.md` carried *Exact numbers —
`@scale(n)`, then `@money`* under **High priority**, opening *there is no
fixed-point numeric type*, four days after `FJS-D142` ruled and built it.
`docs/README.md` described that roadmap as *what's coming: `@scale`/`@money`*.
And `exact-numbers.md` — the page that answers the question — was linked from
nothing. Three signposts on the path a reader takes, all wrong. A session read
them, concluded `.lite` could not express money, and filed a defect against the
ruling (`FJS-560`). Two more roadmap entries were stale the same way (`@type`,
and half of `@slug`) and two more pages were unindexed (`json-types.md`,
`traits.md`).

**`docs-index`** — every `.md` beside a `docs/README.md` must be LINKED from it,
not merely mentioned: the failure is a page nothing navigates to, and prose
citing a filename does not. A `docs/` with no index is skipped until it holds
four pages, because a directory of one file is not lying to anyone.

**`roadmap-shipped`** — a roadmap section whose fenced sample uses an attribute
`catalog.snapshot.md` already carries. It asks the generated catalog rather
than carrying a list, for the reason the rule exists: a list here would rot the
way the roadmap did. Scoped to fenced code, because a paragraph may legitimately
cite a shipped attribute in an argument while a sample demonstrating one is
proposing it. Two quieteners, both derived rather than declared — **scaffolding
comes out of the file itself** (an attribute in two sections' samples is holding
them up rather than being their subject, which is `@id` in every `model` block,
and without it the `Embedding` and `LatLng` entries both fired on it), and a
heading carrying `~~`, `SHIPS` or `SHIPPED` has already answered, since an entry
may legitimately propose the unbuilt HALF of something that ships.

Both were run against the tree before the docs were fixed and fire on exactly
the three stale sections; after, the file is silent and a restored section still
fires. `docs-index`'s other finding was real: `packages/basecamp/docs` held four
pages and no index.

## 2026-08-28 — a generated create page and a generated edit page stop carrying a form each

1144 tests, 0 fail. `FJS-559`.

The Resource's markup half is the model's default form (Invariant 18,
`FJS-D112`), and `core/resource-template.js` has emitted one since it existed —
its own header tells a create page it can be `<Model />` and nothing else. It
could not be. The wrapper was `<Form ...><slot /></Form>` with **no button
anywhere**, so that page put five controls on screen and no way to send them,
and a page reaching for `<Model><Button slot="actions">` did not fix it: that
names a slot on the wrapper, which forwarded none, so the button was swallowed
in silence. Measured in a browser, both shapes, before anything changed.

Meanwhile `core/crud-templates.js` — written first — went on emitting its own
`<Form {resource}>` on the create page **and** on the edit page. That is the
form written twice in the two files most likely to drift, inside the module that
exists because those two commands had already drifted once.

**The wrapper now carries the button row**, because a form with no submit is not
a form. What a PAGE knows is the wording, where Cancel goes and where a save
lands, so those are props — `submitLabel`, `cancelHref`, `oncancel`, `submitId`,
plus `record` and `method`. Everything else rides `$attributes` onto `<Form>`,
which is where `ondone`, `onerror`, `showError`, `class` and `style` are
declared. A page needing an entirely different row — the edit page, which puts
Delete beside Save — passes an `actions` snippet, forwarded explicitly, because
`<Form>` checks the `actions` prop before its own slot.

**Both pages render `<Model />`.** The create page states `method="create"` and
where to go afterwards; the edit page states nothing but its button row. Neither
names a field, and now neither names a form.

Proven by scaffolding the real generator output into `example` and opening both
pages in Chrome: create renders five schema-derived controls with *Create
Product* and a Cancel link, edit renders the same five over a loaded record with
Save and Delete. Two tests in `make-resource.test.js` replaced — the old pair
pinned `auto={!$slots.default}` and `<slot />`, the mechanism that produced the
buttonless form.

## 2026-08-27 — `project:view` says whether the app it maps is running

1112 tests + 21 browser assertions, 0 fail. `IDEAS/shipped/control-surface.md` step 6,
which completes the paper's build list.

The viewer is read off FILES, so it drew a complete chain of responsibility for
an app that is not started and looked identical either way. It carries a live
badge now — the app's surfaces and their state, polled, with the ports in the
title because a person reading that map is about to go and open one.

**Answered by the command's own server, not fetched from the app.** A browser
reaching `localhost:8110/api/health` from the viewer's origin is a cross-origin
request the app has no reason to allow, and a CORS failure would read as *the
app is down*.

**One owner for the probe.** `probeState(rows, { childOf })` moved into
`core/runnables.js` and both servers call it — the GUI's `/api/state` and
`project:view`'s `/state` — so there is one answer to *is it answering* rather
than two that can disagree. It takes rows rather than a root, and the child
lookup is passed in, because `project:view` starts nothing and must not import
a table of processes to ask whether an app is up.

**The badge is the app's own surfaces and not the tooling block.** `fli gui`
being up is not a fact about the app this page maps, and putting it in the badge
would make the badge mean two things.

**The tools group needed no work, which was the point.** It has been derived
from `ports.js` § GLOBAL since the inventory shipped, and the test says so the
only way that claim can be made: a slot added to that object becomes a tile with
nothing edited in `runnables.js`, answering `start: null` because no command
declares that port. `FJS-557` stays open and is visible on the page — studio's
tile has no start command because its command defaults to 5001 while the schema
reserves 8502.

**`test/pview-state.test.js` boots the real command**, because the thing under
test is the WIRING — that the route exists, that it resolves `runnables.js` from
`fliRoot`, and that its shape is the one the badge reads. Each of those is fine
in isolation and can still be absent from the command file. It spawns, so it is
careful with what this week taught: a test-tier port, a bounded wait, and a kill
of the process GROUP.

## 2026-08-27 — the dashboard starts a row, and refuses to stop one it did not start

1107 tests + 21 browser assertions, 0 fail. `IDEAS/shipped/control-surface.md` step 5.

`core/children.js` is the table: `POST /api/start/:id`, `POST /api/stop/:id`,
`GET /api/output/:id`, and a kill on the way out.

**The caller sends an ID and never a command.** What runs comes from the
inventory, which comes from a file in the tree — so a request can choose among
the project's own declared commands and cannot name one of its own. Every row
carries `argv` rather than a string to be re-split, so there is no shell and no
parser between the file and the spawn; two runners are allowed, `bun` and `fli`,
and `fli` is rewritten to this package's own `bin/fli.js` because a globally
installed one of a different vintage driving this tree is the drift a pin
removes. Anything else is refused BY NAME with the line to type, which is the
honest answer for a snapshot generator: those resolve through their own package,
they are one-shot, and `fli test:snapshots` already runs the set.

**The stop refusal is the design.** This server stops what it started and says
so about anything else — *started elsewhere* on the row, and a 409 naming why
from the route. A page that offered otherwise is a button that kills a process
somebody else is depending on.

**A child is its own process group, and that is not a detail.** Every command
here is a launcher — `bun run api` is bun running a script that spawns the app —
so signaling the pid kills the wrapper and leaves what it started running. It
was measured the expensive way: the first cut of the HTTP test started the first
`bun` task it found, which in this package is `bun run test`, and the suite ran
itself; stopping it reported success and left a tree of suites forking until
they were killed by hand. For a server the same shape is quieter and worse —
stop answers 200 and the port keeps answering. `detached: true` and a `-pid`
kill, with a fallback to the child alone for a spawn that has no group.

**A child that dies is remembered as exited**, with the code and the last 60
lines, because a row that goes back to *not running* reads as never having
started — a server that dies two seconds after you press start is exactly the
silent failure this surface exists to reduce.

**Two things the work found and fixed.** Snapshot rows were joining `dir` to a
`file` that is already a path from the root, so every snapshot id and source
named `example/db/example/db/access.snapshot.md` — a path that resolves to
nothing, which reads as a snapshot that has gone missing. The fixture-based test
could not see it, because a fixture tree has no snapshots and no packages; there
is a real-tree case now. And the browser drive's own assertions were twice about
the ENVIRONMENT rather than the rule — *no open links are offered* and *the gui
tool reads as down* both failed on a machine with things running on it. They
assert the rule now.

## 2026-08-27 — the GUI's front page is a dashboard of what can run

1089 tests + a browser drive, 0 fail. `IDEAS/shipped/control-surface.md` steps 3 and 4.

`fli gui`'s front page was an empty state saying *select a command*. It is now
the answer to the question this whole paper is about — what can I start here,
and what is already up — because the complaint is that there are too many things
to keep track of and a fifth server on a fifth port would make it one worse.

**Two endpoints with two lifetimes.** `GET /api/runnables` is the inventory, a
tree walk cached on the same TTL the command registry already uses; `GET
/api/state` is the probe, polled every three seconds while the page is on
screen. They are apart because only one of them misleads when stale: a stale
inventory shows a row that has been renamed, a stale state shows a server that
is down as up. A poll rather than SSE, because there is no event to push — a
port somebody else bound is a question somebody has to ask — and the tick is
printed, since a reading with no time on it cannot be told from a live one.

**Four states and `unknown` is one of them.** A row with no port cannot be
probed, and *nothing here can tell* is a different sentence from *not running*;
collapsing them makes every drive and every suite read as stopped.
`claimed-dead` is a lock claim over a port nothing answers, which is the failure
the lock file already exists for.

**The page shows and opens; it does not start.** A row hands over the command to
type. Starting one is a separate step with a process table behind it, and an
open link is offered only where a row is answering — a link to a port nothing is
listening on is a browser error page wearing this page's name.

**It composes the design system rather than styling itself** — `.surface`,
`.rows divided`, `.list-row`, `.row-actions`, `.badge`, read out of
`@frontierjs/css`'s `vocabulary.json` and its `anatomy` block rather than
guessed, since a class nothing defines is markup that looks styled and is not.

**`bun run test:browser` is this package's first browser drive**, over mesa's
CDP harness by relative path, the way `@frontierjs/ui`'s drive reads it. Ten
assertions, two mutation-checked. The page had never been rendered by anything —
`test/server.test.js` covered the API under it — and a dashboard is the worst
thing to leave that way, because a row that renders as nothing looks exactly
like a project with nothing in it. **Its first run corrected an assertion rather
than the page**: *no open links are offered* expected zero and found two, which
were `example`'s api and web genuinely running on this machine. It asserts the
RULE now — open is offered exactly where a row is answering — which is the half
that survives a developer having things up.

## 2026-08-27 — `core/runnables.js` — what can run in this project, one flat list

1083 tests, 0 fail. The inventory half of `IDEAS/shipped/control-surface.md`, step 1.

92 rows on this workspace — 9 surfaces, 4 tools, 28 drives, 21 suites, 6 tasks,
24 snapshots — each `{ kind, id, name, dir, start, port, open, needs, source }`.
`source` is not decoration: it is `repo-map.js`'s own rule made checkable, so a
wrong row is traceable to the file that produced it rather than to this module.

**It is a factoring and the proof is byte equality.** `SKIP`, `safeRead`,
`isDir`, `readJson`, `appDirs`, the drive scan and the command reader moved here
and `repo-map.js` imports them — 5 insertions against 67 deletions — and the
rendered map is byte-identical to the one the old file produced over the same
tree. Two answers to *where could an app be* is how one of them starts missing a
directory nobody notices.

**Which command starts a reserved tool is derived, not listed** — a command's
own `port` flag default matched against `ports.js` § GLOBAL. A hand-written
name→command table would be the one list in the module that could go stale, and
the derivation has a second virtue: a slot no command claims answers `null`
rather than a plausible guess. Junction's devtools is honestly one of those (an
APP configures it), and studio is the other — its command defaults to 5001 while
the schema reserves 8502, which is `FJS-557`, found by this.

**The command tree is read from a ROOT rather than through the registry**, which
resolves its directories off `global.fliRoot`. A module that may run before
install cannot depend on a global somebody else set.

Two things are deliberately not rows and the reasons are in the header: commands
(the GUI's sidebar already answers them off the registry, and a second list of
the same 236 things is what this module exists against) and CI phases
(`scripts/ci.mjs` has no per-phase flag, so a phase tile could only ever run all
twelve — the runnable is `bun run ci`, which is a task).

## 2026-08-27 — a tsconfig for the surfaces the app actually has

`appTsconfig` wrote `paths: { '@/*': ['./web/src/*'] }` and included
`api/**/*` and `web/**/*`, whatever else the scaffold had been asked for. A
`fli new --site` or `--widgets` app got an `@` pointing at a `web/` it does not
have and a tsconfig that did not include the code it does.

It takes every surface flag now and lists them in a fixed order, first match
wins. That is exact for an app with one UI surface and a **guess** for an app
with two, and the guess is stated rather than hidden: `@` is the surface's own
`src/` because Sierra resolves it per Vite root, and tsc has one program and no
notion of a root. It costs nothing — `checkJs` is off and tsc cannot read a
`.mesa` at all — and the alternative is a tsconfig per surface, four programs to
check what is one app.

## css-token-undefined — a styled value names a token the stylesheets define

The thirty-second rule, and the first one about CSS. A `var(--x)` naming a token
nothing declares is invalid at computed-value time, so the browser drops the
**declaration** rather than the value — `gap: var(--space-4)` is no gap, not a
wrong one. Nothing reports it: the stylesheet is in the bundle, every selector
matches, and a browser drive asserts what a page says. `example/site/` shipped
its entire public storefront with no gap, border or radius anywhere while
`verify:site` stayed green at 39/39 (`FJS-545`).

The token table is read off the app's own dependencies — any package whose
`exports` names a `.css` — for `package-model-drift`'s reason: the answer is a
property of what is installed, and a list written into the rule goes stale the
first time a package adds a rung, while an app on a design system this file has
never heard of would be graded against one it does not have.

**Only the bare form is a finding.** `var(--knob, var(--color-primary))` is an
author saying the token may be absent, and is what a component's own knob looks
like from outside; nothing is dropped, so nothing is reported. That single line
is what separates the defect from the idiom, and it is why the rule can be an
error rather than a warning.

## 2026-08-26 — `--plan`: the journal rows, printed instead of inserted

Phase 1d of `IDEAS/release-transitions.md`. `fli deploy:plan` and `fli deploy
--plan` build the rows `db/deploy.lite` would receive — one `Transition` and one
`TransitionStep` per step — and print them. Nothing is written, no server is
reached, and it exits 0 whatever the pivot says: a plan is a document, so there
is nothing for it to refuse.

It is the same object either way. The model carries the plan on the transition
itself, so the document a person read and the record a deploy wrote cannot be
two things that disagree — `core/plan.js` builds them and 1e will insert what 1d
prints.

**The steps are read, not listed.** They come from `_steps-docker/` with the
runner's own filter and sort, and each `skip:` predicate is evaluated the way the
runner evaluates it — including its fail-open direction, so a predicate that
throws is reported as *it will RUN* rather than silently removed from the plan. A
step added to the pipeline appears here with nobody editing the command. A
skipped step is shown rather than dropped: an operator needs *the backup did not
run* to be visible, and the ordinals have to stay stable so a resumed transition
can find where it stopped even after a `skip:` has changed its answer.

**The transition id, and the one term a plan cannot answer.**

    deploy:shop:production:none:a1b2c3d4e5f6:1:1
     kind  app  environment  from  to  generation  attempt

`from → to` is what lets a crashed deploy resume — rerunning computes the same id
and finds the same row — while keeping R1→R2 and R2→R1 apart. `generation` is
there because a rotated secret is a new intent, not a replay. `attempt` is the
journal's count of prior transitions for that pair, and **a plan has no journal
to count**, so it says `1` and labels the id provisional. The case it exists for
is deploy R2 → revert to R1 → deploy R2 again: every other term is identical to
the first attempt, so without a counter the third operation resumes a transition
already marked `succeeded` and leaves R1 serving. Surfacing that before 1e writes
a row under it is what `--plan` is for.

Also here: the duplicate-prefix warning now matches `\d+[a-z]*` rather than
`\d+`, so `01b-env-check` beside `01-preflight` is no longer reported. A lettered
step is the deliberate way to insert one without renumbering the rest, and a
warning that fires on every correct use is how everyone learns to ignore it.

46 tests, pure.

## 2026-08-26 — the build check: can this image be promoted, or only deployed?

Phase 1c of `IDEAS/release-transitions.md`, and the half `core/image.js` left
open. That module made a deploy able to say WHICH bytes it ran. This is whether
those bytes mean anything in a second environment — invariant 1 of the Release
design: one artefact moves from staging to production unchanged, and only its
bindings differ.

A build that bakes configuration into the image breaks that silently. The result
still builds, still starts, still answers health, and still reports a digest. It
is simply a different digest per environment, and nothing says so. Measured, on
two contexts identical except for a `.env.production`:

    stage       sha256:dfa9655f267c02…    DIFFERENT — configuration is in the digest
    production  sha256:32ab9ba5e266f8…

and the negative control, the same two trees with `.env*` ignored:

    stage       sha256:fa3ecac547cb08…    IDENTICAL — one artefact serves both
    production  sha256:fa3ecac547cb08…

`core/build-check.js` grades four things: a value file the build copies, an `ENV`
line holding a value the environment is meant to supply, a build `ARG` naming a
credential (measured: one `--build-arg` left the value in two `docker history`
lines), and an unpinned base image. The base is graded twice — no tag or
`:latest` refuses, a version tag warns — because `oven/bun:1` is what this
package's own `make:deploy` writes, and a check that refuses its own scaffold is
a default whose first use is red.

**The first version of the context rule was wrong, and measuring is what caught
it.** Grading a file as baked the moment a context COPY reached it refused every
multi-stage build in this repo: two trees whose `.env` differed, copied wholesale
into a build stage whose runtime stage takes only `dist/`, produce a
byte-IDENTICAL final image. The question is therefore not *did a COPY reach it*
but *does it reach the FINAL image*, which is a walk across stages —
`COPY --from=build /app /app` ships what `COPY --from=build /app/site/dist ./dist`
does not, and both forms are here. The intermediate case is a warning rather than
silence, because the value does sit in a layer on the build host, readable with
`docker build --target build`. The trace was then graded against the daemon on
four shapes and two files at two depths: 8 of 8 agreed, and those eight are the
fixtures in `test/build-check.test.js`.

**It is not a `fli check` rule**, which is what the design record proposed. That
surface reads the app's own tree, and the file most likely to be baked is the one
deliberately in no repository: `.env.production` sits at the deploy root, which
IS the build context. So `_steps-docker/02b-build-check` reads the server, after
`02-pull` — before the pull the server's Dockerfile is the previous release's —
and refuses. `deploy:local` reports instead, because that command answers *does
this build and start at all*; `deploy:doctor` asks without deploying anything.
`deploy.api.buildCheck = false` opts out, beside the `envCheck` already there.

It found a live one on its first run. Docker's `*` does not cross a separator, so
basecamp's `db/*.db` excluded `db/basecamp.db` and admitted `db/db/basecamp.db` —
and `db/db/` is precisely what a relative `database { path }` resolved against the
wrong working directory creates (`FJS-449`), git-ignored and therefore in no
diff. `COPY db ./db` then `COPY --from=build /app /app` put it in the image.
Pattern fixed, `FJS-555` filed for the rest.

The suite is pure — no daemon, no network, no fixtures on disk — because a check
that needs Docker is a check that stops running. 66 tests.

## 2026-08-26 — `service-as-system` reads all of `services/`, not just `*.service.*`

A filename filter made two real sites invisible. A helper module beside a service
runs in the same call scope and carries the identical hazard — basecamp's
`api-keys/scopes.ts` reaches for the app-level client from inside a hook, and
`jobs/job-schedule.ts` does it at boot — and neither is a `*.service.ts`, so the
rule had never looked at them.

The DIRECTORY is the principled boundary rather than the filename: anything under
`services/` runs inside a call, and a job handler lives in `jobs/`, is not inside
one, and is exactly where the app-level client is the right reach. Both newly
visible sites turn out to be correct and now carry named allowances saying why,
which is the point — an invisible site is not a decision anybody made.


## 2026-08-26 — `fli check`: `capability-ladder`

A model that declares `@@capabilities` and still grades its writes by ladder. The grid
and the gate are ANDed with the gate as the floor (`FJS-D146`), so a write level above
the read level is the ladder answering what the grid was declared to answer — and both
have to pass, so every grant is silently narrowed. The shape it catches is a model
moved onto capabilities with its old gate left in place: a billing clerk holding
`Invoice.create` refused because creates want ADMINISTRATOR(5), which reads as *not
senior enough* about somebody deliberately granted the capability.

**It reads both gate spellings.** Matching only `@@gate("2.5.5.6")` would have made
the rule silent on every schema that writes its levels by name — which is the form
`example` and `basecamp` both use, so it would have been dead exactly where it
matters. `write:` widens to create/update/delete and `all:` to every position, the
same way the parser treats them.

A warning rather than an error — two authorities in front of one operation is
legitimate where the ladder guards something the grid does not model, and a text scan
cannot tell that from a leftover. `@@gate("2")` flat at the read floor is the usual
answer. The clean fixture now declares the grid with a flat gate so the rule RUNS there
rather than skipping.


## 2026-08-26 — digest, not tag: a deploy can say which bytes it ran

`2.3f`'s first step (`IDEAS/deploy-plane.md`). The pipeline builds on the target
and names the result `${appId}:${shortSha}` from the SHA of that server's own
checkout, so **two servers at one commit hold two images with the same name and
different bytes**, a rebuild after a dependency change produces a third, and
nothing compared them. The failure shape was the worst available: stage and
production reporting one version while running different code.

**Docker has two digests and they do not reach equally far**, which is the whole
substance of `core/image.js`. `RepoDigests` is the registry digest and means the
same bytes anywhere, but exists only once an image has been pushed or pulled;
`Id` is the config hash and always exists, and identifies bytes on **one host**.
A build-on-target pipeline has no registry, so `Id` is what there is — and
reporting it as though it were the other is how the problem comes back wearing a
fix. So the scope is in the sentence: *these bytes on this host; no registry to
compare across*. Same line `@frontierjs/outpost` draws about building on the
target — an answer that is true while there is one machine and stops being true
at the second.

**Step 04 asks the image what it is and step 06 runs that**, falling back to the
tag only when nothing could be read and saying so when it does. **Rollback got
the sharper end**: it listed images by `Repository:Tag` and took the second row,
so it rolled back to a NAME — and two tags can point at one image, from a
rebuild that produced identical layers or a moved tag. The list carries `{{.ID}}`
now, the container is addressed by it, and a rollback whose target is the same
image is refused by name: *both tags name the SAME image — this rollback would
change nothing*.

`imageIdentity` answers `null` rather than guessing, because the entire point is
that two things which look alike are not.

## 2026-08-26 — `fli release:mint`: a Release is computed, and nothing is deployed

Phase 1b of `IDEAS/release-transitions.md`. `core/release.js` computes a Release
from four terms — the image digest, a hash over the resolved bindings, a hash of
the committed release surface, and litestone's pivot verdict — and the id is the
hash of those and of nothing else.

**That the id is a pure function is the whole point, not a property of the
step.** Two mints of an unchanged tree answer the same id, proved against
basecamp: `2997a04e6063` twice. *Build once, promote a digest* is only a sentence
you can say if the thing being promoted has a name that does not depend on who
computed it.

**The environment is deliberately NOT in the id.** One artefact promotes from
staging to production unchanged and only its bindings differ, so the environment
is on the row and the bindings are in the hash. If that ever flips, promotion
becomes a rebuild — which is why it is a test rather than a comment.

**The schema term is the committed `release.snapshot.md`, hashed rather than
re-derived.** It is exactly what `fli release:check` classifies and what the
`snapshots` CI phase already fails a stale one of, so re-deriving it here would
be a second answer to *what is the data boundary of this release* that could
disagree with the first.

**Bindings are declared in the deploy block, values and secret REFERENCES kept
apart** — `deploy.bindings` and `deploy.secrets`, per-target beating app-wide. Two
keys rather than one bag because the rule is not a convention to remember: a
value is in the repository and a reference points at something that is not. An
unpinned reference is refused by name, because a secret is resolved when a
process starts and `latest` means two instances of one immutable Release hold
two different values.

The digest is usually absent and says so rather than showing a tag: `fli deploy`
builds on the target, so `${app}:${sha}` names different bytes on different
hosts. `2.3f` supplies it.

Writing it turned up `FJS-537` — `context.exec({ capture: true })` is not an
option, so four auth commands parse an empty string and print `Failed` directly
beneath the output they meant to read. `release:mint` reached for the same
option because four neighbors use it, which is how a wrong idiom spreads.

## 2026-08-26 — `register:check` catches a register that stopped counting, and `detail-read-dead` names its own limit

**`closed-in-open`.** A row carrying `status: closed` while still sitting in an
open severity table is counted as open by everything that reads the register —
its own tally, `ws:map`, `ws:atlas`, and whoever is choosing what to work on.
Sixteen had accumulated in this repo, one of them the only S1 (fixed two days
earlier). `closed` is in `ISSUE_STATUS` because the READER synthesizes it for
every row under § Closed, which is exactly what made it silently legal as a
hand-written cell where it means the opposite.

Its own rule rather than an `unknown-status`, because the remedy is not *you
wrote a bad word*: the row is correct and it is in the wrong place. It is the
direction `ISSUES.md`'s own Conventions section already names — *the register
also goes stale in the closing direction, which nothing here was watching for*.

**`detail-read-dead` now says when its advice applies.** It told every reader of
`service.get(id)` to watch the row instead, unconditionally. A store node holds
one shape and a push REPLACES it, so that is only correct where the detail row IS
the row: four of basecamp's composed reads (`include:`, a `withWidgets()`, an
adapter ping that answers no row at all) lose their children at the first
announcement, silently. Measured — adopting it on `apps/[id]` took that app's
drive from 302/302 to two failures. The message names the condition and says the
reload-on-push those screens hand-roll is a fair exception.


## 2026-08-26 — `db/deploy.lite`: what a Release is, before anything deploys one

The first step of the Release realm's phase 1 (`IDEAS/release-transitions.md`),
and it writes nothing and deploys nothing. Five models — `Journal`, `Release`,
`BindingSet`, `Transition`, `TransitionStep` — carrying every field including
the ones nothing fills yet: `audienceKey`, `retentionUntil`, `formatVersion`.
That is the sequencing rule the record is built on, *state shape early,
behavior late*, and the reason is that a recorded-state migration is the
expensive kind of change while an unused column is free.

**It is opened, not installed**, which is the whole of how it differs from
`junction/db/outbox.lite`. That one is pasted into an app's schema and carries
`@@db(main)`; this one is handed to `createClient({ schema, db })` with `db`
naming `deploy.db` on the target, so there is no `database` block to reference
and the same line fails to parse. Found by running it, not by reading — and it
is now asserted, because nothing in the fragment says *no `@@db` here*.

**The journal is its own client rather than a second `database` block on the
app's, and both grounds were measured.** `$locks` stores in main only, so under
a second block the deploy lock lands in the app's database while `deploy.db`
gets no `_locks` table at all — the lock cannot sit with the record it protects.
And `$backup` sweeps every declared SQLite database, which is the copy
`05-backup` takes before every deploy, so restoring it would erase the journal
recording the deploy that authorized the restore. Both are asserted as a
negative control, so the rejection fails loudly if litestone ever moves either.

Two things came out of writing it. Lock contention **throws** rather than
answering falsy — `LockNotAcquiredError`, 409, `retryable`, naming the holder,
which is already the *refuse by name* shape `fli revert` wants. And the CHECK
family turned out to be half-built (`FJS-534`): field-level `@check` works, so
`Journal`'s single-row rule IS declared — `@check("id = 'journal'")` plus the
primary key, two constraints saying one rule — while model-level `@@check`,
which would say it in one line, does not exist.

## 2026-08-26 — `detail-read-dead`: a row a screen KEEPS is watched, not fetched once

`service.get(id)` answers a plain object. It is the raw proxy by design — the
same escape hatch `service.find()` is — and nothing can reach a plain object:
not a WS push, not a write from another tab, not a job. So a screen that assigns
one to state it keeps is stale from the moment somebody else writes that row,
and it looks right the whole time, because a screen usually re-reads after its
own actions and never after anyone else's. That was every detail screen in this
repo (`FJS-518`), and `resource.record(id)` is the answer (`FJS-D138`).

**The heuristic is a bare assignment**, and the negative controls are what make
it usable. `order = await …` in a Mesa script is an outer `let`: state the
component keeps. `const row = await …` is a local — a label, a check, something
handed straight on — and flagging those is how a rule gets turned off. A
comparison is not an assignment at all. `X.service.get(…)` is the whole test for
*is this a resource*: `.service` exists on nothing else and every resource has
`record()`, so there is no binding to trace and an imported resource is judged
like one made in the file.

It follows a wrapped ternary back up to three lines, because
`x = cond ? await …get(id) : null` is what every one of these screens actually
writes and matching only the line the call sits on missed them.

**A warning, and it fails open** — a screen may legitimately keep a row nothing
will ever write again. **No `--fix`**: the change is a subscribe, a release and
a lifetime, and a half-applied one is a green check over a leak.

Its first run reported **sixteen**, every one inspected and real: one in
`example` and fifteen in `basecamp`, including three dashboard widgets and the
fleet screens where the row genuinely moves mid-deploy. The screen already
converted to `record()` is silent, which is the rule's own negative control.
Seven cases in `test/checks.test.js`, and `CLEAN` grew a legitimate one-shot
read so the rule RUNS over the clean tree rather than only ever skipping.

# Changes

## 2026-08-26 — `service-as-system`, the 29th rule

`asSystem()` keeps the tenant it is standing in now (`FJS-519`), which makes
*which client you elevate* decide whether the answer is scoped at all:
`ctx.locals.db.asSystem()` crosses the gate and every policy and stays in the
caller's tenant, `app.data.asSystem()` has no principal, so no claim, so every
tenant — with a 200.

**The app-level client cannot be named positively.** It is `app.claim(<any
name>, db)`; basecamp calls it `app.data` and another app will call it something
else. So the rule tests the other direction — a receiver that is not the
request's client — which is also where the fix is. A cast does not hide it:
three of basecamp's sites are `(app.data as any).asSystem()`, read backwards
through the parens.

**A warning rather than an error**, because an unscoped system client is exactly
right for a cross-tenant admin tier. What is wrong is reaching for it by habit
inside a request, where the symptom is silent.

**It runs only under `strategy row`.** With no `tenancy` block there is no claim
to lose, and under `strategy database` one client IS one file, so a system
context cannot physically reach a second tenant — `example` is that case and is
skipped by name rather than reported at.

Writing it found the trap `fli check` blanks comments for, one file over:
basecamp's own schema explains the feature in a doc comment — *declared once in
the `tenancy { }` block below* — and an unblanked match reads that empty pair as
the declaration and skips the entire app. Seven tests. The clean fixture now
declares row tenancy so the rule RUNS there rather than skipping, which is what
the suite's own *nothing was skipped* assertion is for.

Fourteen findings on basecamp, entered as named allowances: eleven files
deferred to `FJS-519` part 2, and the hub's, which does not expire.

## 2026-08-25 — `transition-methods`, the 28th rule

A named move is written in two places that never meet — `@@transitions` in the
seed, and the code that makes the move — and both directions fail quietly
(`FJS-502`). The rule reads the schema and the whole of `api/`.

**A declared move nothing drives** is the silent half. Not an error: the machine
is still enforced, and an aspirational pipeline is a legitimate thing to have.
It reads as a feature nobody got round to, which is why it is a warning that
names the move rather than a failure. **A `transition()` naming no declared
move** is the other half, and it throws `TransitionNotFoundError` (400) the
first time somebody asks for it.

**Reachable means either spelling, and that is the whole of the accuracy.**
`transition(id, 'cancel')` and `update({ data: { status: 'cancelled' } })` are
the same move. The name-only version was written first and measured: it reports
eleven of basecamp's nineteen moves and is wrong about eight. Asking for either
reports three, and all three are real — `Deployment.push -> pushing`,
`release -> deploying` and `rollback -> rolled_back @gate(5)` are declared, the
pipeline goes pending → building → success, and three screens carry a tone for a
state that cannot occur. `example` is clean.

The two spellings are not symmetrical, and writing a test the wrong way round is
what found it: `transition()` resolves a move NAME, so `transition(id, 'closed')`
throws where `update({ status: 'closed' })` works — unless the move is unnamed,
since `pending -> paid` names itself after its target.

Ten tests. `Lead` in the checks fixture now carries a machine, because a rule
that only ever skips is what that file exists to catch.

## 2026-08-25 — `make:extension` derives its port, and writes its own ignore

Found scaffolding `example`'s `extension/` surface (`FJS-280`).

**The dev port was the literal 8400.** That is dev/ext/project-0 — right for a
fresh scaffold and wrong for every app that has a number, so two apps' extensions
could not have their dev servers up at once and jetty's reload push would reach
whichever bound first. It is derived now, from `projectIdFor` + `port('ext')`,
which is what `make:widget` beside it already did.

**The surface writes its own `.gitignore`.** `dist/` is the loaded-unpacked
artefact and `.jetty-cache/` is where the build puts the entries it generates
from what it discovered; without this every app commits a compiler's scratch
directory. Written as the surface's own file rather than merged into the app's,
because a merge has to decide what to do with a rule already there and this
cannot be wrong.


## 2026-08-24 — `package-model-drift`, and it found three things on its first run

`FJS-483`. 848 tests, 0 fail (+7). The twenty-seventh `fli check` rule, and the
first to read a DEPENDENCY's source rather than the app's.

A package that ships `.lite` reaches an app two ways and they are not the same:
some files are imported, and some are appended into the app's own schema to be
grown. `@frontierjs/auth` ships one of each — `User` is the model an app adds
columns to, `Credential` is not. So *the app declares a model a package also
declares* fires on every correct install, and the issue was filed concluding a
package needed a new way to say which file is which.

**It does not.** What is decidable is a column THE PACKAGE DECLARES, declared
differently here. Adding a column is what an app is for; adding `@@tenant(none)`
or a policy is the app's business too; changing the package's own column is the
class that costs something, and it is silent by construction — the package's code
goes on writing to a column whose declaration it no longer recognizes. No
manifest key, no language change, no parser: a line scan over a file in
`node_modules`, reached through that package's own `exports` map.

A **warning**, not an error, and both declarations are printed — a deviation can
be right, and the reader is the one who can tell. `check-baseline.json` is how an
app accepts one it has argued for.

**Its first run on basecamp found three and closed all three**, one of them in
the package rather than the app: `User.emailVerified` and `User.role` had lost
`@allow('write', auth().isAdmin)`, on a model gating update at USER(4) for *your
own row* — latent, since basecamp exposes no `users` service, and real the day a
profile screen writes through one. The third was `accountId`, where AUTH was
wrong: it shipped `Int?`, and every id that package declares is a uuid, so the
column could not hold one and the only app that reached for it had to change the
type. It ships `String?` now.

Mutation-checked both directions — never comparing, and comparing the app's
columns instead of the package's (the false-positive shape) — each turns the
suite red.


## 2026-08-24 — `test-files-run` asks for an importer, not an extension

`FJS-482`. The rule flagged a `*.test.*` file no script names, and looked past
everything else in the directory. jetty's HMR coverage was two `.mjs` harnesses
sitting in `test/` that no script ran and that could not have run — they
resolved mesa by an absolute path from another machine — and they were the only
cover for the seam `FJS-481` broke.

Widening it to every runnable extension immediately broke the case the rule
already had: *a harness beside the tests is support code, not an unrun test*.
Which is correct, and names the real signal — **support code is IMPORTED**. So a
non-`.test.` file is an orphan only when nothing runs it AND nothing beside it
imports it. Unimported and unrun is indistinguishable from dead.

That case's fixture left its stub unreferenced, so it did not model what its own
name claimed; it imports it now, and a second case covers the dead-harness shape
directly.

## 2026-08-24 — two checks that caught this package

847 tests, 86 of them new — 13 of which had been sitting on disk unrun.

**`test-files-run`** (repo scope) — a hand-listed `test` script graded against
the `*.test.*` files beside it. It found `packages/cli`'s own: **`test/pipe.test.js`
and `test/generated-mesa.test.js` were run by nothing**, and the first of those
is the file `CHANGES.md` cites as reproducing `FJS-379`. A test written to pin a
fix, never once executed, in a suite that was green every time. Both pass; both
are in the script now.

Only where the script NAMES files — `vitest`, `jest`, `node --test` and a `bun
test` pointed at a directory all walk it themselves and cannot forget one, which
is the argument for that shape rather than for this rule. A `:watch` script is
not read (it is the bare runner by nature, and reading it would make every
hand-listing package look like it discovers), and only `*.test.*` counts: a stub
or a client beside the tests is support code, named by whatever imports it.

**`test/docs.test.js` + `core/doc-commands.js`** — every `` `fli <command>` ``
named in a reference doc must resolve against the registry. `IDEAS/` is not
graded, because an idea paper names commands that deliberately do not exist;
neither are the registers or CHANGES, which are argument and history. What is
graded is what tells you to run something: a README, a CLAUDE.md, a command file
naming a sibling.

Four real finds, and the sharpest was not in a doc: **the message an EMPTY
WORKSPACE prints told you to run `fli ws-init` and `fli ws-add`**, and the
aliases are `ws:init` and `ws:add`. The one moment the tool speaks to somebody
who has nothing set up, it named two commands that do not exist — in
`workspace/status.md`, `workspace/list.md`, and `workspace/add.md`'s own
`examples:`, which `--help` prints. `@frontierjs/notifications`' README told you
to run `fli add notifications`, which has never existed; its install section now
says to add the model it shows you.

Three resolution rules and the second two are why this is not a set lookup: a
NAMESPACE (`fli make`) is a writer naming the family, and a BUILT-IN (`fli list`)
is answered by `bin/fli.js` and has no command file — read from
`NO_PROJECT_NEEDED` rather than restated, so the next one is not a false positive
nobody can explain. Two allowances, each a named entry with a reason, and a stale
one fails the test.

Writing it cost one defect of its own, worth stating: a lookahead that refuses
only `:` **backtracks**, so `` `fli root:` `` — a log LABEL in a template
literal — was reported as a missing command called `roo`.

## 2026-08-24 — eleven rules that read the app's own source, `--fix`, and the ratchet

823 tests, 62 of them new. `IDEAS/diagnostics.md`'s live-hazard catalog
starts executing, and it executes **inside `fli check`** rather than in a new
command — ruled `FJS-D133`, because `fli doctor` already exists and means *can
this machine run fli*, and a scaffolded app's `bun run check` already calls the
other one.

Everything the idea listed as *what would have to be built* was already here —
ids, two severities, `--list`, `--json` with a non-zero exit, an allowance that
is a named entry with a reason. What was missing was the rules.

- **`raw-route-param`** — `app.get('/orders/:id')` registers `:id` as a literal
  segment, so the route answers that path as typed and 404s on every real
  request. The finding carries the rewrite.
- **`ctx-params`** — there is no `ctx.params` in Junction. It reads `undefined`,
  so a role check written on it passes for every caller.
- **`set-auth-discarded`** — `db.$setAuth(user)` as a statement scopes nothing:
  the writes after it go through the unscoped client and every row policy
  compares against a null principal. Only a whole statement is judged, so
  `const scoped = …` and `db.$setAuth(u).order.create(…)` are untouched, and a
  call spanning two lines is left alone rather than guessed at.
- **`call-header-declared`** — a header set with `setCallHeader` in `web/` and
  absent from `api/`'s `http.callHeaders` works over HTTP and is dropped the
  moment the socket connects. **Cross-surface, which is why nothing else can see
  it**: both halves are correct in the file they are written in. Neither side is
  a literal in a real app, so single-valued constants are resolved across the
  app; a declaration naming something this cannot read is a **skip that says so**
  rather than an absent declaration.
- **`service-model`** — a service resolves its model by name, and a miss is not
  an error: `getTable` throws, but the two things that grade a caller fail OPEN.
  So a `model:` naming nothing in the schema is reported, and so is a
  `createBaseService` whose service name derives to no model — which is every
  hyphenated name, since `db.<accessor>` is the model name with a lower first
  letter and `product-variant` is not `productVariant`. A service with no
  `model:` and no CRUD base is judged on nothing: a service over no model is a
  whole kind of service.

Four more, added the same day, ask across the realms:

- **`resource-model-miss`** — `createResource('product-variants')` resolving to
  nothing falls back to a bare `make()`: no validation, no labels, no field
  rules, and a screen that still renders. It is `service-model`'s question asked
  from the UI realm, so the two share **one resolver** rather than one regex
  each. Reported only where a model plainly EXISTS under the name — a resource
  over no model is a whole kind of resource.
- **`service-module-db`** — the module client inside a service carries no
  principal: `auth()` is null, every row policy matches nothing (an empty list
  with a 200) and a write belongs to nobody in the audit trail. Only where `db`
  is an IMPORT, since `const db = ctx.locals.db` cannot coexist with one;
  `db.asSystem()` says which client it means and is not reported.
- **`scheduler-dispatch`** — `FJS-D36`: a timer that dispatches into the queue
  buys a clock with none of the queue's durability while looking like it has
  one, and it runs in every replica. The callback is read WHOLE (`spanFrom`),
  because a dispatch is three lines below the timer in every real app.
- **`gate-unreachable`** — a `@@gate` at ADMINISTRATOR(5) or above where nothing
  can grade a caller past 4: the shipped resolver reads
  `isAdmin`/`isOwner`/`isSystemAdmin` and **never interprets a role string**, so
  an app with a `role` column, no standing booleans and no `getLevel` of its own
  has declared an operation nobody but `asSystem()` can perform. A warning, not
  an error — the app is more closed than it meant to be, and the symptom is a
  403 reading as *not an admin yet* rather than as *no caller ever will be*. `8`
  and `9` are excluded by name: the identity models ship that way.

**Three more were killed by measuring them.** `@encrypted` on a `Json` column
round-trips correctly (`Int`, `Float` and an array throw at the write, loudly);
a directive key in a `find()` filter is a 400 from `autoFilter` naming the key;
and a model service with no `channel:` is the ruled, intended state. Each was a
row in `IDEAS/diagnostics.md` written before the fix or before the ruling — **a
hazard paragraph is a lead, not a spec.**

**`fli check --fix` applies the ones that are a whole fix.** A finding may carry
`edit: { start, end, was, replacement }` — byte offsets into the file it names —
and `applyFixes` writes, because *how a file gets changed on disk* is one answer
and not one per rule. **The offsets are into the real source although rules read
`readCode`**, which is what blanking comments to spaces rather than deleting them
buys: every position survives.

Three rules carry one. `:id` → `{id}` is a spelling; the two model rules have
already worked out the exact name the call is missing, so the edit is
`model: 'ProductVariant'` written into the options object **the way that object
is already written** — `{}` takes no comma, one opened on its own line takes a
line indented like its neighbor. A canonical form would reformat somebody's
file to add a missing key, which is how a `--fix` gets a reputation.

**The other six deliberately carry none, and `set-auth-discarded` is the
argument**: wrapping the call in `const scoped =` would silence the rule and
leave every write below it going through the unscoped client — the bug, with a
green check over it. A fix that makes a check pass without fixing the failure is
worse than no fix.

Edits apply back to front (two on one line was the case that decides it), `was`
is re-verified so a file that moved since the check is refused by name rather
than written at a stale offset, overlapping spans are refused rather than
resolved, and what was applied is **re-checked from disk** rather than
subtracted from the list in memory. Finding the call site cost a defect on the
way in: `indexOf('createBaseService')` lands on the IMPORT, and searching forward
from there finds the `(` of the arrow function beside it, so the fix came out
empty and the line number pointed at the import.

**Two more ask whether the BUILD-time proof is switched on.** Sierra proves a
prerendered page at build time — reads tapped around the route's companion and
graded against `@@gate`, fail-closed (`FJS-081`) — and no text rule can replace
that, because the question is what a `load()` actually read. What text can see is
whether that proof is running at all, and both of these were measured by calling
`checkRoute` rather than read off the source:

- **`static-publish-db`** — a `target: 'static'` surface whose Sierra config
  wires no `db:`. The tap needs that client; with none the build can observe
  nothing, so every route with a companion is refused until it declares
  `publishes:` — and the message the build prints tells the author to write
  `publishes: 0`. Do that per route and the build goes green having proved
  nothing, permanently. Only for a surface that actually loads data: a site with
  no `.meta.js` reads nothing and wants no client.
- **`static-publishes-0`** — `publishes: N` is the level a page may publish at
  and the default is 0, so declaring 0 raises nothing. Measured: it changes
  exactly two outcomes, and both are refusals becoming passes — a route the
  build could not OBSERVE, and a read of a name the schema does not describe.
  The one declaration that reads like a bar and works like an off switch. A
  declared LEVEL is the mechanism working and is not reported, and the key is
  read from a page's own frontmatter and nowhere else, because that is where
  the build reads it.

**`check-baseline.json` is how an app adopts the rules**, and it is Invariant
14's ratchet applied to a second kind of count — one number per rule id, absent
= 0 = clean, `scripts/typecheck-baselines.json` the precedent and the semantics
deliberately identical. **The file's presence is the declaration**, so an app's
own `bun run check` gets it with no flag to remember.

**It grandfathers nothing: the findings still print, and what the file changes is
the exit code.** Debt you cannot see is debt nobody pays, and a rule set that
goes red the day it is installed gets removed rather than obeyed.

Two verbs, because one flag that both locks in a fix and records a regression is
how a ceiling rises with nobody deciding to raise it. `--update` takes
improvements and **cannot** raise; `--adopt` writes what is there, raising
included, and reads in a diff like the decision it is. Both write and then
**re-grade from the file**, the rule `--fix` already follows — a run that records
a baseline and then fails against the numbers it just wrote is reporting a state
that no longer exists.

**A rule that did not RUN is not a rule that improved**, and that is the one
place the shape had to differ from typecheck's. A rule with nothing to look at
reports 0 findings, which is exactly what a fixed one reports, so a skipped
rule's ceiling is carried forward and said out loud rather than ratcheted to
nothing — otherwise deleting a surface for an afternoon locks in a baseline no
later run can meet. Same doctrine as `skipped` in the summary, one layer along. A
ceiling for a rule that no longer exists is reported the way a stale allowance
is, and a zero is never written, since it says what an absent key says.

**A baseline is not an allowance and both have to exist.** `allow` says *this one
is fine, and here is why* — keyed by rule AND path, carrying a reason. A baseline
says *there are this many and there will never be more*. Adoption needs the
second; a permanent exception needs the first.

**The membership test widens by its INPUT only.** A rule still earns its place by
being silent when broken; it may now read a line of the app's own JavaScript
rather than only the file tree. Text, never an AST — this runs on node with no
build. **Comments are blanked first** (to spaces, so line numbers survive),
because this repo's own `api/` files describe every one of these hazards in the
words the rules match, and a check that fires on the paragraph explaining the
hazard is one people turn off. The blanking is **quote-aware**, which is not
fussiness: a regex sweep blanks from the `//` in `'http://localhost:8010'` to
the end of the line, so a `callHeaders:` sitting after a CORS origin disappears
and the rule reading it reports a correctly-declared header as undeclared.
Blanking too much is how a source rule cries wolf.

`core/checks.js` gains its **first import**: `@frontierjs/toolbelt/inflect`, the
substrate package. *What is the singular of this service name* has one owner
(Invariant 2) and a sixth answer here would grade an app by an inflection the app
does not run — `people` → `person` is the case that decides it.

Clean over `example`, `basecamp` and `packages/sierra/example` — 21, 20 and 20
rules apiece — with every new rule RUNNING over each rather than skipping.
`without(prefix)` in the test file replaces the destructuring two trees used to
strip a directory: a test that lists the files it removes breaks the day CLEAN
grows one, and it breaks by asserting the wrong thing rather than by failing.

## 2026-08-23 — a reader that quits first, and a secret with nothing to sign

760 tests. **`fli list | head -3` no longer dies printing its own stack**
(`FJS-379`). One `error` listener on stdout and stderr at the entry point,
exiting quietly on EPIPE — not a guard per write, since every read-only listing
has the same shape. Measured both ways in a scratch directory: 980 bytes and two
`Unhandled 'error' event` traces before, 0 bytes after, every run. It survived
because merging stderr into the same pipe hides it completely — the trace goes
into the pipe that just closed — so it is only visible the way a person actually
types it, which is what `test/pipe.test.js` reproduces.

**`fli auth:install` no longer generates an `AUTH_SECRET`** (`FJS-360`), and the
reason is in the file where the generation used to be: a session issued by
`@frontierjs/auth` is a ROW — a random UUID stored on `Session`, verified by
lookup — so nothing is signed and there is nothing for a signing secret to sign.
An API key is hashed with `ENCRYPTION_KEY`. A second secret with no reader is
worse than no secret: it gets rotated, nothing breaks, and everybody learns that
rotating is safe. Gone from the generation, the `.env.example` line, the env
declaration and `fli new`'s. Sessions becoming stateless tokens is what would
bring it back.

## 2026-08-23 — `site/` is a surface, and `site:` belongs to it

760 tests, 34 of them new, 0 fail.

`FJS-451`, ruled as `FJS-D127`. Invariant 3 listed four surfaces and a public
prerendered site was none of them, so this repo's own example built one inside
`web/` — a second config in `web/config/`, a second `routesDir` under `web/src/`,
an `outDir` of `dist/public`. Every layer agreed: no rule could see it, no port
slot existed for it, no command could make one.

**The axis that decides it is output.** One Vite root is one `dist/`, and Vite
empties `outDir` by default, so `bun run build` deleted the site. Order-dependent
and silent, and indistinguishable from a stale build.

- **`core/site-surface.js`** — the one owner of the shape, called by `fli new
  --site` / `--template site-only` and by `fli make:site`, the same rule
  `widget-surface.js` and `extension-surface.js` follow. It writes an
  `index.html` and a `src/main.js`, because `target: 'static'` is the SPA's Vite
  config plus a prerender pass: dev is client-routed and the build is files.
- **`fli site:{dev,build,serve}`** — the surface's three commands. The build is
  plain `vite build`; there is nothing for a sierra subcommand to add.
- **`core/ports.js`** — `siteDev` (6) and `siteServe` (7), mirroring the widget
  pair. A surface both written against and served as its own origin needs two
  numbers, and the served half is not the SPA's second server.
- **`core/checks.js`** — `app-layout` reports a `target: 'static'` config found
  inside another surface, read from the config's own text. It is the one folded
  surface that reads as reasonable while it is written, which is why a rule has
  to be what notices.

**The ksite commands moved to `ksite:*`.** Six of them held `site:` — `clone`,
`fetch`, `setup`, `update`, `serve`, `deploy` — and they drive a separate
static-site toolchain that has nothing to do with FrontierJS. Short aliases are
unchanged (`fli clone`, `fli fetch`); the bare `fli serve` is gone, because two
things now serve a directory called `site/`.

## 2026-08-23 — a widget surface gets its own app's ports

`FJS-445`. `fli make:widget` wrote **8200** and **8300** into every app it
scaffolded a surface into — the Vite port, the host page's `<script src>`,
`deploy/serve.js` and the Dockerfile's `EXPOSE`. Those are dev/widgetDev and
dev/widgetServe for **project 0**, right for a fresh scaffold and wrong for
every app that has a number: `core/ports.js` is the schema and the numbers are
derived, not chosen.

Two apps in one workspace both got 8200. `strictPort` makes that a refusal
rather than a silent hop, so the failure was a second widget server that would
not start, naming a port nobody had chosen. Both are now derived from
`projectIdFor` + `port()` and threaded through every generated file and the
epilogue the command prints — `example` scaffolds at 8210/8310.

## 2026-08-22 — the doctor reads the Dockerfile it was given

726 tests, 10 of them new, 0 fail.

`deploy:doctor` required `db:migrate` and `start` in the app's manifest because
that is what `fli make:deploy` writes into the CMD — and never read the
Dockerfile the app actually configured. `basecamp` migrates at boot inside
`app.ts`, on purpose, so it has no `db:migrate` and the doctor reported a hard
failure against a container that starts correctly (`FJS-417`).

`dockerfileScripts(src)` in `core/utils.js` is the derivation: every
`bun run <script>` on a CMD or ENTRYPOINT line, exec form and shell form
including a `&&` chain. Only those two instructions — a `RUN bun run build` has
already succeeded by the time an image exists, and requiring its script at
deploy time would fail an image that is sitting there working.

In `core/` rather than in the markdown because a regex whose only proof is one
run of the command is not proved. One of the ten tests reads basecamp's real
Dockerfile.


## 2026-08-22 — surface-config, the twelfth rule

716 tests, 6 of them new, 0 fail.

Invariant 3 says configuration lives in `config/`, and nothing checked it. This
is the silent-when-broken class the engine exists for: a loader treats an absent
config file as an optional miss — correctly — so a surface with no `config/` at
all boots on framework defaults looking configured. `basecamp` read `api/config`
for its whole life without that directory existing (`FJS-415`).

Three findings in descending sharpness: a config file BESIDE a `config/`, where
one of the two is read and nobody can tell which; a config file at the surface
root with no `config/`, read by nothing; and the bare absence.

The absence is a finding rather than "this surface declares nothing on purpose",
because the framework resolves that path whether or not the app meant it to —
junction's default `configPath` is `api/config` unconditionally. An app that
genuinely wants the defaults says so in a one-line file, which is the difference
between a decision and an accident.

A surface with no source in it is skipped rather than scolded: a directory
somebody made is not a surface yet, and a rule that scolds every fixture is a
rule people turn off.

Both check fixtures gained an `api/config/junction.config.js`, which is the
right answer to a rule firing on the tree that defines *clean*.


## 2026-08-22 — `fli dev` refuses a port that is already answering

`core/db-preflight.js` had told you when a database was empty since it was
written. Nothing told you when a port was taken, and that is the failure with
teeth: the two dev runners fail differently and badly — `bun --watch` prints
EADDRINUSE and **keeps watching**, so the process stays alive and whatever is
waiting on it waits forever, and vite exits on `strictPort` only after somebody
has already been confused once. The worst version is a stale server from an
earlier run: it still owns the port AND still holds the old database open,
including one that has been deleted, since an unlinked SQLite file lives on
while a handle does. The new server never starts, every request is answered by
the ghost, and `db:reset` looks like it did nothing.

`appPorts(appRoot)` in `core/ports.js` derives it. **Which ports come from the
SURFACES that exist** — `web/`, `api/`, `widgets/`, `extension/` (Invariant 3) —
so a list kept per app cannot go stale the day somebody adds one, and a surface
the app does not have is never refused on. `FLI_PORT_FE`/`FLI_PORT_BE` win where
the broker set them.

**It names a script the app actually declares.** Two conventions are live and
both are correct — the apps in this repo call a surface's script by its own name
(`api`, `web`) and `fli new` writes `dev:api`/`dev:web` because there they are
composed into one `dev` — so the refusal reads the manifest rather than
assuming. Telling somebody to stop `bun run api` in an app whose script is
`dev:api` wastes the next minute of their day.

`packages/basecamp/scripts/preflight.mjs` is gone: it was this check, hand-held,
with the two ports written out as literals.

The port check refuses and the database check still warns, because they are
different kinds of fact — an empty database is the correct state for a first
run.

## 2026-08-22 — `make:resource` emits the form, and a generator is executed by a test at last (`FJS-D114`, `FJS-372`)

The command wrote a module script and stopped, so `FJS-D112`'s markup half was
permitted and never generated — the state a convention dies in. It writes the
default form now: `<Form resource={…} {record} ondone={onsaved} auto={!$slots.default}>`
with a `<slot />` inside it, so a create page is `<Model />`, an edit page is
`<Model record={row} />`, and a page wanting a different form still passes
children and still wins.

`auto` is stated rather than left to `<Form>` because the wrapper ALWAYS hands it
a slot: unstated, the component answers *did I receive children* about the
resource file instead of about the page, and generation is off in every app that
ran the command.

**And what a Resource IS became one module.** Three commands wrote one —
`make:resource`, `web:resource`, `make:scaffold` — each with its own copy, already
drifted in their comments, which is the harmless half of the drift that ends with
two of them emitting a different file. `core/resource-template.js` is the owner
now, the same shape `core/crud-templates.js` already is for a generated CRUD page
(Invariant 4).

`test/make-resource.test.js` runs the command for real into a temp app and grades
what it wrote with `runChecks` — the same engine `fli check` gives a client app,
which is the assertion that matters here because the failure class is the
framework generating what the framework refuses. It runs `web:resource` as well and compares
what the two emit with the names swapped out, so *they are one module* is proven
by execution rather than by reading both files. It is the first test in this
package to execute a generator at all — and while adding it, `test/config.test.js`
turned out to be listed in no test script either: eight assertions that had never
run. Both are in `package.json` now. Opening the generated file in the kit's
browser drive found `FJS-400`, a defect in `<Form>` that no app in this repo could
reach and every app running this command would have.

## 2026-08-21 — fli reports the version it actually is (0.1.3)

The list banner carried a literal `v0.1.0` (`core/bootstrap.js`), so every build
published since 0.1.0 told a stranger it was 0.1.0 — and `fli --version` fell
through to the usage screen, because minimist leaves `_` empty and the
no-command short-circuit ran first. Those are the two places somebody who
installed the package off npm looks before filing a bug, and both lied.

- **`fliVersion(root)`** in `core/utils.js` reads the installed `package.json`,
  memoized **per root** rather than once — the argument exists so a caller
  holding its own path can ask, and a single cached answer would hand it this
  package's version for someone else's directory.
- **Four readers**: `fli --version`, `-v`, the bare `fli` usage header, and the
  `fli list` banner. `/api/meta` already read `pkg.version`; its two `'0.1.0'`
  fallbacks are `null` now, because a fabricated version is worse than an absent
  one.
- `test/version.test.js` spawns the real binary for every surface and asserts
  against `package.json`, so the next bump cannot re-open this.

**The usage screen is paste-safe too.** Its two annotated examples marked what a
command produces with a `->`, on lines that look exactly like something to
select and paste — and a paste hands `fli` three junk argv entries. The marker
is `#` now, which the shell reads as a comment, and `test/help.test.js` asserts
no arrow reaches the usage screen, the listing or a namespace page. Found the
way these are always found: a reader pasted an arrow-annotated install line and
npm went looking for a package named after the arrow.

## 2026-08-19 — the admin uses the app's own Resources (`FJS-364`)

`fli admin:generate` wrote one `web/src/resources/admin.mesa` holding every
model. That is N Resources in a file named for no model, which `fli check`
refuses twice (`resource-file-name`, `resource-one-per-file`) — but the rule was
the smaller half. It also declared `createResource('users')` beside an app that
already had `resources/User.mesa`: **two stores over one service**, each with its
own socket subscription, so a write through the admin left the app's list stale
and the app's write left the admin's, with nothing anywhere saying why.

Both close together:

- **The index moved into the layout.** `admin/_module.mesa`'s `<script module>`
  exports `models`; the dashboard imports it from there. A layout is already the
  surface's own module, and module exports are importable by any other module
  (Mesa VISION §11, rule 30) — which is all the pages ever needed from
  `admin.mesa`.
- **The admin imports the app's Resource per model**, and writes one only where
  none exists, from `fli make:resource`'s own template. **Never overwritten,
  `--force` included** — force is about the generated pages, which are
  disposable, and a Resource is not one of those.
- **Both halves of an existing Resource are read, not guessed.** The export name,
  because `Person.mesa` exports `people` and no plural rule applied to `Person`
  finds it; and the service string, without which the irregular generated
  `/admin/persons/` over a service named `people` — the data worked while the
  URL, the route folder and the `make:service` hint were wrong together. That
  second one was found by running the command, not by reading it.
- A Resource file exporting no `createResource` is **named and its model
  skipped**, rather than generating a page whose import resolves to `undefined`
  and dies at first render with no mention of the file.

Verified on a three-model fixture with a hand-written `User.mesa`, an irregular
`Person.mesa` and a missing `Widget`: the hand-written file is byte-identical
after `--force`, only `Widget.mesa` is written, and `fli check` reports nothing
where it previously reported two errors.

## 2026-08-19 — a generated CRUD page is built on the kit, and there is one of it

`fli make:scaffold` and `fli admin:generate` each wrote a list, a create form
and an edit page, and until now each carried its own copy of the same ~180
lines: an `Object.entries(resource.fields)` loop deciding control-per-type, a
`pickers` block resolving a related service through a hand-rolled English
pluralizer, an `errors` array, a `saving` flag, and a `<style>` block of hex
colors. They had already drifted — one filtered `id` by name, the other asked
the resource for its idField, and only one rendered a picker at all.

`core/crud-templates.js` is now the one owner of what a generated page looks
like, and the pages are built on `@frontierjs/ui`: **`<Form {resource} />` with
no children IS the form.** Every writable column in schema order, each with the
control its type implies, picker rows fetched from the related service, the
coerce/blank-strip/validate pass before the request, and a rejection mapped back
under the field that caused it — all of it in the kit or in the resource,
stated once. A generated create page is ~25 lines and names no field, no type
and no enum member; the list still names its columns, because which of twenty
belong in a table is a judgement and that file is where to make it.

Two knobs cover what admin needs and scaffold does not: columns derived off the
schema at runtime (an admin covers every model and cannot name them) and a
per-row delete, plus the gate affordances. `related()` is gone from the
generated admin resources file — the picker asks the resource, which resolves
the related service through Sierra's registry, so a scaffolded app no longer
ships a second pluralizer.

**`@frontierjs/ui` is now part of what an app is given** (`core/app-config.js`,
and `fli new`'s web half). A generated page imports the kit; an app without it
gets pages that cannot resolve their own imports, which is what the first run
of `scripts/scaffold-build.mjs` said in as many words.

**`fli new` no longer keeps two lists of the same packages.** `neededPkgs` — the
list `--source local` runs `bun link` over — is read off the manifest
`makePackageJson` produced rather than restated beside it. Adding the kit to one
and not the other broke every local-source scaffold at install, and the error
surfaced three commands later, in `deploy:vendor`, naming every package at once.

Proven by `node scripts/scaffold-build.mjs --deploy`: scaffolded, installed from
tarballs, built, `bun run check` green, a model scaffolded in and built again,
and both container sources built, started and answered health. The register step
still fails on `FJS-345`, which is about a scaffold having no migrations and
predates this.

## 2026-08-19 — a resource file carries its model's default form (`FJS-D112`)

Invariant 18 said a resource file has no markup. It does now, and the markup is
the model's default form — the data half stays in `<script module>`, which is
the half `resource-script` still enforces. The check's markup finding is gone
and the test that asserted it is replaced by one asserting the opposite: a
module script, an instance `<script>` and a `<Form>` beside them is a clean
resource.

The five command templates that stated the old rule in a header comment were
updated with it — `make:resource`, `web:resource`, `make:model`,
`make:scaffold`, `admin:generate`. What they do NOT yet do is emit the form,
which is permitted rather than generated; that and the named-query question are
named in the ruling and not started.

## 2026-08-19 — a resource file is named for its model, in all five scaffolds (`FJS-363`)

Invariant 19 names a resource file for its MODEL and its export for its SERVICE.
`make:resource` and `web:resource` built the path as `service + '.mesa'` and
`make:model --resource` as `${plural}.mesa`, so `fli make:resource Order` wrote
`orders.mesa` — which the next `fli check` called an error, with this package on
both sides of the disagreement.

The consumer half was wrong with it. `make:route --resource` and
`web:route --resource` generated a page importing `resources/${service}.mesa`, a
file the fixed commands never write, and the *does this resource exist yet*
probe beside it looked for `${service}.js` — the wrong name **and** the wrong
extension, so that warning fired on every run including the correct one.

Only `make:scaffold` had it right, which is why CI was green: the `scaffold`
phase runs `fli scaffold` and reaches none of the other five. Each fixed site
now carries the split as a comment, because the generated import line legitimately
spells the two differently either side of `from` — `import { orders } from
'../../resources/Order.mesa'`. `fli validate`'s worked example was stale the
same way and is corrected.

Not fixed, filed as [FJS-364](../../ISSUES_ARCHIVE.md#fjs-364): `admin:generate` writes
one `resources/admin.mesa` holding every model, which fails `resource-file-name`
and `resource-one-per-file`. That is a shape question, not a spelling — three
ways out and none obviously right.

## 2026-08-19 — the scaffold had two auth files and ran the wrong one (`FJS-357`, `FJS-358`)

`fli new` writes `api/src/core/auth.ts` and imports it from `api/src/app.ts`.
It then composes `auth:install`, which wrote `api/src/auth.ts` — a second
`createLitestoneAuth` over a second `createClient` on the same SQLite file,
imported by nothing — and printed next-steps naming `api/src/server.ts`, which
exists in no app this scaffold writes, telling the reader to call
`createApp({ auth })` again. `auth:install` recognizes the wired layout now and
scaffolds nothing into it.

**The dead file was the more complete one, and that is where the defect lived.**
`core/db.ts` grades the gate on `isAdmin`, and its own comment says the
projection is made where the session is built. `core/auth.ts` declared no
`sessionFields`, and the `User` model ships a role STRING that auth stores and
never interprets — so `isAdmin` reached no session and nothing could grade above
USER(4). Measured on a fresh scaffold with `role='admin'`:

- `DELETE /users/:id` → `403 requires level 5, user has level 4`, at a level no
  caller could reach
- `PATCH` of another person's row → **404**, because
  `@@allow('update', … || auth().isAdmin)` matched nothing and a row policy
  hides rather than refuses
- `PATCH {role:'admin'}` → **200 with the field silently stripped**

Three of `schema.lite`'s own rules, dead, for one missing line. It is there now,
and the same probe passes for an admin and still refuses a plain user on all
three. `authCleanup` is started from `app.ts` rather than constructed in a file
nothing imports, and `AUTH_SECRET` is declared in `core/env.ts` rather than
generated into `.env` and named nowhere.

Declaring it **required** is what found `FJS-360`: every containerized deploy
then refused to boot, correctly, over a value that no code in
`@frontierjs/auth` or junction reads — auth signs with `encryptionKey`, and the
only other mention anywhere is `defineEnv`'s soft-warning table, which knows the
name so it can grade length and placeholders. It is declared optional.


## 2026-08-19 — what `fli new` leaves behind, read as a stranger would (`FJS-353`, `FJS-354`, `FJS-355`)

699 tests, 0 fail.

Four things a scaffold did that a first-time reader would take as the framework
being broken, all found by running `create-frontier` and following its own
instructions.

**`fli keygen --env` printed the key it had just written.** So `fli new --auth`
put a real `ENCRYPTION_KEY` and a real `AUTH_SECRET` in terminal scrollback, and
in the log of every CI job that composes the command. The bare form is meant to
be piped, so the echo survives where nothing else carries the key; `--env` and
`--copy` have already delivered it, and `--print` is the way back. `auth:install`
also stopped printing a second success line over keygen's own, and now declares
each name it generated in `.env.example` — a key written only to `.env` is a key
the next clone has no name for.

**The summary told everyone to `cp .env.example .env`** — over the `.env`
`auth:install` had just filled with both generated keys. An instruction that
breaks the app it finished building. It is printed only when there is no `.env`.

**`cli/src/routes` was created by the directory step and then refused by
`fli:init`**, which exists to fill it. The warning scrolled past, `✓ created`
printed anyway, and the FLI surface shipped as an empty folder.

**The home page read `status.connected`**, which is the socket, and the client
opens one only once it holds a token — so a visitor who had not signed in read
`connecting…` for ever. It asks `/api/health` now, and says separately that the
socket opens at sign-in.


## 2026-08-19 — `project:view` is a page rather than a React bundle, and it stopped inventing data

FJSChain was React 18 from a CDN — two `<script crossorigin>` tags, 486 inline
`style:{}` objects, a 30-key color palette, hand-compiled from an `FJSChain.jsx`
that is **in no checkout**. So the committed artefact could not be regenerated,
and the page could not render at all without the network, which nothing else
here needs.

It is plain HTML and JavaScript in `@frontierjs/css` now, ~1100 lines against
1571, and the terms carry it: Shell, Topbar, Screen, Pane, Card, Tile, Item,
Facts, Table, Badge, Pill, Code, Tabs, Alert, Empty, Disclosure. The diagram is
the only thing left in a `<style>` block, because a chain drawn as a grid is a
picture and not a component. A realm is a **tone** — `primary`, `info`,
`secondary`, the three that claim no status, so `success` and `danger` still
mean what they say beside them.

**The diagram is a flow and it has to look like one.** The first pass drew the
twenty nodes as three rows of cards and left the direction to two captions,
which is not a chain — it is a list that happens to be in order. The arrows are
back and they are CSS rather than glyphs, so they stretch with the gap and take
the ink color: a rule with a head on it between nodes, pointing right along the
outgoing lane, left along the incoming one, down the two spines. Consecutive
nodes of one realm sit in a tinted **band**, which is what makes four API nodes
read as one stretch of the chain; the bands line up with the realm cards
beneath them, which the page this replaced did not manage. And the four elbows
are carried over unchanged, because they are the shape of the thing: a request
enters at the UI end of the bottom lane, turns at the data end, and its result
comes back along the top.

A package tag is a **control** now — outlined in the realm's tone above the node
it joins, and clicking it opens that package's detail. In the first pass they
were badges inside the node, which meant a `<button>` inside a `<button>`, a
name wider than its node painting over the neighbor, and a detail panel nothing
could reach.

**The bigger half is what it no longer says.** Six of its twelve panels were
hardcoded fiction about a shop called acme-crm — `port: 3000`, `acme_crm_token`,
`./db/acme-crm.db`, a `contacts` service — rendered beside real data with
nothing marking which was which. Two of them (`routes`, `fli`) read from
constants that were `[]`, so they had rendered nothing at all since the day they
were compiled. Every panel now declares its `source`: **project** is read off
the tree, **reference** describes FrontierJS and says so in an Alert at the top
of its own tab. The fictional settings are deleted outright.

What the surface snapshot can answer, it now answers. `routes` and `plugins` are
real (they were static and empty); a hook-point detail shows the chains that
actually run at that point **and names the file it read them from**; `channels`
lists the services that declare one, where every service used to be given three
invented events. The issue list checks things the data supports — a missing
`gateAuth`, an ungated model, a required secret that is not set, a service no
resource binds to — replacing a check for an `authenticate` hook this framework
does not have, which flagged every service in every project.

The injected env-health panel is gone with it: `PANEL_JS` existed because the
page was a compiled bundle nobody could edit, so a second hand-styled UI was
stapled on at serve time. Env is a panel like the others now, one-click secret
fix included. The injection survives for `--legacy` only.

**`--legacy` serves the React page from `web/viewer/legacy.html`**, so the two
can be read side by side. It is the only thing in this package that still needs
the network.

Four things found by building it, three of them in how `@frontierjs/css`
composes.

**A View outranks a Stack.** `.view` states `display: block` in the components
layer and `.stack` states `display: flex` in the earlier layout layer, so
`class="view stack gap-lg"` lays out as a block with the gap doing nothing — and
every heading in a panel sat hard against the table above it. The same collision
`.pane` documents, and it had also flattened the Web GUI's documentation drawer.
The Stack goes on a child.

**`.tabs > .view` is a direct-child selector**, so wrapping the panels in a box
of their own took away the air between the strip and the first panel. The strip
and the views are siblings.

**A tone does not reach anything inside the element carrying it.** `--bg-mix` is
element-scoped, so all three realms drew in one color until the tone went on
the heading control too, and every elbow drew in the Data realm's color until
its rail derived the tone into an ordinary custom property first — which is the
move `form-core.css` already makes to get a tone onto a checkbox. Twice in one
page is what makes it worth writing down.

And **Chrome leaves a flex scroll container's bottom padding out of
`scrollHeight`**, which made the last band of the Screen unreachable at any
scroll position: the final row of the schema list could not be scrolled to. A
trailing `::after` is in the flow and is counted.


## 2026-08-19 — the Web GUI is written in the styling language everything else here is

`fli gui` was 840 lines of hand-written CSS with its own token names, its own
three themes and eight literal hexes in a hand-rolled highlighter, next to
`ws:map` and `ws:atlas`, which are written in `@frontierjs/css` (Invariant 13).
Two styling worlds one command apart, and a third spelling of *theme*: the GUI
wrote `data-theme` on `<html>`, the package defines `.theme-*`, and Sierra
settled the question in `FJS-308`.

It is a term now, all the way down: **Shell, Topbar, Sidebar, Screen, Bar,
Card, Field, Item, Badge, Pill, Kbd, Empty, Disclosure, Dialog, Drawer, Code**.
What is left in a `<style>` block is what the vocabulary has no word for — the
console a command streams into, the split it shares with the form, and the
density a command tree needs that a Sidebar does not assume. **No color is
written in the page at all**: an output level is a tone (`text-danger`,
`text-success`), which is what makes the light themes work — the old
console's `#d8d8d8` was invisible on anything but its own ground.

Three things fell out rather than being ported. Every fold is a `<details
class="disclosure">` and every panel a real `<dialog>`, so open/closed, Escape,
the backdrop and the focus trap are the browser's — that is four handlers and
two `.open` classes gone. The theme is a class on `<html>`, applied by a script
above the stylesheet so there is no flash, and the picker offers all ten of the
package's themes instead of three of its own. And the highlighter is
`@frontierjs/toolbelt/glow`, whose output is marked with the ELEMENT that means
each token and which `@frontierjs/css` already themes — so the GUI dropped its
tokenizer and its palette together.

**`core/assets.js` is the one owner of what a browser gets from a sibling
package**, and it answers two questions that are not the same one:
`styleBundle(root)` is the styling language as the tree at `root` holds it —
for a page ABOUT that tree, where a stylesheet from anywhere else describes
nothing (`FJS-256`) — and `ownStyleBundle()` is the copy this `fli` was
installed with, which is what the GUI wants, because the GUI is not about a
tree. `repo-map.js` reads the first; the server serves the second at
`/fli.css`, with the published bundle as a redirect for an install that cannot
read the package at all. Both are now dependencies of the CLI.


## 2026-08-19 — a stack from a command names the `.md` and the line its author wrote

A command is markdown, compiled to a module, written to a temp shim and
imported, so every frame from a command body named a file nobody wrote and which
is deleted on exit. The `//# sourceURL` pragma that covered this made it worse:
it relabels the PATH and leaves the LINE alone, so Node reported `boom.md:15`
for a throw on line 9 of an **11-line file** — authoritative-looking and
impossible — and Bun ignored the pragma outright. Bun ignores an inline source
map and a linked `.map` as well. Four measurements, no runtime answer.

So fli maps the frames itself, and the map turned out to be **one integer**.
`transformMarkdown` never dropped prose — it turns it into `//` comments, line
for line — so the body was already aligned; the only thing that broke alignment
was `stripScriptBlocks` cutting its block out, which shifted everything below it
and made a command with a `<script>` in the middle need two offsets. It leaves
the block's own height behind in blank lines now, and one offset covers the file.

`compileCliWithMap` returns `genLine - mdLine` beside the code. `core/stack.js`
is the one owner of the rewrite: a string pass over `err.stack` and its `cause`
chain, not an `Error.prepareStackTrace` hook — that hook is global and V8-shaped,
and taking it means re-implementing the default formatting for every frame that
is not ours, on two runtimes that format differently, to fix the handful that
are. The pragma is deleted; the body is no longer indented into `run()` either,
so columns are the author's too.

**The test runs the command through `bin/fli.js` under node and under bun.**
Every unit-level expectation the pragma set was satisfied for its whole life — a
pragma was emitted, it named the right file — so only executing it could tell
(`FJS-066`).

## 2026-08-19 — the deploy image says why `--production` can fail on a package it never runs

`bun install --production` skips INSTALLING devDependencies and still RESOLVES
them, so a dev-only package the image would never execute can fail the build
outright — an unpublished one 404s there with the app otherwise perfect. That
cost the `deploy` phase's `npm` branch every run until `@frontierjs/config`
reached npm, and the reason lived only in the issue register.

It is a comment on the `RUN` line in `commands/make/deploy.md` now, beside the
`--frozen-lockfile` note it interacts with: pruning the devDependencies from the
vendored manifest was tried and rejected, because a manifest that no longer
matches the lockfile beside it fails `--frozen-lockfile` on the line above
(`FJS-267`).

`utils:qrcode` is deleted in the entry below.

## 2026-08-18 — `package-root-md` reports the floor, and one function owns the frontmatter fence

Two things, both the same shape: a rule that could only see one side of what it
was written to check.

**`package-root-md` checked the ceiling and not the floor.** It built the set of
four allowed names and reported what was NOT in it, which catches a fifth file at
a package root and can never catch a missing fourth. Seven packages were short a
standard file with the check green over all of them. The asymmetry is defensible
for the fifth — the rule cannot tell a stray design note from the next thing
everyone needs at the root, which is why it warns and names it — but a missing
one needs no judgement, because the four are named in the invariant.

The finding points at the ABSENT FILE rather than at the package directory. An
allowance is keyed by path, so pointing both halves at the directory would mean
excusing `packages/css` its `AGENTS.md` also excused it every file it lacks.
It reports the eight it was written to find: `PROJECT_STATE.md` in `conduit`,
`jetty`, `sierra`, `testing`, `toolbelt` and `frontierjs-vscode`, and
`CHANGES.md` in `css` and `frontierjs-vscode` (`FJS-309`).

**Five call sites carried the frontmatter fence by hand**, as
`/^---[\s\S]*?---\s*/`, which ends the block at the first `---` anywhere —
mid-line included. A `description: use --- as a divider` left the rest of the
frontmatter, and its own closing fence, sitting in the body. The meta parser's
regex was the stricter of the two and read the same file correctly, so the two
halves disagreed about where the file began.

`splitFrontmatter` returns `{ meta, body }` from one match and `stripFrontmatter`
is the body half; `compileCli`, `extractSegments`, `extractScriptBlock`, the
command registry, the prose renderer and the GUI's step reader all ask it. The
fence is `---` alone on its line, opening and closing.

**`utils:qrcode` is deleted.** It imported `qrcode` dynamically and reported the
absence by name, but nothing installed it and nothing could: the advice it gave
was `bun add qrcode` in the user's project, which is not where the command
resolves from. The choice was a dependency on the CLI for one novelty command or
a command that never worked, and neither was worth it. `utils` keeps eleven.

`mod.prose` was in the same pile and is not a defect — `loadModuleFile` builds it
and `fli <namespace> --verbose` renders it. Struck from the row rather than
fixed (`FJS-066`).

## 2026-08-18 — `context.fli` is the one way a command invokes fli

Six command files shelled out to a bare `fli`. That is a GLOBAL install, and
fixing `project/new.md`'s `runFli` alone moved the wall rather than removing it:
the next runner failed inside `auth:install` on
`fli keygen aes --name ENCRYPTION_KEY --env`, which is the step the key comes
from — so the push that follows had no key and the app still came out with no
`User` model.

`context.fli` is the running cli, quoted and ready to prefix a shell command,
built once in `core/runtime.js` from `global.fliRoot` and `process.execPath`.
All six sites use it: `auth/install.md` ×2, `api/model.md`, `api/service.md`,
`make/schema.md`, `completion/install.md`.

Beside it, `auth:install` no longer treats an empty `node_modules` as a failure.
The schema push needs the litestone BINARY, which exists only after
`bun install` — `fli new --no-install` and `npm create frontier` both arrive
before that. It says so and carries on; the schema itself is already written.

Proven the only way that means anything: `fli new --auth` with a clean
environment and no `fli` anywhere on PATH now exits 0 with `model User` in the
schema and `users.service.ts` generated.


## 2026-08-18 — `fli outbox:install` could not be loaded at all

Two unescaped backticks inside `wiringHint`'s template literal — the line
`// Then, in a service that declares \`transactional:\`` — closed the template
and reopened it, so the file compiled to JavaScript that does not parse:
`SyntaxError: Unexpected identifier 'transactional'`. The command was
unrunnable from the day it was written.

Invariant 15 is why this was caught at all: `test/compiler.test.js` parses the
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

Four cases in `test/checks.test.js` — above, below, only, and a closing tag,
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

The clean-app fixture in `test/checks.test.js` now carries the third surface,
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
BEFORE the split is still recognized rather than injected over.

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
— see ISSUES.md ``, `~~shipped~~`, `part-shipped` — so it normalizes to one word
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

**A tone carries the meaning a color used to.** An S1 defect is `danger`, a
ruling is `info`, a claimed folder is `muted`, a fast CI phase is `success`. No
hex is written for any of them, which is what makes the **nine themes** work —
the topbar carries a picker over `default · dark · midnight · forest · sunset ·
elite · basecamp · notebook · press`, remembered in `localStorage`. A test fails
a color literal in the page's own stylesheet, because that is the rule that
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
*unfiled* rather than being quietly labeled. `core/repo-map.js` gained the
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

- **`context.config` was initialized inside the steps runner**, so every command
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
graded correctly at all three sites. Two new scenarios in `test/zz-steps.test.js`
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

Pinned by four scenarios in `test/zz-steps.test.js` over a new
`test/fixtures/sibling-steps/`, each checked against a negative control:
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

`--with litestream` is now recognized by name rather than dropped, so the flag
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
`{serverPath}/.deploy.lock` — but the runner only honored that for the abort
*flag*, and `07-health` sets the flag **and then throws**. The throw exited the
group loop, cleanup never ran, and the next deploy refused while naming a deploy
that had finished minutes earlier. Fixed in `core/runtime.js`: a throw now records
the error, sets `abort`, lets the loop finish so `runOnAbort` steps get their turn,
and re-throws afterwards — so the exit code is unchanged and `runOnAbort` finally
means *runs on abort or throw*, for every `_steps` command. Pinned by
`test/fixtures/cleanup-on-throw/`.

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
own service noun singularized (basecamp's `Hub.mesa` is `createResource('hub')`
and is correct), and a schema with neither `api/` nor `web/` beside it is a
fixture rather than an app that got the layout wrong.

**An exception is a named entry with a reason.** There is no ignore comment;
`runChecks({ allow })` is keyed `'<rule>:<path>'`, and a stale allowance is
reported — an exception that outlives the thing it excused is an unenforced rule
nobody knows is unenforced.

## 2026-08-05 → 2026-08-10 — additions: ws:* in one repo, wsRoot, nested apps, ksite, deploy:doctor

Moved out of `PROJECT_STATE.md`, which carries live state only.

#### Recent additions (last few sessions)

- **The `ws:*` namespace understands a single-repo monorepo (2026-08-10)** — every workspace command assumed the shape `ws:add` builds, where each member is its own git checkout. In one repo the git questions all answered repo-wide: `ws:status` printed the same branch, the same ahead/behind and the same dirty flag on all sixteen rows, and `--affected` selected everything or nothing. Worse, `ws:pub` released through `npm version` per package, which writes a commit and a `vX.Y.Z` tag into the shared history — sixteen commits, sixteen pushes of one branch, and a tag collision the moment two members sat at the same version, which nine of them did. Release now detects which shape it is in (`context.wsRepo`): one repo means one commit, one `<name>@<version>` tag per released package and one push; many repos keeps the per-package path. `git.pkgState()` is the one definition of "has this package changed", asked with a pathspec. Private packages are skipped, since npm refuses them and a failed publish aborts the run before anything is pushed. New: **`ws:npm`**, the state nothing could answer — local version against the registry, one concurrent `npm view` per package, retried once because a published package can answer 404 and "never published" is the one wrong answer that sends someone to publish over a version that exists.

- **`context.wsRoot()` finds the workspace it is standing in (2026-08-10)** — it read `$WORKSPACE_DIR` or prompted, so every `ws:*` command needed an env var set to run against the repo the user was already inside, and a stale global default silently redirected them to another monorepo. `findWorkspaceRoot()` walks up for a `packages/` dir whose parent declares `workspaces` or is a git root; the env var is now the fallback for running from outside any workspace. It is deliberately not `findProjectRoot`, which stops at the deepest `db/schema.lite` and answers `packages/basecamp` from inside basecamp.

- **Nested-app support for `project:*` (2026-08-05)** — `project:map` / `project:view` could not run inside `example/` or `packages/basecamp`: `findProjectRoot` walked past both to the repo's `.git` root, so `paths.db` held no `schema.lite`. Root resolution now recognizes `db/schema.lite` as an app marker (below `.fli.json`, above `.git`), and a global `--project <dir>` / `FLI_PROJECT` pins it explicitly from anywhere. Three defects surfaced underneath: the compiler deleted every line after a `<script>` tag *mentioned* in a comment, which is why `project:view` built its map and exited without starting the server; `scanFiles` was not recursive, so basecamp's `services/<name>/<name>.service.ts` layout reported 0 services; and `--no-open` was declared as flag `no-open`, which minimist never binds. All four fixed, with regression tests for root resolution and for the compiler truncation (a truncated file still parses, so the shipped-command parse sweep could not see it).

- **`ksite:setup`** — first-time setup walkthrough for fresh ksite clones. Per-action confirmation, `--force` to bypass `config_ranSetup` guard, `--skip` for category, `--yes` to auto-accept. Cross-platform JS file edits (no `sed -i` hacks).
- **`ksite:update`** (alias `ksite-update`) — pulls KSITE_DIR canonical, mirrors framework dirs to local site. `--force` to skip version-gate and dirty-checkout warning, `--no-install` to skip final npm install. Major-version compatibility check between local and canonical site/package.json.
- **`deploy:doctor`** — read-only deploy readiness checker. Local checks (config, Dockerfile, /health route, env reference, git state), Junction-aware checks (`@frontierjs/junction` detection, `/ws` route, proxy_read_timeout reminder), and `--remote` for server-side probes (SSH, required tools, deploy dir, .env.production, container state, lock).
- **`make:fetch-config`** (alias `mkfetchconfig`) — scaffolds a `fetch.config.js` template with all options shown commented-out.
- **`fli:update`** (alias `update`) — monorepo-aware self-update via `git pull` + `bun install` in the fli source tree. `--branch`, `--no-install`, `--no-link` flags.
- **`ksite:fetch`** (alias `fetch`) — sitemap/URL→markdown converter using turndown + linkedom. Validates config (errors abort, warnings continue), prints destination upfront, sitemap-index recursion, namespace-loc filtering, HTTP timeout/retry. Uses `context.paths.siteContent` and `context.paths.siteMedia`.

## 2026-08-05 — engine improvements, and the script-block matcher that truncated 11 commands

Moved out of `PROJECT_STATE.md`, which carries live state only.

### Recent engine improvements (worth knowing about)

These were the substantive runtime changes in recent sessions, in case behavior elsewhere depends on them:

1. **`getConfig` deep-clones `defaultFlags` per-call.** Previously a process-wide leak — setting `--step 99` in one call leaked into all subsequent calls. Affected web GUI sessions running multiple commands sequentially.
2. **`getConfig` per-key-merges command flags with defaults.** A command can re-declare `dry` to add its own description without losing inherited `char: 'd'` from defaultFlags. Without this, short-flag resolution silently broke for any command that re-declared a default flag.
3. **Step abort honored before logging.** When `context.config.abort = true`, subsequent steps don't log their `[N/M] step-name` header. Cleanup steps opt back in via `runOnAbort: true`. Silently fixed the "stuck step header" output in `deploy:status`, `deploy:logs`, and any other `deploy:*` command that early-exits.
4. **Server registry cached for 2 seconds.** Sidebar load + meta fetch + run share one filesystem scan instead of three.
5. **`bootstrap.js` doesn't import `zx/globals`.** Saves ~100ms cold start on read-only commands (`fli list`, `fli help`, search). Compiled commands still import it themselves.
6. **`compileCli` emits a `sourceURL=file://...` pragma** so Node stack traces reference the `.md` file, not the temp shim. Bun ignores this — known limitation.
7. **`loadEnv` accepts `{override: true}`** for project `.env` to win over global `~/.config/fli/.env`. Handles multi-line quoted values and `\n \r \t` escapes inside double quotes.
8. **Atomic `claimSession`** via O_EXCL guard file to prevent two concurrent fli processes from claiming the same project ID. Stale guard files reclaimed via PID liveness probe.
9. **Bounded module cache** (256-entry LRU) so long-running GUI sessions don't accumulate stale entries from edited files.
10. **`findFreeServicePort`** probes all 10 service slots in parallel via `Promise.all`. ~10× faster on cold scans.

---

### Fixed 2026-08-05 — the script-block matcher truncated 11 commands

`extractScriptBlock` matched non-greedily, so a command's `<script>` block ended at
the **first** `</script>` anywhere inside it. Every command that *generates* a file
containing a script tag — each scaffold that writes a `.mesa` Resource — was cut off
mid-template-literal, and the remainder was handed to `transformMarkdown` as prose.
The compiled module was syntactically broken JavaScript.

Compiling all 195 command files and parsing the output found 14 failures:

    admin/generate  db/schema      deploy/_module  fli/init      make/command
    make/component  make/model     make/resource   make/route    make/scaffold
    project/new     web/component  web/resource    web/route

The block now runs from its open tag to the **last** close tag. Depth-matching does
not work here and cannot: `make/model.md` mentions `<script module>` inside a
comment, which no counter can distinguish from a real tag. A command has exactly one
script block, so first-open-to-last-close is both what a reader sees and what parses.

Two of the 14 were not compiler bugs and were fixed in the sources:

- `db/schema.md` — `makeModel` was missing its closing `}`. (It also still appends a
  **Prisma** model to `schema.prisma`; the Data realm is Litestone `.lite` now, so
  this command is stale beyond the syntax fix.)
- `deploy/_module.md` — an illustrative `frontier.config.js` sat in a ` ```js `
  fence, which is compiled *into* the command body, so its `export default` was a
  syntax error. Every other fence in that file is a plain one.

Guarded by a test per command file: compile it, then parse the output with a real
ESM parser. Reverting the matcher fails 5 of them.

---
