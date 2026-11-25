# Project state — @frontierjs/claude

**The transport and the live chat are built.** `askArgv`, `sessionArgv`, `readAskEvent`, `runAsk`,
the image checks and the profile constants, typed; cli, Workbench, Basecamp and the prototypes
(Lathe, chat and serpgrid TUIs) import this package by name. The control protocol and `Session`
hold Lathe's chats and Haven's study session. Every reader of Claude Code's own files is here (Phase 5).

## What is true

- Published name `@frontierjs/claude`, TypeScript, typecheck baseline 0. Depends on `@frontierjs/toolbelt`, and on `@frontierjs/conduit` and `conduit-anthropic` for the token count, which goes through the connector's `countTokens` signed in as the login (`loginSend`).
- 71 exports, pinned by name in `test/package.test.ts`. The readers of Claude Code's files came from Workbench and `cli/core/claude-usage.js` (`IDEAS/claude-calls.md` 5.1, 5.2): transcripts, sessions, the configuration scan, quota, context and the `auth`/`mcp`/`doctor` subcommands. Lathe, Workbench, `scripts/headless.mjs`, `loop-review.mjs` and `skill-reach.mjs` read through them. The scan's pure readers have no tests of their own yet; they are driven only through Workbench.
- Five scrubbed stream-json recordings from `claude` 2.1.330 sit in `test/fixtures/` (read-only, edit, resumed, and two live chats: a permission prompt and an AskUserQuestion); `test/replay.test.ts` pins what `readAskEvent` makes of each.
- `fli check` grades the boundary: `claude-package-isolated` (no `@frontierjs/cli` import), `claude-spawn-owned` (only this package starts `claude`; no file outside it does) and `claude-login-owned` (only this package names the credentials file or the usage endpoint).

## Next, in order

1. The scan's pure readers want tests of their own; a recorded `~/.claude` fixture is the cheap way.
   `countContext` has no test either; it was proved live only (2026-11-24: counted, parts 2.2% under the measured total).
