---
title: workspace:terms
description: The vocabulary this workspace asks a newcomer to learn — concepts, language words and api identifiers, counted
alias: ws:terms
examples:
  - fli ws:terms
  - fli ws:terms --as=page --open
  - fli ws:terms --lens=api
  - fli ws:terms --kind=code,framework,web
  - fli ws:terms --json
flags:
  as:
    char: a
    type: string
    description: Which layout — list (the terminal) or page (an interactive HTML page)
    choices:
      - list
      - page
    defaultValue: list
  json:
    type: boolean
    description: Print the model instead
    defaultValue: false
  lens:
    char: l
    type: string
    description: With --as=list, which vocabulary — concept, language or api
    defaultValue: concept
  limit:
    type: number
    description: With --as=list, how many rows
    defaultValue: 40
  kind:
    char: k
    type: string
    description: With --as=list, narrow the corpus to these file kinds — markdown, code, framework, web (comma-separated). Concepts only; count and spread are recomputed
    defaultValue: ''
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

**`VOCABULARY.md` is the root register and not the only one.** A package that
defines its own terms well enough to check them has named them, so its register
is READ rather than copied in — `@frontierjs/css` defines 56 terms and 8 axes,
graded against the real CSSOM by its own spec. The root file outranks it, except
where the root row says `open`, which is the file's own word for *not decided*;
those land in the audit instead, because most of them are one spelling over two
realms and the answer is which sense to name rather than which register wins.

**The corpus is four file KINDS and any of them can be switched off** —
`markdown`, `code` (`.ts .js .mjs .mts`), `framework` (`.mesa .lite`) and `web`
(`.css .html`). *Which concepts are in the code* is a different question from
*which are written about*, and a term explained at length and named by nothing
is only visible once the two can be separated. A source file is read WHOLE, so
an identifier the API tab already counts is counted here too — that is the cost
of the wider corpus and it is what switching `code` off undoes. Switching a kind
off **recomputes** count and spread rather than hiding rows, which is what the
source chips beside them already do. Output this workspace generated is never in
the corpus, this command's own page included.

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
const { collectTerms, renderList, renderJson, renderPage, KINDS } =
  await import(resolve(global.fliRoot, 'core/terms.js'))
const { styleBundle } = await import(resolve(global.fliRoot, 'core/assets.js'))

if (flag.json && flag.as !== 'list') {
  log.error(`--json prints the model; --as=${flag.as} writes a page. Drop one of the two flags.`)
  process.exitCode = 1
  return
}

const root = await $.wsRoot()
if (!root) { log.error('No workspace found from here'); process.exitCode = 1; return }

const model = collectTerms({ root })

if (flag.json) {
  echo(renderJson(model))
  return
}

if (flag.as === 'list') {
  const kinds = flag.kind
    ? new Set(String(flag.kind).split(',').map(k => k.trim()).filter(Boolean))
    : null
  // A kind nobody ships is a typo, and narrowing to it answers an empty table
  // that reads exactly like a corpus with nothing in it.
  const unknown = kinds ? [...kinds].filter(k => !KINDS.includes(k)) : []
  if (unknown.length) {
    log.error(`Unknown file kind(s) ${unknown.join(', ')} — ${KINDS.join(', ')}`)
    process.exitCode = 1
    return
  }
  echo(renderList(model, { limit: Number(flag.limit) || 40, lens: flag.lens, kinds }))
  return
}

const file = flag.out ? resolve(root, flag.out) : resolve(root, 'repo-terms.html')
writeFileSync(file, renderPage(model, styleBundle(root)))

echo('')
echo(`  ✓  ${file.replace(`${root}/`, '')}`)
echo(`  ${model.counts.concept} concept(s) · ${model.counts.language} language word(s) · ${model.counts.api} identifier(s)`)
echo(`  audit — ${model.audit.blessedUnused.length} blessed and unused · ${model.audit.unnamedCommon.length} widespread and unnamed · ${model.audit.undecidedButDefined.length} open here and answered by a package · ${model.audit.forbiddenUsed.length} forbidden word(s) in prose`)
if (flag.open && !openInBrowser(file)) echo('  ⚠  could not open a browser')
echo('')
```
