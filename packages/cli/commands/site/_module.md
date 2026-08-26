---
title: site
description: The site/ surface — the public, prerendered site, a peer of api/ and web/
---

`site/` is a sub-project at the app root, a peer of `api/` and `web/`. It holds
the pages a stranger and a search engine see: one HTML file per route with the
data already in it, islands for the parts that have to be current, and no
application server behind any of it.

It is never a routes directory inside `web/`. Its config, its tests and its
release are a different set of answers from the SPA's, and its output is too —
sharing a Vite root puts the site's `dist/` inside the SPA's, where the next
`vite build` deletes it without a word.

An app may have this surface and no `web/` at all.

| Command | What it does |
| --- | --- |
| `fli make:site` | create the surface |
| `fli site:dev` | Vite over `site/`, port 8600, routes served as an app |
| `fli site:build` | the bundle, then one prerendered HTML file per route |
| `fli site:serve` | serve `dist/` the way a static host does |

**Dev is an SPA and the build is files.** `fli site:dev` is the writing loop;
the publish check, the island chunks and the one-file-per-route output exist
only in the build. Anything touching a `load()` or a page's frontmatter is
proved by building.

Every command runs from the surface root, because that is the Vite root every
path in `config/sierra.config.js` is relative to.
