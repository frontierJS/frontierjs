---
paths:
  - "packages/cli/commands/**/*.md"
  - "**/cli/src/routes/**/*.md"
---

# A fli command

Loaded when a command file is read. The one-line version is in the root `CLAUDE.md` § House style, because a rule scoped by path does not load while a NEW file is being written.

- **The ```js body reads top-down like a doc**: each step a named helper call, the mechanics in the file's `<script>` block, the namespace `_module.md` prelude when siblings share it, or a `core/` module. A `<script>` helper is module scope, so it takes `$`, `log` or `tty` as parameters.
- **Output is `packages/cli/README.md` § Printing a line.** A line or block is one tagged `echo`, written in the shape it prints, and its tag reads `chalk` markup (`echo\`  {dim name } ${v}\``); a value for somewhere else is a `chalk` tag; rows that exist only sometimes are `echo.lines`; a count with a noun is `plural()` from `core/text.js`. References: `commands/ports/status.md`, `commands/basecamp/create.md`.
- **What the command shows is `echo`; `log` is the refusal** (`log.error`, `log.warn`) and `--dry`'s `log.dry`. A run reads as a header, its rows and the result, so progress and success are lines in that block rather than `log.info`/`log.success` chatter.
- **A command a change touches moves to this shape in the same pass**, whatever the change was for.
