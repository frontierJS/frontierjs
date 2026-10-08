---
title: desktop
description: The desktop/ surface — a native Tauri window with its screens bundled into the binary
---

`desktop/` is a sub-project at the app root, a peer of `api/` and `web/`. Its
screens are compiled INTO the binary, so there is nothing to serve: a change
under the screens' `src/` is seen only after a rebuild. The page is served from
`tauri://localhost`, so the API is always another origin and must be running.

| Command | What it does |
| --- | --- |
| `fli make:desktop` | create the surface — config, build script, the Tauri crate, a probe-driven test |
| `fli desktop:run` | build the screens and the shell, start the API if nothing answers, open the window |
| `fli desktop:install` | add the app to this machine's launcher, opening through `desktop:run` (Linux) |

The build is the app's own `desktop/deploy/build.mjs`, so `fli desktop:run` and
`bun run build:desktop` produce one binary.
