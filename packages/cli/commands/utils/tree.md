---
title: utils:tree
description: A project's files as a tree — an icon and a color per file type, folders colored by role
alias: tree
examples:
  - fli tree
  - fli tree example
  - fli tree -L 2
  - fli tree --dirs
  - fli tree --no-icons
args:
  -
    name: path
    kind: path
    description: The folder to draw (default the current one)
    required: false
flags:
  depth:
    char: L
    type: number
    description: Levels below the folder to open; a closed folder shows how many files it holds (default all)
  dirs:
    type: boolean
    description: Folders only (no -d, which is every command's --dry)
    defaultValue: false
  icons:
    type: boolean
    description: An emoji before each name (off when piped)
    defaultValue: true
  compact:
    type: boolean
    description: Draw a folder whose only child is a folder as one row, a/b/c
    defaultValue: true
  pager:
    type: boolean
    description: Page through less when the output is taller than the terminal
    defaultValue: true
---

<script>
import { resolve } from 'node:path'
</script>

```js
const { spawnSync } = await import('node:child_process')
const { listPaths, buildTree, compactTree, renderTree, rootRow, isDir } = await import(resolve(global.fliRoot, 'core/file-tree.js'))
const { colorEnabled } = await import(resolve(global.fliRoot, 'core/color.js'))
const { plural }       = await import(resolve(global.fliRoot, 'core/text.js'))

const root = resolve(process.cwd(), arg.path?.trim() || '.')
if (!isDir(root)) {
  echo(`not a folder: ${arg.path}`)
  process.exitCode = 1
  return
}

const tree  = buildTree(listPaths(root))
if (flag.compact) compactTree(tree)
// Piped, it is `tree`'s plain text, so `fli tree | grep` reads names.
const icons = flag.icons && colorEnabled
const { rows, counts } = renderTree(tree, {
  icons,
  depth:    flag.depth ?? 0,
  dirsOnly: flag.dirs,
  link:     (text, rel) => chalk.fileLink(text, resolve(root, rel)),
})

const doc = [
  rootRow(root, { icons }),
  ...rows,
  '',
  chalk.dim(`${plural(counts.dirs, 'folder')}, ${plural(counts.files, 'file')}`),
  '',
].join('\n')

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

## What it lists

What a clone of the folder holds — tracked files plus untracked ones git does
not ignore — so `node_modules`, build output and a database's `-wal` are left
out with no skip list. Outside a git repository it reads the disk, minus `.git`
and `node_modules`.

## Icons and colors

Each file gets an emoji by name (`package.json` 📦, `CLAUDE.md` 🤖, `.env` 🔑),
then by pattern (`*.test.*` 🧪, `*.snapshot.*` 🧊), then by extension (`.lite`
🪨, `.mesa` 🌵, `.md` 📝, `.js` 🟨, `.ts` 🟦), and its name takes that type's
color. Generated files are dimmed. A folder is colored by its role — `db/`
amber, `api/` cyan, the UI surfaces violet, `test/` green, `docs/` blue.

Emoji, not Nerd Font glyphs, so no special font is needed. Piped, it prints
plain text with no icons and no color.

## Compact folders

A folder whose only child is a folder is drawn as one row, `cli/src/routes`, the
way VS Code draws it. `--no-compact` draws every level.

## Paging

Taller than the terminal, the output goes through `$PAGER`, or `less -R` with
`LESS=FRX` unless `LESS` is set. `--no-pager` writes it straight out.
