# @frontierjs/claude — the inside view

**The local `claude` program: the command line it starts with and the stream it answers in.**
Ruled `FJS-D2321`–`FJS-D2325` — in the tree, TypeScript, published, one package.
The Messages API is `packages/conduits/conduit-anthropic`, never here; the name can
read as covering it, so the README's first line says otherwise.

## What it owns

`src/limits.ts` the fixed values, `src/argv.ts` the profiles (`askArgv`, `sessionArgv`),
`src/events.ts` the stream reader and its typed events, `src/images.ts` pasted images,
`src/run.ts` `runAsk`, `src/door.ts` `claudeDoor` (the `@frontierjs/toolbelt/ask` door over `runAsk`'s `answer` profile). The live chat: `src/protocol.ts` the control channel, `src/permission.ts`
a prompt's card and answer, `src/catalog.ts` what init and `initialize` offer, `src/session.ts`
the process (`Session`). Claude Code's own files: `src/read.ts` (`Read`, `claudeConfigDir`, `readJsonObject`), `src/messages.ts` (`readMessages`), `src/transcript.ts` (the turn fold), `src/calls.ts` (`readToolCalls`, inputs kept), `src/sessions.ts` (the session list), `src/scan.ts` (the configuration, over the pure `src/settings.ts`, `src/hooks.ts`, `src/items.ts`, `src/mcp.ts` and `src/plugins.ts`), `src/quota.ts` (the login token, its usage endpoint and `loginSend`, the token on `conduit-anthropic`'s target), `src/context.ts` (a session's first request, counted through `loginSend`), `src/subcommands.ts` (`auth status`, `mcp list`, `doctor`, `runClaude`). The protocol's frames are `docs/control-protocol.md`. Every in-tree
caller (cli, Workbench, Basecamp, Haven's study, the loop scripts) and Lathe import it by name. What is left of the plan is
`IDEAS/claude-calls.md` Phase 6; do not cite it as behavior.

## Traps

- **Depend on nothing in `cli`.** `cli` depends on this package, so a reverse import
  is a cycle. Phase 2.3 pins it.
- **Prompts stay with their product.** `test/transport.test.ts` fails on an export
  named like a rule, prompt, handoff, kind or scope.
- **`src/limits.ts` and `src/catalog.ts` have no `node:` import**, so a value can be named without the runner.
- **A product's words stay out of `Session`.** The host's name reaches a deny's note and the
  refusal of a request it does not serve through `host`, a deny's own wording through `deny`
  (Haven's), and a card's extra facts (Lathe's diff, Haven's input) through `card`.
- **The login token is read, never refreshed** (`src/quota.ts`): a refresh rotates the refresh token
  and signs out every running `claude`. It never leaves `quota.ts` — not in a value, an error or a log;
  `loginSend` holds it inside conduit's resolver.
- **`readToolCalls` keeps inputs; nothing a page draws may use it.** A screen reads `foldTranscript`,
  which keeps a call's name and one line.
- **A subcommand's environment is the host's.** `runClaude` and `claudeAuthStatus` take `{ bin, env }`;
  Workbench passes `childEnv(env)` so its own keys never reach the child.
- **Relative imports carry `.ts`.** Vite dev servers load `cli/core/vite-ask.js`
  under Node, which strips types but resolves no missing extension.

## Which drive proves a change

`bun run test` drives `runAsk` against a fake `claude` (`test/transport.test.ts`) and
replays the recorded stream-json runs in `test/fixtures/` through `readAskEvent`
(`test/replay.test.ts`), with no `claude` installed. `test/session.test.ts` drives `Session` against
a long-lived fake; `test/protocol.test.ts` replays the two recorded chats through `Protocol` and
checks `decide` writes the host's recorded answer. Lathe's `bun test ./api/test` and
`bun run drive:workspace` drive the session through a real host. `bun run drive:live` runs the
read-only recording against the installed `claude` and names any event or `result` key
that differs; it prints both versions. After a difference, `bun test/record.ts`
re-records all five (haiku, cents), then update the census in `test/fixtures.test.ts`
and the pins in `test/replay.test.ts`. The fixture shape and the scrub are documented at
the top of `test/record.ts`. A change to the edit profile also owes `website`'s
`verify:ask` (`DRIVES.md`).
