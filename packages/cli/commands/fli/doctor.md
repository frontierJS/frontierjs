---
title: fli:doctor
description: Check your FLI setup — env vars, dependencies, and namespace requirements
alias: doctor
examples:
  - fli doctor
  - fli doctor --install
  - fli doctor --fix
  - fli doctor --namespace github
flags:
  fix:
    char: f
    type: boolean
    description: Open the global env file to fix missing vars (runs fli config)
    defaultValue: false
  install:
    char: i
    type: boolean
    description: Run the install line of each missing tool, asking before each one; a URL is printed, never run
    defaultValue: false
  yes:
    type: boolean
    description: With --install, run every install line without asking
    defaultValue: false
  namespace:
    char: n
    type: string
    description: Check only a specific namespace
    defaultValue: ''
  probe:
    char: p
    type: boolean
    description: Also ask each external login (gh, npm, cf, claude) who it is signed in as
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Answer a machine
    defaultValue: false
---

<script>
import { resolve } from 'path'

// Each section of the report as a title and its finished rows, in print order.
const sections = ({ report, probe, chalk }) => {
  const icon    = { ok: chalk.green('✓'), warn: chalk.yellow('⚠'), error: chalk.red('✗') }
  const fix     = text => chalk.dim(`  →  ${text}`)
  const install = b => fix(b.why ? `${b.install}  (${b.why})` : b.install)
  const row     = (level, label, width, text) => `    ${icon[level]}  ${chalk.cyan(label.padEnd(width))} ${text}`
  return [
    { title: 'system',             lines: report.system.map(b => row(b.level, b.name, 10, `${b.status ?? (b.present ? 'found' : 'not found')}${b.ok ? '' : install(b)}`)) },
    { title: 'fli config',         lines: report.config.map(c => row(c.level, c.label, 14, c.ok ? chalk.dim('ok') : c.hint)) },
    { title: 'identity',           lines: report.identity.map(i => row(i.level, i.label, 14, i.ok ? chalk.dim(i.detail ?? 'set') : install(i))) },
    { title: 'namespace env vars', lines: report.namespaces.map(n => row(n.level, n.ns, 14, `${n.key}${n.ok ? '' : fix(n.fix)}`)), empty: 'no _module.md files found with requires:' },
    { title: 'profiles',           lines: report.profiles.map(p => row(p.level, p.label, 14, `${p.detail ?? (p.ok ? chalk.dim('ok') : '')}${p.ok ? '' : fix(p.hint)}`)) },
    { title: 'basecamps',          lines: report.basecamps.map(b => row(b.level, b.label, 14, b.ok ? chalk.dim('ok') : fix(b.hint))), empty: 'no basecamps.json' },
    { title: 'private files',      lines: report.secrets.map(f => row(f.level, f.label, 24, f.ok ? chalk.dim('ok') : fix(f.hint))), empty: 'none yet' },
    // A service the laptop does not use is a warning and not a fault, so these
    // rows never move the verdict.
    { title: 'services',           lines: report.services.map(s => row(s.level, s.id, 16, s.ok ? chalk.dim(serviceState(s)) : serviceState(s))),
      note: probe ? '' : chalk.dim('  (--probe asks each login who it is)') },
    { title: 'where fli keeps your files', lines: report.roots.map(r => `    ${chalk.cyan(r.name.padEnd(7))} ${r.path}  ${chalk.dim(r.holds)}`) },
  ]
}

const serviceState = s => s.probe
  ? (s.probe.ok ? `signed in${s.probe.who ? ' as ' + s.probe.who : ''}` : s.present ? 'login failed' : 'not installed')
  : s.present ? 'present' : s.kind === 'env' ? 'no key' : s.kind === 'cli' ? 'not installed' : 'none yet'

const printSection = ({ title, note = '', lines, empty }, { chalk, echo }) => {
  echo`
  {bold ${title}}${note}`
  echo.lines(lines.length ? lines : [empty && chalk.dim(`    · ${empty}`)])
}

const printVerdict = ({ report, installable, plural, chalk, echo }) => {
  echo`
  {dim ─────────────────────────────────────────────}`
  if (report.ok) return echo`  {green ✓} All ${plural(report.checks, 'check')} passed
`
  echo`  {yellow ⚠} ${report.checks - report.failed}/${report.checks} checks passed  {dim ·}  ${plural(report.failed, 'issue')} found`
  // What is MISSING and what STOPS you are different sentences: a machine with
  // no GITHUB_TOKEN cannot run github: and runs everything else.
  if (!report.blocked) echo`
  {dim Nothing here stops fli running — every required binary and path is present.}`
  echo`
  {bold To fix:}`
  echo.lines([
    installable && chalk`    fli doctor --install       {dim ← run each install line above, asking first}`,
    chalk`    fli config                 {dim ← open the global env file in your editor}`,
    chalk`    fli eset KEY val --global  {dim ← set a value directly}`,
    '',
  ])
}

// An install line is a sudo on the person's own machine, so each one is asked
// for by name, and a URL is only ever printed. keys() leaves raw mode on, and
// apt's prompt and sudo's password need it off, hence aside.
const installMissing = async ({ rows, yes, $, tty, log, chalk, echo }) => {
  const todo = rows.filter(b => !b.ok && b.runnable)
  const hand = rows.filter(b => !b.ok && !b.runnable)
  if (todo.length && !yes && !tty.interactive) {
    log.error('Pass --yes to install without a terminal to confirm on')
    process.exitCode = 1
    return
  }
  echo`  {bold install}
`
  const done = []
  for (const [i, b] of todo.entries()) {
    const answer = yes ? 'y' : await tty.keys(chalk`  {cyan ?} {bold Run} ${b.install}{bold ?}`, { n: 'skip', y: 'run', q: 'stop' })
    if (answer === 'q') { done.push(...todo.slice(i).map(b => ({ b, state: chalk.dim('not asked') }))); break }
    if (answer !== 'y') { done.push({ b, state: chalk.dim('skipped') }); continue }
    const out = await tty.aside(() => $.exec({ command: b.install, allowFailure: true }))
    const failed = out instanceof Error
    done.push({ b, ran: !failed && !$.flag.dry, state: $.flag.dry ? chalk.dim('dry run') : failed ? chalk.red(`failed, exit ${out.status}`) : chalk.green('ran') })
  }
  echo.lines([
    ...done.map(({ b, state }) => `    ${chalk.cyan(b.name.padEnd(10))} ${state}`),
    ...hand.map(b => `    ${chalk.cyan(b.name.padEnd(10))} ${chalk.dim('by hand  →  ' + b.install)}`),
    !todo.length && !hand.length && chalk.dim('    nothing is missing'),
    '',
    done.some(d => d.ran) && chalk.dim('  fli doctor again reads what is now found.\n'),
  ])
}
</script>

Scans all `_module.md` files for `requires:` declarations and checks whether
each env var is set. Also verifies system binaries and FLI configuration.
`--install` runs the install line of each missing binary — the one for the
package manager this machine has — asking before each.

```js
// The answer is `core/doctor.js`, which `fli gui` and Workbench ask as well;
// this is its rendering.
const { buildRegistry, uniqueCommands, getModule } = await import(resolve(global.fliRoot, 'core/registry.js'))
const { diagnose, requiringModules }               = await import(resolve(global.fliRoot, 'core/doctor.js'))
const { globalEnvPath }                            = await import(resolve(global.fliRoot, 'core/global-env.js'))
const { plural }                                   = await import(resolve(global.fliRoot, 'core/text.js'))

const modules = requiringModules({ commands: uniqueCommands(buildRegistry()), getModule })
  .filter(m => flag.namespace ? m.ns === flag.namespace : true)

const report = diagnose({
  root:    $.paths.root,
  fliRoot: global.fliRoot,
  modules,
  probe:   flag.probe,
  profile: global.fliProfile,
})

if (flag.json) {
  console.log(JSON.stringify(report, null, 2))
  return
}

echo`
  {bold fli doctor}`
for (const section of sections({ report, probe: flag.probe, chalk })) printSection(section, { chalk, echo })

const installable = report.system.some(b => !b.ok && b.runnable)
printVerdict({ report, installable: installable && !flag.install, plural, chalk, echo })

if (flag.install) await installMissing({ rows: report.system, yes: flag.yes, $, tty, log, chalk, echo })
if (flag.fix) await tty.aside(() => $.exec({ command: `${process.env.EDITOR || 'vi'} "${globalEnvPath()}"` }))
```
