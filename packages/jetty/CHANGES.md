# Changes — @frontierjs/jetty

## 2026-08-16 — `ctx.findParams` → `ctx.directives`

Jetty's resource pipeline mirrors Sierra's, so it carried the same word for the
same thing. Renamed with it: `directives` is what the API boundary, the router
and `@frontierjs/toolbelt/directives` all call this (Invariant 10). Suite
unchanged — still the one known failure (`islands/demo.js` carries
`import.meta`, and MV3 content scripts are classic scripts).

## 2026-08-15 — an app gets jetty as the `extension/` surface, and Mesa now compiles in it

**The compiler lookup never walked up, so jetty's Mesa path had never run.** It
probed `<extRoot>/node_modules/@frontierjs/mesa` and `<viteRoot>/node_modules/…`
and stopped. In the canonical layout an extension is a sub-project of an app that
has ONE `package.json` at its root — the way `web/` and `widgets/` are — so the
install is at `<app>/node_modules` and neither guess hit it. Stub mode then
handed Vite a `.mesa` as plain JavaScript and the build died with **`Unexpected
JSX expression` pointing at line 1 of the component**, which is the one place the
problem was not. Both roots are walked now.

It survived every run of this suite because **the fixture's `App.mesa` was
JavaScript**, written against stub mode — so the only Mesa surface here was
proof that Mesa was never invoked. It is a real Mesa component now: `{#each}`
over the leads store, `{#if}` on the session, `bind:value` on the login fields,
scoped styles. That is what makes the compiler path testable, and it is what
turned this bug red.

Stub mode also says so **at the file**, not only once at boot: the boot warning
scrolls past and the parse error that follows has no visible cause.

**`fli` integration, which this README listed as not done.** An app scaffolds the
surface with `fli make:extension` and runs `fli extension:{dev,build,audit}` —
thin wrappers over the `jetty-*` binaries with `--root` pointed at `extension/`,
so the build an app runs and the build this package tests are one program.
`fli new --extension` adds it to any template; `--template extension-only` is a
project whose whole product is the extension, with no `api/` and no `web/`.

Verified end to end: a scaffolded `extension-only` project builds for **both**
browsers, emitting an MV3 manifest, a service worker and a compiled dock.

## 2026-08-15 — the wire vocabulary is Junction's now (FJS-059)

`resources/` subscribed to `${service}:created`, `:patched`, `:updated`,
`:removed`. Wrong twice over: a **colon is the in-process bus spelling** and the
wire carries a space (`DECISIONS.md`, 2026-08-02), and **a channel is not an
event** — in Junction you join `posts` and receive `posts created`, so there was
never a channel per event for any of the four to match.

One subscription now, to the channel, and the event decides what to do with what
arrives. `wireEventMethod()` splits a wire event the way Junction's own browser
client does; anything that does not split — the colon spelling, another
service's event, nothing at all — answers null rather than guessing.

**The event name is carried the whole way**, which it was not: `fanOut` forwarded
only the channel, so even a correct subscription could not have told a create
from a remove. Adapter → registry → `channel:event` → `PagePort.subscribe`
handler as `meta.event`. Drop it at any hop and a delete comes back onto the
screen and stays until reload.

**The old test pinned the bug rather than catching it.** It asserted four
subscriptions to names the server has never published, and passed. The new one
reads `AUTO_EVENT_MAP` out of Junction's source instead of restating it — a
vocabulary asserted only against itself is exactly how this drifted — and it
reads it by relative path, because `bun install` copies a workspace dep and an
import by name would check the last install's snapshot.

Still unobservable end to end: nothing here can talk to a real Junction
(`FJS-279`).

---

This file starts here. Invariant 17 asks for four markdown files at a package
root and this package had two; earlier history is in git and in `ISSUES.md`.
