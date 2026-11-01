---
title: fli:doctor
description: Check your FLI setup — env vars, dependencies, and namespace requirements
alias: doctor
examples:
  - fli doctor
  - fli doctor --fix
  - fli doctor --namespace github
flags:
  fix:
    char: f
    type: boolean
    description: Open the global env file to fix missing vars (runs fli config)
    defaultValue: false
  namespace:
    char: n
    type: string
    description: Check only a specific namespace
    defaultValue: ''
  json:
    char: j
    type: boolean
    description: Answer a machine
    defaultValue: false
---

<script>
import { resolve } from 'path'
import { homedir } from 'os'
</script>

Scans all `_module.md` files for `requires:` declarations and checks whether
each env var is set. Also verifies system binaries and FLI configuration.

```js
// The ANSWER is `core/doctor.js` and this is the rendering of it. It used to be
// a hundred lines of logic interleaved with the `echo`s that printed it, so the
// only way to ask was to run the command and read a terminal — and `fli gui`'s
// front page, the second caller, could not ask at all.
const { buildRegistry, uniqueCommands, getModule } = await import(resolve(global.fliRoot, 'core/registry.js'))
const { diagnose, requiringModules }               = await import(resolve(global.fliRoot, 'core/doctor.js'))

const modules = requiringModules({ commands: uniqueCommands(buildRegistry()), getModule })
  .filter(m => flag.namespace ? m.ns === flag.namespace : true)

const report = diagnose({
  root:    $.paths.root,
  fliRoot: global.fliRoot,
  modules,
  home:    homedir(),
})

if (flag.json) {
  console.log(JSON.stringify(report, null, 2))
  return
}

const ICON = {
  ok:    chalk.green('\u2713'),
  warn:  chalk.yellow('\u26a0'),
  error: chalk.red('\u2717'),
}
const hint = text => chalk.dim(`  \u2192  ${text}`)

echo('')
echo(chalk`  {bold fli doctor}\n`)

echo(chalk`  {bold system}`)
for (const b of report.system) {
  const state = b.status ?? (b.present ? 'found' : 'not found')
  echo(`    ${ICON[b.level]}  ${chalk.cyan(b.name.padEnd(10))} ${state}${b.ok ? '' : hint(b.hint)}`)
}

echo(chalk`\n  {bold fli config}`)
for (const c of report.config) {
  echo(`    ${ICON[c.level]}  ${chalk.cyan(c.label.padEnd(14))} ${c.ok ? chalk.dim('ok') : c.hint}`)
}

echo(chalk`\n  {bold namespace env vars}`)
if (!report.namespaces.length) echo(chalk.dim('    \u00b7  no _module.md files found with requires:'))
for (const n of report.namespaces) {
  echo(`    ${ICON[n.level]}  ${chalk.cyan(n.ns.padEnd(14))} ${n.key}${n.ok ? '' : hint(n.fix)}`)
}

echo('')
echo(chalk.dim('  ' + '\u2500'.repeat(45)))

if (report.ok) {
  log.success(`All ${report.checks} checks passed`)
} else {
  log.warn(`${report.checks - report.failed}/${report.checks} checks passed  \u00b7  ${report.failed} issue${report.failed !== 1 ? 's' : ''} found`)
  // What is MISSING and what STOPS you are different sentences: a machine with
  // no GITHUB_TOKEN cannot run `github:` and runs everything else.
  if (!report.blocked) echo(chalk.dim('\n  Nothing here stops fli running \u2014 every required binary and path is present.'))
  echo(chalk`
  {bold To fix missing env vars:}
    fli config            {dim \u2190 open global env file in editor}
    fli eset KEY val --global  {dim \u2190 set a value directly}`)
}
echo('')

if (flag.fix) {
  log.info('Opening global env file\u2026')
  $.exec({ command: `${process.env.EDITOR || 'vi'} "${resolve(homedir(), '.config', 'fli', '.env')}"` })
}
```
