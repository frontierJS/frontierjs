---
title: workspace:tidy
description: What piles up in the tree — records past their keep, dead worktrees, stray SQLite files, leaked temp dirs, bulky build output. Reports; --apply moves the records
alias: tidy
examples:
  - fli tidy
  - fli tidy --apply
  - fli tidy --json
flags:
  apply:
    char: a
    type: boolean
    description: Rotate HANDOFF.md, trim § Closed and prune worktrees whose directory is gone
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Emit the report as JSON
    defaultValue: false
---

<script>
import { resolve } from 'path'
</script>

```js
const { tidy }             = await import(resolve(global.fliRoot, 'core/tidy.js'))
const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

const root   = (await $.wsRoot?.()) ?? $.paths.root
const report = tidy({ root, registerRoot: findRegisterRoot(root) ?? root, apply: flag.apply })

if (flag.json) {
  echo(JSON.stringify(report, null, 2))
  return
}

const size = b => b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)}G` : b >= 1 << 20 ? `${Math.round(b / (1 << 20))}M` : `${Math.round(b / 1024)}K`
const ago  = ms => { const d = Math.floor((Date.now() - ms) / 86400000); return d < 1 ? 'today' : `${d}d` }
const verb = report.applied ? '' : ' (--apply)'

const ok   = chalk.green('✓')
const warn = chalk.yellow('!')
const head = (title, rest = '') => echo(`  ${chalk.bold(title)}${rest ? chalk.dim(`  ·  ${rest}`) : ''}`)

echo('')
head('records')
const { handoff, closed } = report.records
for (const [name, r, what] of [['HANDOFF.md', handoff, 'sessions'], ['§ Closed', closed, 'rows']]) {
  if (!r.ok)         echo(`    ${chalk.red('✗')} ${name}: ${r.reason}`)
  else if (!r.moved) echo(`    ${ok} ${name} ${chalk.dim(`holds ${r.kept} ${what}`)}`)
  else if (r.dry)    echo(`    ${warn} ${name}: ${r.moved} ${what} past the newest ${r.kept}${chalk.dim(verb)}`)
  else               echo(`    ${ok} ${name}: ${r.moved} ${what} archived, ${r.kept} stay`)
}

echo('')
head('worktrees')
const extra = report.worktrees
if (!extra.length) echo(`    ${ok} ${chalk.dim('only this one')}`)
for (const w of extra) {
  const note = w.prunable ? (report.applied ? 'pruned' : `directory gone${verb}`) : w.inTmp ? 'in a temp dir — git worktree remove' : ''
  echo(`    ${w.prunable || w.inTmp ? warn : chalk.dim('·')} ${w.path}  ${chalk.dim(w.head)}${note ? chalk.yellow(`  — ${note}`) : ''}`)
}

echo('')
head('strays', 'SQLite outside every <app>/db/')
if (!report.strays.length) echo(`    ${ok} ${chalk.dim('none')}`)
for (const s of report.strays) echo(`    ${warn} ${s.dir}/  ${chalk.dim(`${s.files} files · ${size(s.bytes)} · newest ${ago(s.newest)}`)}`)

echo('')
const { entries, piles } = report.tmp
const leaked = piles.reduce((n, p) => n + p.count, 0)
head('tmp', `${leaked} of ${entries} temp entries carry a prefix this repo's mkdtemp calls write`)
for (const p of piles.slice(0, 12)) echo(`    ${String(p.count).padStart(6)}  ${p.prefix.padEnd(26)} ${chalk.dim(`oldest ${ago(p.oldest).padEnd(5)}  ${p.source}`)}`)
if (piles.length > 12) echo(chalk.dim(`    … ${piles.length - 12} more prefixes — --json lists them`))

echo('')
head('bulky', 'ignored directories past 500M')
if (!report.bulky.length) echo(`    ${ok} ${chalk.dim('none')}`)
for (const b of report.bulky) {
  echo(`    ${warn} ${b.path}  ${size(b.bytes)}${b.cargo ? chalk.dim('  — cargo build cache, rebuilt on the next build') : ''}`)
  if (!b.cargo) continue
  if (b.cargo.stale.length) echo(chalk.dim(`        no longer built (crate is ${b.cargo.crate}): ${b.cargo.stale.join(', ')}`))
  echo(`        ${chalk.cyan(b.cargo.clean)}`)
}
echo('')
```

## What it reads

Five piles that grow in silence, because nothing that adds to one reads it back:

- **records** — `HANDOFF.md` past its two newest sessions and `ISSUES.md`
  § Closed past its newest 40 rows. `--apply` runs `register:archive`'s two
  moves, so the rules are that command's.
- **worktrees** — every git worktree but this one. A worktree whose directory
  is gone is pruned under `--apply`; one inside a temp dir outlived the session
  that made it and is named, never removed.
- **strays** — a gitignored SQLite file whose nearest `schema.lite` directory is
  not its own, or has a further `db/` between them. A process started from the
  wrong directory writes one; so does a path bug, such as a directory named
  `:memory:`.
- **tmp** — entries in the temp dir whose name begins with a prefix some
  `mkdtemp` call in this repo writes, each with the line that writes it. The
  prefixes are read from the source, so a new leaking suite is named the day it
  lands. A pile here is a writer that never removes what it made, or a run that
  skipped `scripts/tmp-run.mjs`.
- **bulky** — ignored directories of 500M or more. A `target/` beside a
  `Cargo.toml` is a Tauri shell's build cache: cargo never prunes it, and a
  renamed crate leaves the old binary and every dependency it was built with.
  The line names any binary the crate no longer builds, and the `cargo clean`
  that empties the cache.

Nothing is deleted. A gitignored database in this tree is as often somebody's
dev data as it is debris, and the remedy for a tmp pile is the writer it names.
