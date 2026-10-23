---
title: utils:plan
description: A plan read off its boxes — the first open step and what blocks it, one line a phase; --all for every step
alias: plan
examples:
  - fli plan IDEAS/haven.md
  - fli plan IDEAS/shipped/workbench-plans.md --all
  - fli plan PLAN.md --json
args:
  -
    name: file
    kind: path
    description: The plan — a `PLAN.md`, an `IDEAS/` paper, any file holding `### Phase N` headings
flags:
  all:
    char: a
    type: boolean
    description: Print every phase, step and finding, not just the next step
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Print the parsed plan as JSON
    defaultValue: false
---

The shape is `doc-hygiene` § A plan's shape (`FJS-D927`): the next step is
the first open box, and nothing else in the file says where the plan is. A
plan is read to find that box, so the default prints it alone — a hundred
finished steps with their findings are `--all` (`FJS-3461`).

```js
const { existsSync, readFileSync }           = await import('node:fs')
const { resolve }                            = await import('node:path')
const { parsePlan, renderPlan, renderNext, reissued } = await import(resolve(global.fliRoot, 'core/plan.js'))

const file = resolve(process.cwd(), String(arg.file ?? ''))
if (!arg.file || !existsSync(file)) {
  log.error(`no plan at ${arg.file ?? '(no file given)'}`)
  process.exitCode = 1
  return
}

const plan  = parsePlan(readFileSync(file, 'utf8'), { file: arg.file })
const twice = reissued(plan)

if (flag.json) {
  echo(JSON.stringify({ ...plan, reissued: twice }, null, 2))
  return
}

if (!plan.phases.length) {
  log.warn(`${arg.file} holds no \`### Phase N\` heading — not a plan in the ruled shape`)
  process.exitCode = 1
  return
}

echo('')
echo.lines((flag.all ? renderPlan : renderNext)(plan, chalk))
for (const id of twice) log.warn(`step ${id} is issued twice — a number is a citation key, issued once`)
```
