# Project state — @frontierjs/claude

**The transport and the live chat are built.** `askArgv`, `sessionArgv`, `readAskEvent`, `runAsk`,
the image checks and the profile constants, typed; cli, Workbench, Basecamp and the prototypes
(Lathe, chat and serpgrid TUIs) import this package by name. The control protocol and `Session`
are Lathe's chat, which holds its chats on them; Haven's study session still has its own copy.

## What is true

- Published name `@frontierjs/claude`, TypeScript, no dependencies, typecheck baseline 0.
- 39 exports, pinned by name in `test/package.test.ts`.
- Five scrubbed stream-json recordings from `claude` 2.1.330 sit in `test/fixtures/` (read-only, edit, resumed, and two live chats: a permission prompt and an AskUserQuestion); `test/replay.test.ts` pins what `readAskEvent` makes of each.
- `fli check` grades the boundary: `claude-package-isolated` (no `@frontierjs/cli` import) and `claude-spawn-owned` (only this package starts `claude`; `scripts/claude-spawners.json` lists the six files that still do, each with the step that removes it).

## Next, in order

1. Phase 3.2: Haven's study session onto `Session`; then 3.4 (3.3's work profile is built; serpgrid's TUI keeps its own argv until its Bash list is ruled). Each caller
   moved comes off `scripts/claude-spawners.json`.
