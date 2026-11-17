---
id: workbench-capture
status: proposed
dated: 2026-11-16
---

# Idea — a Flameshot replacement in Workbench, by bringing Kapture to X11

**Status: building 2026-11-16; Q1–Q4 and Q6 ruled, Q5 waits on Vlad. every box built except the Wayland pin, all uncommitted (Kapture on local
branch `x11-backend`). The owner ran it on the real two-monitor GNOME/X11 session 2026-11-16 and reported it
works. Owed: `cargo install`, `kapture install-shortcut`, Vlad on Q5 and the Wayland pin.**
Probed against the tree 2026-11-16. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-16): a Flameshot replacement ([flameshot-org/flameshot](https://github.com/flameshot-org/flameshot)) built into Workbench.

## What exists (probed 2026-11-16)

- **Kapture is already the Flameshot replacement, and it only runs on Wayland.** `~/code/KOBAMI/kapture`
  (origin `vladstanca/kapture`, clean tree, last commit 2026-10-21) is about 21k lines of Rust: freeze, select
  with handles and a `1280 × 720` size label, nine tools (number, arrow, rect, ellipse, pen, highlighter, text,
  blur, select) with per-tool styles and undo, a 5 s delayed capture, window picking, clipboard and file, share
  links, video and GIF. It needs layer-shell (COSMIC, KDE, Hyprland, Sway). GNOME has no layer-shell, and this
  laptop is GNOME on X11 with two monitors (DP-2-1 at 3440 × 1440, eDP-1 at 1152 × 2048).
- **Only the window, the grab and the clipboard are Wayland.** In `crates/kapture-overlay/src/`, `paint.rs`,
  `annotate.rs` (the undo `Doc`), `render.rs`, `toolbar.rs`, `text.rs`, `geometry.rs` and `compose.rs` (about
  5k lines) draw with tiny-skia and import no Wayland types. `wayland.rs` (1,348 lines) is the window, and
  smithay types also reach `ui.rs`, `hud.rs` and `lib.rs`. `kapture-capture` is wlr-screencopy with a portal
  fallback. `kapture-core` puts images on the clipboard with `wl-clipboard-rs`.
- **Kapture has no magnifier and no pin-to-screen.** `kapture install-shortcut` (`src/shortcut.rs`) writes
  COSMIC's `system_actions` only. `src/ipc.rs` is a socket that lets a second `kapture` stop a recording.
- **Workbench's desktop shell is Tauri 2 with a tray** (`packages/workbench/desktop/shell/src/tray.rs`): show
  and hide, Start API, `go:<path>` screen items, Start at login. Its only dependencies are `tauri` and `libc`.
- **TPM's whiteboard tools were a JS port of Kapture** (`ink.js`, `mosaic.js`, `export.js` at TPM `c783bc9`).
  Colin's merge `6aa673b` (2026-11-16) dropped them from TPM's `colin/dev`. They survive only in TPM's git
  history, and this plan does not use them (Q1).

## Open questions

- ~~**Q1 — How does Workbench get a capture tool?**~~ **Answered 2026-11-17 (`FJS-D2242`): A — Add an X11 backend to Kapture. Workbench's tray and the GNOME shortcut run `kapture`.**
  - **A** — Add an X11 backend to Kapture. Workbench's tray and the GNOME shortcut run `kapture`.
  - **B** — The same X11 work, but the Tauri shell links Kapture's crates into one binary.
  - **C** — A new webview overlay in Workbench, drawing with TPM's `ink.js` copied out of git history.
  - **Recommend A** — Kapture already does the job. One codebase serves both display servers, and Workbench's
    build does not grow a tiny-skia renderer or depend on a sibling checkout's path. C rewrites in JS what is
    already written in Rust.

- ~~**Q2 — How does a capture start?**~~ **Answered 2026-11-17 (`FJS-D2243`): A — A GNOME custom shortcut on Print that runs `kapture`, plus a Capture item in Workbench's tray.**
  - **A** — A GNOME custom shortcut on Print that runs `kapture`, plus a Capture item in Workbench's tray.
  - **B** — Tauri's global-shortcut plugin grabs the key.
  - **C** — The tray item only.
  - **Recommend A** — GNOME holds Print for its own screenshot UI, so B fails to grab the key, and B does not
    work on Wayland. Flameshot's docs tell GNOME users to set it up this way.

- ~~**Q3 — Where does a finished capture go in v1?**~~ **Answered 2026-11-17 (`FJS-D2244`): A — Clipboard and file, as Kapture already does.**
  - **A** — Clipboard and file, as Kapture already does.
  - **B** — A, and attach the capture to a Workbench Claude chat.
  - **C** — A, and a capture history in Workbench's database.
  - **Recommend A** — It is what Kapture does today. B and C need a Workbench API that a separate binary calls,
    so they wait for the port to be working.

- ~~**Q4 — Which Flameshot extras are in v1?**~~ **Answered 2026-11-17 (`FJS-D2245`): A — Pin to screen, delayed capture, and a size readout with a magnifier.**
  - **A** — Pin to screen, delayed capture, and a size readout with a magnifier.
  - **B** — The core only: region, tools, undo, copy and save.
  - **Recommend A** — Kapture already has the delay and the size readout, so A adds two things: a magnifier
    and a pin window.

- **Q5 — Where does the X11 work land?** Owner 2026-11-16: ask Vlad first. Until he answers the work stays on
  the local, unpushed branch `x11-backend`, uncommitted.
  - **A** — A branch on `vladstanca/kapture`, merged by Vlad.
  - **B** — A Kobami fork that Workbench builds from.
  - **Recommend A** — A fork keeps two copies of the shared drawing code, and each tool fix would need making
    twice. Ask Vlad before 1.1.

- ~~**Q6 — How does Workbench find `kapture`?**~~ **Answered 2026-11-16 (`FJS-D2246`): A — On `PATH`.**
  - **A** — On `PATH`, installed with `cargo install --path ~/code/KOBAMI/kapture`. Setup's Desktop builds goal
    checks for it, and the tray item is disabled with a "Kapture not installed" label when it is missing.
  - **B** — Workbench builds Kapture from a checkout path it is given.
  - **Recommend A** — It is how Workbench already treats `claude` and `gh`: a binary it checks for and never
    builds.

## Plan

### Phase 0 — Groundwork

Goal: Kapture builds here, and the platform seam is drawn.
Done when: `cargo build` succeeds in `~/code/KOBAMI/kapture`, and 0.3's split is written under it.

- [x] 0.1 Build Kapture on this laptop and record how it fails on GNOME/X11. Builds with
      `cargo build --no-default-features`; the default `video` feature needs `libgstreamer1.0-dev` and
      `libgstreamer-plugins-base1.0-dev`. On X11 it logs `Could not find wayland compositor`, then the portal
      fallback fails.
- [ ] 0.2 Ask Vlad about Q5, and about a backend split in the overlay crate.
- [x] 0.3 Draw the seam. Find every smithay type that `ui.rs`, `hud.rs` and `lib.rs` use, and name the
      Kapture-owned input types (key, pointer, modifiers) that replace them. The goal is that a backend is one
      file beside `wayland.rs`. Built: `input.rs` (Kapture's own key, pointer and cursor types) and `session.rs`
      (`Session`, `Screen`, `trait Buffers`); `wayland.rs` went from 1,348 to 919 lines. The Wayland path could
      not be run here, so Vlad smoke-tests it on COSMIC. `hud.rs` is recording-only and is not ported.

### Phase 1 — Grab and clipboard on X11

Goal: `kapture` captures the whole X11 screen to a file and the clipboard, with no overlay yet.
Done when: on this laptop, a headless capture of both monitors writes a PNG, and the image still pastes into
another app after `kapture` has exited.

- [x] 1.1 Pick the backend at runtime from `WAYLAND_DISPLAY` / `DISPLAY`, and put `kapture-capture` behind a
      trait with a Wayland and an X11 implementation (`xcap`, or `x11rb` `GetImage` on the root window).
- [x] 1.2 Write the X11 clipboard with `arboard`. **X11 serves a selection from the process that owns it**, so
      a child process keeps owning the PNG until another app takes the selection. `xclip` and arboard's
      `SetExtLinux::wait` both work this way. A process that just exits leaves the clipboard empty. Built as an
      `x11rb` selection owner (`kapture-core/src/clipboard/x11.rs`) that serves the exact PNG bytes; a 4592 × 2048
      grab pasted back byte-identical after exit. Text and file copy are routed too but were not run.

### Phase 2 — The overlay on X11

Goal: the frozen-screen overlay, every tool and undo, on GNOME/X11.
Done when: every tool in the README's table draws over a real capture spanning both monitors, and Enter copies
the result. Kapture's `visual_tests.rs` stays green on both backends.

- [x] 2.1 Add `x11.rs` beside `wayland.rs`: one borderless, override-redirect window covering the root, a
      tiny-skia pixmap presented through `softbuffer` (or `x11rb` `PutImage`), and keyboard and pointer input
      mapped onto 0.3's types. Built with `x11rb` `PutImage`, one window per monitor, keyboard and pointer
      grabbed. Driven on Xvfb with XTest: drag, rectangle tool, undo, redo, Enter and Esc all work, and a
      3440 × 1440 drag repaints in 4.6 ms median in a release build. The core keymap cannot type AltGr, dead-key
      or Compose characters in the text tool.
- [x] 2.2 Handle per-monitor scale and offsets. The toolbar and HUD place themselves on the monitor under the
      pointer, as they do on Wayland. Xvfb would not report a second monitor; the owner ran a release build on
      the real two-monitor GNOME/X11 session 2026-11-16 against the real-session checklist (top bar, drag across
      the monitor edge, tools, Enter, Esc, magnifier, pin) and reported it works. Launch from the Print key was
      optional in that run and is not confirmed.
- [x] 2.3 Window picking on X11: geometry from `_NET_CLIENT_LIST_STACKING` and `_NET_FRAME_EXTENTS`, standing
      in for COSMIC's toplevel-info protocol. Built with Phase 1 in `kapture-capture/src/x11.rs`.
- [x] 2.4 `install-shortcut` on GNOME. Clear `org.gnome.shell.keybindings show-screenshot-ui`, then add a
      `custom-keybindings` entry with Print → `kapture`. Choose COSMIC or GNOME from `XDG_CURRENT_DESKTOP`.
      A second run changes nothing. Each run prints the keys it changed with their old values, and
      `uninstall-shortcut` (the command Kapture already had) puts the old values back. A wrong write would leave Print doing nothing, so
      the Kapture entry is written first and the screenshot UI loses Print last. Built and proven in an isolated
      settings session only; it has not been run against this laptop's real keybindings (four custom entries).

### Phase 3 — Extras (Q4)

Goal: the magnifier and pin to screen, on both backends.
Done when: the loupe follows the pointer while selecting, and a pinned capture floats above other windows
until Esc.

- [x] 3.1 A magnifier loupe beside the pointer while selecting (in `render.rs`, the shared core, so both
      backends get it), showing pixels at 8× with the pixel under the pointer outlined. It shows while creating or
      resizing the selection and on the first hover, and never while an annotation tool draws. Seen on Xvfb; a
      hover repaints in 5.6 ms median at 3440 × 1440. Not seen on Wayland or a HiDPI display.
- [ ] 3.2 Pin to screen: a toolbar action that opens the annotated capture in an always-on-top borderless
      window. Drag moves it, scrolling zooms it, Esc closes it. On Wayland this needs layer-shell, so the
      done-when is checked on COSMIC as well as on GNOME/X11. **X11 half built** (`kapture-overlay/src/pin.rs`): a
      detached process per pin, a managed undecorated always-above window, Esc or double-click closes. Pin also
      copies and saves like Capture. Seen on Xvfb, then on the owner's real GNOME/X11 session 2026-11-16. **The Wayland half is not written**, since it cannot be
      run here: the toolbar offers Pin only where the backend says it can (`Caps { pin }`), and Vlad adds the
      layer-shell pin. This box stays open until both are seen on a real session.

### Phase 4 — Workbench

Goal: Workbench starts captures and checks that Kapture is installed.
Done when: `bun run verify:desktop` passes, the tray's Capture item opens Kapture's overlay, and Setup shows
the Kapture row.

- [x] 4.1 A Capture item in `tray.rs` that spawns `kapture`, disabled with a label when it is not on `PATH`
      (Q6).
- [x] 4.2 `fli desktop:install` runs `kapture install-shortcut` when Kapture is installed.
- [x] 4.3 A Kapture row under the Setup tab's Desktop builds goal, with its install command shown and a Copy
      button (`FJS-D2162`).

Built 2026-11-16, uncommitted. The row comes from one `BINARIES` entry in `packages/cli/core/doctor.js`, so
`fli doctor` lists Kapture too. `verify:desktop` passed 10 of 10. Not yet seen with Kapture installed: the tray
item enabled and starting the overlay, and `desktop:install` running `install-shortcut`.

## Not taken

- **Recording on X11.** `kapture-record` is wlr-screencopy. X11 recording is a separate plan, written once the
  overlay works.
- **The webview overlay (Q1 C).** It is recorded so it is not proposed again.
