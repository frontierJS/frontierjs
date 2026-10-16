---
title: register:repro
description: "Measure an env: timing row — the test it links run alone, in its package's suite and under load, N times each — and write the verdict into the row"
alias: repro
examples:
  - fli repro FJS-1172
  - fli repro FJS-3015 --runs 3
  - fli repro FJS-2872 --load 4
args:
  -
    name: id
    description: The issue's id, as ISSUES.md writes it
    required: true
flags:
  runs:
    char: n
    type: number
    min: 1
    description: Runs per cell — the same N for all three
    defaultValue: 9
  load:
    char: l
    type: number
    min: 1
    description: Copies of junction's bun run typecheck beside the loaded cell — the default fills the cores (FJS-D1148)
---

```js
const { runRepro, reproVerdict, defaultLoad } = await import(resolve(global.fliRoot, 'core/repro.js'))
const { findRegisterRoot }                    = await import(resolve(global.fliRoot, 'core/registers.js'))
const { amendIssue }                          = await import(resolve(global.fliRoot, 'core/amend.js'))

const root = findRegisterRoot(process.cwd()) ?? $.paths.root
const load = flag.load || defaultLoad()

echo('')
const out = await runRepro({
  root, id: arg.id, runs: flag.runs, load,
  onCell: (c) => echo(chalk`  {bold ${c.label}}` + (c.loadAtStart == null ? '' : chalk`  {dim load ${c.loadAtStart.toFixed(1)}}`)),
  onRun:  (r) => echo(r.pass
    ? chalk`    {green ✓} run ${r.run}`
    : chalk`    {red ✗} run ${r.run}  {dim ${r.failures.map(f => `${f.name} — ${f.message}`).join(' · ').slice(0, 160)}}`),
})

if (out.target) echo(chalk`\n  {bold ${out.target.id}}  {dim ${out.target.file}}`)
for (const c of out.cells ?? []) echo(`    ${String(`${c.pass}/${c.runs}`).padStart(5)}  ${c.label}`)

if (!out.ok) {
  echo(`\n  ✗ ${out.reason} — nothing written to the row\n`)
  process.exitCode = 1
  return
}

const verdict = reproVerdict(out.cells)
echo('')
echo(verdict.code
  ? '  code — it fails on a quiet machine, alone or in its own suite; env: timing comes off so the loop sees it again'
  : verdict.reproduced
    ? '  environment — clean alone and in the suite, failing only under load; env: timing stays'
    : '  did not reproduce — clean in all three cells; the counts are recorded and env: timing stays')

if (flag.dry) {
  echo(chalk`  {dim --dry: would append} ${verdict.segment}\n`)
  return
}
const wrote = amendIssue({ root, id: out.target.id, detail: verdict.segment, drop: verdict.code ? 'env: timing' : null })
if (!wrote.ok) {
  echo(`  ✗ ${wrote.reason}\n`)
  process.exitCode = 1
  return
}
echo(`  ✓ ${wrote.id} amended — ${wrote.file}:${wrote.line}  ${verdict.segment}`)
if (verdict.code) echo(wrote.dropped ? '    env: timing removed' : '    the row named no env: timing to remove')
echo('')
```

## What it measures

An `env: timing` row is a guessed cause until the test it names has run on a
quiet machine. Three cells of N runs, in order, each a fresh process:

```
alone                  the file by itself
in suite               the package's own bun run test, the file's result read out of it
under N typechecks     the file by itself beside N of junction's bun run typecheck
```

Fails alone, or passes alone and fails in the suite, is code — a test leaking
state into the next file is test code (`FJS-D1146`) — and the loaded cell is
not run. Passes both and fails loaded is the environment. The first two cells
assume a quiet machine, and the 1-minute load average each starts at is printed
beside it.

## What it writes

The counts, appended to the row's Detail through `register:amend` — one
` · ` part per cell run:

```
repro: 9/9 alone · 3/9 in suite                                  code: env: timing removed
repro: 9/9 alone · 9/9 in suite · 4/9 under 7 typechecks         environment: tag kept
repro: 9/9 alone · 9/9 in suite · 9/9 under 7 typechecks         did not reproduce: tag kept
```

A code verdict strips `env: timing` in the same write, because a test failing
on a quiet machine is one the loop should see again. A refused run writes
nothing, and `--dry` prints the segment without writing it.

A file's result is read from bun's junit report, because bun's console prints
a file only when it printed something. A run whose report does not name the
file refuses the whole measurement, and so does a load whose typecheck exits
nonzero. A row linking a drive or a spec, no test file, or several, is refused
by name.
