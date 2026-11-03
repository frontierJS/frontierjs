# Workbench -- Project State

**Phase 1 (the skeleton) of `IDEAS/workbench-package.md` is built.** Nothing of
the wing has moved in yet; Basecamp still carries all of it.

## What exists

- `db/schema.lite` -- Member, Session, ClaudeTranscript, ClaudeMessage,
  ClaudeWrite; `db/migrations/main/` holds the fresh init.
- `api/` -- `createApp`, the `workbench` claim, the door (`POST /door/login`,
  `GET /door/me`, `POST /door/logout`), `GET /health`.
- `web/` -- the shell, `/login/`, and `/workbench/` as an empty state; nav
  entries Chats, Atlas, Decide, Autopilot (the last three have no route yet).

## Not yet

- The wing's domains, services, jobs, plugin, routes and resources (Phase 2).
- The import-direction check against Basecamp (Phase 2.4).
- A `desktop/` surface (Phase 4.1), a `/ws` channel, any test.
