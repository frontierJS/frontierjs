---
title: make:command
description: Scaffold a new FLI command file
alias: new
examples:
  - fli make:command
  - fli make:command hello:notify
  - fli make:command hello:notify --description "Send a notification"
args:
  -
    name: title
    description: "Command title in namespace:command format"
flags:
  description:
    char: D
    type: string
    description: Short description of what the command does
    defaultValue: ''
  _spec:
    type: string
    description: JSON spec from Web GUI (internal)
    defaultValue: ''
---

<script>
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { createInterface } from 'readline'

// ─── Prompt engine ────────────────────────────────────────────────────────────
// Two modes:
//   TTY   → readline per-prompt (characters echo as user types)
//   Pipe  → buffer ALL stdin first, then answer prompts from the buffer
//
// The pipe mode avoids readline timing/close-event races entirely.

const readStdin = () => new Promise((res) => {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    res({ tty: true, rl })
    return
  }
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', c => { buf += c })
  process.stdin.once('end', () => res({ tty: false, lines: buf.split('\n').map(l => l.trim()) }))
})

const createPrompts = (stdin) => {
  if (!stdin.tty) {
    // Piped mode: synchronously pop lines from buffer
    let cursor = 0
    const next = (prompt) => {
      process.stdout.write(prompt + '\n')
      return Promise.resolve(stdin.lines[cursor++] ?? '')
    }
    return {
      ask:     async (prompt, fallback) => (fallback !== undefined && fallback !== '') ? fallback : (await next(prompt)) || null,
      confirm: async (prompt)           => { const a = (await next(`${prompt} (y/n) › `)).toLowerCase(); return a === 'y' || a === 'yes' },
      choose:  async (prompt, options)  => {
        options.forEach((o, i) => process.stdout.write(`  ${i + 1}) ${o}\n`))
        const idx = parseInt(await next(`  ${prompt} › `)) - 1
        return options[idx] ?? options[0]
      },
      close: () => {}
    }
  }

  // TTY mode: use readline for proper line echo
  const rl = stdin.rl
  const next = (prompt) => new Promise(r => rl.question(prompt, answer => r(answer.trim())))
  return {
    ask:     async (prompt, fallback) => (fallback !== undefined && fallback !== '') ? fallback : (await next(prompt)) || null,
    confirm: async (prompt)           => { const a = await next(`${prompt} (y/n) › `); return a.toLowerCase() === 'y' || a.toLowerCase() === 'yes' },
    choose:  async (prompt, options)  => {
      options.forEach((o, i) => process.stdout.write(`  ${i + 1}) ${o}\n`))
      const idx = parseInt(await next(`  › `)) - 1
      return options[idx] ?? options[0]
    },
    close: () => rl.close()
  }
}

// ─── Collectors ───────────────────────────────────────────────────────────────

const collectArgs = async (p) => {
  const result = []
  let addMore = await p.confirm('\nAdd a positional arg?')
  while (addMore) {
    const name     = await p.ask('  Arg name › ')
    const desc     = await p.ask('  Description › ')
    const required = await p.confirm('  Required?')
    const variadic = await p.confirm('  Variadic? (captures all remaining input)')
    result.push({ name, description: desc, required, variadic })
    if (variadic) break
    addMore = await p.confirm('\nAdd another arg?')
  }
  return result
}

const collectFlags = async (p) => {
  const result = {}
  let addMore = await p.confirm('\nAdd a flag?')
  while (addMore) {
    const name   = await p.ask('  Flag name › ')
    const char   = await p.ask('  Short char (optional, single letter) › ')
    const type   = await p.choose('Type?', ['string', 'boolean', 'number'])
    const desc   = await p.ask('  Description › ')
    const defVal = await p.ask('  Default value (optional) › ')
    result[name] = {
      ...(char   ? { char }                 : {}),
      ...(type   ? { type }                 : {}),
      ...(desc   ? { description: desc }    : {}),
      ...(defVal ? { defaultValue: defVal } : {}),
    }
    addMore = await p.confirm('\nAdd another flag?')
  }
  return result
}

// ─── YAML serialisers ─────────────────────────────────────────────────────────

const serializeArgs = (args) => {
  if (!args.length) return null
  return 'args:\n' + args.map((a) => {
    let out = '  -\n'
    out += `    name: ${a.name}\n`
    if (a.description) out += `    description: ${a.description}\n`
    if (a.required)    out += `    required: true\n`
    if (a.variadic)    out += `    variadic: true\n`
    return out
  }).join('')
}

const serializeFlags = (flags) => {
  const entries = Object.entries(flags)
  if (!entries.length) return null
  return 'flags:\n' + entries.map(([name, def]) => {
    let out = `  ${name}:\n`
    if (def.char)                       out += `    char: ${def.char}\n`
    if (def.type)                       out += `    type: ${def.type}\n`
    if (def.description)                out += `    description: ${def.description}\n`
    if (def.defaultValue !== undefined) out += `    defaultValue: ${def.defaultValue}\n`
    return out
  }).join('')
}

// ─── Stub generator ───────────────────────────────────────────────────────────

const buildStub = (title, args, flags) => {
  const argLines  = args.map((a) => `log.info(\`  ${a.name}: \${arg.${a.name}}\`)`)
  const flagLines = Object.keys(flags).map((f) => `log.info(\`  ${f}: \${flag.${f}}\`)`)
  return [
    `// TODO: implement ${title}`,
    `log.info('Running ${title}')`,
    ...argLines,
    ...flagLines,
  ].join('\n')
}

// ─── File writer ──────────────────────────────────────────────────────────────
// fence and scriptClose avoid confusing the FLI compiler:
//   - literal ``` inside <script> would be treated as a code fence
//   - literal <\/script> inside <script> would end the block early

const writeCommand = (title, description, newArgs, newFlags, outputPath) => {
  const alias       = title.split(':')[1]
  const fence       = '`'.repeat(3)
  const scriptClose = '</' + 'script>'

  const parts = [
    '---',
    `title: ${title}`,
    `description: ${description || ''}`,
    `alias: ${alias}`,
    'examples:',
    `  - fli ${title}`,
    serializeArgs(newArgs),
    serializeFlags(newFlags),
    '---',
    '',
    '<script>',
    '// Add helper functions here',
    scriptClose,
    '',
    fence + 'js',
    buildStub(title, newArgs, newFlags),
    fence,
    '',
  ]

  const content = parts.filter(p => p !== null).join('\n')
  const dir = dirname(outputPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(outputPath, content, 'utf8')
}
</script>

Scaffold a new FLI `.md` command file interactively.
Pass a title as an arg and `--description` to skip those prompts.

```js
// ─── Web path: spec arrives pre-built as JSON in flag._spec ─────────────────
if (flag._spec) {
  const spec = JSON.parse(flag._spec)
  arg.title = spec.title
  const [namespace, name] = spec.title.split(':')

  const outputPath = resolve(
    context.paths.cli,
    'src/routes',
    namespace,
    `${name}.md`
  )

  if (flag.dry) {
    log.dry(`Would write: ${outputPath}`)
    if (existsSync(outputPath)) log.warn(`Note: ${outputPath} already exists and would be overwritten`)
  } else {
    if (existsSync(outputPath)) {
      log.error(`${spec.title} already exists at ${outputPath}`)
      log.info(`Use \`fli edit ${spec.title}\` to edit it, or delete the file first`)
      return
    }
    writeCommand(spec.title, spec.description, spec.args || [], spec.flags || {}, outputPath)
    log.success(`Created ${outputPath}`)
    echo(`\nRun it with:  fli ${spec.title}`)
  }
  return
}

// ─── CLI path: interactive prompts ────────────────────────────────────────────
const stdin = await readStdin()
const p = createPrompts(stdin)

// ─── Step 1: title ────────────────────────────────────────────────────────────
arg.title ??= await p.ask('Command title (namespace:command) › ')

if (!arg.title?.includes(':')) {
  log.error('Title must be in namespace:command format (e.g. hello:notify)')
  p.close()
  return
}

const [namespace, name] = arg.title.split(':')

// ─── Step 2: description ──────────────────────────────────────────────────────
const description = await p.ask('Description › ', flag.description)

// ─── Step 3: collect args for new command ─────────────────────────────────────
const newArgs = await collectArgs(p)

// ─── Step 4: collect flags for new command ────────────────────────────────────
const newFlags = await collectFlags(p)

// Yield to let readline settle, then close
await new Promise(r => setImmediate(r))
p.close()

// ─── Step 5: resolve output path and write ────────────────────────────────────
const outputPath = resolve(
  context.paths.cli,
  'src/routes',
  namespace,
  `${name}.md`
)

if (flag.dry) {
  log.dry(`Would write: ${outputPath}`)
  if (existsSync(outputPath)) log.warn(`Note: ${outputPath} already exists and would be overwritten`)
} else {
  if (existsSync(outputPath)) {
    log.error(`${arg.title} already exists at ${outputPath}`)
    log.info(`Use \`fli edit ${arg.title}\` to edit it, or delete the file first`)
    return
  }
  writeCommand(arg.title, description, newArgs, newFlags, outputPath)
  log.success(`Created ${outputPath}`)
  echo(`\nRun it with:  fli ${arg.title}`)
}
```
