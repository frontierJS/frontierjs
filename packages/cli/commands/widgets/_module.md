---
title: widgets
description: The widgets/ surface — embeddable scripts for pages this app does not own
---

`widgets/` is a sub-project at the app root, a peer of `api/` and `web/`. It
holds one component per embeddable script, and it builds, tests and deploys on
its own: a widget ships to a stranger's page on the cadence of the pages that
embed it, from a static origin rather than the API's container.

An app may have this surface and no `web/` at all.

| Command | What it does |
| --- | --- |
| `fli make:widget <Name>` | create a widget — and the surface, the first time |
| `fli widgets:dev` | Vite over `widgets/`, port 8200, while a widget is written |
| `fli widgets:build` | one self-contained IIFE per widget → `dist/embeds/` |
| `fli widgets:serve` | serve them with the CORS + cache headers they deploy with |

Every command runs from the surface root, because that is the Vite root every
path in `config/sierra.config.js` is relative to.
