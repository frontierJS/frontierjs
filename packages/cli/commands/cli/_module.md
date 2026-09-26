---
title: cli
description: The cli/ surface — the app on a command line, released as one binary
---

`cli/` is a sub-project at the app root, a peer of `api/` and `web/`
(`FJS-D397`). Its commands are the API's `/mcp` tool list at the signed-in key's
standing, plus the hand-written ones under `cli/src/routes/`; its release is a
compiled binary an app hands to its own users. It is a client of `api/`, so it
is never a whole project on its own.

| Command | What it does |
| --- | --- |
| `fli cli:build` | → `cli/dist/<name>`, one binary per `--target` |

The build is `@frontierjs/mcp/client/build`, read out of the app's own
node_modules, so the binary an app releases and the one basecamp's drive runs
come from one program.
