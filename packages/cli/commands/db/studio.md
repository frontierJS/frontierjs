---
title: db:studio
description: Open Litestone Studio in the browser
alias: studio
examples:
  - fli studio
  - fli studio --test
  - fli studio --port 5502
flags:
  port:
    char: p
    type: number
    description: Port to run Litestone Studio on — default is two past the project's GUI port for its env, or 5502 outside a project
    defaultValue: 5502
  production:
    type: boolean
    description: The project's prod tooling row (9502 for project 0) rather than dev
    defaultValue: false
  open:
    type: boolean
    description: Open Litestone Studio in the browser once it is up (--no-open to skip)
    defaultValue: true
---

<script>
import { join } from 'path'

// The flag's declared default is the global port, so whether --port was typed
// is read off the argv: a default must not pin an in-project studio to 5502.
async function studioPortFor($, flag) {
  if ($.forwarded.some(a => /^(--port|-p)(=|$)/.test(a))) return flag.port
  const { studioPort } = await import(resolve(global.fliRoot, 'core/ports.js'))
  const inApp = existsSync(join($.paths.root, 'package.json'))
  const env   = flag.production ? 'prod' : flag.test ? 'test' : 'dev'
  return studioPort(inApp ? $.paths.root : null, { env })
}
</script>

In a project, studio sits in that project's tooling row beside `fli gui` —
8502 dev, 7502 `--test`, 9502 `--production` for project 0, plus a
scaffolded app's `fli dev` slot, so the app on 8001 has its GUI on 8501 and
its studio on 8503 (`studioPort()`). Outside a project it is the global 5502.

```js
if (!requireSchema($)) return

const { schema } = resolveDb($, flag)
const port       = await studioPortFor($, flag)

echo(chalk`  {bold Litestone Studio} {cyan http://localhost:${port}}`)
await $.stream({
  command: `${litestone($)} studio --schema ${schema} --port ${port}${flag.open ? '' : ' --no-open'}`
})
```
