---
title: db:studio
description: Open Litestone Studio in the browser
alias: studio
examples:
  - fli studio
  - fli studio --test
  - fli studio --port 5502
  - fli studio --schema packages/litestone/test/fixtures/corpus/calcom.lite
  - fli studio --schema yuma:/srv/apps/kapp/db/schema.lite
flags:
  schema:
    type: string
    kind: path
    description: "Open this .lite file instead of the project's db/schema.lite, over a throwaway database with a throwaway encryption key. host:/path reads it over ssh from a box (an ~/.ssh/config alias or user@host)"
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
import { join, basename, dirname, posix } from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const bc = await import(new URL('file://' + global.fliRoot + '/core/basecamp.js'))

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
function scratchFor(schema, dir = mkdtempSync(join(tmpdir(), 'fli-studio-'))) {
  return {
    db:  join(dir, `${basename(schema, '.lite')}.db`),
    env: { ...process.env, ENCRYPTION_KEY: randomBytes(32).toString('hex') },
  }
}

// `host:path` is scp's spelling, so `user@host:path` and an ssh alias both
// work. A local file wins: `a:b.lite` in the cwd is a file, not a host.
const REMOTE_SCHEMA = /^([^/\s:]+):(.+)$/

const remoteSchema = (schema) => !schema || existsSync(schema) ? null : schema.match(REMOTE_SCHEMA)

// A schema split across `import "./x.lite"` files is unreadable without its
// siblings, so each relative import is fetched too, mirrored at its remote path
// so the parser resolves it unchanged. A package import (`@frontierjs/auth/…`)
// resolves through node_modules, which a temp dir has none of — it borrows the
// project's, else the one fli's own litestone came from.
function fetchRemoteSchema($, host, path) {
  const dir  = mkdtempSync(join(tmpdir(), 'fli-studio-'))
  const seen = new Set()
  const todo = [path]
  while (todo.length) {
    const p = todo.shift()
    if (seen.has(p)) continue
    seen.add(p)
    let text
    try { text = bc.readBoxFile(host, p) }
    catch (err) {
      $.log.error(`could not read ${host}:${p}${err.message ? ` — ${err.message}` : ''}`)
      return null
    }
    const local = join(dir, 'remote', p)
    mkdirSync(dirname(local), { recursive: true })
    writeFileSync(local, text)
    for (const [, spec] of text.matchAll(/^\s*import\s+"(\.\.?\/[^"]+)"/gm))
      todo.push(posix.join(posix.dirname(p), spec))
  }
  const modules = nodeModulesFor($)
  if (modules) symlinkSync(modules, join(dir, 'node_modules'))
  return { dir, schema: join(dir, 'remote', path), files: seen.size }
}

function nodeModulesFor($) {
  const has = (d) => existsSync(join(d, '@frontierjs', 'litestone'))
  const project = join($.paths.root, 'node_modules')
  if (has(project)) return project
  for (let d = global.fliRoot; d !== dirname(d); d = dirname(d))
    if (has(join(d, 'node_modules'))) return join(d, 'node_modules')
  return null
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
empty database in a temp directory, never the project's. `--schema
host:/path` reads one off a box over ssh, with its relative imports, into that
temp directory: the deployed schema, never the deployed rows.

A project schema that encrypts, with no `ENCRYPTION_KEY` set, is offered one
as `db:push` is.

```js
const remote  = remoteSchema(flag.schema)
const fetched = remote ? fetchRemoteSchema($, remote[1], remote[2]) : null
if (remote && !fetched) { process.exitCode = 1; return }

const local = fetched ? { ...flag, schema: fetched.schema } : flag
if (!requireSchema($, local)) return

const { schema } = resolveDb($, local)
const port       = await studioPortFor($, flag)
const scratch    = flag.schema ? scratchFor(schema, fetched?.dir) : null
const keyEnv     = scratch ? {} : await keyFor($, schema)
if (!keyEnv) { process.exitCode = 1; return }

echo`  {bold Litestone Studio} {cyan http://localhost:${port}}`
if (fetched) echo`
  {dim from}   ${flag.schema} {dim (${fetched.files} file${fetched.files === 1 ? '' : 's'})}`
if (scratch) echo`
  {dim schema} ${schema}
  {dim db}     ${scratch.db} {dim (throwaway)}`
await $.stream({ command: studioCommand($, { schema, port, scratch, open: flag.open }), env: scratch?.env ?? { ...process.env, ...keyEnv } })
```
