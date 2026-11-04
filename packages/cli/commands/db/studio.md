---
title: db:studio
description: Open Litestone Studio in the browser
alias: studio
examples:
  - fli studio
  - fli studio --test
  - fli studio --port 5502
  - fli studio --schema packages/litestone/test/fixtures/corpus/calcom.lite
flags:
  schema:
    type: string
    kind: path
    description: Open this .lite file instead of the project's db/schema.lite, over a throwaway database with a throwaway encryption key
    defaultValue: ''
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
import { join, basename } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

// The flag's declared default is the global port, so whether --port was typed
// is read off the argv: a default must not pin an in-project studio to 5502.
async function studioPortFor($, flag) {
  if ($.forwarded.some(a => /^(--port|-p)(=|$)/.test(a))) return flag.port
  const { studioPort } = await import(resolve(global.fliRoot, 'core/ports.js'))
  const inApp = existsSync(join($.paths.root, 'package.json'))
  const env   = flag.production ? 'prod' : flag.test ? 'test' : 'dev'
  return studioPort(inApp ? $.paths.root : null, { env })
}

// A foreign schema left to litestone's defaults opens ./development.db in the
// project root — the project's own database under someone else's schema — and
// one with an @encrypted field refuses to start without a key. Both are
// throwaway: the database is empty, so the key seals nothing worth keeping.
function scratchFor(schema) {
  const dir = mkdtempSync(join(tmpdir(), 'fli-studio-'))
  return {
    db:  join(dir, `${basename(schema, '.lite')}.db`),
    env: { ...process.env, ENCRYPTION_KEY: randomBytes(32).toString('hex') },
  }
}

function studioCommand($, { schema, port, scratch, open }) {
  const db = scratch ? ` --db ${JSON.stringify(scratch.db)}` : ''
  return `${litestone($)} studio --schema ${JSON.stringify(schema)}${db} --port ${port}${open ? '' : ' --no-open'}`
}
</script>

In a project, studio sits in that project's tooling row beside `fli gui` —
8502 dev, 7502 `--test`, 9502 `--production` for project 0, plus a
scaffolded app's `fli dev` slot, so the app on 8001 has its GUI on 8501 and
its studio on 8503 (`studioPort()`). Outside a project it is the global 5502.

`--schema` opens any `.lite` file — a test fixture, a corpus schema — over an
empty database in a temp directory, never the project's.

```js
if (!requireSchema($, flag)) return

const { schema } = resolveDb($, flag)
const port       = await studioPortFor($, flag)
const scratch    = flag.schema ? scratchFor(schema) : null

echo`  {bold Litestone Studio} {cyan http://localhost:${port}}`
if (scratch) echo`
  {dim schema} ${schema}
  {dim db}     ${scratch.db} {dim (throwaway)}`
await $.stream({ command: studioCommand($, { schema, port, scratch, open: flag.open }), ...(scratch && { env: scratch.env }) })
```
