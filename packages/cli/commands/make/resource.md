---
title: make:resource
description: Create a Sierra Resource in src/resources/ — the UI's half of the API boundary
alias: mkresource
examples:
  - fli make:resource Client
  - fli mkresource Invoice --open
  - fli make:resource Person --service people
args:
  -
    name: name
    kind: model
    description: Model name (PascalCase and singular, as in schema.lite)
    required: true
flags:
  service:
    char: s
    type: string
    description: Service name, when it is not the regular plural of the model (e.g. Person → people)
    defaultValue: ''
  open:
    char: o
    type: boolean
    description: Open the file in editor after creating
    defaultValue: false
---

<script>
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { resolve, basename } from 'path'

// One owner for what a generated Resource IS — `core/resource-template.js`,
// shared with `fli make:scaffold` (Invariant 4).
const { resourceFile, servicePlural, resourceService } =
  await import(resolve(global.fliRoot, 'core/resource-template.js'))

// The Resource calls `service` by name and nothing else checks it is registered,
// so a hand-named service file leaves the page on a 404 until the screen loads
// (`FJS-3919`). The line names the file that answers, or the way to get one.
const announceService = ({ $, log, echo, chalk }, service, model) => {
  const { file, others } = resourceService(resolve($.paths.api, 'src/services'), service, model)
  if (file) {
    echo(chalk.dim(`  It calls the '${service}' service, served by api/src/services/${basename(file)}.`))
  } else {
    log.warn(`There is no service named '${service}' — the Resource would call a 404.`)
    for (const o of others) {
      log.warn(`${o.file} serves ${model} as '${o.name}' — rerun with --service ${o.name}`)
    }
    if (!others.length) log.warn(`Create it with: fli make:service ${model}`)
  }
  echo('')
}
</script>

Creates the Resource for one model — a `.mesa` file whose data half is `<script module>`. It is the
UI's half of the API boundary. A form is built **from** a Resource, and the
default one belongs in the same file: markup here is what a create or edit page
renders. `fli make:route` builds the pages that
consume it.

The file names a service and a model and nothing else. `resource.fields`,
`.relations` and `.gate` are read off the registered schema at runtime, so a
column added to `schema.lite` later needs no change here.

```js
const model   = arg.name.replace(/\.(mesa|js)$/, '')
const service = flag.service || servicePlural(model)

if (!/^[A-Z]/.test(model)) {
  log.warn(`Model names are PascalCase and singular — got '${model}'. Continuing anyway.`)
}

// The file is named for the MODEL and the export is named for the SERVICE
// (repo invariant 19) — the same split the Data realm makes between
// `model Order` and `db.order`. Naming the file for the service put every
// irregular plural in a place nothing reads, and `fli check`'s own
// `resource-file-name` rule refused what this command had just written.
const filePath = resolve($.paths.webResources, model + '.mesa')

if (flag.dry) {
  log.dry(`Would create: ${filePath}`)
  return
}

if (existsSync(filePath)) {
  log.error(`${filePath} already exists — edit it directly`)
  return
}

mkdirSync($.paths.webResources, { recursive: true })
writeFileSync(filePath, resourceFile(model, service), 'utf8')
log.done(`Created ${filePath}`)

echo('')
echo(chalk.dim(`  Import it from a route through the @/ alias, which is the surface's src/:`))
echo(chalk.cyan(`    import { ${service} } from '@/resources/${model}.mesa'`))
echo('')
announceService({ $, log, echo, chalk }, service, model)

if (flag.open) { const e = process.env.EDITOR || 'vi'; $.exec({ command: `${e} "${filePath}"` }) }
```
