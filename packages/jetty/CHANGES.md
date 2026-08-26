# Changes — @frontierjs/jetty

## 2026-08-25 — a real Junction, at last

**`createJunctionAdapter`** (`FJS-279`), exported as `@frontierjs/jetty/junction`
and built over `@frontierjs/junction/client` — the browser client every Sierra
app already uses, rather than a second implementation written to the same
protocol. `default-adapter.js` stays what it says it is.

The subscription question the issue left open answers itself. There is nothing
for a client to send: membership is the SERVER's (`app.channel(name).join(…)`),
and what arrives is `{ type: 'event', event: 'orders pay' }`, re-emitted as
`client.on('event', …)`. A channel is the first half of that name, so a
subscription is a filter over it — and the whole name is carried on, because a
subscriber given only the data cannot tell a create from a remove (`FJS-059`).

Two things had to move for it to be honest:

- **`url` is spelled differently by the two packages.** jetty's config field has
  always been `wss://` and Junction's client takes an http origin and derives
  the socket from it, so handing one straight over builds `wsss://` and a socket
  that never opens. Both spellings are accepted.
- **Sign-in is `adapter.auth`, not `call('auth', …)`.** Junction has no service
  by that name — `@frontierjs/auth` registers `account`, `sessions` and
  `api-keys`, and establishing a session is a route (`FJS-D20`) — so the
  placeholder's pseudo-service would shadow the methods of any app that has one.
  The contract gains an optional `auth` block and `makeAuthFlow` prefers it,
  falling back to the old call for the placeholder.

Its wire behaviour is proved by `example`'s `verify:extension`, against a real
API. A fake Junction here is the mock that hid this for as long as it existed;
what is asserted in node is the shape — the URL dialect, the contract, and which
of the two sign-in spellings the auth flow reaches for.

**jetty is a real app's surface now** (`FJS-280`). `example/extension/` is a
harbor holding the only connection, a Mesa dock in the popup and a content
script on the shop's own prerendered storefront. Building it found `FJS-493`:
the resource store upserts every record its channel delivers, so a row that has
LEFT the loaded filter stays in the list. Sierra fixed exactly this with
`matchesQuery`; the pure half is not shared yet.


## 2026-08-24 — HMR registration was silently not injected, and is now proven

`FJS-481`. `injectJettyHMR` matches mesa's compiled OUTPUT with two regexes — a
shape jetty reads and does not own — and the second one's lookahead named the
runtime by identifier: `(?=\n\$runtime\.\$\$delegate|\s*$)`.

Mesa's `FJS-470` renamed every emitted identifier to `$$`. From that day, any
component carrying a delegated event — nearly all of them — was wrapped without
its `__jettyMesa.register(...)` call. Step 1 still renamed the function, so the
module looked wrapped; it mounted correctly and never registered, and the only
symptom is an edit that does not appear. Green build, green suite.

Three changes, and the second is the one that matters:

The lookahead matches the delegate call by SHAPE rather than by the namespace's
name. **The plugin throws when neither step lands**, naming the file and saying
the shape has moved — a wrapper that mounts and never registers is worse than an
unwrapped module, so this is a build-time answer rather than one at somebody's
desk. And `test/phase9.test.js` drives the function with **real compiler
output**: both branches of the lookahead, the rename, the wrapper, and the
unrecognised-shape throw. Negative-controlled — the old lookahead turns 3 of its
7 red.

**Why ~450 green tests said nothing.** The only cover was `test/hmr-fullflow.mjs`
and `test/hmr-integration.mjs`, which no script runs and which *could not* run:
they import mesa by an absolute path from another machine. Moved to
`docs/dead/` with a README — the full-flow shape through jsdom is worth
repairing one day, and `phase9` covers only the wrapper's output. Keeping them
in `test/` made a directory whose files are run also hold files that are not.

## 2026-08-17 — `resources/` stops being a copy, and two defects go with it (`FJS-059`)

`make-from-schema.js` and `hooks.js` are gone; both are
`@frontierjs/toolbelt`'s (`/jsonschema` and `/hooks`) and are re-exported from
`resources/index.js` so this stays the one import. No
`@frontierjs/resources-core` — `FJS-D16` refused a fifth published package for
~190 lines that are pure and zero-dependency.

**The copy was Sierra v0.1.0's and had cost two real defects.** Measured against
one schema, the old `make()` answered `customerId: 0` for a foreign key —
customer #0, a claim nobody made, which passes coercion and validation and is
refused by SQLite as a 500 — and `trackingCode: ''` for a `readOnly` column, a
key the Data boundary refuses BY NAME, so a form that never showed the field
could not submit at all. Both are right now because there is one implementation.

**Two things are jetty's own wiring and are new.** Sierra reads a registry its
build populates; a resource here is handed the schema document itself, so
`resolveAgainst(schema, ref)` resolves a `$ref` against that document's own
`$defs`, and the foreign-key list comes off the model's `x-relations` — the only
place a relation exists on the client, since a belongsTo is emitted as a plain
integer.

**A surface change:** `mergeHooks` answers a NEW map and mutates neither
argument, because toolbelt's licence is that every export is pure. A caller
using the re-export must assign the result.

`createStore` stays here. Sierra's is service-backed and stamps each request;
this one takes no service at all, because Junction lives in Harbor and not in
the page — two facts, not one with two owners.

**Coverage moved with the code rather than being deleted.** 22 assertions in
`phase3` that restated the substrate came out and 22 went into toolbelt's own
specs; what replaced them asks the questions that are jetty's — that the
re-exports ARE toolbelt's functions, that `mergeHooks` leaves its target alone,
and that a `make()` built off a whole schema document gets the `$ref`, the
foreign key and the `readOnly` column right. 424 pass, 0 fail.

## 2026-08-17 — the Mesa HMR swap has one owner, and it is tested

`globalThis.__jettyMesa.hot_update` carried a hand copy of Mesa's DOM swap —
~30 lines, identical in both — and **nothing ran either one**. `phase8` audits
the classic-script shape of the bundle the dev client lives in, not its
behaviour, so jetty's whole dev loop rested on code no test had executed.

**The test came first.** Eleven assertions in `phase5` over jsdom: both module
shapes `hot_update` accepts, the mark it seeds, a detached instance pruned
rather than re-rendered, one instance throwing without costing the others, and
a SECOND update landing — the shape of the bug where `__setMark` on the wrong
module made HMR work exactly once per page load and then report no instances.

**Then the extraction.** The swap is `@frontierjs/mesa/vite/swap` and both
callers import it. What stays here is what genuinely differs: the registry on
`globalThis` rather than module exports, because a content script has no module
graph to share; `hot_update` resolving a module namespace or a bare function and
answering a count; and no `import.meta.hot` anywhere, because Vite's HMR client
is not in the page. Mutation-checked — delete the `newSetMark` call in Mesa's
module and two tests here go red, which is what proves the two are one.

**The specifier resolves both ways.** jetty's mesa plugin maps
`@frontierjs/mesa/vite/swap` to Mesa's module when it is installed and to
`src/dev/mesa-swap-fallback.js` in stub mode. An extension without Mesa must not
fail to build over a feature it cannot use, and 0 is the honest answer there:
nothing can register without a compiled Mesa component. Both answers asserted.

443 pass, 0 fail.

## 2026-08-17 — an island is a lib build, and the suite is green

**Chrome could not parse a content script at all, and nothing said so.** The
built `islands/demo.js` carried `import.meta`; an MV3 content script is a
CLASSIC script, so V8 rejected the whole bundle at parse time — `Cannot use
'import.meta' outside a module` — before a line of it ran. Vite emits the
bundle happily, and the error only fires when Chrome injects the script, which
is why this survived as *the package's one failing test* rather than as a
report from anyone using it.

**Where it came from.** Vite injects its preload helper into every client build
that is not a lib or a worker, and that helper is written with
`import.meta.resolve` and `import.meta.url`. It arrived because the island graph
holds one dynamic import — `@frontierjs/mesa/runtime`, an optional peer,
imported that way so an extension without Mesa still builds — and it had nothing
to do once it got there: the graph is inlined, so there was no chunk to preload.

**The fix is to describe the output honestly.** An island is built in lib mode
now, which is both the only supported way to opt out of the helper and a true
statement about what comes out — one self-contained file, not a page module
fetched off a base URL. The single `lib.entry` also makes *one island per build*
structural: rollup refuses to inline a graph with more than one input, where the
old multi-input shape depended on the caller passing exactly one key.

**Two dead config keys found on the way, and one was load-bearing.**
`codeSplitting` is a rollup OUTPUT option — Vite reads no `build.codeSplitting`
— so both this package's configs set it where nothing looks. The islands' actual
inlining was coming from a deprecated `output.inlineDynamicImports`, and moving
to the documented replacement *in the wrong place* split the island into a 24 kB
entry plus a chunk Chrome will not load: the exact failure the config exists to
prevent, arrived at by taking the deprecation warning at face value. Harbor's
copy of the same key is inert today (nothing dynamic in its graph) and was moved
rather than deleted.

**432 pass, 0 fail** — jetty's first clean run. Output verified beyond the
suite: same path, no chunks beside it, no deprecation warning, and harbor
unchanged at 37.05 kB.

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
