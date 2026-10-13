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
| `fli gui` | `packages/cli/core/server.js` | 8500 | what can run, what is up, start and stop, `proves`, `check`, decisions, CI, release, publish (`overview.md` 5.24) | `cli/web/index.html`, 4,249 lines |
| the viewer | the same server | 8500 | reads a document | `cli/web/viewer/index.html`, 2,064 lines |
| Litestone Studio | `litestone/src/tools/studio.js` | 8502 | browse and edit rows | `studio.html`, 7,946 lines |
| devtools | `junction/src/plugins/devtools/` | 8503 | service calls, live, health and metrics | `admin.html`, 650 lines |

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

- **Web:** `fli gui` serves them on 8500, as today.
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
| `:ask`: an agent over the same app | `mcp` | none |

**Every pane but `:ask` exists in some form.** The new work is the key model, the
move to `.mesa`, and the terminal target taking the screens.

---

## 4. Plan

### Phase 0 — Measure

Goal: know what lowers and what each console reads before anything moves.
Done when: Q1–Q3 are ruled and the inventory in 0.1 is in this file.

- [ ] 0.1 Inventory the four consoles: each screen, the endpoint it reads, the
  components it would need from `@frontierjs/ui`.
- [ ] 0.2 Run `bun run corpus -- --portability terminal` over the `ui` components
  that inventory names, and list the blockers.
- [ ] 0.3 Price the key model (`:` / `/` / one key per action) against the
  terminal runtime's one-listener-per-renderer `onKey`.

### Phase 1 — One screen, both targets

Goal: `fli gui`'s front page (what can run, what is up) is a `.mesa` screen.
Done when: a drive opens it in Chrome and in a pty and asserts the same rows.

- [ ] 1.1 Build the front page as a `.mesa` screen in `packages/cli`, served by
  `server.js` beside the old page.
- [ ] 1.2 The same screen through the terminal target, started by the Q1 command.
- [ ] 1.3 One drive, two frames: Chrome over CDP and a pty, same rows.

### Phase 2 — `fli gui` whole

Goal: `cli/web/index.html` is deleted.
Done when: every `server.js` endpoint has a `.mesa` consumer, and the old page is
gone.

- [ ] 2.1 `:check` and `:decide`.
- [ ] 2.2 `:ship`: release and publish.
- [ ] 2.3 The key model across panes, plus the always-visible key legend.
- [ ] 2.4 The viewer.

### Phase 3 — The app half

Goal: the running app is visible and callable from the same process.
Done when: a drive calls a method as a member, sees its announcement on `:live`,
and sees a guest refused on `:data`.

- [ ] 3.1 `:live` over devtools' stream; `admin.html` is deleted.
- [ ] 3.2 `:call`, as somebody.
- [ ] 3.3 `:data`, viewed as a principal.

### Phase 4 — Studio

Goal: `studio.html` is deleted.
Done when: litestone's five `verify:studio:*` drives pass against the `.mesa`
screens.

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
9. **Silence.** *The two targets show the same rows*: Phase 1.3's drive, which
   does not exist yet. *A deleted page left no reader behind*: the
   `server.js` endpoint list against its consumers, which is `none` until
   Phase 2's done line is a check.

**Adjudication in tension: the paved road vs. the workaround.** The four
consoles are workarounds (hand-written pages beside a framework that claims every
interface). Moving them onto the paved road is the ruling's direction.

**Tier: Assessment.** A choice from the questions below becomes a ruling in
`DECISIONS.md`.

---

## Open questions

- **Q1 — What starts it?**
  - **A** — `fli runtime`, as the owner first said it. It collides with "the FLI
    runtime" (`server.js`'s own header) and with Mesa's runtime.
  - **B** — `fli gui`, which picks the terminal target when it is started in a
    terminal without `--open`, and the web target otherwise.
  - **C** — a new `fli console` command beside `fli gui`.
  - **Recommend B** — one command and one noun for one console. A and C put two
    names on the same screens.
- **Q2 — Does `FJS-D810`'s line reach this?** `FJS-D810` admits the terminal
  shell as a stressor, with shipping a terminal app to users deferred past
  alpha. A developer tool is used daily but is not a user's app.
  - **A** — yes: tool screens count as the stressor, so the work starts now.
  - **B** — no: wait until core leaves alpha (`FJS-D14`).
  - **Recommend A** — the tool screens are a second corpus for the IR, written by
    the same people who maintain it.
- **Q3 — Where do Studio's screens live?**
  - **A** — in `packages/cli`, with the other three. Studio stays reachable from
    an app without the CLI only through its endpoints.
  - **B** — in `packages/litestone`, compiled ahead of time so Litestone ships
    built output and takes no Mesa dependency.
  - **Recommend A** — one owner for tool screens. B keeps a second console app
    alive inside the spine.
- **Q4 — Who decides what `:ask` may do?**
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
