# Workbench -- Project State

**`IDEAS/workbench-package.md` is shipped**: every phase is closed, the wing
has moved out of Basecamp, and the desktop shell is how the owner opens it
(`fli desktop:install --release`).

## What exists

- Screens under `web/src/routes/`: home, workbench (Claude Code chats per
  pinned checkout), terminal, atlas (the registers, Decide), messages (the
  Mattermost mirror), notifications, capture, git-activity, laptop, servers,
  basecamps, charter, recommended-services, settings.
- Providers `bc3` (37signals Basecamp, `FJS-D2265`) and `chat` (the Mattermost
  sync into the Messages mirror models).
- `desktop/`: the Tauri shell around `web/`, with a tray, single instance and
  `--go <path>`.
- Drives: `verify:desktop`, `verify:atlas`, `verify:capture`, `verify:messages`,
  `verify:chat`.

## Open

- `FJS-4440` -- `verify:messages` sometimes never shows the second pick.
- `FJS-3237` -- a lane worktree's build cannot resolve `@xterm/xterm`.
- `FJS-4332`, `FJS-4252`, `FJS-4418` -- a session-file reader, `runAsk` and
  the chat view each have a copy outside Workbench and no shared owner.
- `verify:chat` and `verify:messages` have no row in `DRIVES.md`.
