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
---

<script>
import { existsSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'
import { homedir } from 'os'

const checkBin = (cmd) => {
  try { execSync(`which ${cmd}`, { stdio: 'pipe' }); return true }
  catch { return false }
}
</script>

Scans all `_module.md` files for `requires:` declarations and checks whether
each env var is set. Also verifies system binaries and FLI configuration.

```js
const { buildRegistry, getModule } = await import(resolve(global.fliRoot, 'core/registry.js'))
const { uniqueCommands }           = await import(resolve(global.fliRoot, 'core/registry.js'))

buildRegistry()

// ── Gather all namespaces with modules ───────────────────────────────────────
// Walk every unique command, collect distinct namespaces, check their module
const registry  = buildRegistry()
const all       = uniqueCommands(registry)
const namespaces = [...new Set(all.map(c => c.title.split(':')[0]))]
  .filter(ns => flag.namespace ? ns === flag.namespace : true)

let totalChecks = 0
let totalFail   = 0

echo('')
echo('  fli doctor\n')

// ── 1. System binaries ───────────────────────────────────────────────────────
const bins = [
  { name: 'bun',     required: true,  hint: 'https://bun.sh' },
  { name: 'git',     required: true,  hint: 'sudo apt install git' },
  { name: 'sqlite3', required: false, hint: 'sudo apt install sqlite3  (needed for db: commands)' },
  { name: 'zip',     required: false, hint: 'sudo apt install zip  (needed for utils:pack)' },
  { name: 'ssh',     required: false, hint: 'sudo apt install openssh-client' },
  { name: 'rsync',   required: false, hint: 'sudo apt install rsync  (needed for deploy:)' },
  { name: 'docker',  required: false, hint: 'https://docs.docker.com/engine/install/' },
]

echo('  system')
for (const b of bins) {
  totalChecks++
  const ok = checkBin(b.name)
  if (!ok) totalFail++
  const icon   = ok ? '✓' : b.required ? '✗' : '⚠'
  const suffix = ok ? '' : `  →  ${b.hint}`
  echo(`    ${icon}  ${b.name.padEnd(10)} ${ok ? 'found' : 'not found'}${suffix}`)
}

// ── 2. FLI config ────────────────────────────────────────────────────────────
echo('\n  fli config')

const fliRoot    = global.fliRoot
const globalEnv  = resolve(homedir(), '.config', 'fli', '.env')
const projectEnv = resolve(context.paths.root, '.env')
const guiPort    = process.env.FLI_PORT || '5000'

const checks = [
  { label: 'global env',    ok: existsSync(globalEnv),  hint: `run: fli config  to create ${globalEnv}` },
  { label: 'project .env',  ok: existsSync(projectEnv), hint: 'no .env in project root' },
  { label: 'fli root',      ok: existsSync(fliRoot),    hint: fliRoot },
]
for (const c of checks) {
  totalChecks++
  if (!c.ok) totalFail++
  echo(`    ${c.ok ? '✓' : '⚠'}  ${c.label.padEnd(14)} ${c.ok ? 'ok' : c.hint}`)
}

// ── 3. Namespace requires ────────────────────────────────────────────────────
echo('\n  namespace env vars')

let anyModule = false
for (const ns of namespaces) {
  const mod = getModule(ns)
  if (!mod?.meta?.requires?.length) continue
  anyModule = true

  const nsLabel = ns.padEnd(14)
  let nsOk = true

  for (const key of mod.meta.requires) {
    totalChecks++
    const val = process.env[key]
    const ok  = !!val
    if (!ok) { totalFail++; nsOk = false }
    const icon   = ok ? '✓' : '✗'
    const suffix = ok ? '' : `  →  fli eset ${key} <value> --global`
    echo(`    ${icon}  ${nsLabel} ${key}${suffix}`)
  }
}

if (!anyModule) {
  echo('    ·  no _module.md files found with requires:')
}

// ── 4. Summary ───────────────────────────────────────────────────────────────
const passed = totalChecks - totalFail
echo('')
echo(`  ─────────────────────────────────────────────`)

if (totalFail === 0) {
  log.success(`All ${totalChecks} checks passed`)
} else {
  log.warn(`${passed}/${totalChecks} checks passed  ·  ${totalFail} issue${totalFail !== 1 ? 's' : ''} found`)
  echo('')
  if (totalFail > 0) {
    echo('  To fix missing env vars:')
    echo('    fli config            ← open global env file in editor')
    echo('    fli eset KEY val --global  ← set a value directly')
  }
}
echo('')

if (flag.fix) {
  log.info('Opening global env file…')
  context.exec({ command: `${process.env.EDITOR || 'vi'} "${resolve(homedir(), '.config', 'fli', '.env')}"` })
}
```
