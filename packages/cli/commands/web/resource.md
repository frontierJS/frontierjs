---
title: web:resource
description: Create a Sierra Resource in src/resources/ — the UI's half of the API boundary
examples:
  - fli web:resource Client
  - fli web:resource Invoice --open
  - fli web:resource Person --service people
args:
  -
    name: name
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
import { resolve } from 'path'

// One owner for what a generated Resource IS — `core/resource-template.js`,
// shared with `fli make:resource` and `fli make:scaffold`. Three commands wrote
// the same file three times and had already drifted (Invariant 4).
const { resourceFile, servicePlural } =
  await import(resolve(global.fliRoot, 'core/resource-template.js'))
</script>

Creates the Resource for one model — a `.mesa` file whose data half is `<script module>`. It is the
UI's half of the API boundary. A form is built **from** a Resource, and the
default one belongs in the same file: markup here is what a create or edit page
renders (invariant 18, `FJS-D112`). `fli make:route` builds the pages that
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
const filePath = resolve(context.paths.webResources, model + '.mesa')

if (flag.dry) {
  log.dry(`Would create: ${filePath}`)
  return
}

if (existsSync(filePath)) {
  log.error(`${filePath} already exists — edit it directly`)
  return
}

mkdirSync(context.paths.webResources, { recursive: true })
writeFileSync(filePath, resourceFile(model, service), 'utf8')
log.success(`Created ${filePath}`)

echo('')
echo(`  Import it from a route with a relative path — Sierra has no @/ alias:`)
echo(`    import { ${service} } from '../../resources/${model}.mesa'`)
echo('')
echo(`  It calls the '${service}' service, so api/src/services/${service}.service.ts must register it.`)
echo('')

if (flag.open) { const e = process.env.EDITOR || 'vi'; context.exec({ command: `${e} "${filePath}"` }) }
```
