---
title: project:intent
description: Resolve a structured candidate against this app's seed and snapshots, and print the verdict
alias: intent
examples:
  - fli intent --candidate '{"claim":"question","facts":[{"kind":"attribute","about":"customer","words":"note"}]}'
  - fli intent --file candidate.json --json
flags:
  candidate:
    char: c
    type: string
    description: The candidate as JSON — a claim and facts in plain words, never an identifier
  file:
    char: f
    type: string
    description: Read the candidate from a JSON file instead
  json:
    type: boolean
    description: Answer a machine
    defaultValue: false
---

<script>
import { join } from 'path'
import { pathToFileURL } from 'url'
</script>

The middle of `IDEAS/intent-recognizer.md`: a candidate in, a verdict with a
citation out. **No model runs here.** The candidate is what a translator would
emit from a person's words — `claim`, and facts carrying a `kind` and plain
words — and this command refuses one that names an identifier.

It reads the app's own `db/schema.lite` through the litestone the APP has
installed, and the committed `surface`, `routes` and `notifications` snapshots.
What a screen shows is not indexed, so a UI fact reports that half as
`unverified` rather than guessing.

```js
const root = context.paths.root

const text = flag.file ? readFileSync(flag.file, 'utf8') : flag.candidate
if (!text) { log.error('pass --candidate <json> or --file <path>'); return }
let candidate
try { candidate = JSON.parse(text) } catch (e) { log.error(`the candidate is not JSON: ${e.message}`); return }

// The APP's litestone, read out of its own exports map — a parser beside the
// global `fli` would be whatever version happened to be installed there.
const lsDir = join(root, 'node_modules', '@frontierjs', 'litestone')
const lsPkg = existsSync(join(lsDir, 'package.json')) ? JSON.parse(readFileSync(join(lsDir, 'package.json'), 'utf8')) : null
const parserTarget = lsPkg?.exports?.['./parser']?.import ?? lsPkg?.exports?.['./parser']
if (typeof parserTarget !== 'string') { log.error(`@frontierjs/litestone is not installed in ${root}`); return }
const { parseFile } = await import(pathToFileURL(join(lsDir, parserTarget)).href)

const schemaPath = join(root, 'db', 'schema.lite')
if (!existsSync(schemaPath)) { log.error(`no db/schema.lite in ${root}`); return }
const parsed = parseFile(schemaPath)
if (!parsed.valid) { log.error(`db/schema.lite does not parse: ${parsed.errors?.[0]?.message ?? 'unknown error'}`); return }

const { surfaceFile } = await import(resolve(global.fliRoot, 'core/app-entry.js'))
const { buildIndex, recognize } = await import(resolve(global.fliRoot, 'core/intent.js'))

// A snapshot that is absent is read as empty and SAID, because an index missing
// the surface answers "no such method" about methods that exist.
const readFirst = (name, dirs) => {
  for (const d of dirs) { const p = join(root, d, name); if (existsSync(p)) return readFileSync(p, 'utf8') }
  return null
}
const surfacePath   = surfaceFile(root)
const surface       = surfacePath && existsSync(surfacePath) ? readFileSync(surfacePath, 'utf8') : null
const routes        = readFirst('routes.snapshot.md', ['web', '.'])
const notifications = readFirst('notifications.snapshot.md', ['api', '.'])
const missing = [['surface.snapshot.md', surface], ['routes.snapshot.md', routes], ['notifications.snapshot.md', notifications]]
  .filter(([, v]) => v == null).map(([n]) => n)

const index  = buildIndex({ schema: parsed.schema, surface: surface ?? '', routes: routes ?? '', notifications: notifications ?? '' })
const answer = recognize(index, candidate)

if (flag.json) { console.log(JSON.stringify({ ...answer, missing }, null, 2)); return }

if (answer.refused) {
  log.error('refused:')
  for (const r of answer.refused) echo(`  · ${r}`)
  return
}
if (missing.length) log.warn(`not indexed: ${missing.join(', ')}`)

echo('')
echo(`  ${answer.verdict.toUpperCase()}  ·  cost ${answer.depth}${answer.identity ? `  ·  ${answer.identity}` : ''}`)
echo('')
for (const f of answer.facts) {
  const words = [f.fact.about, f.fact.words, f.fact.from && `from ${f.fact.from}`, f.fact.to && `to ${f.fact.to}`].filter(Boolean).join(' · ')
  echo(`  ${f.fact.kind.padEnd(12)} ${words}`)
  echo(`    → ${f.verdict}${f.target ? `  ${f.target}` : ''}`)
  if (f.why)                 echo(`      ${f.why}`)
  if (f.cite)                echo(`      cite  ${f.cite}`)
  if (f.notes?.length)       echo(`      note  ${f.notes.join('; ')}`)
  if (f.unverified?.length)  echo(`      unverified: ${f.unverified.join(', ')} — nothing indexes what a screen shows`)
  if (f.candidates?.length)  echo(`      could be: ${f.candidates.join(', ')}`)
}
echo('')
```
