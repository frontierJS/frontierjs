---
title: test:done
description: Is the change in the working tree finished — docs pointers, test wiring, snapshots, registers, and the drives it needs
alias: done
examples:
  - fli done
  - fli done --json
  - fli done --fresh
flags:
  json:
    char: j
    type: boolean
    description: Emit the report as JSON
    defaultValue: false
  fresh:
    type: boolean
    description: Build the report even when the tree is as the last run left it
    defaultValue: false
---

```js
const { doneReport } = await import(resolve(global.fliRoot, 'core/done.js'))

// The workspace, because the diff and the registers are its.
const root   = (await $.wsRoot?.()) ?? $.paths.root
const report = await doneReport(root, { fresh: flag.fresh })

if (flag.json) {
  echo(JSON.stringify(report, null, 2))
  if (report.unfinished) process.exitCode = 1
  return
}

if (!report.changed) {
  echo`
  {bold fli test:done}  {dim ·  nothing changed against HEAD}
`
  return
}

echo.lines([
  '',
  headerRow(report, chalk),
  report.kept && chalk.dim(`  kept from ${report.kept} — the tree has not moved since; --fresh builds it again`),
  '',
  ...report.items.map(item => itemRow(item, chalk)),
  ...driveRows(report.drives, chalk),
  '',
])

if (report.unfinished) process.exitCode = 1
```

<script>
const { plural } = await import(new URL('file://' + global.fliRoot + '/core/text.js'))

const headerRow = (report, chalk) => {
  const unfinished = report.unfinished ? chalk.yellow(`${report.unfinished} unfinished`) : chalk.green('0 unfinished')
  return chalk`  {bold fli test:done}  {dim ·  ${plural(report.changed, 'file')} changed  ·} ${unfinished}`
}

const itemRow = (item, chalk) => item.ok
  ? chalk`  {green ✓}  ${item.check.padEnd(15)} {dim ${item.message}}`
  : chalk`  {red ✗}  ${item.check.padEnd(15)} ${item.message}`

// A row matched on the package alone says only that something in the package
// changed, and a package the table names often matches most of its rows at once.
const driveRows = (drives, chalk) => {
  if (!drives.length) return []
  const loose = drives.filter(d => d.tier === 'package')
  const pkgs  = [...new Set(loose.flatMap(d => d.on))].join(', ')
  return [
    '',
    chalk`  {bold run before calling it proved:}`,
    ...drives.filter(d => d.tier !== 'package').flatMap(d => [
      chalk`    ${d.changed}   {dim (matched by ${d.tier}${d.on.length ? `: ${d.on.slice(0, 3).join(', ')}` : ''})}`,
      ...d.run.map(r => chalk`      {cyan ${r}}`),
    ]),
    loose.length > 0 && chalk.dim(`    + ${plural(loose.length, 'row')} that name only the package (${pkgs}) — \`fli proves\` lists them`),
  ]
}
</script>

## What it grades

The steps that close a change out and fail in silence when skipped, asked of
`git diff HEAD` plus untracked files:

- **layout-named** — a new module is named in its package's `CLAUDE.md`, when
  that file already names most of the new module's siblings.
- **module-named** — a new command is named in its namespace's `_module.md`,
  on the same sibling rule.
- **test-files-run** — `fli check`'s rule: a hand-listed test script names
  every test file beside it.
- **registers** — `register:check`'s errors.
- **snapshots** — every committed snapshot still matches its source.

Then the drives `fli proves` names for the diff. Whether they were run is not
something the tree records, so they are listed rather than graded. A row
matched on the package alone is counted in one line rather than listed. It never
grades whether the change is right — that is what the drives are for.

The last report is kept under the git dir for half an hour, keyed on HEAD and
the tree, and the Stop hook shares it: asked again with nothing changed, it
answers at once and says so. `--fresh` builds it regardless.

Exit code 1 while anything is unfinished.
