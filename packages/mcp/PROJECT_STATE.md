# Project state — @frontierjs/mcp

**An agent can reach a FrontierJS app now.** `mcpPlugin()` mounts the endpoint
inside the API that is already running; `projectTools()` is what it serves.

## What is true

- `mcpPlugin({ path })` is a Junction plugin. It registers POST/GET/DELETE at
  `/mcp` (under the app's own `apiPrefix`), builds the projection at the caller's
  standing on every request, and dispatches through `app.service(name)` with
  `{ auth: { user } }` at `CALL_OPTIONS_AT`. Stateless: nothing is kept between
  two requests, so nothing outlives a sign-out.
- `projectTools(services, views, level)` answers the tool list, the withheld
  list, the unresolved models and the name collisions — each row carrying its
  verdict AND its argument schema.
- **Four inputs**, matching what the boundary reads: the method policy, the
  model's `@@gate`, a declared move's `gate`, and `describe().methodGates`
  through Junction's own `customMethodGrade`.
- `schemaViews(schema, generate)` owns the audience. There is no way through this
  module to generate a `system`-audience schema.
- **52 tests over two files, plus a drive.** `example`: `verify:mcp` is the only
  place a real MCP client connects and the only one over an app with no `app.db`. `tests/projection.test.ts` is the rules against a
  real `.lite` fixture; `tests/plugin.test.ts` boots a real Junction app over a
  real Litestone client on a real port and speaks JSON-RPC to it.

## Measured over `example`, 2026-09-16

44 services, 248 methods. 54 tools at STRANGER, 88 at VISITOR, 142 at USER, 245
at STAFF, 248 at SYSTEM. 186 graded by a model gate, 12 by a move floor, 13 by a
declared method gate, 16 by a presence floor, 21 ungraded. 236 of 248 carry an
argument schema. No collisions, and none of the 12 protected columns in that app
reaches any tool schema.

**The RELATIONS are gated and the counts are not.** `example`'s `verify:mcp`
asserts the shape — a stranger sees fewer than a shopper, a shopper fewer than an
administrator, nothing is lost by climbing, and no protected column reaches any
tool — against a real client on a real app. The absolute figures above stay a
dated hand measurement on purpose: a typed-in count froze a Studio panel at a
four-model `example` and reported a fixture as a regression (`FJS-773`).

## Next, in order

1. **Tool descriptions from the seed.** The docs call the description the single
   biggest factor in a model choosing the right tool, and what ships is one
   generated sentence. `///` doc comments already reach `$def.description`.
2. **The level under `tenancy { strategy database }`.** There is no app-wide
   client to ask, so the standing falls back to `sessionGateLevel`. That is the
   right answer for every app declaring no `getLevel` — and the wrong one for an
   app that is both tenant-per-database and declares its own mapping. The fix is
   to resolve the request's tenant client; the cost is that listing tools would
   open one.
3. **Whether the SDK should validate the argument at all.** `fromJsonSchema`
   installs a default validator when none is passed, so the surface grades every
   tool argument before dispatch — a second engine over one schema, and the two
   disagree: `total: "2500"` against an `Int` is refused here and COERCED by the
   Data boundary, so the agent path is stricter than the HTTP one. It fails safe
   and self-corrects, but *one owner per translation* says a pass-through
   validator and let the boundary answer. Not changed without a decision.
4. **What a stranger is OFFERED, where nothing grades the service.** Over
   `example` the 21 ungraded tools include `account_changePassword`,
   `account_disableTotp` and `account_regenerateRecoveryCodes` — every one of
   them refused with *Authentication required* when called, so this is an
   affordance failure and not an escalation. The cause is upstream: those
   services resolve to no model and declare no method gate, so
   `customMethodGrade` answers `unchecked` and the API boundary checks nothing
   either. The fix belongs in the packages that ship those services, not here —
   but a surface that advertises password changes to an anonymous agent is worth
   a row of its own.
5. **A read-only mode and a dry-run mode.** Not derivable — an explicit choice.
6. **The size question.** 236 schemas is roughly 48K tokens of tool list before a
   description is written. The options are a declared allowlist (a new config
   option, so it needs a ruling), the client's own tool search, or leaving it.
7. **The hold** — a protected call becomes a proposal a human approves by name.
   Depends on the durable-workflow noun rather than defining one here.

## The 21

`example` leaves 21 methods ungraded, and they are no longer *every custom
method*: what is left is the five services whose `model` names no definition at
all — `shopfront`, `account`, `api-keys`, `connections`, `account-recovery` —
which is a real category rather than a resolution failure. `customMethodGrade`
calls that `unchecked`: no model, so no floor to derive, so nothing is checked at
the API boundary either. Whether those services should declare a gate is a
question for the apps, not for this package.
