---
title: make:factory
description: Scaffold a test factory for a model — db/factories/<Model>Factory.js
alias: mkfactory
examples:
  - fli mkfactory Lead
  - fli mkfactory Invoice --traits paid,overdue
  - fli mkfactory Product --open
args:
  -
    name: model
    description: Model name (PascalCase and singular, as schema.lite declares it)
    required: true
flags:
  traits:
    char: t
    type: string
    description: Comma-separated trait names to stub out (e.g. admin,archived)
    defaultValue: ''
  force:
    char: f
    type: boolean
    description: Overwrite an existing factory file
    defaultValue: false
  open:
    char: o
    type: boolean
    description: Open the created file in editor
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const accessorOf = (model) => model.charAt(0).toLowerCase() + model.slice(1)

// ─── The factory file ─────────────────────────────────────────────────────────
// defineFactory over the class form: everything is known at definition time, so
// there is no subclass ceremony and no instance-field ordering to think about.
//
// The definition is deliberately thin. `autoFactories` already derives a valid
// row from the schema — a hand-written factory exists to say the things the
// schema cannot: which values a test wants to READ, and which states matter.

const makeFactoryFile = (model, traits) => {
  const accessor = accessorOf(model)
  const traitBlock = traits.length
    ? `\n  traits: {\n${traits.map(t => `    ${t}: { /* ${t} state — the fields that make it ${t} */ },`).join('\n')}\n  },\n`
    : ''

  return `// db/factories/${model}Factory.js — test data for \`${model}\`.
//
// Registered by name, keyed by ACCESSOR (db.${accessor} → factories.${accessor}):
//
//   import { makeTestClient } from '@frontierjs/litestone/testing'
//   import { ${model}Factory } from '../db/factories/${model}Factory.js'
//
//   const { db, factories } = await makeTestClient(schemaText, {
//     seed: 42,
//     autoFactories: true,                 // everything else, derived
//     factories: { ${accessor}: ${model}Factory },   // this one, by hand
//   })
//
// Relations are not listed here — the schema already declares them:
//
//   factories.${accessor}.withParents().createOne()   // every required parent
//   factories.${accessor}.has('children', 3).createOne()
//   factories.${accessor}.asSystem().createOne()      // past @@gate
import { defineFactory } from '@frontierjs/litestone'

export const ${model}Factory = defineFactory({
  model: '${model}',

  // (seq, rng) → row. seq increments per build; rng is seeded when the caller
  // passed \`seed:\`, and is null otherwise — so guard anything random.
  //
  // Only name the fields a test asserts on. Everything omitted still gets a
  // schema-valid value.
  definition: (seq, rng) => ({
    // name: \`${model} \${seq}\`,
  }),
${traitBlock}
  // afterCreate: async (row, db) => {
  //   // rows that must exist alongside this one, but are not a relation
  // },
})
`
}
</script>

Writes a `defineFactory` stub for one model into `db/factories/`.

You usually do not need this. `makeTestClient({ autoFactories: true })` derives a
working factory for every model straight from `schema.lite`, including values that
satisfy `@email`, `@length`, `@regex` and numeric bounds. Reach for a hand-written
factory when a test needs to *assert* on specific values, or when a model has
states worth naming as traits.

```js
const model    = arg.model.charAt(0).toUpperCase() + arg.model.slice(1)
const traits   = String(flag.traits || '')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean)

// ─── Check the model exists ──────────────────────────────────────────────────
// A factory for a model the schema does not declare fails at createOne() with
// "model not found", far from here. Catch it now.

const schemaPath = resolve(context.paths.db, 'schema.lite')

if (existsSync(schemaPath)) {
  const schemaText = readFileSync(schemaPath, 'utf8')
  const declared   = new RegExp(`^\\s*model\\s+${model}\\s*\\{`, 'm').test(schemaText)
  if (!declared) {
    log.error(`schema.lite declares no model "${model}"`)
    log.info('Model names are PascalCase singular. Create it first: fli make:model ' + model)
    return
  }
} else {
  log.warn(`schema.lite not found at ${schemaPath} — writing the factory anyway`)
}

// ─── Write ───────────────────────────────────────────────────────────────────

const dir  = resolve(context.paths.db, 'factories')
const file = resolve(dir, `${model}Factory.js`)

if (existsSync(file) && !flag.force) {
  log.error(`${file} already exists`)
  log.info('Pass --force to overwrite')
  return
}

mkdirSync(dir, { recursive: true })
writeFileSync(file, makeFactoryFile(model, traits))

log.success(`Created db/factories/${model}Factory.js`)
if (traits.length) log.info(`Traits stubbed: ${traits.join(', ')}`)
log.info(`Use it: makeTestClient(schema, { factories: { ${accessorOf(model)}: ${model}Factory } })`)

if (flag.open) {
  const editor = process.env.EDITOR || 'vi'
  await $`${editor} ${file}`
}
```
