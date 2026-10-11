---
title: dev:web
description: Start the web app dev server alone
alias: web-dev
examples:
  - fli dev:web
  - fli dev:web --test
  - fli dev:web --host
flags:
  test:
    char: t
    type: boolean
    description: Run with NODE_ENV=test
    defaultValue: false
  host:
    type: boolean
    description: Serve on every interface, so a phone on the LAN can open it
    defaultValue: false
---

Starts the one surface. A `web/` with its own `package.json` runs its own
`dev`; otherwise the app's script for the surface runs at the root — `web` or
`dev:web`, whichever the app declares. Running `dev` from inside `web/` there
would reach the app's `dev`, which starts every surface.

`--host` is `fli dev --host` for this one surface: `FLI_HOST=1`, which Sierra's
base vite config reads into `server.host`.

<script>
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
</script>

```js
const { appPorts }     = await import(resolve(global.fliRoot, 'core/ports.js'))
const { detectRunner } = await import(resolve(global.fliRoot, 'core/db-preflight.js'))

const root   = $.paths.root
const dir    = $.paths.web
const runner = detectRunner(root)
const env    = {
  ...process.env,
  ...(flag.test && { NODE_ENV: 'test' }),
  ...(flag.host && { FLI_HOST: '1' }),
}

if (existsSync(resolve(dir, 'package.json'))) {
  $.exec({ command: `cd ${dir} && ${runner} run dev`, dry: flag.dry, env })
  return
}

let manifest = {}
try {
  manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
} catch { /* no manifest, so no script either -- refused below */ }

// The port `fli dev` last gave this root, so the surface lands where its
// siblings expect it.
const row = appPorts(root, { name: manifest.name, scripts: manifest.scripts })
  .find(r => r.surface === 'web')

if (!row?.script) {
  log.error(`No script starts web/ here — declare \`web\` or \`dev:web\` in ${resolve(root, 'package.json')}`)
  process.exit(1)
}

if (row.env) env[row.env] = String(row.port)
log.info(`${runner} run ${row.script} — ${row.label} ${row.port}`)
$.exec({ command: `cd ${root} && ${runner} run ${row.script}`, dry: flag.dry, env })
```
