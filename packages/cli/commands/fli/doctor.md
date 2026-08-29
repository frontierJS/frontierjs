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
  root:    context.paths.root,
  fliRoot: global.fliRoot,
  modules,
  home:    homedir(),
})

if (flag.json) {
  console.log(JSON.stringify(report, null, 2))
  return
}

const ICON = { ok: '\u2713', warn: '\u26a0', error: '\u2717' }

echo('')
echo('  fli doctor\n')

echo('  system')
for (const b of report.system) {
  echo(`    ${ICON[b.level]}  ${b.name.padEnd(10)} ${b.ok ? 'found' : 'not found'}${b.ok ? '' : `  \u2192  ${b.hint}`}`)
}

echo('\n  fli config')
for (const c of report.config) {
  echo(`    ${ICON[c.level]}  ${c.label.padEnd(14)} ${c.ok ? 'ok' : c.hint}`)
}

echo('\n  namespace env vars')
if (!report.namespaces.length) echo('    \u00b7  no _module.md files found with requires:')
for (const n of report.namespaces) {
  echo(`    ${ICON[n.level]}  ${n.ns.padEnd(14)} ${n.key}${n.ok ? '' : `  \u2192  ${n.fix}`}`)
}

echo('')
echo('  ' + '\u2500'.repeat(45))

if (report.ok) {
  log.success(`All ${report.checks} checks passed`)
} else {
  log.warn(`${report.checks - report.failed}/${report.checks} checks passed  \u00b7  ${report.failed} issue${report.failed !== 1 ? 's' : ''} found`)
  // What is MISSING and what STOPS you are different sentences: a machine with
  // no CLOUDFLARE_TOKEN cannot run `cloudflare:` and runs everything else.
  if (!report.blocked) echo('\n  Nothing here stops fli running \u2014 every required binary and path is present.')
  echo('')
  echo('  To fix missing env vars:')
  echo('    fli config            \u2190 open global env file in editor')
  echo('    fli eset KEY val --global  \u2190 set a value directly')
}
echo('')

if (flag.fix) {
  log.info('Opening global env file\u2026')
  context.exec({ command: `${process.env.EDITOR || 'vi'} "${resolve(homedir(), '.config', 'fli', '.env')}"` })
}
```
