---
title: ai:tldr
description: How do I…? answered as a tldr page — Claude reads the project, prints the few commands that do it
alias: tldr
examples:
  - fli tldr "add a field to a model and migrate"
  - fli tldr "deploy an app to a new server"
  - fli tldr "run one package's tests"
  - fli tldr --effort medium "gate a model so only admins can write"
args:
  -
    name: question
    description: What you want to do, in plain words
    variadic: true
flags:
  effort:
    char: e
    type: string
    description: How hard Claude looks before answering — low is fastest
    choices: [low, medium, high, xhigh, max]
    defaultValue: low
  model:
    char: m
    type: string
    description: Claude model to use (the account's default when empty)
    defaultValue: ''
---

<script>
import { resolve } from 'path'
import { spawnSync } from 'child_process'
</script>

Claude Code (`claude -p`) started at the repository root, read-only — Read,
Grep, Glob, and `rg`/`ls`/`git` in Bash — with hooks off and a $2 cap, the same
session `fli gui`'s *ask claude* runs (`core/ask-claude.js`). It searches the
READMEs, `CLAUDE.md` files, `docs/` and the fli command files, then answers in
tldr-pages shape: a one-line summary and two to six examples.

The workspace's `VOCABULARY.md` is in the prompt, so the answer is written in
the framework's words; each one it uses is colored on the page and defined
underneath it, and a refused word is flagged with the word to say instead. A
project with no `VOCABULARY.md` gets the plain page. Needs the `claude`
CLI on `PATH` and signed in. `--verbose` prints each file it reads.

```js
const { runAsk }                                 = await import(resolve(global.fliRoot, 'core/ask-claude.js'))
const { tldrPrompt, renderTldr, readVocabulary } = await import(resolve(global.fliRoot, 'core/tldr.js'))

const question = arg.question || await tty.line('tldr: ')
if (!question?.trim()) { log.error('No question given'); process.exitCode = 1; return }

// The workspace, not the package cwd is in: a question about deploying is
// answered from the root docs as often as from one package's.
const top  = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' })
const root = top.status === 0 ? top.stdout.trim() : $.paths.root

const vocab = readVocabulary(root)

if (flag.dry) {
  log.dry(`Would ask claude in ${root} (effort ${flag.effort}${flag.model ? `, ${flag.model}` : ''}): ${question}`)
  return
}

let text   = ''
let reads  = 0
let result = null
let error  = null
const footer = tty.live(() => [chalk.dim(`searching${reads ? ` · ${reads} read` : ''}…`)])

const { child, done, error: refused } = runAsk({
  root,
  prompt: tldrPrompt(question, vocab),
  effort: flag.effort,
  model:  flag.model || null,
  onEvent: e => {
    if (e.type === 'text')   text += (text ? '\n' : '') + e.text
    // Text before a tool call is narration ("let me look…"); the page is
    // whatever comes after the last one.
    if (e.type === 'tool')   { text = ''; reads++; log.detail(chalk.dim(e.text)); footer.update() }
    if (e.type === 'result') result = e
    if (e.type === 'error')  error = e.text
  },
})
if (refused) { footer.stop(); log.error(refused); process.exitCode = 1; return }

// Detached, so the group is signaled: the pid alone leaves a running rg behind.
tty.onExit(() => { try { process.kill(-child.pid) } catch {} })

const code = await done
footer.stop()

if (error) log.error(error)
if (!text.trim()) {
  if (!error) log.error(`claude answered nothing${result?.stop ? ` (${result.stop})` : ''}`)
  process.exitCode = 1
  return
}

echo(renderTldr(text, chalk, vocab))
if (result?.cost != null) log.detail(chalk.dim(`$${result.cost.toFixed(3)} · ${result.turns} turn(s)`))
if (code) process.exitCode = code
```
