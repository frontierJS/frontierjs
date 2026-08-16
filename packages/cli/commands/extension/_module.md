---
title: extension
description: The extension/ surface — a jetty browser extension, MV3, Chrome and Firefox
---

`extension/` is a sub-project at the app root, a peer of `api/`, `web/` and
`widgets/`. It builds, tests and ships on its own, and further from the SPA than
a widget does: the config emits a *manifest*, the artefact is loaded unpacked
into a browser profile rather than served, and the release is a signed upload to
two web stores under a review measured in days.

An app may have this surface and no `web/` at all.

| Command | What it does |
| --- | --- |
| `fli make:extension` | create the surface — config, harbor, dock, test and deploy notes |
| `fli extension:dev` | jetty's dev server: watch, rebuild, push a reload over port 8400 |
| `fli extension:build` | → `extension/dist/chrome/` (and `dist/firefox/` with `--browser both`) |
| `fli extension:audit` | permissions declared vs. `chrome.*` actually called, both directions |

These wrap jetty's own `jetty-*` binaries with `--root` pointed at the surface,
so the build an app runs and the build jetty tests are one program.
