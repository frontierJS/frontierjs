---
id: agent-client-ui
status: proposed
dated: 2026-10-10
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
   from the resource file by the widget target at build time and stored
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
   goes inside it. Sierra's widget target owns the bundle.
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

- **Does `FJS-D38`'s *nothing is scheduled before alpha* cover this?** It covers
  a non-markup target. MCP Apps is a markup target plus a relay adapter, which
  is nearer to the widget target than to the terminal. Asking rather than
  assuming; `FJS-D689` made the same exemption for mobile.
- **Sign-in inside the iframe.** The host's standing is whatever the MCP
  session resolved. Whether a resource may ask the host to elevate (OAuth back
  to the app) is a protocol question with no stable answer yet.
- **A2UI's catalog is the host's.** If the host's catalog has no `Field` with
  `aria-describedby`, the kit's forwarding rule (`ui` package) has nowhere to
  land. That is the first thing a spike would learn.

## Sources

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
