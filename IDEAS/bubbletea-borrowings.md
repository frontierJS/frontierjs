---
id: bubbletea-borrowings
status: assessment
dated: 2026-10-22
---

# Idea — Four things worth taking from bubbletea, and what it confirms

**Do not cite as behavior — see `VERIFYING.md`.** Every *FJS today* line below
was read on 2026-10-22 against `@opentui/core` 0.5.17 and the files it names;
re-probe before planning from it.

Read beside `pico-borrowings.md`. pico is the *service* around a terminal
program — ssh as the account, the tables, the runbooks. bubbletea
(`charmbracelet/bubbletea`, v2, 45k stars, pushed 2026-10-21) is the *program*
itself: Elm architecture in Go (`Model`/`Update`/`View`, `Msg`, `Cmd`), a
cell renderer, and the lifecycle edges a terminal program meets — suspend,
hand the tty to an editor, refuse a quit, restore after a panic. pico's own
TUI began on bubbletea and moved to vaxis; charm's `wish` is the ssh server
that runs one bubbletea program per session, which is the Go answer to
pico-borrowings item 1 and is why that item stays an owner question: the
program here is Mesa over Bun, and an ssh front door in Go would hold a pty
to a Bun child rather than render anything itself.

FJS already owns the middle of what bubbletea is: rendering (`FJS-D698`,
Mesa's terminal target over OpenTUI), components (`@frontierjs/ui` lowered
through the IR, `IDEAS/mesa-ir.md`), keys (`IDEAS/keys.md`, one keymap engine
with derived help), and a frame drive (`packages/mesa/test/terminal/run.mjs`).
The architecture itself is not a take: `FJS-D38` makes a surface a compiler
backend, and Mesa's signals are the Elm loop with the dispatch folded into
the language. What bubbletea has that FJS has not looked at are the edges.

## 1. A quit can be refused — `WithFilter` on `QuitMsg`

bubbletea's `prevent-quit` example installs a filter that drops the quit
message while the model has unsaved changes (`options.go` `WithFilter`,
`examples/prevent-quit/main.go`). The program decides whether Ctrl+C ends it.

*FJS today:* `packages/sierra/src/terminal/shell.js` creates the renderer
with `exitOnCtrlC: true`, and OpenTUI destroys it on the key with no hook
between. `packages/mesa/src/compiler.js` already names `beforeunload` in its
DOM event list, and `packages/mesa/src/runtime-terminal.js` never fires it:
`rg beforeunload packages/mesa/src/runtime-terminal.js` is empty. A Haven
member half-way through a bubble, or the keys-plan L1 text box with a draft
in it, loses the text on Ctrl+C.

*Take:* fire `beforeunload` on `<mesa:window>` before the shell destroys the
renderer, and let `preventDefault` keep the program up — the browser's own
shape, which is what `FJS-D809` asks the terminal runtime to deliver. One
owner: the shell owns exit (`exitOnCtrlC: false`, its own Ctrl+C listener
that dispatches first), the runtime owns the event. Waits for a consumer with
a draft to lose; the L1 modal text box (`IDEAS/keys.md` Phase 5) is the first.
No ruling needed — the event name exists, the terminal is the second target
of a DOM event the compiler already accepts.

## 2. The program hands the tty away and takes it back — `ExecProcess`, `Suspend`, `ReleaseTerminal`

`exec.go`: a `Cmd` that pauses the program, runs `vim file.txt` on the real
tty, and resumes with a message when it exits. `tea.Suspend` is Ctrl+Z done
right (restore the terminal, `SIGTSTP`, re-enter on `SIGCONT`).
`ReleaseTerminal`/`RestoreTerminal` are the same pair exposed to the host.

*FJS today:* none of it. `rg SIGTSTP|SIGCONT packages/mesa/src
packages/sierra/src/terminal` is empty; OpenTUI 0.5.17 registers `exit`,
`SIGWINCH`, `uncaughtException` and `unhandledRejection` only. The keys plan
chose an in-house modal text box (L1) over calling `$EDITOR`, so the editor
path has no consumer. Ctrl+Z under `fli haven` is unprobed.

*Take:* nothing yet. Record that both are one Cmd each in bubbletea, so the
cost is small when someone asks to write a long room message in their editor;
the shape then is `renderer.suspend()`/`resume()` around a child on the
inherited tty, in `shell.js` beside exit. **Probe owed before any TUI ships
to strangers:** Ctrl+Z under `fli haven`, then `fg` — does the screen come
back drawn, or is the terminal left in raw mode.

## 3. Terminal state is a field of the view, not a startup flag

v2's single biggest change (`UPGRADE_GUIDE_V2.md` § The Big Idea): alt
screen, mouse mode, window title, cursor shape and position, focus reporting,
bracketed paste, background color and the new Program Status Protocol
(OSC 7501, `programstatus.go`) are fields on the `View` the program returns
each frame. Nothing is toggled; the renderer diffs the fields and emits the
sequences. The old imperative options were removed.

*FJS today:* half way there by accident. Mesa is declarative, and
`packages/mesa/src/window-binds.js` is exactly this table for the browser
window — `bind:innerWidth`, `bind:scrollY` — with the compiler refusing a
name it does not list. The terminal side has no row of its own: title, alt
screen and mouse mode live in `createRenderer` options in `shell.js`, set once.

*Take:* when a terminal app needs one of these live — the first ask will be
`document.title` for Haven's room name in the tab bar — put it where the
browser spelling already lands (`document.title`, a `<mesa:window>` bind)
and let the terminal runtime emit the OSC, rather than adding a renderer
option. The rule is the one `window-binds.js` already states: a name not in
the table refuses by name. Nothing to build until a consumer names a field.

## 4. International keyboards — `BaseCode`, `ShiftedCode`, `IsRepeat`

v2's `KeyPressMsg` carries `Code` (what the layout produced), `BaseCode`
(the key on a US PC-101 layout), `ShiftedCode`, `IsRepeat` and release events
under the Kitty protocol; `Keystroke()` always spells the modifiers.

*FJS today:* `IDEAS/keys.md` ruled vim spelling and `<Mod-k>` (`FJS-D1382`–
`FJS-D1388`) and binds by the key the engine names. A `<C-;>` or `<C-/>`
chord on a German or French layout reaches a different code, and the
terminal protocol in use decides whether the modifier survives at all.

*Take:* a hazard line for keys.md Phase 5 (L2), not a change: a chord on a
punctuation key is layout-dependent, so a default keymap binds letters and
the home row only, and a punctuation chord is a user's own binding. bubbletea's
answer, matching on `BaseCode`, needs the Kitty keyboard protocol, which
OpenTUI may or may not negotiate — probe before promising it.

## Confirmed, not taken

- **Golden frames.** bubbletea's own `examples/simple/main_test.go` is
  `t.Skip`'d because color escapes made the golden output unstable outside a
  pty. `run.mjs` captures the char frame from the headless renderer and
  compares text; that is the trap already stepped around.
- **Panic restores the terminal.** `WithoutCatchPanics` is the opt-out;
  OpenTUI registers `uncaughtException` itself, and `packages/cli/core/tty.js`
  restores on `exit`. Equal.
- **Derived key help.** bubbles' `help` reads a `KeyMap` struct's
  `WithHelp` strings; keys.md's derived help is the same idea one layer
  lower, in the chord table.
- **Mouse by content** (`View.OnMouse`, BubbleZone). The engine hit-tests
  elements, which is what a DOM event model gives for free.
- **`Tick`/`Every`** (clock-aligned ticks), `Batch`/`Sequence` — signals and
  `setTimeout` cover it; Haven's motion loop has no clock alignment need.
- **Inline mode and `Println` above the program.** bubbletea runs inline by
  default and lets a program print persistent lines above itself. OpenTUI
  takes the screen. `fli ci`/`fli prove` print plain lines and want nothing
  more; if a spinner inside a plain `fli` command is ever wanted, this is the
  gap, and OpenTUI's `useAlternateScreen` option is where to start probing.
- **Program Status Protocol (OSC 7501).** Working/waiting/done reported to
  the terminal; one terminal (rex) reads it. Too new to carry.
- **18,000 dependents, `huh` forms, `glow`, `wishlist`.** The ecosystem is
  the argument for the terminal target, not something to import.

## Order

Nothing builds from this file alone.

1. Item 1 lands with the first draft-holding control (keys.md Phase 5 L1),
   as one box there: `beforeunload` on `<mesa:window>`, shell owns Ctrl+C.
2. Item 4 is one hazard line in keys.md under Phase 5, now.
3. Item 2's probe (Ctrl+Z under `fli haven`) joins the pre-deploy list in
   `haven.md` Phase 10 beside pico-borrowings items 3–5.
4. Item 3 waits for the first live field; `document.title` is the bet.
