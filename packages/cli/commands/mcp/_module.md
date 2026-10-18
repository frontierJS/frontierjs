---
title: mcp
description: The agent surface's build — one view per resource file, for an MCP host to draw
---

`@frontierjs/mcp` mounts an MCP endpoint inside the running API. A host that
speaks the apps extension draws a tool's answer in a sandboxed iframe, and the
document it draws is built from the app's own `web/src/resources/` files: the
file's markup half where it has one, the model's default form where it does
not.

The views are written to `api/dist/mcp/`, beside the API that serves them,
because the API image carries `api/` and never `web/` (`FJS-D955`). The plugin
is told the same directory once, as `mcp({ ui: { root } })`, and refuses
to start when it is declared and missing.

| Command | What it does |
| --- | --- |
| `fli mcp:build` | one self-contained HTML document per resource file → `api/dist/mcp/` |
