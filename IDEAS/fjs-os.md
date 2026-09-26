---
id: fjs-os
status: proposed
dated: 2026-09-25
---

# Idea — An FJS operating system: borrow the bottom, own the top

**Status: PROPOSED. Nothing here is built.** Dated 2026-09-25. Do not cite this
file as behavior — see `VERIFYING.md`. What § 1 says about Omarchy and Quickshell
is from outside the repo and was not re-read against either project on that date.

**The question:** what is the foundation an FJS desktop OS is built on, and which
layers of it would FrontierJS itself own?

---

## Trigger

Omarchy, an opinionated Arch setup built on Hyprland, and Quickshell, which draws a
desktop shell from QML files. The owner wants an OS that is FrontierJS from the shell
up, and asked what the right foundation is to build on rather than build.

---

## 1. What an OS like this is made of

**Omarchy is the evidence that the bottom is borrowed.** It is an install script
and a directory of config files over plain Arch. As far as the author knew, its
shell is Waybar, Walker, mako, SwayOSD, hyprlock and hypridle, not Quickshell. Its
own code is glue. An FJS OS starts the same way.

| # | Layer | Borrowed | What FJS adds |
| --- | --- | --- | --- |
| 0 | Kernel and drivers | Linux | nothing |
| 1 | Base and updates | Arch, later bootc (§ 3) | an OS update becomes a Release |
| 2 | System services | systemd, PipeWire, NetworkManager, BlueZ, UPower, logind, polkit, xdg-desktop-portal, **all reachable over D-Bus** | nothing |
| 3 | Compositor | Hyprland, whose IPC socket controls windows and workspaces | nothing |
| 4 | Shell: bar, launcher, notifications, lock, OSD | Quickshell (QML) | `.mesa` screens through a QML backend (§ 4) |
| 5 | System API | — | a Junction app whose services ARE the OS (§ 2) |
| 6 | FJS-owned settings | — | a Litestone schema |
| 7 | Apps | — | FJS apps, including the `desktop/` surface (`FJS-D263`) |

**Layers 0 to 3 are someone else's and stay that way.** Every one of them is years
of hardware and protocol work with no FJS angle. Layers 4 to 6 are where the
framework's model applies, and layer 5 is the one that makes the rest follow.

---

## 2. The system API is the piece nobody else has

**The OS is a Junction app whose services are the machine**: `wifi`, `audio`,
`windows`, `power`, `bluetooth`. Each service is a bridge. It reads and writes
through D-Bus or Hyprland IPC and holds no copy of its own. NetworkManager stays
the origin of which network is connected. The service is a door onto it.

What that buys is everything Junction already does for any service:

- **One path for every client.** The shell, a web page, `cli/` (`FJS-D397`) and an
  agent over `/mcp` (`FJS-D258`) all call `wifi.connect` the same way, with the
  same hooks and the same announcement.
- **Live for free.** A write announces, so a bar holding the `audio` state gets
  the new volume without polling. A change made OUTSIDE Junction (a key on the
  keyboard, another tool) has to be read off the D-Bus signal and announced by the
  bridge, or the shell drifts from the machine with nothing saying so. That is
  the ninth question's hardest case (§ 6).
- **A standing on every call.** Which caller may change the network is a declared
  gate rather than a check inside a handler. Whether that gate or polkit decides
  is the fourth open question.

**Litestone holds only what FJS itself owns**: shell layout, launcher history, the
theme choice. It does not mirror dconf or any service's own config. A setting that
belongs to NetworkManager stays in NetworkManager.

---

## 3. The base layer

- **Arch plus a script** is the Omarchy route. It is cheap and quick to start. Its
  updates are rolling and have no rollback.
- **bootc** (Fedora's image-based OS, the base of Universal Blue) makes the whole
  OS an OCI image built from a Containerfile, with atomic updates and a rollback.
  **This is the shape FJS already has a word for**: one image is a Release, an
  update is a deploy, and a bad one is reverted. `fli deploy`'s journal and
  revert are the model, even if none of their code transfers.
- **NixOS** matches *everything derives from a seed* most closely. It also brings
  a second language and a second mental model, which is a large charge on the
  concept budget.

---

## 4. The shell, and the Mesa → QML backend

**`FJS-D38` already ruled the authoring side**: `.mesa` is the model for every
interface, and a new surface is a compiler backend. `mesa-ir.md` is where that
seam is placed. **A QML backend is one more consumer of that IR, not a separate
compiler.**

The template half maps closely, because QML is itself declarative and reactive:
a signal becomes a QML property, `{#if}` becomes a `Loader` or `visible:`,
`{#each}` becomes a `Repeater` over a model, and an event becomes `onClicked`.

**The hard part is the same one `mesa-ir.md` § 3 names: vocabulary, not tree.**

- **QML has no CSS.** Invariant 13 is what saves this: a tone and a treatment can
  be lowered to a QML `Theme` singleton, generated from css's tokens and
  `vocabulary.js`, while a raw color cannot. The portability report that paper
  proposes says which components lower and which do not.
- **The script half is less certain than it looks.** QML runs JavaScript, but
  with no DOM, no `fetch` and no npm module resolution. Whether Mesa's reactive
  core and Junction's browser client run in QML's engine unchanged, or need a thin
  adapter speaking Junction's WebSocket frames directly (QML has a `WebSocket`
  type), has not been measured.

**The webview route is the alternative, and it is priced here rather than
assumed away.** The `desktop/` surface already runs `.mesa` screens in Tauri over
WebKitGTK, so a webview on a layer-shell surface would run Mesa with no new
backend at all. The cost is a browser engine per shell surface in memory and
startup time, for a bar that should cost almost nothing. It is the second open
question.

---

## 5. Sequencing, and what proves each step

0. **Nothing before core leaves alpha**, on `FJS-D14`'s reasoning, which
   `mesa-ir.md` § 6 also inherits. What this paper settles now is where the
   pieces go.
1. **Arch + Hyprland + Quickshell by script.** Add one hand-written QML widget that
   shows live data from an FJS app over Junction's WebSocket. This proves the data
   half and measures the script-half question in § 4 before any compiler work.
2. **The system daemon.** Junction services bridged to D-Bus and Hyprland IPC.
   Proved when a volume change made on the keyboard reaches a subscribed shell
   through an announcement, and a caller below the gate is refused by name.
3. **The QML backend**, with the terminal as the IR's first consumer or beside
   it (`mesa-ir.md`'s second open question). The first target is a bar and a
   launcher, plus the generated `Theme` singleton. The hand-written widget from
   step 1 is the reference the backend's output is compared against.
4. **A bootc image**, where an OS update is a Release and a revert returns the
   previous one.

---

## 6. The nine questions (`decision-rules`)

1. **Origin.** Machine state stays with the service that owns it (NetworkManager,
   PipeWire, Hyprland). The Junction services are bridges and hold no copy. The
   one risk of a second origin is a bridge that caches.
2. **Concept.** No new noun is coined here. *OS* names the body of work, the way
   *Homestead* does (`FJS-D297`), and not a module. Quickshell, QML and D-Bus are
   dependencies and count against the same budget. A `shell/` surface would be a
   new entry in Invariant 3's list and is the third open question, not assumed.
3. **Complexity.** Layers 0 to 3 are the problem's own complexity and are
   borrowed, not rebuilt. The QML backend is added complexity, and the webview
   route exists to price it.
4. **Predictability.** A system service is an ordinary service: the same hooks,
   gate and announcement as `orders`. Nothing about calling `wifi` is special.
5. **Derived.** The QML `Theme` derives from css's tokens and is never
   hand-written. A bootc image derives from a Containerfile in the repo.
6. **Owner.** The QML backend is a `mesa-ir.md` consumer and not a second
   compiler. The webview route is the `desktop/` surface's (`FJS-D263`). Revert is
   modeled on `fli deploy`. OS privilege is either polkit's or the gate's, never
   both (fourth open question).
7. **Boundary.** D-Bus to Junction is one named bridge per service. QML to Junction
   is the WebSocket client, or its adapter.
8. **Failure.** A missing system service (no Bluetooth adapter, for example)
   answers *unavailable* by name, and the shell drops that widget rather than
   crashing. A refused call is refused like any gate.
9. **Silence.** *The shell shows the machine's state*: this breaks silently when a
   bridge misses a D-Bus signal. The artifact would be step 2's drive, a change
   made outside Junction and read back through an announcement; **none** exists
   today. *The `Theme` matches css's tokens*: a generated snapshot gated by the
   `snapshots` phase. *A component lowers to QML*: `mesa-ir.md`'s portability
   report.

**Adjudication in tension: batteries vs. smallness.** None of this is in the core.
The OS is an application of the framework, severable in the way basecamp is,
and nothing under `packages/` should grow an OS-shaped branch for it.

**Tier: Assessment.** This file is an `IDEAS/` proposal. A choice made from the
open questions below becomes a ruling in `DECISIONS.md`.

---

## Open questions

- **Which base layer?**
  - **A** — Arch plus an install script, the Omarchy route.
  - **B** — bootc from the start.
  - **C** — NixOS.
  - **Recommend A** — then B. A is weeks rather than months and proves the shell and
    the daemon. B is the destination because an image is a Release, and the move
    changes only layer 1.
- **Which shell first?**
  - **A** — a webview on a layer-shell surface, reusing the `desktop/` surface's
    engine and running `.mesa` unchanged.
  - **B** — hand-written QML in Quickshell, then the Mesa → QML backend.
  - **C** — the Mesa → QML backend straight away.
  - **Recommend B** — a webview shell pays a browser engine's memory on every surface, all day. A
    hand-written QML widget is also the reference output the backend needs, so it
    places the seam from a real consumer rather than a guess
    (`cut-one-level-simpler`, and `mesa-ir.md`'s own recommendation).
- **Is it an application or a surface?**
  - **A** — one application built on FJS, the way basecamp is.
  - **B** — a `shell/` surface any app may have, beside `widgets/` and `desktop/`:
    an app's own bar widget or launcher entry.
  - **Recommend A** — for now. B is the same idea one level down, and is worth a ruling
    only once a second app wants a widget in the shell.
- **Who decides OS privilege?**
  - **A** — polkit decides, and the Junction service asks it.
  - **B** — the service's gate decides, and polkit is configured to allow the
    daemon.
  - **Recommend A** — polkit is already the machine's origin for *may this user do
    this*, and B makes the gate a second origin for it. The gate still grades who
    may reach the service at all.

---

## See also

- `mesa-ir.md` — the IR a QML backend consumes, and the portability report.
- `terminal-surface.md` — the other non-markup backend, and `FJS-D37`'s *buy the
  engine*.
- `DECISIONS.md` `FJS-D38` (every interface is `.mesa`) · `FJS-D263` (the
  `desktop/` surface) · `FJS-D14` (V2 deferral).
