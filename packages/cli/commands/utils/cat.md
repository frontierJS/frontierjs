---
title: utils:cat
description: Markdown rendered for a terminal — a file, one section of it, or a folder's files
alias: cat
examples:
  - fli cat README.md
  - fli cat DECISIONS.md FJS-D237
  - fli cat docs
  - fli cat docs --all
  - fli cat IDEAS/*.md
args:
  -
    name: paths
    description: Markdown files or folders — and, after one file, a section of it by heading, dotted path or line
    variadic: true
flags:
  all:
    char: a
    type: boolean
    description: For a folder, render every file in it rather than listing them
    defaultValue: false
  raw:
    char: r
    type: boolean
    description: Print the source unrendered
    defaultValue: false
  pager:
    type: boolean
    description: Page through less when the output is taller than the terminal
    defaultValue: true
---

<script>
import { resolve } from 'node:path'
</script>

```js
const { existsSync, statSync, readFileSync } = await import('node:fs')
const { spawnSync }                          = await import('node:child_process')
const { render, section, folderIndex, MARKDOWN } = await import(resolve(global.fliRoot, 'core/cat.js'))
const { colorEnabled }                       = await import(resolve(global.fliRoot, 'core/color.js'))

const tokens = (arg.paths?.trim() || '').split(/\s+/).filter(Boolean)
if (!tokens.length) {
  echo('name a markdown file or a folder — fli cat README.md')
  process.exitCode = 1
  return
}

// A token naming nothing on disk is a section, and only after exactly one file.
const paths   = tokens.filter(t => existsSync(resolve(process.cwd(), t)))
const strays  = tokens.filter(t => !paths.includes(t))
const isDir   = p => statSync(resolve(process.cwd(), p)).isDirectory()
const onlyFile = paths.length === 1 && !isDir(paths[0])
if (strays.length && !(onlyFile && strays.length === 1)) {
  for (const s of strays) echo(`no such file or folder: ${s}`)
  process.exitCode = 1
  return
}
const query = strays[0] ?? null

// Piped output is the source, so `fli cat x.md | grep` reads what is in the file.
const pretty  = colorEnabled && !flag.raw
const columns = Math.min(process.stdout.columns || 80, 100)
const show    = (file, text) => pretty ? render(text, { file, columns }) : text.replace(/\n?$/, '\n')
const banner  = rel => pretty ? `${chalk.dim('━━━')} ${chalk.bold(rel)} ${chalk.dim('━'.repeat(Math.max(3, columns - rel.length - 5)))}\n\n` : `==> ${rel} <==\n`

const out = []
for (const p of paths) {
  const abs = resolve(process.cwd(), p)
  if (isDir(p)) {
    const files = folderIndex(abs)
    if (!files.length) { out.push(`no markdown under ${p}\n`); continue }
    if (flag.all) {
      for (const f of files) out.push(banner(`${p.replace(/\/$/, '')}/${f.rel}`), show(f.file, readFileSync(f.file, 'utf8')), '\n')
      continue
    }
    const width = Math.max(...files.map(f => f.rel.length))
    const lines = Math.max(...files.map(f => String(f.lines).length))
    out.push(paths.length > 1 ? `${chalk.bold(p)}\n` : '')
    for (const f of files) out.push(`${f.rel.padEnd(width)}  ${chalk.dim(String(f.lines).padStart(lines))}  ${f.title ?? chalk.dim('—')}\n`)
    continue
  }
  if (!MARKDOWN.test(p)) {
    echo(`not markdown: ${p}`)
    process.exitCode = 1
    return
  }
  const text = readFileSync(abs, 'utf8')
  if (query) {
    const got = section(text, query)
    if (got.refused) {
      echo(got.refused)
      for (const r of got.rows) echo(r)
      process.exitCode = 1
      return
    }
    out.push(show(abs, got.text))
    continue
  }
  if (paths.length > 1) out.push(banner(p))
  out.push(show(abs, text))
}

const doc = out.join('')
const tall = doc.split('\n').length > (process.stdout.rows || Infinity)
if (!(flag.pager && process.stdout.isTTY && tall)) {
  process.stdout.write(doc)
  return
}
// LESS is set on the call: an assignment to process.env never reaches a child under bun
const pager = process.env.PAGER || 'less'
const paged = spawnSync('sh', ['-c', pager === 'less' ? 'less -R' : pager], {
  input: doc,
  stdio: ['pipe', 'inherit', 'inherit'],
  env:   { ...process.env, LESS: process.env.LESS ?? 'FRX' },
})
if (paged.error) process.stdout.write(doc)
```

## What it renders

Bun's renderer, with three things handed to it differently: a frontmatter block
as a yaml fence (md4c reads one as a rule and a heading), a command file's
`<script>` as a js fence, and a relative link as a `file://` URL so the terminal
can open it.

**Piped, it prints the source.** Rendering follows the color rule every fli
command follows — a terminal, unless `NO_COLOR`; `FORCE_COLOR=1` renders into a
pipe. `--raw` prints the source on a terminal.

## A section

`fli cat DECISIONS.md FJS-D237` prints one heading's section, named the way
`fli outline` names it — a whole heading, a dotted path through its ancestors,
a substring, or a line inside it. A word after one file that names nothing on
disk is read as a section; anywhere else it is a missing file.

## A folder

Bare, a folder is listed: each markdown file under it with its line count and
title (frontmatter `title`, else the first `#` heading). `--all` renders every
one under a banner. Hidden folders, `node_modules` and build output are skipped.

## Paging

Taller than the terminal, the output goes through `$PAGER`, or `less -R` with
`LESS=FRX` unless `LESS` is set. `--no-pager` writes it straight out.
