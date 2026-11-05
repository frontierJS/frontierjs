---
title: ai:ask
description: Ask Claude a FrontierJS question from the terminal — it reads the project and the fli commands before answering
alias: ask
examples:
  - fli ask "how do I make a server?"
  - fli ask "how do I add a field to a model and migrate?"
  - fli ask "Review this resource" --file ./src/resources/Lead.mesa
  - fli ask --effort medium "why would a gate refuse an admin?"
  - fli ask --system "Answer in one paragraph" "what is a Basecamp?"
args:
  -
    name: prompt
    description: Question or prompt to send to Claude
    variadic: true
flags:
  effort:
    char: e
    type: string
    description: How hard Claude looks before answering — low is fastest (Claude Code only)
    choices: [low, medium, high, xhigh, max]
    defaultValue: low
  model:
    char: m
    type: string
    description: Claude model to use (Claude Code's default when empty; claude-sonnet-5 over the API)
    defaultValue: ''
  system:
    char: s
    type: string
    description: Extra instructions added to the FrontierJS framing
    defaultValue: ''
  file:
    char: f
    type: string
    description: Path to a file whose contents are appended to the prompt
    defaultValue: ''
  max-tokens:
    type: number
    description: Maximum tokens in the response (API only)
    defaultValue: 1024
---

<script>
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { execFileSync, spawnSync } from 'child_process'

const API_MODEL = 'claude-sonnet-5'

function withFile(prompt, file) {
  const filePath = resolve(process.cwd(), file)
  if (!existsSync(filePath)) return { failure: `File not found: ${filePath}` }
  const ext = filePath.split('.').pop()
  return { prompt: `${prompt}\n\n\`\`\`${ext}\n${readFileSync(filePath, 'utf8')}\n\`\`\`` }
}

// The workspace, not the package cwd is in: a question about deploying is
// answered from the root docs as often as from one package's.
function workspaceRoot(fallback) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' })
  return top.status === 0 ? top.stdout.trim() : fallback
}

function commandIndex(commands) {
  return commands
    .filter(c => c.title && !c.hidden)
    .map(c => `- fli ${c.title}${c.alias ? ` (${[].concat(c.alias).join(', ')})` : ''} — ${c.description || ''}`)
    .sort()
}

// A machine logged in to Claude Code answers through `claude -p` on its
// subscription; only a machine without it needs an API credential.
function claudeCliLoggedIn() {
  try {
    const status = execFileSync('claude', ['auth', 'status'], {
      encoding: 'utf8',
      stdio:    ['ignore', 'pipe', 'ignore'],
      timeout:  10_000,
    })
    return JSON.parse(status).loggedIn === true
  } catch {
    return false
  }
}

// Three sources, in the order the Anthropic SDKs use. An OAuth token travels on
// Authorization: Bearer and needs the oauth beta header, so a key swap alone is
// not enough — x-api-key with a Bearer token is a 401 that names neither.
function apiAuthHeaders() {
  const bearer = token => ({ 'authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' })
  if (process.env.ANTHROPIC_API_KEY) return { 'x-api-key': process.env.ANTHROPIC_API_KEY }
  if (process.env.ANTHROPIC_AUTH_TOKEN) return bearer(process.env.ANTHROPIC_AUTH_TOKEN)
  try {
    // Without --access-token this prints JSON, not a bare token.
    const token = execFileSync('ant', ['auth', 'print-credentials', '--access-token'], {
      encoding: 'utf8',
      stdio:    ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (token) return bearer(token)
  } catch {}
  return null
}

// The read-only session `fli tldr` runs; `runAsk` owns its argv and budget.
async function askClaudeCode({ runAsk, root, prompt, effort, model, tty, log, chalk }) {
  let text   = ''
  let reads  = 0
  let result = null
  let error  = null
  const footer = tty.live(() => [chalk.dim(`searching${reads ? ` · ${reads} read` : ''}…`)])

  const { child, done, error: refused } = runAsk({
    root, prompt, effort, model: model || null,
    onEvent: e => {
      if (e.type === 'text')   text += (text ? '\n' : '') + e.text
      // Text before a tool call is narration ("let me look…"); the answer is
      // whatever comes after the last one.
      if (e.type === 'tool')   { text = ''; reads++; log.detail(chalk.dim(e.text)); footer.update() }
      if (e.type === 'result') result = e
      if (e.type === 'error')  error = e.text
    },
  })
  if (refused) { footer.stop(); return { failure: refused } }

  // Detached, so the group is signaled: the pid alone leaves a running rg behind.
  tty.onExit(() => { try { process.kill(-child.pid) } catch {} })

  const code = await done
  footer.stop()
  if (error) return { failure: error }
  if (!text.trim()) return { failure: `claude answered nothing${result?.stop ? ` (${result.stop})` : ''}` }
  return { text, result, code }
}

async function askApi({ prompt, model, system, maxTokens, authHeaders }) {
  const body = { model, max_tokens: maxTokens, stream: true, system, messages: [{ role: 'user', content: prompt }] }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeaders },
    body:    JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
    return `API error ${res.status}: ${err?.error?.message || res.statusText}`
  }

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let   buffer  = ''
  let   printed = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let evt
      try { evt = JSON.parse(line.slice(6)) } catch { continue }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        if (!printed) process.stdout.write('\n')
        process.stdout.write(evt.delta.text)
        printed = true
      }
    }
  }

  if (printed) process.stdout.write('\n\n')
  return null
}
</script>

Ask Claude a question about this FrontierJS workspace. Every fli command, with
its one-line description, rides in the prompt, so an answer names the command
that does it rather than another framework's.

When Claude Code is installed and logged in, the question goes to the read-only
session `fli tldr` runs (`core/ask-claude.js`): `claude -p` at the repository
root with Read, Grep, Glob and `rg`/`ls`/`git`, hooks off and a $2 cap, so it
opens the command file before quoting a flag. Otherwise it goes to the API with
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or the profile `ant auth login`
writes, and answers from the command list alone. `--verbose` prints each file
it reads.

```js
const { runAsk, questionPrompt }         = await import(resolve(global.fliRoot, 'core/ask-claude.js'))
const { buildRegistry, uniqueCommands } = await import(resolve(global.fliRoot, 'core/registry.js'))

let question = arg.prompt || await tty.line('Ask Claude: ')
if (!question?.trim()) {
  log.error('No prompt provided')
  process.exitCode = 1
  return
}

if (flag.file) {
  const read = withFile(question, flag.file)
  if (read.failure) {
    log.error(read.failure)
    process.exitCode = 1
    return
  }
  question = read.prompt
}

const root     = workspaceRoot($.paths.root)
const commands = commandIndex(uniqueCommands(buildRegistry()))

if (flag.dry) {
  log.dry(`Would ask Claude in ${root} with ${commands.length} commands listed: "${question.slice(0, 80)}${question.length > 80 ? '…' : ''}"`)
  if (flag.system) log.dry(`System: "${flag.system}"`)
  return
}

if (claudeCliLoggedIn()) {
  echo`  {dim ${flag.model || 'claude'} · claude -p · effort ${flag.effort}}`
  const prompt = questionPrompt({ question, commands, system: flag.system })
  const asked  = await askClaudeCode({ runAsk, root, prompt, effort: flag.effort, model: flag.model, tty, log, chalk })
  if (asked.failure) {
    log.error(asked.failure)
    process.exitCode = 1
    return
  }
  echo(`\n${asked.text.trim()}\n`)
  if (asked.result?.cost != null) log.detail(chalk.dim(`$${asked.result.cost.toFixed(3)} · ${asked.result.turns} turn(s)`))
  if (asked.code) process.exitCode = asked.code
  return
}

const authHeaders = apiAuthHeaders()
if (!authHeaders) {
  log.error('No Claude login or Anthropic credentials found')
  log.info('Run: claude auth login   (uses your Claude.ai subscription)')
  log.info('Or:  ant auth login      (Console account, no key to manage)')
  log.info('Or add ANTHROPIC_API_KEY to your .env')
  process.exitCode = 1
  return
}

const model = flag.model || API_MODEL
echo`  {dim ${model} · API}`
const failure = await askApi({
  prompt:    question,
  model,
  system:    questionPrompt({ commands, system: flag.system, tools: false }),
  maxTokens: flag['max-tokens'],
  authHeaders,
})
if (failure) {
  log.error(failure)
  process.exitCode = 1
}
```
