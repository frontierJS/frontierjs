---
id: stacks-borrowings
status: reading
dated: 2026-11-27
---

# Idea — Three things worth taking from Stacks.js, and one question it raises

**Status: READING.** Nothing here is built and nothing here is a dependency.
[Stacks.js](https://stacksjs.com/) is a full-stack TypeScript framework on Bun.
Its desktop and mobile surfaces run on **Craft**, its own shell written in Zig
([`@stacksjs/ts-craft`](https://www.npmjs.com/package/@stacksjs/ts-craft)),
which hosts the system webview — WKWebView on macOS, WebView2 on Windows — and,
since October 2026, draws compiled STX screens as UIKit and Android views
([`@stacksjs/mobile`](https://npm.io/package/@stacksjs/mobile),
[native apps](https://stacksjs.com/features/native-apps)). `buddy build:ios` and
`buddy build:android` generate the Xcode and Gradle projects from
`config/mobile.ts`. Findings come from their READMEs, releases and issues, read
on the date above; nothing was run.

**The shell itself is not a model.** FJS desktop is Tauri with a Bun sidecar
(`FJS-D263`, `FJS-D1815`), and mobile is Tauri first, then Mesa's
`target: 'native'` on Lynx, with no FJS-owned Swift or Kotlin host (`FJS-D689`,
`FJS-D1069`). Craft is the owned host `FJS-D1069`'s research warned against —
v0.0.x, carried by a small team — and its open issues show the costs that
research predicted: a native view still needs a WKWebView just to run the
screen's JS ([craft#327, craft#328](https://github.com/stacksjs/stx/issues/1992)),
and the shipped runtime is 13 MB against a 3 MB claim
([stacks#877](https://github.com/stacksjs/stacks/issues/877)). Watch it; do
not follow it. The three below stand on their own.

## 1. Every runtime permission has a framework capability, or a check fails

[stacks#3148](https://github.com/stacksjs/stacks/issues/3148) exists because
Craft gained Wallet, Health Services and passkeys flags that Stacks' capability
list did not map, and the gap was found by reading. Their capabilities use the
runtime's feature names with version floors (`audioRecording` needs Craft
≥ 0.0.324 and STX ≥ 0.2.678), so the drift is between two lists nobody diffs.

**FJS:** `make:desktop` writes `shell/capabilities/default.json` into the app
from `sidecarCapabilities()` (`packages/cli/core/desktop-surface.js`), and no
`mobile/` generator exists yet. When `mobile/` gets a capability table, a
`fli check` rule lists every Tauri plugin permission and Lynx module with no
entry and fails on it. Lands with the `mobile/` generator, not before.

## 2. A device API is one call on every surface, with a web fallback

Stacks' safe-area, haptics and share helpers are STX composables called the
same way from a component that also renders on the web.

**FJS:** layout already has this shape — `$.measure`, `$.focus` and
`$.viewport` return the same Promise on DOM, terminal and Lynx
(`IDEAS/mesa-ir.md` § 12, steps 5.1–5.3). Device features do not: a wrapped app
would call Tauri plugins directly, so a component using one stops rendering on
`web/`. Extending the `$` set or the ui kit with safe area, haptics and share,
each degrading on the web, keeps `FJS-D38`'s one authoring model. Open: which
owner holds them — mesa's `$` or `@frontierjs/ui` — is a `decision-rules`
question.

## 3. The native project is generated output, and the config is the source

Stacks writes the Xcode and Gradle projects under
`storage/framework/mobile/`; the app edits `config/mobile.ts` and its STX views
only. Craft ships the Swift shells inside its package.

**FJS:** `make:desktop` writes the Tauri `shell/` into the app tree, where it is
committed and hand-editable. For `mobile/` the cheaper shape to price first is
the generated one: the native project rebuilt from config on every build, so an
upgrade is a version bump rather than a diff against files the app owns. Tauri
commits `gen/apple` by default, so this is a real choice with a cost on each
side, not a default to copy.

## Question — native screens beside webview screens in one app

Stacks appears to ship native STX screens beside webview ones in the same iOS
app (releases [v0.75.102](https://github.com/stacksjs/stacks/releases/tag/v0.75.102),
[v0.75.158](https://github.com/stacksjs/stacks/releases/tag/v0.75.158)), so an
app ships before every screen reaches native parity. Mesa's native sweep still
refuses 16 of 48 fixtures, so a per-screen mix would let `mobile/` ship early.
But one app holding a Tauri webview and a LynxView means native glue code,
which `FJS-D1069` rules out. Wanting the mix is a ruling, not a workaround —
ask it before `FJS-D689` step 4 builds toward a whole-app switch.
