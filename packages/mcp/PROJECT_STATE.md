# Project state — @frontierjs/mcp

**The projection ships. Nothing else does.** This package cannot be pointed at an
agent today: there is no transport, so no MCP client can reach it.

## What is true

- `projectTools(services, views, level)` answers the tool list, the withheld
  list and the unresolved models, each row carrying its verdict AND its argument
  schema.
- `schemaViews(schema, generate)` owns the audience. There is no way through
  this module to generate a `system`-audience schema, which is the one mistake
  here that would disclose a credential column in a tool description.
- 29 tests, run with `bun run test`. The fixture is real `.lite` source in
  `tests/fixtures/shop.lite`, parsed and run through the real generator; three
  of its shapes are ones `example` cannot produce — that file says which.
- It is graded against `example`'s real app by hand, not by a drive. **That is a
  gap**: nothing in CI runs this projection over a real app, so a change to
  `describe()`, to `generateJsonSchema`'s keywords, or to the gate kit could move
  the answer and only these unit tests would speak.

## Next, in order

1. **A transport.** stdio first. It dispatches through `app.service(name)` with
   `{ auth: { user } }` and Junction's `CALL_OPTIONS_AT` — never through
   `bridge.toContext()`, which is HTTP-shaped. One execution path or the boundary
   duplicates itself.
2. ~~**Input schemas on the tools.**~~ Done 2026-09-12 — see `CHANGES.md`. What
   it left behind is the 47: tools with no argument schema (162 of 209 carry
   one, per the root `CLAUDE.md`'s package table), which is `aggregate`
   plus every custom method the seed does not describe.
3. **A read-only mode and a dry-run mode.** Not derivable — an explicit choice.
4. **A drive over `example`**, which is what would make the hand measurements in
   `CHANGES.md` things that fail when they stop being true. **This is the gap
   that has grown rather than shrunk**: there are now two measured tables and a
   credential-absence claim in there, and none of them is gated.
5. **The hold** — a protected call becomes a proposal a human approves by name.
   Depends on the durable-workflow noun rather than defining one here.

## The 37

`example` leaves 37 custom methods ungraded — `carts.checkout`,
`payments.start`, `inventory.adjust` and the rest. Nothing in the seed says what
standing they need, so the projection labels them rather than guessing. Whether
that number should fall by declaring more moves, or by the hold covering them, is
the open design question and it is argued in `IDEAS/agent-surface.md`.
