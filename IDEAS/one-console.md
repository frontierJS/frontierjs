---
id: one-console
status: proposed
dated: 2026-10-13
---

# Idea — One console, two targets: the tool screens in `.mesa`, and a terminal that gets them free

**Status: PROPOSED. Nothing in § 3 or after is built.** Dated 2026-10-13. Do not
cite this file as behavior — see `VERIFYING.md`. § 1 was read off the tree on
that date. § 2 is from outside the repo and was not re-checked against any of
the tools it names.

**The question:** can one long-running process be where a developer manages
everything about an FJS app (processes, services, data, live traffic, checks,
release), in the terminal as well as the browser, without building a fifth
console beside the four that exist?

---

## Trigger

The owner, while weighing `fjs-os.md`, asked for something smaller: `fli
<something>` starts a process, and every FJS task is managed from inside it,
k9s-style. The OS turned out to be packaging around a daemon and a shell. This is
the same daemon and shell with the machine left out.

---

## 1. What exists: four consoles, all hand-written HTML

**Most of the console is built. None of it is written in the framework.**

| Console | Serves | Port | What it does | Written as |
| --- | --- | --- | --- | --- |
| `fli gui` | `packages/cli/core/server.js` | 5500 | what can run, what is up, start and stop, `proves`, `check`, decisions, CI, release, publish (`overview.md` 5.24) | `cli/web/index.html`, 4,247 lines |
| the viewer | `project:map --as=serve` (`commands/project/_module.md`) | 5501 | the chain of responsibility and 18 project tabs | `cli/web/viewer/index.html`, 2,064 lines |
| Litestone Studio | `litestone/src/tools/studio.js` | 5502 | browse and edit rows | `studio.html`, 7,946 lines |
| devtools | `junction/src/plugins/devtools/` | 5503 | service calls, live, health and metrics | `admin.html`, 650 lines |

**About 15,000 lines of console, in four pages, each its own app.** All four read
`@frontierjs/css`, so they share a look but nothing else: no shared component, no
shared client, and each has its own idea of a list, a filter and a detail pane.

**The terminal half exists too.** `fli dev:tui` runs `web/src/routes` in a
terminal through Mesa's terminal backend (`FJS-D809`), and 32 of the example's 34
routes lower. Sierra's router runs over a memory history there. Keys, focus,
dialogs, scroll and forms work.

**The commands an app-level pane would wrap exist as one-shots:**
- `fli app:call` calls one service method as somebody, through the hook pipeline.
- `fli db:repl` boots a console at a gate level (`overview.md` 4.23).
- `mcp` is the agent's way into the app (`FJS-D258`).

**So the work is not building a console.** It is moving four that exist into the
one authoring model, which `FJS-D38` already says every interface uses, and then
the terminal target paints them with no second copy.

---

## 2. Prior art: the cockpit, not the output line

`terminal-surface.md` § 4 covers how a single line of output should look (Cargo,
rustc, `gh`, clack, Charm). This is the other half: a screen you live in.

- **k9s** is the model to copy. One list per kind of thing, `:kind` to switch,
  `/` to filter, and one key per action on the selected row (`l` logs, `d`
  describe, `s` shell). Nothing has to be memorized past those three.
- **lazygit and lazydocker**: panels with one-key actions, and the key legend
  always on screen.
- **Tilt** (`tilt up`) lists every dev resource with its status and logs, and
  serves the same in a terminal and a browser. That is this paper's shape.
- **Laravel Solo** is every dev process in one terminal, in tabs. It is the
  nearest match to `fli dev` with a screen on top.
- **Phoenix**: `iex -S mix phx.server` is a console inside the running app, with
  LiveDashboard beside it. It is the best version of *the app is alive and I am
  inside it*.
- **Expo CLI and Vite** add single-key actions to a dev server's own output. They
  are the floor, not the target.

**What none of them can do is FJS's edge.** Their panes are hand-built per
resource kind. Here every pane can be derived: the model list from the schema,
what a role may see from the gate, the methods from the service, the queue from
`app.jobs`. **Browse as a role**, meaning the same table viewed as a guest, a
tenant or a member, needs no new code, because the gate is declared rather than
written in handlers.

---

## 3. The proposal

**One set of tool screens, written in `.mesa`, built for two targets.**

- **Web:** `fli gui` serves them on 5500, as today.
- **Terminal:** the same screens through the `FJS-D809` path, one process, one
  key model.
- **Owner:** the screens live in `packages/cli`, which is the tooling ring and may
  read every package. Litestone and Junction keep their JSON endpoints (`studio.js`,
  devtools' WebSocket) and stop owning a page. That keeps Invariant 1 intact:
  nothing below the CLI imports Mesa for this.

**The panes**, k9s-style, `:` to switch and `/` to filter:

| Pane | Reads | Exists today as |
| --- | --- | --- |
| `:run`: processes, ports, logs, start and stop | `core/runnables.js`, `core/children.js` | `fli gui` front page |
| `:check`: `check`, `proves`, `done`, CI | `core/ci-log.js`, `DRIVES.md` | `fli gui` |
| `:decide`: the open register | `core/next.js`, `core/decide.js` | `fli gui` |
| `:data`: rows per model, **viewed as a principal** | Studio's endpoints, `db.$readAs` | Studio, `db:repl` |
| `:call`: a service method, as somebody | `app:call`'s path | `fli app:call` |
| `:live`: announcements, sockets, jobs | devtools' telemetry stream, `app.jobs` | devtools |
| `:ship`: release steps, deploy, revert | `core/release-view.js` | `fli gui` |
| `:ask`: an agent over the same app | `mcp` | `fli gui`'s ask-claude drawer, which reads console output, never the app |

**Every pane but `:ask` exists in some form.** The new work is the key model, the
move to `.mesa`, and the terminal target taking the screens.

---

## 4. Plan

### Phase 0 — Measure

Goal: know what lowers and what each console reads before anything moves.
Done when: Q1 and Q2 are ruled and the inventory in 0.1 is in this file.

- [x] 0.1 Inventory the three consoles Phases 1–3 move (`fli gui`, the viewer,
  devtools): each screen, the endpoint it reads, the components it would need
  from `@frontierjs/ui`.
- [x] 0.2 Run `bun run corpus -- --portability terminal` over the `ui` components
  that inventory names, and list the blockers.
- [x] 0.3 Price the key model (`:` / `/` / one key per action) against the
  terminal runtime's one-listener-per-renderer `onKey`.

**0.1, the inventory** (read off the tree 2026-10-21). *Kit* names
`@frontierjs/ui` components; **gap** is a screen part the kit has no component
for.

`fli gui` — 38 routes in `server.js`, every one read by the page.

| Screen | Reads | Kit | Gap |
| --- | --- | --- | --- |
| home tiles (9, each opens its panel) | each panel's own read | `StatCard`, `Badge` | — |
| `run`: what can run, start/stop, health, last output | `/api/runnables`, `/api/state` (polled), `/api/health/:id`, `/api/start/:id`, `/api/stop/:id`, `/api/output/:id` | `Table`, `Button`, `Badge`, `Dot`, `Popover`, `Transcript` | ANSI in output |
| `tree`: what you have changed | `/api/status` | `Accordion`, `Badge` | — |
| `proves`: drives a change needs | `/api/proves` | `Table`, `Badge` | — |
| `ci`: run, history, failures, fixes | `/api/ci`, `/api/ci/run`, `/api/ci/stop`, `/api/ci/fix` | `Table`, `Accordion`, `Button`, `Transcript` | ANSI in output |
| `checks`: `fli check` + doctor | `/api/check`, `/api/doctor` | `Table`, `Badge`, `EmptyState` | — |
| `next`: what to work on | `/api/next` | `Table` | — |
| `decisions`: rule an open question | `/api/decisions`, `/api/decide` | `RadioGroup`, `Select`, `Button` | — |
| `release`: steps, target, run/stop | `/api/release`, `/api/release/target`, `/api/release/steps`, `/api/release/step`, `/api/release/step/stop` | `Table`, `Select`, `Button`, `Transcript` | ANSI in output |
| `publish`: packages, bump, registry | `/api/publish`, `/api/publish/registry` | `Table`, `Checkbox`, `Select` | — |
| command runner: sidebar, form from frontmatter, streamed output, source | `/api/commands`, `/api/commands/:title`, `/api/meta`, `/api/run/:title` (stream) | `Form`, `Input`, `Checkbox`, `Select`, `Code`, `Accordion`, `Transcript` | ANSI in output; a filterable tree |
| make-command form | `/api/run/:title` | `Form`, `Input`, `Select` | — |
| palette | `/api/commands` | `CommandPalette` | — |
| ask claude drawer | `/api/ask-claude` (GET, POST, `/stop`) | `Drawer`, `Textarea`, `Select`, `Transcript` | — |
| ports drawer | `/api/ports`, `/api/ports/schema`, `/api/ports/clean` | `Drawer`, `Table` | — |
| env drawer | `/api/env` (GET, POST) | `Drawer`, `Textarea` | — |
| docs drawer, 6 tabs of static prose | none | `Drawer`, `Tabs`, `Table`, `Code` | — |

The viewer — three routes, its own server.

| Screen | Reads | Kit | Gap |
| --- | --- | --- | --- |
| the chain | `/data` | — | a node-and-edge diagram (SVG) |
| 18 tabs: issues, schema, machines, warden, services, routes, plugins, resources, channels, relations, jobs, notifications, principal, migrations, env, workflows, error paths, session | `/data` | `Tabs`, `Table`, `Accordion`, `Select`, `Badge` | `machines` draws each `@@transitions` as SVG |
| is the app up | `/state` | `Badge` | — |
| fix a secret | `/fix/secret` | `Button` | — |

devtools — its own server in the app's process.

| Screen | Reads | Kit | Gap |
| --- | --- | --- | --- |
| feed, connections, events | WebSocket `/ws` | `Table`, `Tabs`, `Badge`, `Transcript` | — |
| services | `/api/state` | `Table` | — |
| jobs: list, one, run now | `/api/jobs`, `/api/jobs/:id`, `/api/jobs/run/:name` | `Table`, `Button`, `Json` | — |
| metrics | `/api/health` | `Stat`, `Sparkline` | — |

**What the inventory says.** Every screen is a list, a form or a log, and the
kit covers all three: a log is `Transcript`, whose follow-the-bottom rule takes
any children, not only `<Message>`s. Three gaps remain. **ANSI in output**: four
screens show command output that carries color codes, and the page today strips
them (`stripAnsi`). **A diagram**: the viewer's chain and its state machines are
hand-built SVG, and on the terminal an `<svg>` paints only its `aria-label`
(slice 28). **A filterable tree** for the command sidebar. The terminal blockers
for the named components are 0.2's job.

**0.2, the terminal blockers** (`bun run corpus -- --portability terminal`,
2026-10-21). **None.** All 26 kit components the inventory names lower, and so
do the 5 more they call (31 files). The one offense in that tree is the
report's own: `FormField.mesa:227` mounts `<Control>`, a component it picks at
runtime from the control registry, and the report cannot follow a call it
cannot resolve. The compiler lowers it: `/customers/`, `/orders/create/` and
`/products/create/` mount `Form` and lower (`fli dev:tui --list` in `example/`,
32 of 36 routes). So the terminal cost of the move sits in the three gaps above,
not in the kit.

**0.3, the key model** (priced against `runtime-terminal.js` `onKey` and
`@frontierjs/mesa/keys`). **No engine work.** The keys plan (`IDEAS/keys.md`
Phases 1–2, `FJS-D1382`–`FJS-D1388`) built the engine this needs, on both
targets: vim's spelling, sequences, the 720ms timeout, and `bindings()` for the
legend. The console takes it as:

- **One `keys()` on the console's root**, with the active pane's table ahead of
  the console's own (`:`, `/`, `?`, the pane switches). The terminal hands the
  focused node `keydown` before it does anything with Tab, a dialog's Esc or
  PageUp/PageDown, so the keymap answers first and leaves what it does not
  bind to the runtime. The table binds none of those.
- **The root holds focus.** With nothing focused, a key goes to the window on
  the terminal and to `<body>` in a browser, and an element's keymap hears
  neither. So the console focuses its first pane on mount and gets focus back
  when a dialog closes, the way slice 20's dialogs return it.
- **`:` and `/` open a text field**, and from then on the field keeps every
  unmodified key (`FJS-D1386`). It closes itself on Enter and Esc. Nothing in
  the keymap has to step aside for it.
- **The always-visible legend (2.3) is `bindings()`** for the active context.
  Phase 3.4 of the keys plan builds the same for the terminal shell's `?`, so
  one of the two builds it and the other reuses it.

### Phase 1 — One screen, both targets

Goal: `fli gui`'s front page (what can run, what is up) is a `.mesa` screen.
Done when: a drive opens it in Chrome and in a pty and asserts the same rows.

- [x] 1.1 Build the front page as a `.mesa` screen in `packages/cli`, served by
  `server.js` beside the old page.

**1.1, how it is built** (2026-10-21). `packages/cli/console/Run.mesa` at
`/console/`, the old page still at `/`. **No build step**: `core/console.js`
compiles a `.mesa` per request, the shape `mesa` and `ui` already use for their
browser drives, and serves Mesa, the kit and toolbelt from the copies this
`fli` holds through an import map read off each package's `exports`. Sierra's
build was the other road and is not taken: it brings Vite, a `dist/` and an
app layout to a tool that has none of them. `@frontierjs/ui` is now a
dependency of the cli. The screen reads `/api/runnables` once and polls
`/api/state`, grouped by kind in a kit `Table` with `Badge` and `Button`; it
takes an `api` origin prop, which the browser leaves empty and the terminal
target will fill. Checked by hand in Chrome against this workspace: 237 rows,
the per-kind counts equal `/api/runnables`', live state badges, no page
errors. The same file compiles for the terminal with no refusal (`bun
scripts/tui.mjs ../cli/console/Run.mesa --frame` from `packages/mesa`); its
fetch fails there for want of an origin, which is 1.2's to supply. Health,
the last-run badge, output and a drive's *needs* are not on it yet; they
come with the panes that read them.
- [x] 1.2 The same screen through the terminal target, started by the Q1 command.

**1.2, how it is built** (2026-10-21). `fli gui` at a terminal without
`--open` starts the server quiet and mounts `Run.mesa` in the same process,
`api` naming that server; `--open`, or no TTY on stdin and stdout, is the
browser as before. The terminal half is in `core/console.js`
(`runTerminalConsole`): a Bun loader compiles each `.mesa` with `target:
'terminal'` from the same mesa root, and rewrites the browser import map's
names to files, since Bun never hands a plugin-loaded module's package
imports to the plugin. A row's `open` is a link, handed to the browser.
Ctrl+C and a signal take one exit, `shutdown` in `server.js`, which stops
what the screen started. Checked by hand in tmux against this workspace:
rows and per-kind counts paint, state polls, Tab moves focus, Enter on
`gui :8501`'s start brought it up (200) and its stop took it down, and
Ctrl+C with that child running freed both ports and exited 0. Found: a
pressed button unmounts (start becomes stop) and focus goes to nothing,
which 0.3's *the root holds focus* answers in 2.3; and the header's two
spans paint with no gap between them.
- [x] 1.3 One drive, two frames: Chrome over CDP and a pty, same rows.

**1.3, how it is built** (2026-10-21). `bun run test:browser:console` in
`packages/cli` (`test/browser/console.mjs`). It starts `fli gui --port 7501`
under util-linux `script`, 400 rows tall so every row is on the screen, then
opens that same process's `/console/` in Chrome, so both frames read one
server. The terminal frame is the stream replayed onto a grid, as `example`'s
`verify:tui` does, and parsed by the table header's column starts; the browser
frame is the same cells read off the DOM. Diffed per row: group and count,
name, state word, command, actions. Green against this workspace (237 rows),
and red with one browser state altered. Found on the way: a cell wider than
its terminal column wraps onto a line of its own, so the parse folds a line
with a blank name into the row above; and the badge's uppercase is CSS, so
the browser is read by `textContent`, not `innerText`.

### Phase 2 — `fli gui` whole

Goal: `cli/web/index.html` is deleted.
Done when: every `server.js` endpoint has a `.mesa` consumer, and the old page is
gone.

- [x] 2.1 `:check` and `:decide`.

**2.1, how it is built** (2026-10-21). `console/Console.mesa` is now the
root both targets mount: a kit `Tabs` strip, `:run · :check · :decide`, each
pane a `TabPanel` that unmounts when another is shown, so `:check`'s scopes
run only while it is in view. `Check.mesa` reads `/api/check` and
`/api/doctor` as one findings list (the machine first when it is not ok),
`/api/proves`, and `/api/ci` polled 2s live and 20s idle, with run fast,
run full, stop, rerun a phase and a failure's fix. `Decide.mesa` reads
`/api/next`'s head with its terms and `/api/decisions`, and rules through
`/api/decide` with a reason required against the recommendation. Lists show
eight and count the rest on the button. The 1.3 drive now also switches
panes in both frames (ArrowRight on the strip in the terminal) and compares
the findings count (317) and the decisions count (275): green. Not pressed
by any drive: *rule*, which writes `DECISIONS.md`, and the CI buttons, which
start a run. Left out: a CI phase's suites unfolded and a failure's output,
owed before Phase 2 deletes the old page; and *ask claude* on a failure,
which is `:ask` (Phase 5). `TIER_WORD`, the CI tones, the machine row and
the phase merge are copied from `web/index.html`, a second copy until that
deletion. Seen again: the terminal paints no flex gap, so a bar's title and
count touch (`findings317`).
- [x] 2.2 `:ship`: release and publish.

**2.2, how it is built** (2026-10-21). `console/Ship.mesa` holds the two
walked flows the old page had, the release of one app and the publish of the
workspace's packages, and `console/Flow.mesa` draws one of them: stage by
stage, a status badge per step, run, fix and stop, and the output of the last
run under its step. The steps are still the server's tables
(`/api/release/steps`, `/api/publish`), run one at a time through
`/api/release/step`, so the pane sends a step's key and nothing that becomes
argv. `Ship` grades each step the way the old page did, from a gate (the
tree, CI, the registry), from its last run, or `not run`. The verdict per app
sits under *classify* and the target read under *serving*. What reaches a
machine or npm still waits for a press. A step that `confirm`s takes a second
press on a line that says what it does to what, since a browser dialog does
not exist on the terminal. The step results stay in `localStorage` under the
old page's key where there is one, and only while the pane is mounted where
there is not (the terminal). The drive now opens `:ship` in both frames and
compares the release step count (16) and the package count (21): green.
Checked by hand in Chrome: deploy's confirm appears and cancels, and
`release:mint` for `example` ran, streaming its refusal (*no deploy block*)
into the step as `failed`. Not pressed by any drive: every step runs a real
command. Seen: a kit `Select` or `Input` inside a `cluster` takes the whole
row in the browser, so the pickers stack, and the terminal does not show that
(`:decide`'s pickers do the same).
- [x] 2.3 The key model across panes, plus the always-visible key legend.

**2.3, how it is built** (2026-10-21). One `keys()` on `Console`'s root, as
0.3 priced it: the active pane's table, then `<Esc>` clearing a filter while
one is in force, then the console's own, `1`–`4` for the panes (read off one
`PANES` list, as the `:` names are), `:` and `/`. A pane hands its table up
through a `keyed` prop as `{ keys, label, run }` rows, Haven's `HomeRow`
shape, and the label IS the action, so `bindings()` over the same tables is
the legend with nothing written twice; each pane binds `r` for its own
read-again, and `:check` binds `f`/`F` to run CI fast or full, or `s` to stop
the run going, as its bar's buttons do. `/` filters as you type: the console
hands every pane one predicate, `shown(...fields)`, and a narrowed list says
`n of m`; `:` takes a unique prefix (`:ru`), k9s's way, and names the panes
for one it cannot place. Each field's `<CR>` and `<Esc>` are a keymap on the
input itself. **The root keeps focus**: the selected tab takes it on mount,
after a pane switch and when a field closes, and a key that arrives with focus
outside the console (a pressed button that unmounted) only brings it back.
To reach the tab on the terminal, the kit's `Tab` now registers its button
with `Tabs` by reference, `Tabs` exports `focus()`, and `TabList`'s arrow
keys use the same lookup instead of `querySelectorAll`, which a terminal node
does not have (`FJS-2391`'s rule). **The legend** is `Legend.mesa`, plain
text: in the terminal `runTerminalConsole` mounts it in mesa's `footerOf`
strip, as sierra's mode line is, and in the browser it sits at the page's foot
(sticky); it reads a signal either way, since the footer is a second root that
hears no prop. It is text and not buttons because focus inside that second
root would be outside the keymap. The drive now presses the keys in both
frames: the legend compared on every pane, `/drive` narrowing both to the
same rows and Esc restoring them, `2` `3` `4` reaching the panes, and `:ru`
coming back: green, and red with the Esc keymap left out. Found on the way: a
terminal can hand `:ru` over in one read, so the `ru` landed on the tab before
the flush that mounted the field; `:` now flushes and focuses in its own turn
(`flushSync`). Still seen: the header title and its count touch
(`release16 steps`), and the kit pickers stack in the browser.
- [x] 2.4 The viewer.

**2.4, how it is built** (2026-10-22). The viewer is the console's fifth
pane, `:map` (`console/ProjectMap.mesa`), and `project:map --as=serve` is
gone with its server, its port (5501) and `web/viewer/index.html`: `FJS-D1389`
put one command on one console, and a second server drawing the same screen is
the second name it refused (`project:map` keeps the report and `--json`,
as `app:atlas` lost its `--as` under `FJS-D401`). The map is still
`buildProjectMap`: `server.js` spawns `project:map --json` in the app's root
for `/api/map?app=<dir>` (`core/map-view.js`, about a second with the atlas
boot), so no second reader exists. A workspace holds several apps, so the pane
has a picker; an app is a directory with `db/schema.lite`, out of the root
and the surfaces' dirs, looked up by name and never joined onto a path. The
pure half of the old page (the model, the findings, the machines and their
layout, `wardenAt`) is `console/map-model.js`, and its two tests import it
rather than evaluating a page's script block; the reference data is
`map-reference.js`. The one write, a secret into the app's `.env`, is
`core/env-health.js` now, shared with `project:map`'s report and refused
from a foreign origin, which the old `/fix/secret` was not. The chain draws
as lanes of buttons joined by text arrows, so the terminal reads the same
run; a machine's board is an SVG, which the terminal paints as its
`aria-label`, so its moves are also buttons and either opens the detail.
Keys: `r` reads again, `n`/`p` step through the 18 lists, `a` the next app,
and `/` filters every list with `n of m`. The theme picker did not come
along. The tutor's lesson 3 reads `:map` off the `fli gui` it already
started. The drive presses `5` in both frames and compares the issue count
and the legend: green. Checked by hand: the chain, machines and Warden in
Chrome and in the terminal. Found on the way: `.lane` and `.rail` are
`@frontierjs/css` classes, and a space opening an `{#if}` or closing an
`{#each}` body is trimmed, so a terminal line glued badge to text until
the separator became an expression.

### Phase 3 — The app half

Goal: the running app is visible and callable from the same process.
Done when: a drive calls a method as a member, sees its announcement on `:live`,
and sees a guest refused on `:data`.

- [x] 3.1 `:live` over devtools' stream; `admin.html` is deleted.

**3.1, how it is built** (2026-10-22). `console/Live.mesa` is the sixth pane
(`6`). Devtools still owns every reading and now serves no page: its root
answers 404 naming `:live`, and its socket and JSON reads stay for this pane
and Sierra's toolbar. The console cannot read devtools from a browser, which
is another origin that allows none, so `server.js` carries it
(`core/live-view.js`): `/api/live/stream` is devtools' socket relayed a frame
a line, with an `open` and a `closed` of the relay's own so a quiet app and an
absent one differ, and `/api/live/health`, `metrics` and `jobs` are reads,
with retry, cancel and run now as POSTs refused from a foreign origin. Each is
an allow-listed shape, never a path joined onto the target. The pane follows
the stream while it is up and again when it drops, and polls the queue and
readiness only while it is open. Not running is a sentence naming where it
looked, never empty lists. `fli gui --devtools-port` names a devtools off the
reserved 5503, since the tutor runs it on 7503 and the drive must not grade a
dev's own app (decision-rules answered in the session; it matches
`tutor:tools`' own flag). The 1.3 drive now boots a Caravan app with devtools
on 7503, presses `6` in both frames and compares the call and job counts, then
in Chrome opens a payload, retries a dead job through to done, runs a handler
by hand and sees a new call arrive: green. Junction's `verify-devtools.mjs`
and its `test:browser` went with the page they drove; their assertions are
those. Tutor lesson 4 points at `:live` and asks that `fli gui` reaches
devtools: the CI tutor phase is green. Found on the way: Caravan reports a
failed job as `dead`, which the old page never offered retry on. Not carried
over: the feed's pause, the per-call expand, and the status pills (`/` filters
every list instead).
- [x] 3.2 `:call`, as somebody.

**3.2, how it is built** (2026-10-22). `console/Call.mesa` is the seventh
pane (`7`). The call runs inside the running app, not through `app:call` as
the pane table above said: `junction call` boots a copy whose bus nobody is
on, so its announcement would never reach `:live` or an open tab, which this
phase's done line asks for (`FJS-D1426`, ruled in session). Devtools answers
`GET /api/call` (each service's methods, the hook-bypass twins left out) and
`POST /api/call`, which is refused outside development: acting as somebody
in production is auth's support mode. What `tools/call.ts` held (the method
check, positional arguments, `$`-keys as directives, `--as` through
`findPrincipal`, nobody as `reenterAs(null)`, the status from
`toFrameworkError`) is now `junction/src/core/call-as.ts`, which both callers
run, so `junction call` is argv and printing. `core/live-view.js` carries it
as `/api/live/call`, a POST refused from a foreign origin. The pane lists the
methods per service as buttons and takes three fields: as whom (empty is
nobody, never the app), the arguments as comma-separated JSON in the method's
own order (`12, {"note":"late"}`), and a tenant. Each answer keeps its
standing and its status, and the newest shows its result. Keys: `r` reads
again, `x` makes the call once a method is picked, and `/` filters the
methods and answers. Litestone's `index.d.ts` now declares `findPrincipal`,
which it already exported. The drive's app now has a `User` and a `Note` only
a person may write. The drive presses `7` in both frames and compares the
method count (15). Then, in Chrome, it creates a note as `ann@x.test` (ok,
standing `User 1`, the row back) and as nobody (403). It presses `6` and sees
both calls in the feed, as user 1 and as a guest, plus `notes:created` on the
bus: green. With nobody run as the app (no `reenterAs(null)`), the nobody
check and its feed row go red. Seen: `:ship`'s release count read 15 in the
terminal against 16 in the browser in 2 of 4 runs, and nothing in this step
touches it.
- [x] 3.3 `:data`, viewed as a principal.

**3.3, how it is built** (2026-10-22). `console/Data.mesa` is the eighth
pane (`8`). It reads inside the running app, not Studio's endpoints as the
pane table above said (`FJS-D1427`, ruled in session): Studio is a second
process, grades by toolbelt's default unless started with `--gate`, and runs
no principal as `asSystem()`. Devtools answers `GET /api/data` (the models
and views off the app client's `$schema`) and `GET /api/data/<Model>?as=&tenant=&limit=&offset=`,
which `rowsAs` in `junction/src/core/call-as.ts` reads through `app.withDb`
inside `app.runAs`, so the gate, the row policies and redaction answer as
for a request. The principal lookup `callAs` held is now `standingOf`, and
nobody is `reenterAs(null)` for both through one `asWhom`. Rows are refused
outside development, as a call is; the model list is not. `modelToAccessor`
is now on litestone's main entry, so junction asks Invariant 2's one answer.
`core/live-view.js` carries both as `/api/live/data…`. The pane lists the
models as buttons, takes as whom (empty is nobody) and a tenant, and shows a
page of 50 with its standing, a cell cut at 60 characters; `r` reads again,
`n`/`p` page, `/` filters models and rows. Reads only: editing stays
Studio's. The legend's eight pane digits are now one row,
`1–8 the panes`: the eighth wrapped it past the drive's 160 cells, and the
wrapped `/drive` parsed as a row. The drive's app now has a `@@gate(3)`
`Memo`. It presses `8` in both frames and compares the model count (3),
then in Chrome reads `Memo` as nobody (403, `requires level 3, user has
level 0`) and as `ann@x.test` (the row), and `Note` as nobody (no rows, the
policy) and as ann (the note `:call` wrote): green. With nobody run as the
app, the `:call` and `:data` nobody checks go red (4).

### Phase 4 — Studio — DEFERRED

Goal: `studio.html` is deleted.
Done when: litestone's five `verify:studio:*` drives pass against the `.mesa`
screens.

Deferred by the owner, 2026-10-22: `studio.html` stays a hand-written page in
litestone, and Phase 5 goes next. Nothing reopens this phase but the owner, and
Q3 is asked only then. `:data` (3.3) already covers reading rows as a principal;
editing rows stays Studio's.

- [ ] 4.1 Port Studio's screens. At 7,946 lines it is the largest console, so it
  goes last, after the panes it shares components with exist.

### Phase 5 — `:ask`

Goal: an agent pane over `mcp`, graded like any caller.
Done when: Q4 is ruled and a drive shows a call refused below the agent's
standing.

- [ ] 5.1 `:ask`

---

## 5. The nine questions (`decision-rules`)

1. **Origin.** Today the same fact (what a list looks like, how a row filters) is
   written four times, in four pages. This proposal removes copies and adds none.
   The risk is a pane that caches what an endpoint owns.
2. **Concept.** No new noun. *Console* is the existing word, as in devtools'
   "API admin console". `sysadmin-console.md` is a different audience (an app's
   operators, in production) and stays separate. Q1 keeps the noun count at
   zero.
3. **Complexity.** It removes about 15,000 lines of hand-written HTML. The added
   complexity is the key model and a second target per screen, and the second is
   already paid by `FJS-D809`.
4. **Predictability.** A tool screen becomes an ordinary `.mesa` screen. Learning
   one teaches the rest, which four separate HTML pages do not.
5. **Derived.** Panes derive from the schema, the gate, `svc.describe()` and
   `runnables.js`. None hand-lists a model or a method.
6. **Owner.** `packages/cli` owns the screens. `studio.js` and devtools keep their
   endpoints. The terminal paint is Mesa's backend, not a second renderer.
7. **Boundary.** A screen reads an endpoint and never imports litestone or
   junction internals. That keeps the terminal and the web copy identical.
8. **Failure.** A screen that does not lower is refused by name, as
   `fli dev:tui --list` does today. An app that is not running shows each app
   pane as *not running*, never as empty.
9. **Silence.** *The two targets show the same rows*: Phase 1.3's drive,
   `test:browser:console`. *A deleted page left no reader behind*: the
   `server.js` endpoint list against its consumers, which is `none` until
   Phase 2's done line is a check.

**Adjudication in tension: the paved road vs. the workaround.** The four
consoles are workarounds (hand-written pages beside a framework that claims every
interface). Moving them onto the paved road is the ruling's direction.

**Tier: Assessment.** A choice from the questions below becomes a ruling in
`DECISIONS.md`.

---

## Open questions

- ~~**Q1 — What starts it?**~~ **Answered 2026-10-22 (`FJS-D1389`): B — `fli gui`, which picks the terminal target when it is started in a terminal without `--open`, and the web target otherwise.**
  - **A** — `fli runtime`, as the owner first said it. It collides with "the FLI
    runtime" (`server.js`'s own header) and with Mesa's runtime.
  - **B** — `fli gui`, which picks the terminal target when it is started in a
    terminal without `--open`, and the web target otherwise.
  - **C** — a new `fli console` command beside `fli gui`.
  - **Recommend B** — one command and one noun for one console. A and C put two
    names on the same screens.
- ~~**Q2 — Does `FJS-D810`'s line reach this?**~~ **Answered 2026-10-22 (`FJS-D1390`): A — yes: tool screens count as the stressor, so the work starts now.** `FJS-D810` admits the terminal
  shell as a stressor, with shipping a terminal app to users deferred past
  alpha. A developer tool is used daily but is not a user's app.
  - **A** — yes: tool screens count as the stressor, so the work starts now.
  - **B** — no: wait until core leaves alpha (`FJS-D14`).
  - **Recommend A** — the tool screens are a second corpus for the IR, written by
    the same people who maintain it.
- **Q3 — Where do Studio's screens live?** Deferred with Phase 4 (owner, 2026-10-22).
  - **A** — in `packages/cli`, with the other three. Studio stays reachable from
    an app without the CLI only through its endpoints.
  - **B** — in `packages/litestone`, compiled ahead of time so Litestone ships
    built output and takes no Mesa dependency.
  - **Recommend A** — one owner for tool screens. B keeps a second console app
    alive inside the spine.
- ~~**Q4 — Who decides what `:ask` may do?**~~ **Answered 2026-10-22 (`FJS-D1391`): A — the agent calls through `mcp` at a declared standing, like any caller.**
  - **A** — the agent calls through `mcp` at a declared standing, like any
    caller.
  - **B** — the agent inherits the developer's standing.
  - **Recommend A** — `FJS-D258` already made the gate the agent's permission
    model. B gives the agent a standing nobody declared.

---

## See also

- `terminal-surface.md` — the output-line half, and `FJS-D809`/`FJS-D810`.
- `mesa-ir.md` — the IR the terminal target consumes.
- `fjs-os.md` — the same daemon and shell, with the machine included.
- `sysadmin-console.md` — the operators' console, a different audience.
- `DECISIONS.md` `FJS-D38` (every interface is `.mesa`) · `FJS-D258` (the agent
  surface).
