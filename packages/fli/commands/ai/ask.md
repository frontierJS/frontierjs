---
title: ai:ask
description: Ask Claude a question from the terminal
alias: ask
examples:
  - fli ask "What is the capital of France?"
  - fli ask "Explain async/await in 2 sentences"
  - fli ask "Review this code" --file ./myfile.js
  - fli ask --system "You are a SQL expert" "How do I index a join?"
  - fli ask "Summarize this" --file ./notes.md --model claude-opus-4-6
args:
  -
    name: prompt
    description: Question or prompt to send to Claude
    variadic: true
flags:
  model:
    char: m
    type: string
    description: Claude model to use
    defaultValue: claude-sonnet-4-6
  system:
    char: s
    type: string
    description: System prompt to set Claude's persona or context
    defaultValue: ''
  file:
    char: f
    type: string
    description: Path to a file whose contents are appended to the prompt
    defaultValue: ''
  max-tokens:
    type: number
    description: Maximum tokens in the response
    defaultValue: 1024
---

<script>
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
</script>

Ask Claude a question directly from the terminal. Streams the response as it arrives.
Requires `ANTHROPIC_API_KEY` in your environment or `.env` file.

```js
// ─── Resolve prompt ───────────────────────────────────────────────────────────
let prompt = arg.prompt || await question('Ask Claude: ')

if (!prompt) {
  log.error('No prompt provided')
  return
}

// Append file contents if --file is set
if (flag.file) {
  const filePath = resolve(process.cwd(), flag.file)
  if (!existsSync(filePath)) {
    log.error(`File not found: ${filePath}`)
    return
  }
  const contents = readFileSync(filePath, 'utf8')
  const ext      = filePath.split('.').pop()
  prompt += `\n\n\`\`\`${ext}\n${contents}\n\`\`\``
}

// ─── Dry run preview ─────────────────────────────────────────────────────────
if (flag.dry) {
  log.dry(`Would send to ${flag.model}: "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`)
  if (flag.system) log.dry(`System: "${flag.system}"`)
  return
}

// ─── Check for API key ────────────────────────────────────────────────────────
const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  log.error('ANTHROPIC_API_KEY is not set')
  log.info('Add it to your .env or run: export ANTHROPIC_API_KEY=sk-...')
  return
}

// ─── Call Claude with streaming ───────────────────────────────────────────────
log.info(`${flag.model}`)

const body = {
  model:      flag.model,
  max_tokens: flag['max-tokens'],
  stream:     true,
  messages:   [{ role: 'user', content: prompt }],
}
if (flag.system) body.system = flag.system

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method:  'POST',
  headers: {
    'Content-Type':      'application/json',
    'x-api-key':         apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify(body),
})

if (!res.ok) {
  const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
  log.error(`API error ${res.status}: ${err?.error?.message || res.statusText}`)
  return
}

// ─── Stream response ──────────────────────────────────────────────────────────
const reader  = res.body.getReader()
const decoder = new TextDecoder()
let   buffer  = ''
let   printed = false

process.stdout.write('\n')

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })

  const lines = buffer.split('\n')
  buffer = lines.pop()

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6).trim()
    if (data === '[DONE]') continue
    try {
      const evt = JSON.parse(data)
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        process.stdout.write(evt.delta.text)
        printed = true
      }
    } catch {}
  }
}

if (printed) process.stdout.write('\n\n')
```
