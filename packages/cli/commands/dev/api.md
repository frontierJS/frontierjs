---
title: dev:api
description: Start the API dev server alone
alias: api-dev
examples:
  - fli dev:api
  - fli dev:api --test
flags:
  test:
    char: t
    type: boolean
    description: Run with NODE_ENV=test
    defaultValue: false
---

Starts the one surface. A `api/` with its own `package.json` runs its own
`dev`; otherwise the app's script for the surface runs at the root — `api` or
`dev:api`, whichever the app declares. Running `dev` from inside `api/` there
would reach the app's `dev`, which starts every surface.

<script>
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
</script>

```js
const { appPorts }     = await import(resolve(global.fliRoot, 'core/ports.js'))
const { detectRunner } = await import(resolve(global.fliRoot, 'core/db-preflight.js'))

const root   = $.paths.root
const dir    = $.paths.api
const runner = detectRunner(root)
const env    = { ...process.env, ...(flag.test ? { NODE_ENV: 'test' } : {}) }

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
  .find(r => r.surface === 'api')

if (!row?.script) {
  log.error(`No script starts api/ here — declare \`api\` or \`dev:api\` in ${resolve(root, 'package.json')}`)
  process.exit(1)
}

if (row.env) env[row.env] = String(row.port)
log.info(`${runner} run ${row.script} — ${row.label} ${row.port}`)
$.exec({ command: `cd ${root} && ${runner} run ${row.script}`, dry: flag.dry, env })
```
