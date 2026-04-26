---
title: fli:init
description: Scaffold cli/src/routes/ in the current project
alias: init
examples:
  - fli init
  - fli init --namespace myapp
  - fli init --dry
flags:
  namespace:
    char: n
    type: string
    description: Namespace for the sample command (overrides .fli.json defaultNamespace)
    defaultValue: ''
---

<script>
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'

// Build the sample command file content
const sampleCommand = (namespace) => {
  const fence = '`'.repeat(3)
  const scriptClose = '</' + 'script>'
  return [
    '---',
    `title: ${namespace}:hello`,
    `description: A sample ${namespace} command`,
    `alias: hello`,
    'examples:',
    `  - fli ${namespace}:hello`,
    `  - fli ${namespace}:hello --name World`,
    'flags:',
    '  name:',
    '    char: n',
    '    type: string',
    '    description: Name to greet',
    '    defaultValue: World',
    '---',
    '',
    '<script>',
    '// Add helper functions here',
    scriptClose,
    '',
    fence + 'js',
    `log.info(\`Hello from ${namespace}!\`)`,
    `echo(\`Hello, \${flag.name}!\`)`,
    fence,
    '',
  ].join('\n')
}
</script>

Scaffold `cli/src/routes/` in the current project and create a sample command.
Run this once when adding FLI to an existing project.

```js
const { getConfig } = await import(resolve(global.fliRoot, 'core/config.js'))
const { routesDir: ROUTES_DIR, defaultNamespace } = getConfig()
const projectRoot = context.paths.root
const ns          = flag.namespace || defaultNamespace
const routesDir   = resolve(projectRoot, ROUTES_DIR)
const nsDir       = resolve(routesDir, ns)
const sampleFile  = resolve(nsDir, 'hello.md')

// ─── Check if already initialised ────────────────────────────────────────────
if (existsSync(routesDir) && !flag.dry) {
  log.warn(`${ROUTES_DIR} already exists at ${projectRoot}`)
  log.info('Add commands manually or use: fli make:command')
  return
}

// ─── Show plan ────────────────────────────────────────────────────────────────
log.info(`Initialising FLI in: ${projectRoot}`)
log.dry(`  create  ${ROUTES_DIR}/${ns}/hello.md`)

if (flag.dry) {
  log.dry('Dry run — nothing written')
  return
}

// ─── Create directory and sample command ─────────────────────────────────────
mkdirSync(nsDir, { recursive: true })
writeFileSync(sampleFile, sampleCommand(ns), 'utf8')

log.success(`Created ${ROUTES_DIR}/${ns}/hello.md`)
echo('')
echo(`Next steps:`)
echo(`  fli list                        — see all available commands`)
echo(`  fli ${ns}:hello     — run your sample command`)
echo(`  fli make:command                — scaffold a new command`)
echo(`  fli edit ${ns}:hello — edit the sample command`)
```
