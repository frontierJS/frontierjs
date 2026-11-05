---
title: mesa
description: Mesa components outside an app — pack one into a self-contained page module
---

A package that serves a page but must not depend on Mesa at runtime ships the
page packed: the component compiled `target: 'server'`, its runtime and a
`@frontierjs/css` subset bundled into one committed module (`FJS-D1934`).

| Command | What it does |
| --- | --- |
| `fli mesa:pack <file.mesa>` | `<Name>.snapshot.js` beside it: `render(props)` and `STYLE_HASH` |
