---
title: 02-pause
description: Write the guard file — the edge refuses from the next request
skip: "$.config.pauseKind !== 'pause'"
---

```js
if ($.config.abort) return

const { host, serverPath } = $.config
const { pausedFile, pagePath, DEFAULT_PAGE } =
  await import(new URL('file://' + global.fliRoot + '/core/pause.js'))

const machine = machineFor($, host, serverPath)

// The page first. Caddy's file_server answers 404 when the page it was pointed
// at is missing — a paused app reading as a missing one, and 03-verify refusing
// the pause — so a pause that found no page puts the default one there before
// it puts the guard in force, and never the other way round.
const page = pagePath(serverPath)
const hasPage = machine.capture(`[ -s ${page} ] && echo yes || echo no`).trim() === 'yes'
if (!hasPage) {
  log.warn('No maintenance page on this target — writing the default one')
  machine.run(`mkdir -p $(dirname ${page})
cat > ${page} << 'FLIPAGEEOF'
${DEFAULT_PAGE}FLIPAGEEOF`)
}

// Caddy stats this per request, so there is nothing to reload and no window in
// which the guard is half applied.
machine.run(`touch ${pausedFile(serverPath)}`)
log.success(`Paused → ${pausedFile(serverPath)}`)
```
