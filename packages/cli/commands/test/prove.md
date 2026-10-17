---
title: test:prove
description: Run every drive `fli proves` names — start what each needs, run it, stop what was started
alias: prove
examples:
  - fli prove
  - fli prove packages/sierra/src/resource/resource.js packages/sierra/test/sync-policies.test.js
  - fli prove --from main
args:
  -
    name: paths
    kind: path
    description: Prove only these files' changes — the rest of a shared tree is another change's
    variadic: true
flags:
  from:
    char: f
    type: string
    description: Compare against this ref instead of the working tree
---

`fli proves` names the drives; this runs them. For each target it runs the
drive's *Start first* steps from `DRIVES.md` in order — a seed to completion, a
server until its port answers — then the drive, then stops what it started. One
line per target, and the last thirty lines of any that failed.

**Name the files you changed** when the tree is shared: bare, it proves every
edit in the working tree, and another session's edits name drives of their own.

**It refuses a server port that already answers** rather than running the drive
against it: a port that answers is not the right process (`FJS-740`). Stop it
and run again.

The verdict is the LAST lines — failure tails print above it, so `| tail`
keeps the answer. A failed drive that an open register row names says so
(`open: FJS-1272`): the failure was known before this change, which is a lead
and not an acquittal.

**A drive an open row's TITLE names is skipped**, listed as `skipped — open:
FJS-1366`: that row says the drive fails at HEAD, so running it answers nothing
about this change. It runs anyway when the change touches the drive's own file,
because that change is the fix the row waits on. A prove whose every ✗ carries
`open:` is finished; a second run prints the same tags.

**A drive that declares what it holds waits for it.** A script's
`export const holds = ['ports', 'db']` names the checkout's port block and its
dev database; a second `fli prove` in the same tree queues behind the first
rather than failing on a port the first one started. A linked worktree has both
of its own, so a lane never waits. A drive declaring nothing holds nothing, and
a server some other process started is still refused above.

A target that is a test FILE is listed, not run — the runner differs per
package. The package's own suite is still first; this is what runs after it.

```js
const root = (await $.wsRoot?.()) ?? $.paths.root

const { provesFor, changedTree } = await import(resolve(global.fliRoot, 'core/proofs.js'))
const { runnables }              = await import(resolve(global.fliRoot, 'core/runnables.js'))
const { prove, knownFailures, brokenDrives } = await import(resolve(global.fliRoot, 'core/prove.js'))
const { readRegisters }          = await import(resolve(global.fliRoot, 'core/registers.js'))
const children                   = await import(resolve(global.fliRoot, 'core/children.js'))
const { isPortInUse }            = await import(resolve(global.fliRoot, 'core/ports.js'))
const { treeHold }               = await import(resolve(global.fliRoot, 'core/guard.js'))

// Relative to where the caller stands; git takes an absolute pathspec.
const paths = (arg.paths?.trim() || '').split(/\s+/).filter(Boolean).map(p => resolve(process.cwd(), p))
const { files, diff } = changedTree(root, { from: flag.from || null, paths })
if (!files.length) {
  log.info(paths.length ? 'none of those files has changed' : flag.from ? `nothing changed against ${flag.from}` : 'nothing changed in the working tree')
  return
}

const rows   = runnables(root)
const proofs = provesFor(root, { files, diff, rows })
if (!proofs.length) {
  log.warn('no row of the proof table matches this change — run the package\'s own suite')
  return
}

// A drive interrupted mid-run leaves its servers up unless the group is killed.
const bail = () => { children.killAll(); process.exit(130) }
process.once('SIGINT', bail)
process.once('SIGTERM', bail)

const procs = {
  startRow: row => children.startRow(row, { root, fliRoot: global.fliRoot }),
  stopRow:  id  => children.stopRow(id),
  childOf:  children.childOf,
  outputOf: children.outputOf,
}

const issues = readRegisters(root).issues

// A drive an open row's title names fails at HEAD — unless this change touches
// the drive's own file, which is the fix that row is waiting on.
const skip = t => {
  const open = brokenDrives(issues, t.name)
  if (!open.length) return null
  const run = (t.id && rows.find(r => r.id === t.id)?.run) || ''
  const own = files.some(f => run.includes(f.startsWith(`${t.dir}/`) ? f.slice(t.dir.length + 1) : f))
  return own ? null : open
}

const out = await prove({
  proofs, rows, procs, skip,
  hold:      treeHold(root),
  answering: port => isPortInUse(port, '0.0.0.0'),
  say:       line => echo(chalk.dim(line)),
})
children.killAll()

// Tails first and the verdict last: a caller piping through `tail` reran the
// whole set to find the ✓/✗ lines a failure's stack trace had pushed off.
const failures = out.ran.filter(r => !r.ok)
for (const r of failures) {
  if (!r.tail?.length) continue
  echo('')
  echo(chalk.dim(`  ── ${r.dir}: ${r.command}`))
  for (const line of r.tail) echo(chalk.dim(`      ${line}`))
}

echo('')
for (const r of out.ran) {
  const secs = `${Math.round(r.ms / 1000)}s`
  if (r.ok) { echo(`  ${chalk.green('✓')} ${r.dir}: ${r.command}  ${chalk.dim(secs)}`); continue }
  const known = knownFailures(issues, r.name)
  echo(`  ${chalk.red('✗')} ${r.dir}: ${r.command}  ${chalk.dim(secs)} — ${r.reason}${known.length ? chalk.yellow(`  open: ${known.join(', ')}`) : ''}`)
}
for (const s of out.skipped) echo(`  ${chalk.yellow('–')} ${s.dir}: ${s.command}  ${chalk.dim('skipped')} — ${chalk.yellow(`open: ${s.open.join(', ')}`)} names this drive broken at HEAD`)
for (const t of out.read) echo(`  ${chalk.dim('read')} ${t.dir ?? t.where}/${t.name}`)
for (const t of out.gone) echo(`  ${chalk.red('gone')} ${t.where}: ${t.name} — the proof table names what nothing declares`)
echo('')

const failed = failures.length
if (failed) process.exitCode = 1
log.info(`${out.ran.length - failed}/${out.ran.length} passed${out.skipped.length ? `, ${out.skipped.length} skipped on an open row` : ''}`)
```
