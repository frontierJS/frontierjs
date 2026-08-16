---
title: utils:dev
description: Start the dev server — warns first if the database has nothing in it
alias: dev
examples:
  - fli dev
  - fli dev --dry
  - fli dev --no-check
flags:
  no-check:
    type: boolean
    description: Skip the database preflight
    defaultValue: false
---

Runs the project's own `dev` script with the right runner, after saying whether
there is anything in the database.

**The preflight is the point.** An app with an empty database boots clean,
serves every route, answers every request correctly, and shows a person a blank
screen — so the first thing anyone does is look for a bug in the app. It is a
warning and never a refusal: empty is the correct state for a first run.

**The runner is decided by a lockfile found by walking UP.** A package inside a
workspace has no lockfile of its own — the one lockfile is at the workspace root
— so looking only beside `package.json` reported *npm detected* for every
package in a bun monorepo, and then ran the wrong runner.

<script>
import { resolve } from 'path'
</script>

```js
const root = context.paths.root

const { warnIfDatabaseEmpty, detectRunner } =
  await import(resolve(global.fliRoot, 'core/db-preflight.js'))

if (!flag['no-check']) {
  try {
    warnIfDatabaseEmpty(context)
  } catch (err) {
    // A preflight that throws must not stop a dev server. It is a courtesy.
    log.debug?.(`database preflight skipped: ${err.message}`)
  }
}

const runner = detectRunner(root)

log.info(`${runner} — running: ${runner} run dev`)
context.exec({ command: `cd ${root} && ${runner} run dev`, dry: flag.dry })
```
