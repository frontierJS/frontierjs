---
title: test:done
description: Is the change in the working tree finished — history, docs pointers, test wiring, snapshots, registers, and the drives it needs
alias: done
examples:
  - fli done
  - fli done --json
flags:
  json:
    char: j
    type: boolean
    description: Emit the report as JSON
    defaultValue: false
---

```js
const { runDone } = await import(resolve(global.fliRoot, 'core/done.js'))

// The workspace, because the diff and the registers are its.
const root   = (await context.wsRoot?.()) ?? context.paths.root
const report = runDone(root)

if (flag.json) {
  echo(JSON.stringify(report, null, 2))
  if (report.unfinished) process.exitCode = 1
  return
}

echo('')
if (!report.changed) {
  echo('  fli test:done — nothing changed against HEAD')
  echo('')
  return
}

echo(`  fli test:done — ${report.changed} file(s) changed · ${report.unfinished} unfinished\n`)
for (const item of report.items) {
  echo(`  ${item.ok ? '✓' : '✗'}  ${item.check.padEnd(15)} ${item.message}`)
}

if (report.drives.length) {
  // A row matched on the package alone says only that something in the package
  // changed, and a package the table names often matches most of its rows at once.
  const named = report.drives.filter(d => d.tier !== 'package')
  const loose = report.drives.filter(d => d.tier === 'package')
  echo('')
  echo('  run before calling it proved:')
  for (const d of named) {
    echo(`    ${d.changed}   (matched by ${d.tier}${d.on.length ? `: ${d.on.slice(0, 3).join(', ')}` : ''})`)
    for (const r of d.run) echo(`      ${r}`)
  }
  if (loose.length) {
    const pkgs = [...new Set(loose.flatMap(d => d.on))].join(', ')
    echo(`    + ${loose.length} row(s) that name only the package (${pkgs}) — \`fli proves\` lists them`)
  }
}
echo('')

if (report.unfinished) process.exitCode = 1
```

## What it grades

The steps that close a change out and fail in silence when skipped, asked of
`git diff HEAD` plus untracked files:

- **changes-entry** — every directory with a `CHANGES.md` that has a changed
  file under it gained a `## ` heading there.
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

Exit code 1 while anything is unfinished.
