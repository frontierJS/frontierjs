---
title: project:diagram
description: Draw the heart of this app on one page — what the machine inside it does, read off project:map and app:atlas and drawn by Claude from a saved prompt
alias: diagram
examples:
  - fli project:diagram
  - fli project:diagram --open
  - fli project:diagram --digest
  - fli project:diagram --out docs/heart.html --effort high
  - fli project:diagram --notes README.md
  - fli project:diagram --prompt docs/diagram-prompt.md
flags:
  out:
    char: o
    type: string
    description: Where the page is written, from the app root
    defaultValue: docs/diagram.html
  notes:
    type: string
    description: "The app's description of itself, for its words and its purpose ('' for none)"
    defaultValue: AGENTS.project.md
  prompt:
    type: string
    description: The prompt to draw with (default cli/prompts/diagram.md when the app keeps one, else the package's)
  digest:
    type: boolean
    description: Print what Claude would be given and stop
  open:
    type: boolean
    description: Open the page once it is written
  effort:
    char: e
    type: string
    description: How hard Claude thinks
    choices: [low, medium, high, xhigh, max]
    defaultValue: medium
  model:
    char: m
    type: string
    description: Claude model to use (the account's default when empty)
    defaultValue: ''
  budget:
    type: number
    description: Most the run may spend, in US dollars
    defaultValue: 3
---

<script>
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { dirname, relative } from 'path'
import { tmpdir } from 'os'
</script>

**One picture of what the app is for**, with everything every app has taken
out: no sign-in, no CRUD, no plugins. The record that carries the work, the
states it moves through, the people and the outside world it touches — at
most twelve boxes, readable in one glance.

The app is read the way `project:map` and `app:atlas` read it, in-process,
and cut down to a digest: the state machines and their moves, each model's
`belongsTo` relations, the services' verbs beyond CRUD, the raw routes, each
UI surface's page count and `--notes` (`AGENTS.project.md` by default). That
digest goes to `claude -p` on stdin, with the prompt as the whole system
prompt. The run has no tools, no hooks, no MCP servers and no settings files,
and starts in an empty directory, so one digest and one prompt are all it
reads.

The prompt is `core/diagram-prompt.md` in this package. An app that wants its
own keeps it at `cli/prompts/diagram.md`, and that one is used instead; copy
the package's there to start. `--digest` prints the input without calling
Claude. Needs the `claude` CLI on `PATH` and signed in.

```js
const { readAppAtlas } = await import(resolve(global.fliRoot, 'core/app-entry.js'))
const { DIAGRAM_PROMPT, diagramDigest, diagramPrompt, surfacePages, readNotes, pageOf, restarted } = await import(resolve(global.fliRoot, 'core/diagram.js'))

const root = $.paths.root
if (!existsSync(resolve($.paths.db, 'schema.lite'))) {
  log.error(`no db/schema.lite under ${root} — cd into a FJS app, or point at one with --project <dir>`)
  process.exitCode = 1
  return
}

const promptFile = diagramPrompt(root, flag.prompt || null)
if (!existsSync(promptFile)) { log.error(`no prompt at ${promptFile}`); process.exitCode = 1; return }
if (flag.notes && !existsSync(resolve(root, flag.notes))) { log.error(`no notes file at ${flag.notes}`); process.exitCode = 1; return }

const { map, error: mapError } = await buildProjectMap($, { atlas: false, log: null })
if (mapError) { log.error(mapError); process.exitCode = 1; return }
const { model: atlas, error: atlasError } = readAppAtlas(root)
if (atlasError) { log.error(atlasError); process.exitCode = 1; return }

const pkg    = resolve(root, 'package.json')
const digest = diagramDigest({
  name:     existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).name : root.split('/').pop(),
  map, atlas,
  notes:    readNotes(root, flag.notes),
  surfaces: surfacePages(root),
})

if (flag.digest) { echo(JSON.stringify(digest, null, 2)); return }

const input = JSON.stringify(digest)
const out   = resolve(root, flag.out)
const kb    = n => `${Math.round(n / 1024)} KB`
if (flag.dry) {
  log.dry(`Would draw with ${promptFile === DIAGRAM_PROMPT ? 'the package prompt' : relative(root, promptFile)} from a ${kb(input.length)} digest (effort ${flag.effort}, $${flag.budget} cap) and write ${relative(root, out)}`)
  return
}

const { runAsk } = await import(resolve(global.fliRoot, 'core/ask-claude.js'))

// An empty directory: no CLAUDE.md or project file joins the prompt.
const cwd = mkdtempSync(resolve(tmpdir(), 'fli-diagram-'))
let text = '', result = null, error = null
const footer = tty.live(() => [chalk.dim(`drawing from a ${kb(input.length)} digest${text ? ` · ${kb(text.length)} written` : ''}…`)])

const { child, done, error: refused } = runAsk({
  root:   cwd,
  prompt: input,
  draw:   { system: readFileSync(promptFile, 'utf8'), budget: flag.budget },
  effort: flag.effort,
  model:  flag.model || null,
  // A page is longer than the default reply allows once thinking has spent its share.
  env:    { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
  onEvent: e => {
    if (e.type === 'text')   { text += e.text; footer.update() }
    if (e.type === 'result') result = e
    if (e.type === 'error')  error = e.text
  },
})
if (refused) { footer.stop(); rmSync(cwd, { recursive: true, force: true }); log.error(refused); process.exitCode = 1; return }
tty.onExit(() => { try { process.kill(-child.pid) } catch {} })

const code = await done
footer.stop()
rmSync(cwd, { recursive: true, force: true })

const page = pageOf(text)
if (!page) {
  log.error(error || `claude returned no page${result?.stop ? ` (${result.stop})` : ''}`)
  process.exitCode = code || 1
  return
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, page + '\n')
log.success(`Wrote ${relative(root, out)} (${kb(page.length)})`)
if (restarted(text)) log.warn('The reply started the page over after reaching the output limit; the last whole page was kept')
if (result?.cost != null) log.info(chalk.dim(`$${result.cost.toFixed(3)} · ${result.turns} turn(s)`))
if (flag.open) {
  const { openUrl } = await import(resolve(global.fliRoot, 'core/open-url.js'))
  openUrl(`file://${out}`)
}
```
