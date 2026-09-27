---
title: git:status
description: Working tree grouped by package and by what each file is
alias: gs
examples:
  - fli gs
  - fli gs --with-new
  - fli gs --short
  - fli gs --hubs
  - fli gs --json
flags:
  short:
    char: s
    type: boolean
    description: Hand over to plain `git status -s`
    defaultValue: false
  with-new:
    type: boolean
    description: List untracked files in the groups too (their count is always in the summary)
    defaultValue: false
  hubs:
    type: boolean
    description: Only the edited hubs (the amber rows), one path per line
    defaultValue: false
  json:
    type: boolean
    description: Answer a machine
    defaultValue: false
---

<script>
import { execSync } from 'child_process'
import { resolve as joinPath } from 'path'
</script>

`git status` answers in one flat alphabetical list. In a monorepo that is the
wrong axis: a hundred paths sorted by first character interleaves nine packages,
six example surfaces and the root registers, and the reader re-derives the
grouping by eye every single time.

This groups by **where** (package, surface, root folder) and then by **what the
file is to that place** — schema, source, test, config, snapshot, record. Both
fall out of the path alone, so there is no list of packages to keep current.

Heaviest place first, because that is the one a scan is looking for. A conflict
outranks any amount of churn.

A file named by more than three others carries `↑n` — how far a change to it
reaches. The count comes from `core/blast.js`, which is `core/codegraph.js`'s own
reference reading narrowed to that one question, and the bands are codegraph's,
so a file the codegraph page draws as a hub is marked here. It is the scan that
costs (~0.4s on this workspace): knowing who names `parser.js` means reading
everyone, and it cannot be narrowed by target.

Untracked files are counted in the summary but not listed — a scaffold or a
generated tree drowns the edits the scan is for. `--with-new` lists them.

`--hubs` prints only the amber rows — edited files named by more than fifteen
others — as bare paths, one per line, most reach first. Nothing else is printed,
so it pipes.

`--short` hands over to plain `git status -s` unchanged.

```js
const root = context.git.repoRoot(context.paths.root) ?? context.paths.root

if (flag.short) {
  context.exec({ command: 'git status -s', dry: flag.dry })
  return
}

const { buildStatus, splitRel, hubsOf } = await import(joinPath(global.fliRoot, 'core/git-status.js'))
const { usedByIndex, blastReader } = await import(joinPath(global.fliRoot, 'core/blast.js'))

const git = (argv) => {
  try { return execSync(`git ${argv}`, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
  catch { return '' }
}

// `--no-color`: a user's `color.diff = always` colors a piped diff too, and the
// numbers then arrive wrapped in escapes that `Number()` reads as NaN.
const model = buildStatus({
  porcelain: git('status --porcelain -z'),
  unstaged:  git('diff --no-color --numstat'),
  staged:    git('diff --no-color --numstat --cached'),
  branch:    git('rev-parse --abbrev-ref HEAD').trim() || null,
  blastOf:   blastReader(usedByIndex(root)),
})

if (flag.json) { console.log(JSON.stringify(model, null, 2)); return }

if (flag.hubs) {
  const hubs = hubsOf(model, { withNew: flag['with-new'] })
  if (hubs.length) console.log(hubs.join('\n'))
  return
}

if (!model.total.files) { log.success(`${model.branch ?? 'detached'} — clean`); return }

const n     = (v) => v.toLocaleString('en-US')
const width = Math.max(60, Math.min(process.stdout.columns || 100, 160))
const t     = model.total

console.log('')

// ─── per place ─────────────────────────────────────────────────────────────
// The bar is proportional to the heaviest place, not to an absolute scale: the
// question it answers is *which of these is the big one*, which is the only one
// a ten-cell bar can answer honestly.
const shown = flag['with-new'] ? model.zones : model.zones
  .map(z => ({ ...z, files: z.files.filter(f => !f.untracked) }))
  .filter(z => z.files.length)
const peak = Math.max(...shown.map(z => z.churn), 1)
const BAR  = 12

// Widest place name, so the bars line up into a column the eye can compare.
const nameCol = Math.min(24, Math.max(...shown.map(z => z.zone.length), 0))
const roleCol = Math.max(...shown.flatMap(z => z.files.map(f => f.role.length)), 0)

// A file's own churn sits in a column after the widest path, so the numbers
// line up down the whole listing — capped, or one deep path pushes every
// number off a narrow terminal.
const plainWidth = (f) => {
  const glyph = f.untracked || f.index === 'A' || f.index === 'D' || f.work === 'D' || f.conflict ? 1 : 0
  const from  = f.from ? f.from.split('/').pop().length + 2 : 0
  const reach = f.blast && f.blast.band >= 2 ? String(f.blast.usedBy).length + 1 : 0
  return glyph + f.rel.length + from + reach
}
const pathCol = Math.min(width - (6 + roleCol + 2) - 15, Math.max(...shown.flatMap(z => z.files.map(plainWidth)), 0))

// State first, reach second. What you DID to a file outranks how far it
// reaches — deleting something 77 files import is red before it is amber, and
// the `↑77` beside it is still amber, so both facts survive on the one row.
// Amber claims the name only where there is no state to say.
const paint = (f) => {
  if (f.conflict)  return chalk.red
  if (f.untracked) return chalk.cyan
  if (f.index === 'D' || f.work === 'D') return chalk.red
  if (f.index === 'A') return chalk.green
  if (f.index === 'R' || f.work === 'R') return chalk.magenta ?? chalk.cyan
  if (f.blast && f.blast.band >= 3) return chalk.yellow
  return (s) => s
}

for (const z of shown) {
  const filled = Math.max(1, Math.round((z.churn / peak) * BAR))
  const bar    = chalk.dim('█'.repeat(filled) + '·'.repeat(BAR - filled))
  const marks  = [
    z.conflicts && chalk.red(`!${z.conflicts}`),
    z.staged    && chalk.green(`●${z.staged}`),
    z.untracked && chalk.cyan(`?${z.untracked}`),
  ].filter(Boolean).join(' ')

  console.log([
    '  ' + chalk.bold(z.zone.padEnd(nameCol)),
    String(z.files.length).padStart(3),
    bar,
    chalk.green(`+${n(z.added)}`.padStart(6)),
    chalk.red(`-${n(z.deleted)}`.padStart(6)),
    marks,
  ].join(' ').trimEnd())

  // One row per file. Rows sharing a directory repeat it, dimmed: a row the eye
  // has to reassemble from a wrapped line of siblings is the flat list again.
  for (const f of z.files) {
    const { dir, base } = splitRel(f.rel)
    const glyph = f.untracked || f.index === 'A' ? '+' : f.index === 'D' || f.work === 'D' ? '-' : f.conflict ? '!' : ''
    // The count rather than a severity word, and only above band 2. Every
    // file carries a reading and most of them are 0 — printing all of them
    // trains the eye to skip the column that matters. `↑` and not `!`,
    // which already means a conflict here.
    const reach = f.blast && f.blast.band >= 2
      ? (f.blast.band >= 3 ? chalk.yellow : chalk.dim)(`↑${f.blast.usedBy}`)
      : ''
    // Painted BEFORE the reach is appended, never around it: an inner
    // color's reset ends the outer one, so a red deleted hub went plain
    // from its own `↑` onward.
    // The glyph leads the row, not the basename: `hooks/+x.mjs` reads as a
    // file named `+x.mjs`.
    const name = base + (f.from ? chalk.dim(` ←${f.from.split('/').pop()}`) : '')
    const cell = paint(f)(glyph) + chalk.dim(dir) + paint(f)(f.index ? chalk.bold(name) : name) + reach
    const pad  = ' '.repeat(Math.max(0, pathCol - plainWidth(f)))
    const nums = f.untracked || f.binary ? '' :
      chalk.dim(`+${n(f.added)}`.padStart(6) + ' ' + `-${n(f.deleted)}`.padStart(6))
    console.log(`      ${chalk.dim(f.role.padEnd(roleCol))}  ${cell}${nums && pad + '  ' + nums}`)
  }
  console.log('')
}

// ─── the summary, last ─────────────────────────────────────────────────────
// Below the listing rather than above it: the totals are what the eye should
// land on when the scroll stops, and on a hundred-file tree a header has left
// the screen by the time the last place is printed.
const counts = [
  t.conflicts && chalk.red(`${t.conflicts} conflicted`),
  t.staged    && chalk.green(`${t.staged} staged`),
  t.dirty     && chalk.yellow(`${t.dirty} dirty`),
  t.untracked && chalk.cyan(`${t.untracked} new`),
].filter(Boolean)

console.log([
  chalk.bold(model.branch ?? 'detached'),
  `${n(t.files)} files in ${n(model.zones.length)} places`,
  `${chalk.green(`+${n(t.added)}`)} ${chalk.red(`-${n(t.deleted)}`)}`,
  ...counts,
].join(chalk.dim('  ·  ')))
const marked = model.zones.flatMap(z => z.files).filter(f => f.blast && f.blast.band >= 2).length
const legend = [
  t.staged && chalk.dim('bold = staged'),
  marked   && chalk.dim('↑n = named by n other file(s), ') + chalk.yellow('amber') + chalk.dim(` past 15 — ${marked} marked here`),
].filter(Boolean)
if (legend.length) console.log('  ' + legend.join(chalk.dim('  ·  ')))
console.log('')
```
