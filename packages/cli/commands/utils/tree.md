---
title: utils:tree
description: A project's files as a tree — an icon and a color per file type, folders colored by role
alias: tree
examples:
  - fli tree
  - fli tree example
  - fli tree -L 2
  - fli tree --dirs --fit
  - fli tree --flat
  - fli tree --no-icons --no-links
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
  flat:
    type: boolean
    description: One long tree instead of a lane per top-level folder
    defaultValue: false
  fit:
    type: boolean
    description: Close folders level by level until the drawing fits the screen
    defaultValue: false
  links:
    type: boolean
    description: Names are clickable links (VS Code underlines them)
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
const { listPaths, buildTree, compactTree, renderTree, treeDepth, rootRow, isDir, buildLanes, layoutLanes, drawLanes } =
  await import(resolve(global.fliRoot, 'core/file-tree.js'))
const { colorEnabled } = await import(resolve(global.fliRoot, 'core/color.js'))
const { plural }       = await import(resolve(global.fliRoot, 'core/text.js'))

// Narrower than this, two lanes side by side wrap and read worse than one tree.
const LANES_AT = 100

const root = resolve(process.cwd(), arg.path?.trim() || '.')
if (!isDir(root)) {
  echo(`not a folder: ${arg.path}`)
  process.exitCode = 1
  return
}

const tree = buildTree(listPaths(root))
if (flag.compact) compactTree(tree)

// Piped, it is `tree`'s plain text, so `fli tree | grep` reads names.
const term  = Boolean(process.stdout.isTTY)
const icons = flag.icons && colorEnabled
const link  = flag.links ? (text, rel) => chalk.fileLink(text, resolve(root, rel)) : text => text
const width = process.stdout.columns || 0
// The root row, the blank and count lines, and the prompt after.
const room  = term && process.stdout.rows ? Math.max(10, process.stdout.rows - 4) : Infinity
const lanes = term && !flag.flat && width >= LANES_AT

const draw = depth => {
  const opts = { icons, depth, dirsOnly: flag.dirs, link }
  return lanes
    ? drawLanes(layoutLanes(buildLanes(tree, opts), { width, height: room }))
    : renderTree(tree, opts).rows
}

let depth = flag.depth ?? 0
let body  = draw(depth)
let fitted = false
if (flag.fit && body.length > room) {
  for (let d = (depth || treeDepth(tree)) - 1; d >= 1; d--) {
    depth  = d
    body   = draw(d)
    fitted = true
    if (body.length <= room) break
  }
}

const { counts } = renderTree(tree, { icons: false })
const summary = [
  plural(counts.dirs, 'folder'),
  plural(counts.files, 'file'),
  fitted && `opened ${depth} ${depth === 1 ? 'level' : 'levels'} deep to fit`,
].filter(Boolean).join(', ')

const doc = [rootRow(root, { icons }), ...body, '', chalk.dim(summary), ''].join('\n')

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

## Lanes

In a terminal at least 100 columns wide, each top-level folder is its own tree
and the trees sit side by side, packed down a column and then across, with the
files at the root as the last lane. A lane stays whole when the whole layout
fits the screen; otherwise the shortest layout that fits the width is drawn,
and a lane cut across two columns carries a `(cont.)` header where it resumes.
`--flat` draws one long tree; piped output is always flat.

## Fitting the screen

`--fit` closes folders one level at a time, from the deepest, until the drawing
fits the terminal's height; a closed folder shows how many files it holds, and
the count line says how deep it opened. With `-L`, it starts from that depth.

## Links

Every name is a clickable link to its file (OSC 8), which VS Code's terminal
underlines. `--no-links` prints plain names.

## Compact folders

A folder whose only child is a folder is drawn as one row, `cli/src/routes`, the
way VS Code draws it. `--no-compact` draws every level.

## Paging

Taller than the terminal, the output goes through `$PAGER`, or `less -R` with
`LESS=FRX` unless `LESS` is set. `--no-pager` writes it straight out.
