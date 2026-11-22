---
id: webkit-window
status: proposed
dated: 2026-11-21
---

# WebKit check — Safari's engine in the drives, and a WebKit window parked

**Status: PROPOSED.** Dated 2026-11-21. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. The file id keeps the first
draft's name; `decision-rules` ran on that draft and its findings are folded in.

## Why

**Every drive proves Blink only.** `@frontierjs/mesa/drive` speaks CDP and so
launches Chrome. A page that breaks in WebKit — the engine of Safari and of
every iOS browser — passes every drive here. The one second engine in the tree
is sierra's CSP drive, which loads its page in Playwright's Firefox as well
(`FJS-3549`) because Chrome alone reported none of 21 refusals.

The first draft proposed an FJS-owned WebKitGTK window on Bun and `webview`.
Phase 0 and a Playwright trial moved the check to Playwright's WebKit and
parked the window for the one use only it serves: staying logged in.

## What was measured — 2026-11-21, this machine (Ubuntu 22.04)

| Finding | Evidence |
| ------- | -------- |
| Playwright's WebKit runs headless here | `playwright-core` 1.62.1 from sierra's `node_modules`, cached `webkit-2336`; reports WebKit 26.5 and a Safari 26.5 user agent |
| It catches a WebKit-only failure | a page reading `navigator.userAgentData.brands` logged the `undefined is not an object` error; `console`, `pageerror`, `requestfailed` and 4xx/5xx `response` events all fire |
| It renders a real page | the GitHub repo page loaded in about 5 s, screenshot correct, no problems |
| The whole check is about 20 lines | launch, four listeners, `goto`, `screenshot`, `close` |
| A Bun + `webview` window would cost far more for the same check | a native `cmake` build, an FFI binding, isolated site data, error capture only from inside the page, no request status, Xvfb in CI |
| surf and Tauri 2 run the same distro engine build | surf links `libwebkit2gtk-4.0`, Tauri `-4.1`; both 2.50.4 — older than Playwright's 26.5 |
| `webview` cookies outlive the window only when told to | default: second launch sent no cookie; three WebKit calls to `webkit_cookie_manager_set_persistent_storage` before the first navigate: launches 2 and 3 sent it |

Playwright's WebKit is WebKit on Linux, not Safari on macOS: it shows engine
differences in JavaScript, CSS features and layout, and not macOS font
rendering, Apple-only media or iOS behavior.

## The boundary

**Playwright is a test-time tool here, never an app's dependency.**
`FJS-D1214` gives an app two browser owners, print-kit and `mesa/drive`, and
`fli check` names a Playwright runtime dependency as off the road. The WebKit
check follows `FJS-3549`'s exception: a devDependency, launched by a drive, for
an engine `mesa/drive` cannot reach.

## Plan

### Phase 0 — price the simpler version

Goal: know whether a Bun-owned window earns anything over what exists.
Done when: 0.1 and 0.2 each have a number or an answer written under them.

- [x] 0.1 Time a warm `dev:desktop` rebuild against opening a `webview` window
  on the same dev server. If the warm rebuild is a few seconds, use 1 is
  dropped.
  - `example`'s shell, built from a scratch copy, 12 cores: cold 2 min 36 s
    with crates already fetched, 2.2 GB `target/`, 194 MB debug binary. Warm
    no-op 0.2–1.9 s; after touching `main.rs` 2.3–3.0 s.
  - Same bundle, same static server, three alternating runs: window shown
    Tauri 0.31–0.76 s, `webview` 0.38–0.69 s; first request 0.56–1.15 s vs
    0.59–0.87 s; PSS 241–248 MB vs 241–246 MB, three processes each.
  - **The desktop preview is dropped.** Only the cold build differs, once per
    machine, and the screens reach the Tauri window by HMR with no Rust
    rebuild at all.
  - Both windows wrote site data on first run: the Tauri shell under
    `~/.local/share/<identifier>`, `webview` under `~/.cache/<prgname>` and
    `~/.local/share/<prgname>`, i.e. `bun`.
- [ ] 0.2 Owner logs into 37signals ID in a persisted `webview` window,
  restarts it, and tries Google sign-in. Only Phase 2 needs the answer.
- [x] 0.3 Read `webview-bun`'s maintenance: releases, open issues, and whether
  it binds `webview_get_native_handle`.
  - Last release v2.4.0 on 2025-04-27, one maintainer, 15 open issues
    unanswered, among them a non-blocking run loop. It does not bind
    `webview_get_native_handle`, and its prebuilt links WebKitGTK 6.0, absent
    on 22.04. Upstream `webview` is active (commit 2026-10-22).

### Phase 1 — a WebKit check in the drives

Goal: a drive loads a page in WebKit and reads back its problems and a
screenshot, the way a Chrome drive does.
Done when: a page with a deliberate WebKit-only error fails the check in
WebKit and passes the same page's Chrome drive, and the check runs in CI.

- [ ] 1.1 Put the launcher where Q2 rules.
- [ ] 1.2 Problems list and screenshot matching `mesa/drive`'s shapes, so a
  drive reads one list whichever engine ran.
- [ ] 1.3 First consumer: one app surface whose drive also runs in WebKit.
- [ ] 1.4 The browser install: the one-time `playwright-core install webkit`
  named where a new machine and CI read it.

### Phase 2 — a window that stays logged in, parked until Q3 names a consumer

- [ ] 2.1 One profile directory per site, cookies and storage in it, on a
  binding Q4 rules.

## Open questions

- **Q1 — The desktop preview**
  - **A** — Keep `dev:desktop` as the only desktop preview; no second host.
  - **B** — A `webview` host inside `desktop-surface.js`, beside the Tauri one.
  - **Recommend A** — 0.1 measured the warm rebuild at 3 s or under and the two
    windows as equal in open time and memory, so B buys nothing, and two hosts
    for one surface is a render that can pass in one and ship broken in the
    other.
- **Q2 — Where the WebKit launcher lives**
  - **A** — One helper that opens a page in a Playwright engine, WebKit or
    Firefox, and returns problems and a screenshot; sierra's `openFirefoxCsp`
    moves onto it.
  - **B** — Each drive launches its engine itself, as `openFirefoxCsp` does
    today.
  - **Recommend A** — two engines are about to be launched from drives, and one
    owner keeps the browser install and the problems shape in one place.
- **Q3 — The logged-in window**
  - **A** — Park it until a consumer asks.
  - **B** — Workbench opens site windows (Basecamp and the like), one profile
    each.
  - **Recommend A** — no package needs it today.
- **Q4 — The binding under a logged-in window**
  - **A** — `libwebview` built against WebKitGTK 4.1, under `webview-bun`.
  - **B** — `webview-bun`'s prebuilt, requiring WebKitGTK 6.0.
  - **C** — A's library under a binding FJS owns over `bun:ffi`, about 14
    symbols.
  - **Recommend C** — 0.3 found `webview-bun` unmaintained since 2025-04, and B
    is a different API line from the Tauri shell. Matters only if Q3 is B.
- ~~**Q5 — What drives a page in WebKit**~~ **Answered 2026-11-22 (`FJS-D2305`): A — Playwright's WebKit through `playwright-core`, a test-only devDependency, following `FJS-3549`'s Firefox exception to `FJS-D1214`.**
  - **A** — Playwright's WebKit through `playwright-core`, a test-only
    devDependency, following `FJS-3549`'s Firefox exception to `FJS-D1214`.
  - **B** — A WebDriver backend in `mesa/drive` (`WebKitWebDriver`, then
    Firefox), keeping one driver.
  - **C** — The Bun + `webview` window.
  - **D** — Not now.
  - **Recommend A** — about 20 lines, headless and CI-ready today, the newest
    engine of the three, and confined to tests.

## Prior art

- **surf** (suckless): about 2,500 lines of C around WebKitGTK, MIT, one active
  maintainer; read and set aside — a C fork is a second toolchain with nothing
  that `webview` lacks.
- **Portal's bookmark stage** (`fjs-prototypes/portal`) frames a page when its
  headers allow and shows a saved copy otherwise. A frame renders in the host
  browser's engine and cannot hold a login on Basecamp, 37signals ID or
  GitHub, all three of which refuse framing.
- **Tauri `dev`** reuses the shipped shell for preview rather than adding a
  second host. From memory, not sourced here.
