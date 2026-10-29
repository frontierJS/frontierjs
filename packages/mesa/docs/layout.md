# mesa — layout

The file-by-file map of `@frontierjs/mesa`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`, the browser drives `browser-drives.md`.

```
src/
  compiler.js          — the compiler. ~290 KB, one file: parse → analyze → emit
  ir.js                — lower(ctx): the parse tree plus analysis as one target-free
                         tree, ctx.ir, built on every compile; a kind it does not
                         translate is `unlowered` and named, never dropped
  terminal/tags.js     — the terminal target's table: which tags and DOM event
                         names it paints (FJS-D700, FJS-D692). Pure data; the
                         compiler refuses what is not in it, by file and line
  host/emit.js         — the host emitter, the stage compile() runs for every
                         target in host/targets.js (FJS-D699, FJS-D1074):
                         ctx.ir → calls on $$host written into ctx.module.body.
                         Takes the target's profile; refuses, never approximates
                         — except a tag it cannot paint on or inside a static
                         aria-hidden="true", which it leaves out (`hostDropped`)
  host/targets.js      — one profile per non-DOM target: its tables, which
                         `class:` names it paints, whether it paints CSS, the
                         runtime it imports
  native/tags.js       — the native target's table (FJS-D1074): what a phone
                         builds. What it has no element for is absent, so refused.
                         tagClass(): the `_p` every element carries (FJS-D1139).
                         userAgentSheet: the browser's own sheet, which a phone
                         lacks, for whatever builds a bundle to put first. Its
                         `._html` rule is the 16px root, on the page the runtime
                         classes; the engine's own root is 14px, read by rem and em
  native/css.js        — cssOffense(): the selectors and at-rules a phone's
                         stylesheet drops in silence, so a `<style>` rule using
                         one is refused by line. lowerTypes(): a type selector
                         as its tag class, since every element is the engine's
                         view or text; scopeCSS and lowerSheet both run it
  native/sheet.js      — lowerSheet(): a whole stylesheet, the kit's bundle
                         first, flattened out of its layers and split one rule
                         per list member, `:where()`/`:is()` lists included,
                         since the encoder drops a layer or a list whole, then
                         its tokens evaluated and agreeing members rejoined. Returns what
                         it dropped by line, an app knob it lost included
  native/tokens.js     — lowerTokens(): the token graph evaluated per (theme ×
                         axis × tone), so no var() on a phone is more than one
                         hop from a literal. The contexts are read off the
                         sheet: `.theme-*`, and each @property's setters
  native/values.js     — lowerValues(): oklch(), oklab(), color() and color-mix() over
                         literals computed to rgb()/rgba(), clipped as Chrome
                         paints, logical properties written physical for
                         left-to-right, and `display` by its inner display
                         (flow → the engine's `linear`, since it lays `block`
                         out as a row). A color or display it cannot lower
                         comes back by line
  runtime.js           — the signal runtime the emitted code calls. ~174 KB
  runtime-terminal.js  — the terminal runtime, @frontierjs/mesa/runtime/terminal:
                         `$$host`, a cell tree over @opentui/core (optional peer,
                         pinned exact while 0.x — FJS-D698). Bun only. Events
                         dispatch as a browser's (capture, target, bubble) and
                         it is a CLIENT: `$.onMount` and `{@attach}` run, so a DOM API
                         reached there throws on a terminal (FJS-2242). Also the
                         one place another package gets a renderer from
                         (`createRenderer`, `createHeadlessRenderer`) — its own
                         engine import would be a second copy — the page
                         (`pageOf`), a strip under it that does not scroll (`footerOf`),
                         and a pane at its right (`sideOf`): Tab stays in the
                         pane holding focus, `focusPane` crosses, and a key in
                         the side never reaches the window a scene walks on.
                         Whoever fills the side hands its show-and-hide to
                         `setSideToggle`, and a page reads it with
                         `sideToggle()` — null where there is no side
  runtime-native.js    — the native runtime, @frontierjs/mesa/runtime/native:
                         `$$host` over Lynx's Element PAPI, the main-thread
                         globals, so no engine import and no peer. The one file
                         that names Lynx. Pointer and mouse events are made from
                         touch, one finger, so an attachment's addEventListener runs.
                         `$.measure`/`$.viewport`/`$.focus` answer a Promise
                         here, in runtime.js and in runtime-terminal.js alike
  runtime-server.js    — the server runtime, @frontierjs/mesa/runtime/server:
                         `esc` and `attrs`, the one escaper and the one
                         attribute serializer the emitter's string mode
                         calls (`FJS-D1634`). Nothing else: the mode writes
                         `$$out.push` lines, not `$$host` calls, so there is
                         no node tree here and no engine. Every rule in it
                         is a happy-dom serialization behavior the DOM path
                         shows, since parity is byte for byte against it
  entities.js          — htmlEntitiesToText(): character references as text,
                         read by the compiler and the terminal runtime's {@html}
  render-component.js  — renderComponent(): a component → HTML, at build time
  render.js            — SSR / static-site rendering entry
  compiler-md.js       — Markdown + frontmatter compiler (the .md path)
  css-inliner.js       — scoped-style extraction and inlining
  optional-peer.js     — missingPeer(): the error when a server-half peer is absent
  drive.js             — Chrome over CDP, @frontierjs/mesa/drive: openChrome,
                         findChrome, createNetwork. Published: an app's drive
                         and every in-repo drive import it (`FJS-D554`). No
                         framework import, no dependency
  window-binds.js      — what <mesa:window bind:prop> binds and the event
                         that moves each; the compiler refuses any other prop
  browser/             — @frontierjs/mesa/browser, the browser kit (`FJS-D1097`;
                         plan IDEAS/browser-kit.md). Every wrapper answers by
                         host.js — live in a tab, its default under a server
                         render, a throw on a terminal (isClient() without
                         isBrowserClient()). persisted.js is #1, on runtime.js's
                         subscribe(); prefix.js is the app's key namespace, its
                         own module because sierra's router sets it in every app
                         and persisted.js carries /redact. tab.js is #8, an
                         object watched like session (`$: tab.online`), armed at
                         its first read and held for the tab. clock.js is #2,
                         one timer per `every`, parked by a watch on
                         tab.visible. media.js is #3, one MediaQueryList
                         per query; every signal wrapper is a CALL held in a
                         const, since a template read of an imported name is
                         static (`FJS-060`, `FJS-3096`). hotkey.js is #5, a
                         keymap in its root's one keys() attachment, newest
                         first, so of two `<Esc>` the newest answers until
                         disposed; a chord a browser takes first (toolbelt's
                         `browserOwned`) throws there and at keys()'s attach.
                         datetime.js is dt/at/ago, toolbelt's createDatetime
                         over the zone the module loads in; no host rule, so
                         a terminal reads its own zone and a server render
                         the server's (`FJS-D1543`). result.js is the
                         one { ok, via, reason } an action returns;
                         browser.d.ts states each server answer
  keys.js              — @frontierjs/mesa/keys: `keys(() => ({ active, on }))`,
                         toolbelt /keys read on an element's keydown — the one
                         attachment a tab and a terminal both run (`FJS-D1388`),
                         so not in browser/, which throws on a terminal. On a
                         terminal node it is hosted through `__hostKeys`, and
                         the runtime's `stepKeys` steps every host on the
                         focus path, innermost first, then the shell's
                         (`setShellKeys`), before it makes the keydown; a key
                         one took makes NO keydown there (`FJS-D1401`), and
                         `keymapsAt(r)` lists them for help. A getter
                         may answer `mode`, which `modeAt(r)` reads off
                         the innermost host for the shell to follow
                         (`FJS-D1411`). A key ending a
                         pending sequence unfinished is swallowed on both
                         targets. On a phone it refuses `keydown` by name

mesa-vite/
  index.js             — the Vite plugin, exported as @frontierjs/mesa/vite
  client.js            — the HMR client, @frontierjs/mesa/vite/client
  swap.js              — the DOM swap it performs, @frontierjs/mesa/vite/swap.
                         jetty imports this one: no import.meta, no imports
  client-source.js     — client.js + swap.js joined, for a plugin serving the
                         client at a virtual id
  inspect-client.js    — click-to-source, as a string for a plugin to serve.
                         Sierra serves this same source at an id of its own
  hmr.js               — the HMR boundary, @frontierjs/mesa/vite/hmr
  devtools.html        — the /__mesa/devtools panel it serves

docs/VISION.md         — the language: rules 1–40ish, numbered. Cite by rule
docs/STATIC_RENDERING.md — server rendering: what runs, islands, tmpDir, globals

test/terminal/
  run.mjs              — bun test/terminal/run.mjs: the terminal target in
                         OpenTUI's headless renderer — fixtures compiled with
                         target: 'terminal', specs asserting the captured frame
                         after typed keys. Bun only: node 22 cannot load the engine,
                         so vitest excludes this directory

test/browser/
  drive.mjs            — the spec runner over src/drive.js. SHARED, unpublished:
                         @frontierjs/ui and the cli read it by relative path
  probes.js            — the in-page DOM half (waitVisible, matchedRules, …)
  runtime/             — the language in a real browser (server · page · fixtures · specs)
  vite/                — the plugin in a real dev server (app · specs)
  repl/                — example/index.html itself, offline off example/vendor/
  kit/                 — @frontierjs/mesa/browser, one spec per wrapper; runtime/'s
                         server and page, its own fixtures
  drive/               — src/drive.js itself: each spec launches its own browsers
                         (a kept profile, a wedged close, a browser gone mid-call,
                         a signal to the launcher)

bench/
  run.mjs              — bun run bench: bytes, DOM mutations, time, heap
  baseline.json        — the gated numbers. Ratchets down: --update, --adopt
  fixtures/            — rows (Mesa) · vanilla (the floor) · floor (the smallest
                         component) · shared/data.js (the workload both tables run)

scripts/
  corpus.mjs           — bun run corpus: every .mesa in the workspace, compiled
                         prod and dev, acorn-parsed; --save NAME / --diff NAME
                         grade a change meant to move no byte; --portability
                         terminal tallies every node the terminal would refuse;
                         --portability server also renders each lowering file
                         on both paths and compares the HTML byte for byte
  portability.js       — the report's counting, pure: a file lowers only when
                         every component it imports lowers. A tally change is
                         graded by test/portability.test.js, not by eye
  host-tree.js         — compileTree(): a .mesa file and its imports compiled
                         for a host target against this tree's src/. The two
                         drives and `tui` share it. A bare import resolves
                         from the source's directory, since the output sits in
                         a temp dir where `@frontierjs/toolbelt` names nothing;
                         `@frontierjs/mesa/*` is left alone. Each file's scoped rules
                         come back on `styles`, since a Lynx bundle takes its
                         stylesheet at build time and has no addStyles
  tui.mjs              — bun run tui <file.mesa>: one file live in a real
                         terminal (--frame prints one and exits, --props=JSON).
                         Paths are relative to packages/mesa; from elsewhere
                         call `bun packages/mesa/scripts/tui.mjs <path>`
```

**The Vite plugin is a subpath, not a package.** A `package.json` of its own
would put it below the `packages/*` glob — uninstalled, so nothing imports it
and nothing can test it. It also could not
find its own compiler: the resolver hunted `@mesa/compiler` and
`node_modules/mesa/`, one never published and the other someone else's package
on npm. The compiler is now a sibling and reached by relative path, which is
also the rule for every in-repo consumer of mesa (`bun install` copies workspace
deps, so a package-name import serves a stale snapshot). `vite` is an optional
peer — mesa stays a leaf.

**happy-dom, css-tree and the six markdown packages are optional peers too**, mirrored in
`devDependencies` for this suite. The server half reaches them through a
top-level `await import()` that `missingPeer` (`src/optional-peer.js`) turns into
an error naming the install. **A static `import` of one from anything a client
build reaches breaks every client-only install.** `test/optional-peers.test.js`
walks that graph.

**The file EXTENSION decides the language.** A `.mesa` file with frontmatter is
Mesa, not Markdown — `compiler-md.js` is only for `.md` (FJS-106).
