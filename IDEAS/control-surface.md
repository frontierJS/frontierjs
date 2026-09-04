---
id: control-surface
status: shipped
dated: 2026-08-26
---

# Idea — the control surface: one page that shows what can run, what is running, and starts it

**Status: SHIPPED.** Dated 2026-08-26; all six steps of §8 landed 2026-08-27 and
are behavior, not proposal. §1–§7 are the argument that produced them and are
kept as the record; **§9's open questions are still open** and one of them —
whether a started server should outlive the GUI — is now a thing a person will
notice rather than a thing to reason about. Do not cite the rest of this file as describing behavior — see
`VERIFYING.md`.

The third `*-surface` paper and the one with the least new machinery under it.
`command-surface.md` asks how a command is authored, `terminal-surface.md` asks how
its output looks. This one asks the question a person has when they sit down: **what
can I start here, and what is already up.**

---

## 1. The observation

Count what a person in this workspace can start:

| Kind | How many | Where the list lives |
| --- | --- | --- |
| Tooling servers on the reserved block | 4 (`gui` 8500 · `project:view` 8501 · `db studio` 8502 · junction `devtools` 8503) | `core/ports.js` § GLOBAL |
| Surface categories per app | 7 (api · web · site dev · site served · widgets dev · widgets served · extension dev) | `core/ports.js` § CAT, `appPorts()` |
| Apps with ports assigned | 8 | `core/ports.js` § PROJECTS |
| Browser drives | 25 | `verify*` scripts in 5 `package.json` files |
| Package suites | 20 | `test` scripts, one runner each and they differ |
| CI phases | 12 | `scripts/ci.mjs`'s `main()` |
| `fli` commands | 236 | the command tree |

Every one of those is derived from a file that already exists. None of them is in
front of a person at the moment they need it, and the two documents that come
closest — `CLAUDE.md` § Running things and `repo-map.snapshot.html` — are **read**
rather than **used**: they tell you the port and the script, and then you go and
type it in a terminal, and neither of them can tell you whether the thing is already
answering on that port.

That is the whole complaint. The inventory problem is solved. The **state** problem
and the **reach** problem are not.

---

## 2. What is already built, which is most of it

This proposal is small because three of its four parts ship today and were built for
other reasons.

**The inventory is derived and committed.** `packages/cli/core/repo-map.js` already
reads drives out of `package.json`, ports out of `ports.js`'s registry, CI phases out
of `ci.mjs`'s own `main()`, snapshots out of `snapshots.js`'s walker, and commands out
of the command tree. Its header states the rule this proposal inherits without
changing a word: *nothing here is typed twice — every row comes from a file that
would break something else if it were wrong.* The output is `repo-map.snapshot.html`,
gated by the `snapshots` CI phase.

**Liveness is already answerable.** `core/ports.js` exports `isPortInUse(p)` and
`busyPorts(ports)`, and `appPorts(appRoot, { exists })` already answers *which
surfaces does this app have, and therefore which ports* off the file tree. `readLock`
and `getSessionStatus` hold the claims, and `fli ports:status` prints them.

**Running a command from a browser is already built.** `core/server.js` is 441 lines
that take the same `Command()` the CLI takes and stream its output as SSE, and
`fli gui`'s page already has the console to print it in, a ⌘K palette, a themed
shell, a ports drawer and an env drawer.

**What is missing is the join.** Three facts — *what could run*, *what is running
now*, *start it* — each have an owner, and nothing puts them on one page. `fli gui`'s
front page is an empty state that says *select a command*.

---

## 3. Where it should live, and the argument against a new port

The instinct is a new command on a new port. **That instinct is wrong here and the
reason is the problem statement itself**: the complaint is that there are too many
things to keep track of, and a fifth server on a fifth port makes the thing it fixes
one item worse. `GLOBAL` has five free slots and this is not what they are for.

So: **it is `fli gui`'s front page.** 8500 is already the number typed from memory,
the shell is built, the SSE runner is built, and every tile's *run* action is a
command the runner can already execute. `fli project:view` becomes a tile on it
rather than a rival to it — which is also the honest reading of what `project:view`
is: a map of one app's chain of responsibility, excellent, and not a place from which
anything is launched.

The alternative worth stating so it can be rejected on the record: `fli dash` as its
own command that *serves the same page* and exits after opening it. That buys a
shorter word and costs a second answer to *where does the dashboard live*. If the
word matters, `fli dash` should be an alias that starts `fli gui` on its home route.

---

## 4. What a tile is

One row per runnable thing, grouped by kind, each carrying four columns:

- **What it is** — a name and the directory it runs in, because a runner differs per
  package and `bun test` in mesa produces ~35 failures that belong to nothing.
- **How it starts** — the exact command, taken from the file that declares it.
- **What state it is in** — *not running* · *answering on :8110* · *claimed but
  dead*. The third is a real failure mode this repo already has a lock file for.
- **What you can do** — open · run · stop.

Grouped by kind, and every group's rows derived:

| Group | Derived from | Notes |
| --- | --- | --- |
| **Surfaces** | `appPorts()` over the app's own directories | The `strictPort` invariant means the number in the config is the number to probe |
| **Tools** | `ports.js` § GLOBAL | `devtools` is the odd one: an *app* configures it, `fli` cannot start it, so it can only be linked when it answers |
| **Drives** | `verify*` scripts | Needs a preamble it cannot see today — see §6 |
| **Suites** | `test` scripts, one per package | The runner difference is the reason the directory is shown |
| **CI phases** | `ci.mjs`'s `main()` | `--only <pkg>` is already a flag; the tile can carry it |
| **Snapshots** | each `*.snapshot.*` file's own header | The generator command is in the file, which is what the `snapshots` phase relies on |
| **Commands** | the registry | Already the sidebar; the dashboard's job is only to surface the handful you actually use |

**No tile is hand-written.** A row somebody maintains is a row that goes stale, which
is the argument the `snapshots` CI phase already makes by carrying no list of what
exists. If a thing cannot be derived, that is a finding about the thing — see §6.

---

## 5. Three tiers of runnable thing, and only one of them is derivable today

§4's table quietly assumes every runnable thing is declared in a file `fli` can
read. Boot `example`'s API and that assumption falls over in the first nine lines:

```
🚀 shop v1.0.0 url=http://0.0.0.0:8110 routes=31 services=20 autoload=api/src/services prefix=/api health=…
  [mail] dev sink on http://localhost:8111 — inbox: http://localhost:8111/  ·  json: …/outbox
  [psp]  dev provider on http://localhost:8112 — GET http://localhost:8112/v1/intents
  [idp]  dev identity provider on http://localhost:8113
```

Four servers, one command, and **`ports.js` knows about exactly one of them.**

| Tier | Example | Who knows | Mechanism the page needs |
| --- | --- | --- | --- |
| **1 — framework-declared** | api 8110 · web 8010 · site 8610/8710 · the 8500 block | `ports.js` § CAT + PROJECTS, `appPorts()` | derive from the file tree |
| **2 — app-declared side servers** | mail sink 8111 · payment provider 8112 · identity provider 8113 | **nothing that is data** | the app has to declare them — see below |
| **3 — runtime self-description** | `routes=31 services=20 prefix=/api devtools=disabled` | the running app | **ask it**, do not guess |

**Tier 3 is already solved and the page should lean on it hard.** Junction answers
`/manifest`, `/health` and `/metrics`, `svc.describe()` is the one answer to *what is
this service*, and `surface.snapshot.md` is the committed version of the same fact.
So the split is clean and worth stating as the page's own rule: **the tree says what
COULD run, the process says what IS running.** A tile for a live app should read its
route count, its prefix and its health off the app rather than re-deriving them, which
is also the only version that cannot be wrong.

**Tier 2 is the gap, and it is an Axiom 1 miss sitting in the middle of this
proposal.** `8111` exists in three places today — a literal in
`example/api/src/providers/mail/sink.ts` (with an env override), a row in `CLAUDE.md`'s
prose ports table, and a hand-written `console.log` in `example/api/index.ts`. None of
the three is data. They agree today; nothing makes them agree.

Two things follow, and the second is the proposal:

- **The numbers are already derivable and are being typed by hand.** `port('be', {
  projectId: 1, serviceId: 1 })` is 8111, `serviceId: 2` is 8112, `serviceId: 3` is
  8113 — the formula produces exactly what the literals say. An app starting a side
  server should ask for a service slot, not pick a number, or the next app to grow a
  mail sink picks one by hand and collides with something.
- **A side server should be claimed the way everything else on `app` is.**
  `app.registerDevService({ name, url, note })` — the same shape as
  `app.registerMetricsSource` and `app.registerHealthCheck`, which already exist and
  already merge into `/metrics` and `/health`. One declaration, three readers: the
  boot banner prints it, `/manifest` carries it (it is `devOnly` already, which is
  exactly the right lifetime), and this page lists it. The banner then stops being the
  only place that knowledge lives.

Without that, a tile for the mail sink can only be hand-written, which §4 forbids.

**The curl block is the same shape one level up.** `example`'s banner ends with four
hand-written lines that are the best *what can I do now* text in the repo:

```
curl http://localhost:8110/api/products      # 200, the catalogue reads at 0
curl http://localhost:8110/api/orders        # 401, the ledger does not
```

The 200/401 half is not editorial — it is `db/access.snapshot.md` and
`surface.snapshot.md`, which hold the gate level and the mounted path for every
service and are already committed. So a tile for a live API can offer *the endpoints
that answer to nobody* and *the ones that refuse* derived, and the app's contribution
is only which handful to feature. That is a `pinned:` list of four strings against a
paragraph of prose, and it is the same trade the whole page is making.

## 6. What it must not become

- **Not a process supervisor.** It can start what it started and stop what it
  started. A server somebody launched in their own terminal is *answering on :8110*
  and there is no stop button on it. Say so in the tile rather than pretending.
- **Not a second answer to which port a thing takes.** `ports.js` stays the schema;
  the page reads it and never guesses.
- **Not a health check.** A port answering is not an app working — `example`'s own
  deploy phase exists because a container that answers `/health` can still be unable
  to log anybody in. The tile says *answering*, never *healthy*.
- **Not gated on the network or a daemon.** Same rule the `registry` and `deploy` CI
  phases follow: a row it cannot probe reads *unknown* and says why.

---

## 7. The one thing that is not derivable, and it is a finding

**A drive's preamble exists only in prose.** `CLAUDE.md`'s drive table carries a
*Start first* column — `verify:live` needs `db:seed`, then `api` and `web`;
`verify:site` needs a build first; `verify:cart` needs nothing because it starts and
stops both servers itself — and there is no machine-readable form of it anywhere. The
drives themselves know: they exit 1 naming the missing process. So the knowledge
exists twice, in a prose table and in an error string, and in neither place can a
dashboard read it before pressing the button.

Two ways out were weighed, and the second was better:

1. Declare it — `"fli": { "needs": ["db:seed", "api", "web"] }` beside the script.
   Cheap, and it is a third copy that can drift from the other two.
2. **Make the drive's own refusal structured** — the drive already checks; have it
   check on request. `verify:live --preflight` (or the same check behind `--json`)
   answers what is missing without running the assertions, and the dashboard runs
   that before it offers the button. One owner, which is the drive, and it makes the
   error message and the dashboard the same answer.

**A third way is what shipped, 2026-08-29, and it dominates the first on the first's
own argument: READ THE PROSE TABLE.** *Start first* adds no copy at all — it is the
copy people already maintain, finally read, which is exactly the move `proofs.js`
made on the table beside it. `core/preflight.js` parses it, `runnables.js` puts the
resolved steps on the drive's row, and the page walks them.

What that does not close is drift against the drive's own check, and no parse can
reach it; `--preflight` is still the way to close that half. What it does close is
the half that actually bites — a step whose script has been renamed — because
`fli check`'s `drive-preamble` grades every step against the directory that would
have to run it. Reading beat declaring, and it beat asking, because the answer was
already written down.

Option 2 is also `command-surface.md` 4.2b's argument arriving from a different
direction: **a command that answers a machine is a command a dashboard can compose.**

---

## 8. What would have to be built

Six steps, all shipped 2026-08-27. Each names what proved it, because the one
thing this page cannot have is a row that is wrong with nothing saying so.

### 1 — ~~`packages/cli/core/runnables.js`~~ — shipped 2026-08-27

One module answering *what can run here*, as a flat list of one shape:

```js
{
  kind:   'surface' | 'tool' | 'drive' | 'suite' | 'phase' | 'snapshot' | 'command',
  id:     'example/api',            // stable, and the key /api/state answers under
  name:   'api',
  dir:    'example',                // where the command is typed — runners differ per package
  start:  'bun run api',            // null where nothing here starts it
  port:   8110,                     // null where it takes none
  open:   'http://localhost:8110',  // null where there is nothing to open
  needs:  ['db:seed'],              // §7; [] until a drive can be asked
  source: 'example/package.json',   // the file this row came from
}
```

`source` is not decoration — it is `repo-map.js`'s own rule made checkable: every row
comes from a file that would break something else if it were wrong, so a wrong tile is
traceable to the file that produced it rather than to this module.

**It is a FACTORING, not a second reader.** `repo-map.js` already holds `drives()`,
`ports()`, `apps()`, `ciPhases()`, `snapshots()` and `packages()` as private
functions. The readers move here and `repo-map.js` imports them; writing new ones
beside them is the exact failure this page exists to reduce. Zero dependencies, node
or bun — its callers include a script that runs before install.

Takes a root and answers for either scope, which is open question 1's shape: an app
root gives that app's rows, a workspace root gives every app's plus the workspace's
own (phases, suites, snapshots).

**Proved by** `packages/cli/tests/runnables.test.js` — 16 tests over a temp fixture
tree, two of them mutation-checked. 92 rows on this workspace. The factoring is proved
by BYTE EQUALITY rather than by a suite: the old `repo-map.js` and the new one render
one identical page over one tree, 62,246 characters each.

**Two corrections the build made to this section.** The tools list matches a command
to a reserved slot by that command's own `port` flag default rather than by a table —
which is what found `FJS-557`, studio reserving 8502 and defaulting to 5001. And **CI
phases are not rows**: `scripts/ci.mjs` has no per-phase flag, so a phase tile could
only run all twelve; the runnable is `bun run ci`, a task. `kind` is therefore
`surface · tool · drive · suite · task · snapshot`, with commands left to the sidebar
that already answers them.

### 2 — ~~`app.registerDevService()`~~ — shipped 2026-08-27

`{ name, url, note }` on the app, keyed by name, beside `registerMetricsSource` and
`registerHealthCheck`. Two readers: the boot banner prints one line each after the
app's own, and `/manifest` gains a `devServices` section — the one section a sidecar
could never reach by mounting a route. `example`'s three sinks are on it and its three
`console.log`s are gone. Announcing is all it does; junction never starts, stops or
health-checks the process.

**The port-formula half is deliberately NOT done.** `example/api` does not depend on
`@frontierjs/cli`, and taking a dependency on it to compute one number is a worse
trade than the literal — so each sink names its slot in a comment instead and the
number traces back without the import.

**Proved by** `packages/junction/tests/dev-services.test.ts`, whose manifest case
carries its own negative control: neither sink mounted a route, so every other section
of that document is blind to them. Both guards mutation-checked.

### 3 — ~~two endpoints on `core/server.js`~~ — shipped 2026-08-27

- **`GET /api/runnables`** — the inventory. Cached on the same TTL the command
  registry already uses (2s): both walk the filesystem, and a page polling state must
  not re-walk the tree on every tick.
- **`GET /api/state`** — the probe, keyed by the same `id`. Per row:
  `{ state: 'down' | 'up' | 'claimed-dead' | 'unknown', since?, pid? }`.
  `up` is `busyPorts()`; `claimed-dead` is a lock-file claim over a port nothing
  answers, which is a real failure this repo already has a lock for; `unknown` is a
  row with no port, and it is a state rather than an omission — *nothing here can
  tell* and *not running* are different sentences.

**A poll, not SSE.** The server already streams command output over SSE and this is
not that: there is no event to push, because a probe is a question somebody has to
ask. ~3s from the page, and the tick is visible in the UI so a stale reading cannot
be mistaken for a live one.

**Proved by** six cases in `tests/server.test.js`, two mutation-checked — including
a real socket bound and released, so a row moves `down → up → down`.

### 4 — ~~the front page~~ — shipped 2026-08-27

Tiles where `web/index.html`'s empty state is, grouped by `kind` in §4's order,
each row: name · directory · state · actions. The shell, the theme, the ⌘K palette
and the output console are already there and unchanged.

**It must compose the design system rather than style itself.** `@frontierjs/css` is
already loaded; a class it does not define is markup that looks styled and is not, and
nothing checks a class name. Read `vocabulary.json` (55 terms, with `anatomy` giving
the canonical block for each) rather than guessing — `.surface`, `.rows divided`,
`.btn`, `.badge` are the four this needs. A bare `var(--x)` naming a token nothing
declares drops the whole declaration, which `fli check`'s `css-token-undefined` will
now catch.

**Proved by `bun run test:browser`, this package's first browser drive** — mesa's CDP
harness by relative path, the way `@frontierjs/ui`'s reads it. Ten assertions, two
mutation-checked, run against the REPO rather than a fixture, because what a fixture
cannot answer is whether the real thing has any rows at all.

**Its first run corrected this section rather than the page.** *No open links are
offered while nothing is answering* expected zero and found two — `example`'s api and
web, genuinely up on the machine it ran on. It asserts the rule instead: open is
offered exactly where a row is answering, which is the half that survives a developer
having things running.

### 5 — ~~start and stop what the page started~~ — shipped 2026-08-27

`POST /api/start/:id` spawns the row's `start` in the row's `dir` and records the
child; `POST /api/stop/:id` kills one it holds. Children die with the GUI process
unless open question 2 is answered the other way.

**The refusal is the design.** A row that is `up` and not in the child table gets no
stop button and says why — *started elsewhere*. A page that offered one would be a
process supervisor, which §6 forbids, and the failure mode is killing something
somebody else is using.

**Proved by** `tests/children.test.js` (12, hermetic through a `spawnFn` seam), four
route cases in `tests/server.test.js`, and eleven in the browser drive — start, poll,
stop, and both refusals on screen. Three guards mutation-checked.

**What this step actually cost, and it is the correction worth keeping.** A child is
a LAUNCHER: `bun run api` is bun running a script that spawns the app, so signaling
the pid kills the wrapper and leaves what it started running. It was found the
expensive way — the first HTTP test started the first `bun` task it found, which in
this package is `bun run test`, so the suite ran itself and stopping it reported
success while a tree of suites went on forking. For a server the same shape is
quieter and worse: stop answers 200 and the port keeps answering. `detached: true`
and a `-pid` kill. **And a suite must never spawn a real project command**, because
the command it picks may be the suite.

### 6 — ~~the tools become tiles~~ — shipped 2026-08-27

`fli project:view`, `db studio` and junction's `devtools` are rows in the **tools**
group, read from `ports.js` § GLOBAL. Their commands are unchanged.

**And `project:view` grows a live badge**: it maps one app's chain of responsibility
and says nothing about whether that app is up, which is a fact its own reader wants
and which `/health` already answers. It reads state; this page starts things. Neither
becomes the other.

**Proved by** a test that adds a slot to `GLOBAL` and asserts a tile appears with
nothing edited in `runnables.js` — mutation-checked by hardcoding the four current
tools, which turns it red. Plus `tests/pview-state.test.js`, which boots the real
command, because the thing under test is the WIRING and that is fine in isolation
while being absent from the command file.

**The tools needed no work, which was the point** — they have been derived from
`GLOBAL` since the inventory shipped. What the step actually cost was `probeState`
getting ONE owner: it moved into `core/runnables.js` and both servers call it, so
*is it answering* has one answer rather than two that can disagree. It takes rows
rather than a root and its child lookup is injected, because `project:view` starts
nothing and must not import a table of processes to ask whether an app is up.

**And the badge is the app's own surfaces, not the tooling block**: `fli gui` being
up is not a fact about the app this page maps.

## 9. Open questions

- **Whose project?** This workspace has eight apps with assigned ports; a client app
  has one. `project:view` takes `--project`. Does the dashboard show one app or the
  workspace? Probably: one app by default, the workspace when `fli` is run from its
  root, which is a distinction `context.wsRoot()` already makes.
- **Does a started server outlive the GUI?** A child of the GUI process dies with it,
  which is tidy and is not what somebody who just started `api` expects. Detaching
  buys the expectation and costs the stop button.
- **How does a tile know a port is *its*?** A port answering is not proof it is the
  thing the tile names — this is exactly the failure `strictPort` exists for. A probe
  of `/health` or `/manifest` narrows it for an API and answers nothing for a static
  origin.
- **Is `repo-map.snapshot.html` then redundant?** No, and the split is worth stating:
  the snapshot is a **committed artefact reviewable in a diff**, the dashboard is
  **live and never committed**, the same split `fli ws:atlas` and `ws:atlas --live`
  already make.

---

## 10. What it could grow, and what it must not

Read against the tools that solved this before: Tilt, Overmind and Foreman for
processes, Vitest UI and Wallaby for a test board, Nx and Turborepo for a task
graph, Tilt and Nx `affected` for *what does my change touch*, Laravel Herd for
local URLs, Docker Desktop for state. Ranked by value × fit, not by novelty.

**Three are worth building and one of them is not really this page's.**

1. ~~**`needs` — one button starts the whole thing.**~~ **Shipped 2026-08-29.**
   `verify:live` needs `db:seed`, then `api` and `web`, and that was three rows
   pressed in order with the order living in prose. The preamble is read off
   `CLAUDE.md`'s own *Start first* column (§7, third way), shown on the row before
   anything is pressed, and walked by the page — **a step already answering is
   skipped**, which is what makes it the only start button a drive needs. The
   sequence is on the page and not on the server, so each step lights up as it
   goes: *the API is still coming up* and *the API failed to start* are different
   things to look at. *Rails `bin/dev`, a Procfile, Tilt's resource deps.*
2. ~~**Last-run memory — the page becomes a test board.**~~ **Shipped 2026-08-29.**
   The child table held an exit code and sixty lines of output and threw both away
   — `stopRow` deleted the entry and `startRow` overwrote it — so every drive and
   every suite read `unknown` forever, which is the honest answer to *is it
   running* and no answer at all to *does it pass*. A row now carries a second
   badge: passed or failed, how long, how long ago, and the kept tail behind a
   click. **Two badges, one fact each** — a single one saying `exited 0` had to
   choose between *is it running* and *did it pass*, and chose the one that
   disappears.

   Three things it decides, and each is the honest half of a pair. **`stopped` is
   not `failed`** — a SIGTERM looks the same whoever sent it, so the stop is
   marked before the signal, and without that the page tells somebody their drive
   broke when they are the one who stopped it. **The words are the page's, not the
   process table's** — a suite that exits 0 passed, and a dev server that exits 0
   on its own did something nobody has a word for, so `children.js` keeps facts
   and the kind chooses the vocabulary. **In memory, and it says *here*** —
   persisting would claim a verdict about a tree that has moved on, and it would
   still know nothing about the runs somebody did in a terminal. *Vitest UI,
   Wallaby, an Actions run page.*
3. ~~**What should I run for what I touched.**~~ **Shipped 2026-08-29.**
   `CLAUDE.md` already carried the map — *sierra router → `verify` +
   `verify:build`* — as a table nothing read and nothing checked. It is the one
   idea here that no other framework's dashboard could copy, because no other
   framework wrote the table. **It is its own paper** (`IDEAS/proof-map.md`) and
   only ends up on this page because this page is where the answer is pressed:
   `GET /api/proves` resolves both columns and the panel above the tiles renders
   each answer as the same start button the tiles carry. *Tilt's graph, `nx
   affected`.*

**Two more are cheap and close gaps this file already names.**

4. ~~**Health rather than answering.**~~ **Shipped 2026-08-29.** §6 states the
   limit — a port answering is not an app working — and Junction answers
   `/health` with a named check per plugin. A third badge carries it: *healthy*,
   or *1 check failing* with the check NAMED, and the detail printed on a click.

   Three things it decides. **The fli server does the fetching, not the page** —
   the page is on 8500 and the app on 8110, so a browser fetch is cross-origin
   and an app whose CORS does not name this origin answers a network error
   indistinguishable from being down, which is the opposite of the point.
   **The path is probed and the answer says which one worked** — `apiPrefix`
   moves every route an app registers, `/health` included, so it is a fact about
   the app's config rather than about its port; Invariant 3's rule for the same
   class of question. **A row that answers nothing shows nothing** — a Vite dev
   server is up and has no opinion about its readiness, and rendering that red
   would leave every web surface here permanently wrong, which is how a signal
   gets ignored. A 200 of something else is not a health answer either, or an
   index page would read as a healthy API.

   Polled at a fifth of the state rate, and **the verdict is dropped the moment
   the port stops answering**: a row that goes down and comes back is a new
   process, and without that the badge shows the previous one's failing check
   for up to fifteen seconds.
5. ~~**`fli check` and `fli doctor` on the page.**~~ **Shipped 2026-08-29.** One
   panel, two questions kept apart: `check` grades the PROJECT against the rules
   this framework publishes, `doctor` grades the MACHINE the commands run on,
   and a missing `sqlite3` is not an architecture finding.

   **One engine existed and the other did not.** `fli doctor` was a hundred
   lines of logic interleaved with the `echo`s that printed it, so the only way
   to ask was to run the command and read a terminal. `core/doctor.js` is the
   answer and the command is now the rendering of it — the shape `checks.js` and
   `proofs.js` were already in — with `has`/`env`/`home` injected, so a missing
   `docker` and a present one are both a test.

   Three things it decides. **Both are asked in process**, not spawned and not
   parsed out of `--json`, so there is no second answer to either. **A clean
   project says so** — unlike the proves panel above it, which hides on a clean
   tree, because *nothing changed* is noise and *this project passes its own
   rules* is not; hiding it would make `clean` and `never ran` one screen.
   And **the machine's answer goes first when it has one**, graded on whether it
   STOPS fli rather than on whether something is absent: a missing
   `CLOUDFLARE_TOKEN` blocks `cloudflare:` and nothing else, and counting it as
   blocking makes almost every machine read as broken.

   It also found something the paper did not predict: `runChecks` is synchronous
   and one scope is ~half a second, so five in a row froze the fli server — the
   state poll missed, every badge emptied, and a start button did nothing for a
   second and a half. A yield between scopes does not make it faster; it makes
   the server answerable while it runs.

**And one that was ranked elsewhere.** ~~Named dev URLs~~ — `example.localhost`
rather than `localhost:8010` — was `IDEAS/overview.md` 5.19 and is **shipped
2026-08-29**. `core/ports.js` derives the names (a rendering of the table that
already owns the numbers), `fli proxy` maps Host to port, and every tile carries
its name beside the number. Strictly additive: `open` is still the port, so
nothing here stops working when the proxy is not running.

### Two real limitations, stated rather than discovered

**A child gets no stdin.** `stdio: ['ignore', 'pipe', 'pipe']`, so a dev server
started from here cannot be sent the keypresses it offers — vite's `r` to restart,
`o` to open. Overmind exists in large part for `overmind connect`, and the honest
answer is that a terminal attach is a different feature from a button.

**One console, prefixed.** A started row's output goes to the shared pane as
`[id] …`. mprocs and Tilt give each process its own pane and a combined view; a
per-row filter here is small and is the obvious next thing.

### Three to refuse

- **Auto-restart on a file change.** Every surface's dev server already owns when
  it reloads. A second owner of that is what Invariant 4 exists to prevent, and
  the failure — two reloads racing one edit — is the kind nobody attributes
  correctly.
- **Metrics and graphs.** Junction's devtools console owns that, on its own port,
  and is already a tile on this page.
- **An in-page overlay toolbar**, the way Nuxt and Astro ship one. The app-side
  answer already exists and is devtools; a second one is a second answer to *what
  is this app doing*.

---

## See also

- `command-surface.md` §4.2b — `--json` as a global contract; this page's data source
- `terminal-surface.md` — the sibling question: how an event becomes a line
- `packages/cli/core/repo-map.js` — the derivation rule this inherits
- `packages/cli/core/ports.js` — the schema, which stays the schema
