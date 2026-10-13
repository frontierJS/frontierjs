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
   (§ *The plan*, 2.1) and stored
   beside the tool manifest, keyed by `x-fjs-build` like the terminal client's
   command cache. A tool that returns a row of model `X` names the `ui://`
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

- **Does `FJS-D38`'s *nothing is scheduled before alpha* cover this?** Step 0.1
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

- [ ] 0.1 `FJS-D38`'s *nothing is scheduled before alpha* — ask whether a markup
  target plus a relay adapter is covered, the exemption `FJS-D689` gave mobile.
  Options and the recommendation are in § *Open questions*; `fli decisions`
  lists it. Closed by the owner's pick, not by this plan.
- [ ] 0.2 Where the built views live and what the plugin option is called
  (`mcpPlugin({ views })` is the placeholder spelling). An option, so
  `decision-rules`; the same ruling names the Sierra command (2.4).
- [ ] 0.3 `toolName` — `<service>_<method>`, owned by `projection.ts` — must be
  ONE spelling on both sides of the iframe. Move to `@frontierjs/toolbelt`
  (a pure function, `FJS-D26`); `@frontierjs/mcp` and Sierra both import it.
  A second spelling in the client is the drift `FJS-D197` exists to refuse.
- [ ] 0.4 SDK compatibility probe. `plugin.ts` builds on
  `@modelcontextprotocol/server@^2`'s `McpServer`; the extension's helpers
  (`@modelcontextprotocol/ext-apps/server`: `registerAppTool`,
  `registerAppResource`, `RESOURCE_MIME_TYPE`, `getUiCapability`) may target
  SDK v1. If they do not load, hand-register `resources/list` and
  `resources/read` through `McpServer.registerResource` — a few handlers. This
  decides 1.2's shape and is the largest unknown in the plan.
- [ ] 0.5 Scope: one-row views only. `answersOneRow` (`src/breadcrumbs.ts`)
  already decides *this tool answers one row of model X*; reuse it, never a
  second rule. A list view over a `find` result is Phase 5 and unscheduled.

### Phase 1 — The protocol half, inside `mcpPlugin()`

Goal: a host that speaks the extension is offered a `ui://` view per model that
has one, listed from the same projection that lists the tools.
Done when: `test/plugin.test.ts` reads a view over a real app on a real port, and
a standing withheld from the model's tools is refused the view.

- [ ] 1.1 Read `capabilities.extensions['io.modelcontextprotocol/ui']` at
  initialize. Absent: no `_meta.ui` on any tool, no resources, text as today —
  the silent downgrade § *The nine* item 8 already argues for.
- [ ] 1.2 `resources/list` and `resources/read` for `ui://<app>/<Model>`, mime
  `text/html;profile=mcp-app`. A model is listed iff some one-row tool of it is
  offered at the caller's standing — the projection's answer, read once.
  `_meta.ui.csp.connectDomains` is `[]`: the view makes no HTTP, every call is
  the host's.
- [ ] 1.3 Stamp `_meta.ui.resourceUri` on every tool `answersOneRow` admits.
  `visibility` stays the default: the verbs a view calls back (`patch`) remain
  the model's too.
- [ ] 1.4 The tool answer carries the row in `structuredContent` as Junction's
  envelope (`kind`/`data`/`total`). Confirm `plugin.ts` does; if the answer is
  text only, this is the one envelope owner to extend (Invariant 4), so the
  client's existing unwrap serves the iframe unchanged.
- [ ] 1.5 Bundle source: the plugin reads `<views>/<Model>.html` at boot, keyed by
  `x-fjs-build` the way the terminal client's command cache is. A missing file
  means no pointer for that model, never a boot failure.

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
- [ ] 2.4 The command: a `sierra <name>` beside `sierra widgets` and `sierra
  site`, wrapped by an `fli mcp:*` command; the name is 0.2's ruling.

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
