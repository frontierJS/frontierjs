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

// Model → service name. Regular English plurals only — the same three rules
// Sierra's schema registry applies in the other direction. Irregulars are not
// guessed anywhere in this framework; pass --service for those.
const servicePlural = (model) => {
  const a = model.charAt(0).toLowerCase() + model.slice(1)
  if (/[^aeiou]y$/.test(a))     return a.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/.test(a)) return a + 'es'
  return a + 's'
}

const makeResource = (model, service) => `<script module>
// src/resources/${service}.mesa — the Resource layer.
//
// A Resource is a UI-realm noun, so it is a .mesa file (repo invariant 18).
// There is no markup: everything lives in <script module>, which runs once at
// import and whose named exports any other module can import.
//
// Read this next to db/schema.lite. Nothing here restates anything there: no
// field list, no types, no enum values, no required list, no relations. A
// resource names a service and turns three flags on; everything a form needs is
// read back off it at runtime as \`fields\`, \`relations\` and \`gate\`.

import { createResource } from '@frontierjs/sierra/junction'

export const ${service} = createResource('${service}', {
  // Stated rather than inferred, so an irregular plural cannot quietly resolve
  // to nothing.
  model: '${model}',

  // Every DOM control hands back a string — \`<input type="number">\` and
  // \`<select>\` included. The schema is the only thing that knows the column is
  // an Int, so it does the casting. Without this a form bound to make() sends
  // "42" for a Float and is told it is not a number.
  coerce: true,

  // An empty text box submits '', which SQLite does not agree is NULL: a
  // \`String? @unique\` column takes any number of NULLs and rejects the second
  // ''. Rewrite blanks on nullable fields on the way out.
  blankToNull: true,

  // Check the record against the schema before the request rather than
  // round-tripping to be told the same thing. The server validates regardless —
  // this only moves the first "no" closer to the user.
  validate: true,
})
</script>
`
</script>

Creates the Resource for one model — a `.mesa` file with no markup, its code in `<script module>`. It is the
UI's half of the API boundary: forms are built **from** a Resource and are not
one. `fli make:route` builds the pages that consume it.

The file names a service and a model and nothing else. `resource.fields`,
`.relations` and `.gate` are read off the registered schema at runtime, so a
column added to `schema.lite` later needs no change here.

```js
const model   = arg.name.replace(/\.(mesa|js)$/, '')
const service = flag.service || servicePlural(model)

if (!/^[A-Z]/.test(model)) {
  log.warn(`Model names are PascalCase and singular — got '${model}'. Continuing anyway.`)
}

const filePath = resolve(context.paths.webResources, service + '.mesa')

if (flag.dry) {
  log.dry(`Would create: ${filePath}`)
  return
}

if (existsSync(filePath)) {
  log.error(`${filePath} already exists — edit it directly`)
  return
}

mkdirSync(context.paths.webResources, { recursive: true })
writeFileSync(filePath, makeResource(model, service), 'utf8')
log.success(`Created ${filePath}`)

echo('')
echo(`  Import it from a route with a relative path — Sierra has no @/ alias:`)
echo(`    import { ${service} } from '../../resources/${service}.mesa'`)
echo('')
echo(`  It calls the '${service}' service, so api/src/services/${service}.service.ts must register it.`)
echo('')

if (flag.open) { const e = process.env.EDITOR || 'vi'; context.exec({ command: `${e} "${filePath}"` }) }
```
