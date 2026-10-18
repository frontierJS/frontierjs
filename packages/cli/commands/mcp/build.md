---
title: mcp:build
description: Build one view per resource file in web/src/resources/ into api/dist/mcp/
alias: mcp-build
examples:
  - fli mcp:build
  - fli mcp:build --dry
---

<script>
import { existsSync } from 'fs'
import { join } from 'path'
</script>

Each view is its own library build — one HTML document carrying the Mesa
runtime, the model schemas, the stylesheet and the component, because a host's
iframe cannot load a shared chunk. N resource files is N builds; `sierra mcp`
runs the loop from `web/`.

The output directory is supplied here and nowhere else: fli is the one thing
that knows where `api/` is, and `sierra mcp` refuses a relative `--out`. A
document no resource file built is removed, since `mcp()` serves
whatever the directory holds.

```js
// The views are read by mcp() inside the API. With no api/ surface the
// build would create an api/dist/ that nothing serves.
if (!existsSync($.paths.api)) {
  log.error(`No api/ surface at ${$.paths.api} — the views are served by mcp() inside the API, so there is nothing to build them for.`)
  process.exit(1)
}

$.exec({
  command: `${$.bin('sierra', $.paths.web)} mcp --config config/sierra.config.js --out ${JSON.stringify(join($.paths.api, 'dist/mcp'))}`,
  cwd:     $.paths.web,
  dry:     flag.dry,
})
```
