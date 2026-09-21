---
title: workspace:terms
description: The vocabulary this workspace asks a newcomer to learn — concepts, language words and api identifiers, counted
alias: ws:terms
examples:
  - fli ws:terms
  - fli ws:terms --as=page --open
  - fli ws:terms --lens=api
  - fli ws:terms --as=json
flags:
  as:
    char: a
    type: string
    description: Which presentation — list (the terminal), page (an interactive HTML page), or json (the model)
    defaultValue: list
  lens:
    char: l
    type: string
    description: With --as=list, which vocabulary — concept, language or api
    defaultValue: concept
  limit:
    type: number
    description: With --as=list, how many rows
    defaultValue: 40
  open:
    type: boolean
    description: Open the written page in a browser
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default repo-terms.html at the workspace root)
    defaultValue: ''
---

**How big is the vocabulary, and which half of it did anybody define?** Three
vocabularies are counted separately because they are learned three different
ways — the concepts a mental model is built from, the words a `.lite` or `.mesa`
file may hold, and the identifiers a developer types. A single number over all
three describes none of them.

Nothing is dropped. A term that is not a concept is CLASSIFIED — `product`,
`external`, `common` — and can be read, because a word in the wrong class is the
failure this command can have and a deleted word leaves nothing to notice it by.

Ranked by **spread** rather than by count: a term in twelve packages is core
vocabulary, a term with three hundred hits in one file is local jargon.

The audit tab is the payoff — blessed by `ARCHITECT.md` § 2 and barely used,
widespread and never named, or forbidden by § 2 and still in live prose.

**This is exploratory and is not a snapshot.** The page carries no generator
line and the `snapshots` phase does not adopt it, because the exclude lists are
still being refined and a gated artifact would fail the build on every tuning
pass. `FJS-1211` is where this is going.

<script>
import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

// Detached and ignored: an opener holding the pipe keeps the terminal after the
// command has finished, which reads as a hang.
const openInBrowser = (path) => {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'explorer'
            : 'xdg-open'
  try {
    spawn(cmd, [path], { stdio: 'ignore', detached: true }).unref()
    return true
  } catch {
    return false
  }
}
</script>

```js
const { collectTerms, renderList, renderJson, renderPage } =
  await import(resolve(global.fliRoot, 'core/terms.js'))
const { styleBundle } = await import(resolve(global.fliRoot, 'core/assets.js'))

const root = await context.wsRoot()
if (!root) { log.error('No workspace found from here'); process.exitCode = 1; return }

const model = collectTerms({ root })

if (flag.as === 'json') {
  echo(renderJson(model))
  return
}

if (flag.as === 'list') {
  echo(renderList(model, { limit: Number(flag.limit) || 40, lens: flag.lens }))
  return
}

if (flag.as !== 'page') {
  log.error(`Unknown presentation '${flag.as}' — list, page or json`)
  process.exitCode = 1
  return
}

const file = flag.out ? resolve(root, flag.out) : resolve(root, 'repo-terms.html')
writeFileSync(file, renderPage(model, styleBundle(root)))

echo('')
echo(`  ✓  ${file.replace(`${root}/`, '')}`)
echo(`  ${model.counts.concept} concept(s) · ${model.counts.language} language word(s) · ${model.counts.api} identifier(s)`)
echo(`  audit — ${model.audit.blessedUnused.length} blessed and unused · ${model.audit.unnamedCommon.length} widespread and unnamed · ${model.audit.forbiddenUsed.length} forbidden word(s) in prose`)
if (flag.open && !openInBrowser(file)) echo('  ⚠  could not open a browser')
echo('')
```
