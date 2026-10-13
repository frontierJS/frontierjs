---
id: agent-client-ui
status: proposed
dated: 2026-10-13
---

# Idea — a Resource rendered inside the agent's client: MCP Apps and A2UI as Mesa targets

**Status: PROPOSED.** Dated 2026-10-10. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. Written from a survey of what
shipped between April and October 2026 (sources at the end), with every FJS claim
checked against the tree that day.

**"Agent" means an AI caller** (`FJS-D29`), and `IDEAS/agent-surface.md` owns the
tool half: which tools a standing sees, served by `mcpPlugin()` inside the
running API. This paper is the half that paper did not ask about — **the screen
the agent's client shows a person while the tool runs**, and whether the one in
`src/resources/*.mesa` is it.

---

## What changed outside

Two protocols now let a server put a user interface inside Claude, ChatGPT,
Goose and VS Code rather than on a domain of its own.

- **MCP Apps** (extension `ext-apps`, live 2026-01-26, carried as an extension of
  the 2026-07-28 spec). A tool result names a resource at a `ui://` URI. The
  host fetches it, runs the HTML in a sandboxed iframe, and the page speaks to
  the host over JSON-RPC: it may call the server's tools and receive the
  tool's result, and it may read nothing else. Figma, Slack and Asana shipped
  the day it went live. **It is HTML and JavaScript**, which is the fact this
  paper rests on.
- **A2UI** (Google, v0.9.1 stable, 1.0 targeted Q4 2026). The agent sends a
  declarative JSON tree, and the host renders it from a catalog of components it
  already trusts. No HTML crosses the wire, and the agent may only ask for a
  component the catalog names. Built for one agent orchestrating others.

The substrate did not move: a server, HTTP, a JS runtime. What moved is **who
owns the shell** — the chat client does, and a product's screen appears inside
it, with no port, domain or login page of the product's own.

## The claim

**An FJS app already has the screen. Invariant 18 says a resource file carries
its model's default form, and `FJS-D38` says a new surface is a compiler
backend, never a second way to write a component.** So the question is not *what
UI does the agent client show* but *which Mesa target emits it*, and the two
protocols answer differently:

- **MCP Apps is a markup target**, and every Mesa target that exists produces
  markup — SPA, static, widget, email. The emit is already there. What is new is
  the transport underneath the page.
- **A2UI is a non-markup target**, the same class as the terminal backend and
  the Mesa IR (`mesa-ir.md`): a cell tree a host renders. It is the second
  customer for the seam `FJS-D38` says the first non-markup target must build or
  prove unnecessary. Its component catalog is a tone-and-treatment vocabulary
  with no colors in it, which is what `@frontierjs/css` already is (Invariant 13).

Order follows from that: **MCP Apps first**, because it reuses an emit, and
A2UI when the IR has a second backend to amortize against.

## What exists, probed 2026-10-10

- `packages/mcp/src/plugin.ts` answers `tools/list` and `tools/call` and nothing
  under `resources/*`. MCP Apps needs `resources/read` for the `ui://` URI and a
  `_meta` entry on the tool pointing at it — the same `_meta` channel the plugin
  already uses for `frontierjs/await` and breadcrumbs.
- Sierra's `widget` target builds a self-contained bundle meant to run inside
  somebody else's page. That is the closest existing artifact to a `ui://`
  resource.
- The browser client has a relay seam: `relay` → `client.forward(call)` /
  `client.receive(frame)` (Bridge index, *API → UI*). Jetty uses it so a page
  with no network reaches Junction through a service worker. **An MCP Apps
  iframe is the same situation** — the page may not open HTTP or a WebSocket
  to the app, and every call must go out as `tools/call` through the host. One
  owner already exists for *the client runs where the transport is somebody
  else's*, and this target adds a second caller to it rather than a second
  relay.
- A resource's `save()`, `more()` and the live store assume a Junction
  transport that announces writes. Inside the iframe there is no announce
  channel, so the store is request-response only. `tokenStorage` has nowhere
  to put a token either; identity is whatever standing the host's session
  already resolved for `tools/call`.

## What it would be

1. **The plugin serves `resources/read` for `ui://<app>/<Resource>`**, built
   from the resource file by a Sierra build loop of the widget build's shape
   (§ *The plan*, 2.1), written to `api/dist/mcp/` so the API image carries
   it, and read at boot from the `ui.root` the plugin is told (`FJS-D955`).
   A tool that returns a row of model `X` names the `ui://`
   resource for `X` in `_meta`. No new file in the app: the file is the one
   Invariant 18 already requires.
2. **A relay adapter for the MCP Apps host**: `client.forward(call)` becomes a
   `tools/call` JSON-RPC message to the host, and the tool result comes back
   through `client.receive(frame)`. The resource code above it does not know.
3. **Visibility is the projection's, unchanged.** A standing that cannot see
   the tool cannot fetch the resource either, because the resource is listed
   from the same projection. `x-gate` inside the iframe stays an affordance
   (Invariant 6); the server enforces on every `tools/call` regardless.
4. **A2UI later**, as a backend of the Mesa IR emitting its JSON, with the
   `@frontierjs/ui` kit as the catalog the host trusts.

## Where it is NOT a new surface

Invariant 3 lists the surfaces an app may have, and this paper proposes none.
The resource file is `web/`'s, the server half is `mcpPlugin()` inside `api/`,
and the host is a stranger's client. Coining `agent/` beside `cli/` would be a
fourth noun for a thing three already cover — the one `decision-rules` row this
proposal most nearly fails, and the reason the shape above puts the build step
in the plugin rather than in a directory.

## The nine, answered before any edit

1. **Origin** — the form has one: the resource file. The `ui://` bundle is
   compiled from it at build time, never written by hand.
2. **Concept** — zero new nouns. Target (`FJS-D38`), Resource, relay, projection,
   all exist. A2UI adds a backend, not a noun.
3. **Complexity** — the sandbox's rules (no network, host-mediated calls) are
   the protocol's, not this design's. The design adds one relay adapter.
4. **Predictability** — a resource inside Claude behaves as the same resource
   inside `web/`, with live updates absent. That absence is the one sibling
   difference and it is stated.
5. **Derived** — the bundle, the `_meta` pointer and the resource list are all
   derived from the projection and the build. Nothing restated by hand.
6. **Owner** — relay already owns *a client whose transport is someone else's*;
   this adds a caller. `mcpPlugin()` already owns the endpoint; `resources/read`
   goes inside it. A Sierra build loop beside the widget build owns the bundle
   (§ *The plan*, 2.1).
7. **Boundary** — the author writes a resource file and knows nothing about
   iframes. The host knows nothing about Mesa. The seam is the protocol's own.
8. **Failure** — a tool whose model has no resource file returns no `_meta`
   pointer and the host renders text, which is what it does today. Silent
   downgrade is correct here: the text answer is not wrong.
9. **Silence** — *what must stay true*: a standing that cannot call a tool
   cannot load its screen. *What fails*: a projection test that asserts the
   resource list equals the tool list for every fixture standing, and a
   `drive-browser` run loading the bundle in a sandboxed iframe against a fake
   host that refuses every message but `tools/call`. Until those exist the
   answer is `none`, and this paper records it as unenforced.

**Adjudications in tension (§ IV):** *batteries vs. smallness* — `mcp` is a
battery, and `resources/read` plus the relay adapter land inside it, severable
with it. *Familiarity vs. precision* — the protocol says `resources/read` and
this paper writes that word in code spelling only; **Resource** keeps its FJS
meaning, and a `ui://` entry is *the bundle*, never *a resource*, so the two do
not collide in prose.

**Tier:** Assessment. Nothing here is a ruling; the one ruling it would need is
whether the terminal backend or this one builds the IR seam first, and that is
owed to `mesa-ir.md`, not here.

## Open questions

- ~~**Does `FJS-D38`'s *nothing is scheduled before alpha* cover this?**~~ **Answered 2026-10-13 (`FJS-D38`): `FJS-D38`'s own price paragraph is the test, and this design pays none of it: no second emit, no forked runtime, the same `.mesa` file compiled by the same compiler. B mints a ruling to exempt a thing the line never covered, and every later markup wrapper (a `print-kit` document is already one) would need its own. C holds a line against the one kind of target the ruling priced at zero. *Doctrine vs. discovery* (§ IV): the doctrine's word is *target* and the tree now holds three markup ones built without a ruling; A fixes the doctrine's reading, not the tree.** Step 0.1
  of § *The plan*. The deferral is written against a *target*, and `FJS-D38`
  prices a target as *a second compiler backend emitting a cell tree* — the
  runtime restated. Nothing in Phases 1–4 restates the runtime: the view is the
  DOM backend's own output wrapped as one HTML document (the widget build's
  loop, `packages/sierra/src/build/widget-build.js`), and the relay adapter is
  the handle jetty's `harborApp()` already answers
  (`packages/jetty/src/resources/harbor-app.js`). `email-kit`'s
  `target: 'email'` is the precedent: a markup target that shipped under
  `FJS-D38` with no exemption, because `FJS-D38` names it as one that already
  exists. Two exemptions have since been ruled anyway — `FJS-D689` for mobile,
  `FJS-D810` for the terminal shell — so the line now reads as *ask*, and this
  asks.
  - **A** — the deferral does not reach it: an MCP App view is markup from the
    existing backend, as SSR, `email` and the widget target are, so no ruling
    is owed and `fli decide --by FJS-D38` strikes this. The plan runs from
    0.2. A note on `FJS-D38` says the line defers backends, not wrappers, so
    the next markup-shaped proposal does not ask again.
  - **B** — covered, and exempted the way `FJS-D689` exempted mobile: one
    `FJS-D##` amending `FJS-D38`'s line for MCP Apps, with the proof it owes
    named in the ruling (the two artefacts § *The nine* 9 lists). The plan
    runs from 0.2 under that id.
  - **C** — covered and held: the paper stays Assessment, Phases 1–4 wait for
    core to leave alpha, and 0.3 (`toolName` to toolbelt) lands alone, since
    it is a drift fix `FJS-D197` already owes.
  - **Recommend A** — `FJS-D38`'s own price paragraph is the test, and this
    design pays none of it: no second emit, no forked runtime, the same
    `.mesa` file compiled by the same compiler. B mints a ruling to exempt a
    thing the line never covered, and every later markup wrapper (a
    `print-kit` document is already one) would need its own. C holds a line
    against the one kind of target the ruling priced at zero. *Doctrine vs.
    discovery* (§ IV): the doctrine's word is *target* and the tree now holds
    three markup ones built without a ruling; A fixes the doctrine's reading,
    not the tree.
- ~~**Where the built views live, and what the plugin option and the Sierra command are called**~~ **Answered 2026-10-13 (`FJS-D955`): A — `api/dist/mcp/<Model>.html`, written by `sierra mcp` run from `web/` with `--out <absolute dir>` and refused without it; `fli mcp:build` supplies `$.paths.api/dist/mcp`, because fli is the one thing that knows the app's layout and a relative default crossing a surface is the derived path Invariant 3 forbids. The plugin is told once, as `static` is told its `root`: `mcpPlugin({ ui: { root } })` — `ui` is the extension's own key (`capabilities.extensions['io.modelcontextprotocol/ui']`, `_meta.ui`) and leaves room for `csp` and `permissions` beside `root`. Absent, the plugin registers text-only tools. Declared and missing at boot, it REFUSES to start, naming the directory and `fli mcp:build`: that amends 1.5's *never a boot failure* to per-file (a model with no view is no pointer; a surface with no directory is a deploy defect). The image carries API and views from one commit, so 1.5's `x-fjs-build` key is unneeded — agreement by construction, not by check.**
  Steps 0.2 and 2.4. Probed 2026-10-13. The API image
  `fli make:deploy` writes COPYs `api/` and `db/` and its `.dockerignore` drops
  `web/`, so nothing under `web/dist/` exists where `mcpPlugin()` boots in
  production. `vite build` empties the SPA's own `dist/`
  (`packages/cli/core/desktop-surface.js` records a wrapped build deleting it),
  so a second loop writing beside it is the `FJS-D127` hazard by another path.
  And the plugin's silent downgrade (§ *The nine* 8) would turn a directory
  missing from the image into *no views in production* with nothing said.
  `desktop/ wraps web` is the precedent that decides it: **the output belongs
  to the surface that SHIPS it.** On the names: `plugin.ts` already calls its
  schema audiences `views: SchemaViews`, and *view* is an open Page-tier word
  in `VOCABULARY.md`, so `mcpPlugin({ views })` would collide inside one file
  and bless a noun by the side door.
  - **A** — `api/dist/mcp/<Model>.html`, written by `sierra mcp` run from
    `web/` with `--out <absolute dir>` and refused without it; `fli mcp:build`
    supplies `$.paths.api/dist/mcp`, because fli is the one thing that knows
    the app's layout and a relative default crossing a surface is the derived
    path Invariant 3 forbids. The plugin is told once, as `static` is told its
    `root`: `mcpPlugin({ ui: { root } })` — `ui` is the extension's own key
    (`capabilities.extensions['io.modelcontextprotocol/ui']`, `_meta.ui`) and
    leaves room for `csp` and `permissions` beside `root`. Absent, the plugin
    registers text-only tools. Declared and missing at boot, it REFUSES to
    start, naming the directory and `fli mcp:build`: that amends 1.5's *never
    a boot failure* to per-file (a model with no view is no pointer; a surface
    with no directory is a deploy defect). The image carries API and views
    from one commit, so 1.5's `x-fjs-build` key is unneeded — agreement by
    construction, not by check.
  - **B** — `web/dist/mcp/`, emitted INSIDE the SPA build as a postbuild step
    (the islands' shape: a second Vite build, `emptyOutDir: false`), switched
    on by `sierra.config.js` `mcp: true`. The Dockerfile template gains
    `COPY web/dist/mcp` and `.dockerignore` an exception for it; the plugin
    reads `../web/dist/mcp` and keeps the `x-fjs-build` key, because web and
    API release separately (deploy steps 03 and 08) and can be two commits.
    Every SPA build of an opted-in app grows by N library builds.
  - **C** — no files in the image: the SPA release serves
    `/mcp/<Model>.html` and the plugin's `resources/read` fetches it from the
    web origin and relays the bytes. The API must then be told the web origin,
    a tool answer gains a network hop, and a down SPA host empties the agent's
    screen.
  - **Recommend A** — the nine: *origin* — the path is written once, in fli's
    layout, and read by `--out` and `ui.root`; *concept* — zero nouns, `mcp`
    already names the battery and `fli mcp:*` follows `fli outbox:*` and
    `fli notifications:*`, the battery namespaces that exist; *complexity* —
    N builds is the widget loop's cost and the problem's (a host cannot load a
    shared chunk), A adds one required flag; *predictability* — output under
    the shipping surface's `dist/` as desktop does, a plugin told a `root` as
    `static` is, a battery namespace as outbox has; *derived* — the image
    carries the views through the `COPY api` it already has, nothing restated;
    *owner* — fli owns the layout, Sierra the build, the plugin the serving,
    and the Dockerfile template is untouched; *boundary* — `sierra mcp` takes
    one absolute `--out`, `mcpPlugin` one absolute `ui.root`, both refused
    when relative; *failure* — a declared directory missing at boot refuses
    loudly, because the mistake it hides is the whole surface gone in
    production, and a model with no file stays silent, because text is not
    wrong; *silence* — what must stay true is that the image serves the views
    its commit built, and what fails is `example`'s `verify:mcp` reading one
    view through `resources/read` after `fli mcp:build` — until that drive
    lands the answer is `none`. B fails *derived* (a Dockerfile exception
    restating the layout) and *silence* (two commits, one key, a stale view
    nothing reports). C fails *boundary* (the API learns the web origin).
    *Batteries vs. smallness* (§ IV): `fli mcp:*`, `api/dist/mcp/` and
    `ui.root` are the battery's and go with it. *Familiarity vs. precision*:
    `ui` is taken from the spec because it fits whole; `views` is refused
    because it half-fits and collides. Tier: Register — the ruling closes 0.2,
    names 2.4 and amends 1.5.
- **Sign-in inside the iframe.** The host's standing is whatever the MCP
  session resolved. Whether a resource may ask the host to elevate (OAuth back
  to the app) is a protocol question with no stable answer yet.
- **A2UI's catalog is the host's.** If the host's catalog has no `Field` with
  `aria-describedby`, the kit's forwarding rule (`ui` package) has nowhere to
  land. That is the first thing a spike would learn.

## The plan — MCP Apps first

Written 2026-10-13 from a probe of the tree and the extension spec dated
2026-01-26. Each phase ends in something checkable; nothing below is behavior
until its box is closed.

**What the probe corrected.** This paper said Sierra's widget target owns the
bundle. Half right. A widget is an IIFE a host page mounts through a custom
element; an MCP App view is a WHOLE HTML5 document the host runs in a sandboxed
iframe, mime `text/html;profile=mcp-app`, with no network of its own. So the
emit is the widget build's loop (`build/widget-build.js`: one Vite library build
per entry, runtime and CSS inside) plus a document wrapper, and the entries are
`src/resources/*.mesa` rather than `src/Embeds/`. A new loop of the same shape,
not the widget target.

**The wire, as the spec names it.** A tool links to its view through
`_meta.ui.resourceUri`; the flat `ui/resourceUri` key is deprecated. The view
speaks JSON-RPC to `window.parent` over `postMessage`: it sends `ui/initialize`
and `ui/notifications/initialized`, then `tools/call`, `resources/read`,
`ui/notifications/size-changed`; the host sends `ui/notifications/tool-input`,
`ui/notifications/tool-result`, `ui/notifications/host-context-changed`
(theme, display mode, container size) and `ui/resource-teardown`. The host
advertises the extension as `capabilities.extensions['io.modelcontextprotocol/ui']`
with `mimeTypes`; a server with no such client registers text-only tools. A
resource's `_meta.ui` carries `csp` (`connectDomains`, `resourceDomains`,
`frameDomains`, `baseUriDomains`), `permissions` and `prefersBorder`. Tool
`visibility` is `model`, `app`, or both (the default).

### Phase 0 — Rulings and probes

Goal: every judgment call below has an owner's answer before a line is written.
Done when: each step cites the ruling or the probe's result.

- [x] 0.1 `FJS-D38`'s *nothing is scheduled before alpha* — ask whether a markup
  target plus a relay adapter is covered, the exemption `FJS-D689` gave mobile.
  Settled 2026-10-13 by `FJS-D38` itself, option A in § *Open questions*: the
  line defers a compiler backend, and a markup wrapper over the DOM backend is
  not one. No new ruling; the plan runs from 0.2.
- [x] 0.2 Where the built views live and what the plugin option is called.
  Ruled 2026-10-13, `FJS-D955`, option A in § *Open questions*:
  `api/dist/mcp/<Model>.html`, written by `sierra mcp --out <absolute dir>`
  run from `web/`, the dir supplied by `fli mcp:build`; the plugin is told
  `mcpPlugin({ ui: { root } })`. The same ruling names 2.4 and amends 1.5.
- [x] 0.3 `toolName` — `<service>_<method>`, owned by `projection.ts` — must be
  ONE spelling on both sides of the iframe. Move to `@frontierjs/toolbelt`
  (a pure function, `FJS-D26`); `@frontierjs/mcp` and Sierra both import it.
  A second spelling in the client is the drift `FJS-D197` exists to refuse.
  Done 2026-10-13: it is `@frontierjs/toolbelt/inflect`'s `toolName` — the
  SHAPE axis already owns how a name is spelled for a consumer, so no new kit
  and no new noun; `projection.ts` imports it and `@frontierjs/mcp` no longer
  re-exports it. The nine passed; the one `none` is that nothing greps for a
  hand copy beyond the two specs that assert the spelling.
- [x] 0.4 SDK compatibility probe. `plugin.ts` builds on
  `@modelcontextprotocol/server@^2`'s `McpServer`; the extension's helpers
  (`@modelcontextprotocol/ext-apps/server`: `registerAppTool`,
  `registerAppResource`, `RESOURCE_MIME_TYPE`, `getUiCapability`) may target
  SDK v1. If they do not load, hand-register `resources/list` and
  `resources/read` through `McpServer.registerResource` — a few handlers. This
  decides 1.2's shape and is the largest unknown in the plan.
  Probed 2026-10-13, `ext-apps@2.0.3` against `server@2.2.0` + `client@2.2.0`
  over `InMemoryTransport`: **it loads and round-trips** — `registerAppTool`,
  `registerAppResource`, `getUiCapability` and `RESOURCE_MIME_TYPE` all work,
  `tools/list` carries `_meta.ui.resourceUri`, `resources/list` and
  `resources/read` answer the `ui://` uri. Two things the probe found that the
  plan did not know: the server half is 561 bytes and imports nothing — three
  spec constants (`EXTENSION_ID`, the mime type, the legacy key) and two
  wrappers over `registerTool`/`registerResource`, the tool one MIRRORING
  `_meta.ui.resourceUri` into the deprecated `_meta['ui/resourceUri']` so a
  host on either spelling sees it; and the package hard-peers `zod ^4.2`
  (bun installs it, nothing on the server path loads it) while the browser
  `App` class, which Phase 2's iframe would want, imports `client`, `core`
  and `zod/v4` — a bundle question for 2.x, not for here. 1.2 keeps the
  helpers' shape; the hand-register fallback is not needed.
- [x] 0.5 Scope: one-row views only. `answersOneRow` (`src/breadcrumbs.ts`)
  already decides *this tool answers one row of model X*; reuse it, never a
  second rule. A list view over a `find` result is Phase 5 and unscheduled.
  Confirmed 2026-10-13, probed rather than ruled: the rule is `model` set and
  `kind: 'move'` or a CRUD verb in `get`/`create`/`patch`/`update`/`restore`,
  it is the one such rule in `packages/mcp/src` (`projection.ts` has an
  id-TAKING rule at `inputFor`, a different question), and it stays where it is
  — both consumers are `plugin.ts`, one module away, and the function reads
  nothing of the projection's. Two verbs it leaves out, each on purpose:
  `upsert` is in `CRUD` but `dispatchable()` refuses it until Junction has a
  signature for it, so admitting it names a tool that cannot run; `remove`
  by id answers the row it stamped or deleted, and the breadcrumb rule already
  chose that a removed row offers nothing next — a view follows the same
  answer rather than opening a second one. 1.3 amends the function's JSDoc
  when the second caller lands; a comment naming a caller that does not exist
  yet is a sketch. Silence: `test/breadcrumbs.test.ts` § *what gets
  breadcrumbs at all* pins the rule, and nothing fails a second one — `none`,
  as 0.3 recorded.

### Phase 1 — The protocol half, inside `mcpPlugin()`

Goal: a host that speaks the extension is offered a `ui://` view per model that
has one, listed from the same projection that lists the tools.
Done when: `test/plugin.test.ts` reads a view over a real app on a real port, and
a standing withheld from the model's tools is refused the view.

- [x] 1.1 Read `capabilities.extensions['io.modelcontextprotocol/ui']` at
  initialize. Absent: no `_meta.ui` on any tool, no resources, text as today —
  the silent downgrade § *The nine* item 8 already argues for.
  Done 2026-10-13, and not as written — a hearing (§ IV *doctrine vs.
  discovery*), because the step and the code disagreed. **The read as written
  is impossible on this server.** `mcpPlugin` builds one `McpServer` per HTTP
  request (stateless by design: the standing is re-read every time), so the
  instance that answers `tools/list` never saw `initialize`; the ext-apps
  helper's `oninitialized` example, which the step copied, is the stateful
  shape. The SDK knows this: its 2026-07-28 era carries the client's
  capabilities in EVERY request's `_meta` (`CLIENT_CAPABILITIES_META_KEY`,
  "servers must not infer capabilities from prior requests"), and on the 2025
  era "per-request instances that never saw an initialize hold nothing" — its
  own words. Measured: `client@2.0.0` over the stateless transport sends no
  `_meta` on `tools/list`, and `core@2.2.0` still defaults to `2025-11-25`, so
  no host in the wild carries the envelope yet. Three readings of silence: **A**
  the step's — absent is none — which is text-only for every host that exists
  and a modern-era test client the only thing that could ever close Phase 1;
  **B** read the envelope where the era carries it, and silence is UNKNOWN,
  which is permissive as `x-gate` is in the browser (Invariant 6's own clause),
  because a view is an affordance a host that does not speak the extension
  ignores; **C** always stamp, read nothing, which differs from B only for a
  modern host that declares its capabilities and names no view, and that host
  then gets `ui://` entries it never asked for. **B landed.** *Ergonomics vs.
  strictness* settles A against B: strictness follows what a mistake destroys,
  and a stray `_meta` key destroys nothing where a dead surface loses the whole
  feature. The six-months tiebreak settles C against B: when hosts move to the
  2026 era C would be the thing someone adds the read to, and B is the spec's
  own shape through the SDK's own constants. In `plugin.ts`: `asksToAwait`
  became `readRequest`, the ONE parse of the body answering both facts, and
  `CallScope.renders` carries the answer to 1.2 and 1.3. `@modelcontextprotocol/
  ext-apps` is now a dependency (0.4's `getUiCapability`, `RESOURCE_MIME_TYPE`).
  The nine, in order: origin — the key and the mime type are the SDK's exports,
  no second spelling; concept — the dependency 1.2 already owed, no noun;
  complexity — the read is the field's, capability negotiation in a stateless
  server; predictability — silence is read as `x-gate` reads it, where A would
  have made an affordance the one sibling that fails closed; derived — read
  from the request, nothing restated; owner — the existing body read, grown,
  rather than a second `JSON.parse` beside it; boundary — a host sees `_meta.ui`
  or not and knows nothing of the rule, the type is ext-apps'
  `McpUiClientCapabilities`; failure — a host misread gets text or a key it
  ignores, both a turn and never a grant; silence — must stay true: *an
  envelope naming no view gets no `_meta.ui`, and no envelope gets it*, pinned
  by the 1.3 test as a pair over hand JSON-RPC, since nothing is observable
  until the stamp lands. Tier: Assessment, here. No ruling: nothing in
  `DECISIONS.md` is overridden and Invariant 6 is the citation.
- [x] 1.2 `resources/list` and `resources/read` for `ui://<app>/<Model>`, mime
  `text/html;profile=mcp-app`, through `registerAppResource` and
  `registerAppTool` (0.4). A model is listed iff some one-row tool of it is
  offered at the caller's standing — the projection's answer, read once.
  `_meta.ui.csp.connectDomains` is `[]`: the view makes no HTTP, every call is
  the host's.
  Done 2026-10-13, and 1.5 with it: a resource needs bytes, and the bytes are
  1.5's `<ui.root>/<Model>.html`, so the two steps are one change. In
  `plugin.ts`: `mcpPlugin({ ui: { root } })` (`FJS-D955`), `readDocuments`
  at boot, `offerViews` per request over the tool list AFTER `narrow` and the
  key's scopes, `viewUri(server, model)` the one spelling 1.3 stamps on the
  tool. `<app>` is the server's name, `opts.name ?? app.config.name` — the
  option's doc said *the app's name* and the code said `frontierjs`; the code
  now matches the doc. **One finding the step did not know:** the SDK installs
  the `resources/*` handlers with the FIRST `registerResource` and nowhere
  public, so a caller offered no view is a server with no resources —
  `initialize` declares none and `resources/list` is `-32601`. Declaring the
  capability without the handler was tried and dropped: it tells a host to
  call what then fails. *Paved road vs. workaround* (§ IV): the SDK's own
  installation over a private method or a disabled placeholder. The nine,
  answered LATE (after green): origin — `viewUri` is the URI's one function,
  the mime and extension id are ext-apps' exports, the model set is the tool
  list's; concept — no noun, `ui.root` is the ruled key; complexity — a
  directory listing at boot and one registration per one-row model, plus a
  boot warning for a document naming no model; predictability — told a `root`
  as `static` is, refused as `FJS-D955` says, and `-32601` is what every
  resourceless `McpServer` answers; derived — the list is read off the
  narrowed tool list, never declared, and the file set is read off disk;
  owner — inside the per-request server beside `register()`, no second body
  parse (`renders` from `readRequest`); boundary — a host sees a URI, a mime
  and a csp, the app author passes one absolute directory; failure — relative
  or missing root refuses the boot (the whole surface gone), a missing file is
  silent (text is not wrong), a stale file warns at boot; silence — must stay
  true: *a standing withheld a model's one-row tools is not offered its view,
  and one offered it reads the file's bytes under the extension's mime* —
  fails in `test/plugin.test.ts` § the views: the stranger/shopper pair, the
  `narrow` test, the read pair, the envelope pair, and both boot refusals.
  `verify:mcp` is unchanged (`example` passes no `ui` yet; 4.2 is that test).
  Tier: Assessment; `FJS-D955` is the citation and nothing is overridden.
- [x] 1.3 Stamp `_meta.ui.resourceUri` on every tool `answersOneRow` admits.
  `visibility` stays the default: the verbs a view calls back (`patch`) remain
  the model's too.
  Done 2026-10-13. In `plugin.ts`: `viewedModels(tools, documents)` is the one
  answer to *which models have a view for this caller* — one-row tool offered
  AND document present — read by `offerViews` for the resource list and by
  the tool loop for the stamp, so a pointer cannot name a view the same
  caller is not listed. `register()` takes the `ui://` URI or null; a viewed
  tool goes through `registerAppTool`, which mirrors the pointer into the
  legacy `_meta['ui/resourceUri']` for older hosts, and a text tool is
  registered as before. `answersOneRow`'s JSDoc names its three callers
  (0.6). The nine, answered LATE (after green): origin — the viewed set is
  one function and the URI is `viewUri`; concept — no noun, a `view`
  parameter; complexity — one Set per request and one branch in `register`;
  predictability — a viewed tool is registered as its resource is, through
  the extension's wrapper, and `visibility` default means its siblings are
  agent-callable alike; derived — the stamp is read off the same set as the
  list, never declared twice; owner — the branch is INSIDE `register()`, the
  one registration, not a second one beside it; boundary — a host reads
  `_meta.ui.resourceUri` in either spelling and the app author passes
  nothing new; failure — a model with no document stamps nothing and refuses
  nothing, text is not wrong; silence — must stay true: *the set of URIs
  stamped on a caller's tools equals the set of resources that caller is
  listed* — fails in `test/plugin.test.ts` § the tool points at it: the
  agreement test over staff and shopper, the three-verb stamp with both
  spellings, the narrow and declared-no-ui pair. Adjudication: *paved road
  vs. workaround* — the wrapper over a hand-written `_meta`. Tier:
  Assessment; nothing in `DECISIONS.md` is overridden. `verify:mcp` is the
  no-`ui` path only, as at 1.2; 4.2 is the drive over a built view.
- [x] 1.4 The tool answer carries the row in `structuredContent` as Junction's
  envelope (`kind`/`data`/`total`). Confirm `plugin.ts` does; if the answer is
  text only, this is the one envelope owner to extend (Invariant 4), so the
  client's existing unwrap serves the iframe unchanged.
  Done 2026-10-13. It was text only. `run()` now sets `structuredContent` to
  `result` when it is an object — the value `app.service()` already handed it,
  which is `unwrapResult(ctx.result)`, the same unwrap the socket's
  `service_result` carries: a `find` keeps its `kind`/`data`/`total` envelope
  and a `get` is the row. *Junction's envelope* above means that wire
  convention, not a `{ kind, data }` around a single — the client's `get()`
  never unwraps one, so a rebuilt envelope would have needed a new unwrap in
  3.2, where `forward()` already resolves exactly this. A scalar or array
  answer (a custom method's) rides in the text alone: the protocol types the
  field as an object. The nine, answered BEFORE the edit: origin — one value,
  `result`, read by the text block and the field, and the wire shape's owner
  stays `envelope.ts`; concept — a protocol field, no noun; complexity — one
  guard and one assignment; predictability — a relayed call resolves what a
  socket frame resolves, per method; derived — the field is never shaped by
  hand, it is the stringified value before stringifying; owner — no second
  wrap beside the owner's unwrap; boundary — a host reads the field with no
  knowledge of the text, and the app author passes nothing; failure — a
  non-object answer stamps nothing and refuses nothing; silence — must stay
  true: *where present, `structuredContent` equals `content[0].text` parsed,
  and it is present on every CRUD `get` and `find`* — fails in
  `test/plugin.test.ts` § the answer is structured (the get, the find with its
  `kind`, the scalar `credentials_tally` carrying none), and the FJS-D473 test
  greps the whole body, so the field is held to the same `@secret` absence.
  Adjudication: *doctrine vs. discovery* — this step's wording against the
  wire; the wire won and the wording is amended here, since 3.2 already said
  the same. Tier: Assessment; nothing in `DECISIONS.md` is overridden.
  `verify:mcp` is the no-`ui` path, as at 1.2 and 1.3.
- [x] 1.5 Bundle source: the plugin reads `<ui.root>/<Model>.html` at boot
  (`FJS-D955`). Done 2026-10-13 inside 1.2, every clause below as written; the
  boot warning for a `<Model>.html` no one-row tool answers is the one addition. No `x-fjs-build` key: the image carries the API and its views
  from one commit. A missing FILE means no pointer for that model and nothing
  said; a declared `ui.root` that is not a directory refuses the boot, naming
  it and `fli mcp:build`, because the mistake it hides is the whole surface
  gone in production. `ui` absent means text-only tools, by design.

### Phase 2 — The build half, in Sierra

Goal: `src/resources/<Model>.mesa` compiles to one self-contained HTML document
per model, with nothing written by hand.
Done when: the loop emits a document per resource file over `example`, and a
file with no markup half emits the model's default form.

- [ ] 2.1 A build loop beside `build/widget-build.js`, same shape: a generated
  entry per resource file imports the Resource and mounts its view over
  `mcpApp()` (3.1); the Mesa runtime and the stylesheet are inlined into one
  `<script>` and one `<style>` of an HTML5 document. N builds for N views, for
  the reason the widget file states — a bundler's shared chunk is the one thing
  this host cannot load.
- [ ] 2.2 What the view IS: the resource file's markup half when it has one,
  else the generated `<Form record>` — the file already carries the model's
  default form (Invariant 18). A save is `resource.save(data, { mode: 'patch' })`
  and leaves through the relay.
- [ ] 2.3 Theme: `hostContext.theme` from `ui/initialize` becomes the class on
  `<html>`, since Sierra owns the switch (Bridge index). Mapping
  `hostContext.styles.variables` onto `@frontierjs/css` tokens is later work,
  named in Phase 5.
- [ ] 2.4 The command: `sierra mcp --out <absolute dir>` beside `sierra widgets`
  and `sierra site`, run from `web/` and refused without `--out` or with a
  relative one; `fli mcp:build` wraps it and supplies `$.paths.api/dist/mcp`
  (`FJS-D955`). No `sierra.config.js` key for the output: fli is the one
  origin of the app's layout.

### Phase 3 — The client half, a relay adapter

Goal: the Resource inside the iframe is Sierra's own, over a Junction client
whose transport is the host.
Done when: a `createResource(name, { app: mcpApp() })` loads and saves through
`tools/call` with no HTTP from the iframe.

- [ ] 3.1 `mcpApp()` answers `{ client, registry, user }`, the exact handle
  jetty's `harborApp()` answers (`packages/jetty/src/resources/harbor-app.js`).
  `createJunctionClient({ relay })`, where `relay` turns a `RelayedCall`
  (`{ service, method, id, data, query, opts }`) into a `tools/call` request to
  `window.parent`, named by `toolName(service, method)` (0.3).
  `tokenStorage: null`; `connect()` is never called.
- [ ] 3.2 The answer mapping: `CallToolResult.structuredContent` is what
  `forward()` would have resolved; `isError` rebuilds the framework error's
  `code` and `data`, so `toFieldErrors(err)` still lands a message under its
  field. Jetty learned this once — a refusal crossing a JSON port arrived as
  `{}` and a 409 was indistinguishable from a 400.
- [ ] 3.3 The handshake: `ui/initialize` → `ui/notifications/initialized` → the
  first `ui/notifications/tool-result` seeds the record store → mount →
  `ui/notifications/size-changed`. `host-context-changed` re-applies the theme;
  `ui/resource-teardown` unmounts.
- [ ] 3.4 Identity: no boot restore — `account.me` is a route, and a relayed
  client refuses routes by name. `session.ready` resolves at once with
  `user: null`; `resource.can()` is permissive on an unknown answer and the
  server enforces every `tools/call` (Invariant 6). This is the second sibling
  difference, stated beside the first: no live pushes.
- [ ] 3.5 The live store is request-response only; `stale` never fires. Written
  into the handle's header rather than worked around.

### Phase 4 — Proof

Goal: § *The nine* item 9 stops reading `none`.
Done when: the three tests below are green in CI and the drive is a row in
`DRIVES.md`.

- [ ] 4.1 Projection test: for every fixture standing, the resource list equals
  the models of the one-row tools offered, and a withheld tool's model is
  unlisted.
- [ ] 4.2 Plugin test over a real app on a real port: `resources/read` answers
  the document with its mime; a stranger reading a staff-only model is refused.
- [ ] 4.3 A browser drive over mesa's `test/browser/drive.mjs` harness. The fake
  host serves from a SECOND origin, as the spec requires of a host and its
  sandbox (`widget/serve.js` is already the cross-origin shape), with the iframe
  under `sandbox="allow-scripts allow-same-origin"`. It answers `ui/initialize`
  and `tools/call` — proxied to the real `/mcp` — and refuses every other
  method. Asserts: the form renders the row, a patch round-trips, the iframe's
  failed-request count is zero and no request reaches the app's origin. Lands
  in `example` as a drive.
- [ ] 4.4 A real host, by hand: the MCPJam inspector or Claude Desktop. Dated in
  `packages/mcp/PROJECT_STATE.md`, not asserted.

### Phase 5 — Unscheduled

- [ ] 5.1 List views over a `find` result.
- [ ] 5.2 `hostContext.styles.variables` → `@frontierjs/css` tokens.
- [ ] 5.3 A2UI as an IR backend, when `mesa-ir.md` has its seam.

### Sizes and risks

| Piece | Where | Size |
| --- | --- | --- |
| protocol (Phase 1) | `packages/mcp/src/plugin.ts` | small; 0.4 is the risk |
| build loop (Phase 2) | `packages/sierra/src/build/` | medium; copies the widget shape |
| relay adapter (Phase 3) | Sierra `resource/`, see below | small; the handshake is the work |
| drive (Phase 4) | `example/` | medium; the fake host is new |

**Where the adapter lives is open.** Sierra's `resource/` owns the Resource and
already holds `connectApp()`, the other handle over a client that is not the
page's; `@frontierjs/mcp/client` owns the protocol. Recommend Sierra, with
`toolName` in toolbelt (0.3): then `@frontierjs/mcp` imports nothing from the UI
realm and Invariant 1 stays as it is.

## Sources

- MCP Apps extension spec 2026-01-26:
  github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx,
  modelcontextprotocol.io/extensions/apps/overview
- MCP Apps extension and the 2026-07-28 release:
  blog.modelcontextprotocol.io, workos.com/blog/2026-01-27-mcp-apps,
  scalekit.com/blog/mcp-apps-saas-context-engines
- A2UI: developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces,
  a2ui.org/roadmap
- Comparison: sunpeak.ai/blogs/mcp-apps-vs-a2ui

## See also

`IDEAS/agent-surface.md` (the tool half) · `IDEAS/chat-surface.md` (the app
driving a model, the other direction) · `IDEAS/mesa-ir.md` (the non-markup
seam) · `DECISIONS.md` `FJS-D38`, `FJS-D258`, `FJS-D29`.
