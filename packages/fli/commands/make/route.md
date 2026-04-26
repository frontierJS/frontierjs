---
title: make:route
description: Scaffold a Svelte route — optionally with a matching resource and component
alias: mkroute
examples:
  - fli mkroute users/edit
  - fli mkroute users/[user]
  - fli mkroute invoices --resource
  - fli mkroute invoices/[id] --resource --component InvoiceCard --open
args:
  -
    name: path
    description: Route path relative to src/routes/ (e.g. users/edit or users/[user])
    required: true
flags:
  resource:
    char: r
    type: boolean
    description: Also scaffold a matching resource component in src/resources/
    defaultValue: false
  component:
    char: c
    type: string
    description: Also scaffold a named component in src/components/
    defaultValue: ''
  open:
    char: o
    type: boolean
    description: Open all created files in editor after scaffolding
    defaultValue: false
---

<script>
import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname, basename } from 'path'

const makeRouteFile = (name) => `<script>
  import { title } from '@/core/app'
  $title = '${name}'
<\/script>
`

const makeResourceFile = (name) => {
  const lower  = name.toLowerCase()
  const plural  = lower + 's'
  const idField = lower + 'Id'
  const sc = '</' + 'script>'
  return `<script context='module'>
  import { resource } from '@/core/frontier'
  export { store, service, make }
  const { store, service, make } = resource.createResource({ model: '${name}', service: '${plural}' })
${sc}

<script>
  import { setContext } from 'svelte'
  import { useForm } from '@/components/Forms/Form.svelte'
  import { back, goto } from '@/core/router'

  export let ${lower} = make()
  setContext('resource', ${lower})
  let { form, status, errors } = useForm({
    submit: async () => { await service.upsert(${lower}); $goto('/${plural}/[${ idField }]', { ${idField}: ${lower}.id }) },
    reset: () => $back(),
  })
${sc}

<form use:form={${lower}}>
  <fieldset class='space-y-4'></fieldset>
  <footer>
    <button class='btn' type='submit'>{$status || 'Save'}</button>
    <button type='reset' class='btn secondary'>Back</button>
  </footer>
</form>
`
}

const makeComponentFile = () => ``
</script>

```js
const created = []
const editor  = process.env.EDITOR || 'vi'

// ─── 1. Route file ────────────────────────────────────────────────────────────
const file      = arg.path.endsWith('.svelte') ? arg.path : arg.path + '.svelte'
const dirPath   = resolve(context.paths.webPages, dirname(file))
const routePath = resolve(context.paths.webPages, file)
const name      = basename(file, '.svelte').replace(/[\[\]]/g, '')
const display   = name.charAt(0).toUpperCase() + name.slice(1)

if (flag.dry) {
  log.dry(`Would create route:     ${routePath}`)
} else {
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(routePath, makeRouteFile(display), 'utf8')
  log.success(`Created route:     ${routePath}`)
  created.push(routePath)
}

// ─── 2. Resource component ────────────────────────────────────────────────────
if (flag.resource) {
  if (!context.paths.webResources) {
    log.warn('webResources path not configured — skipping --resource')
  } else {
    const resourcePath = resolve(context.paths.webResources, display + '.svelte')
    if (flag.dry) {
      log.dry(`Would create resource:  ${resourcePath}`)
    } else {
      mkdirSync(context.paths.webResources, { recursive: true })
      writeFileSync(resourcePath, makeResourceFile(display), 'utf8')
      log.success(`Created resource:  ${resourcePath}`)
      created.push(resourcePath)
    }
  }
}

// ─── 3. Named component ───────────────────────────────────────────────────────
if (flag.component) {
  const cname = flag.component.endsWith('.svelte') ? flag.component : flag.component + '.svelte'
  const compPath = resolve(context.paths.webComponents, cname)
  if (flag.dry) {
    log.dry(`Would create component: ${compPath}`)
  } else {
    mkdirSync(dirname(compPath), { recursive: true })
    writeFileSync(compPath, makeComponentFile(), 'utf8')
    log.success(`Created component: ${compPath}`)
    created.push(compPath)
  }
}

// ─── Open files ───────────────────────────────────────────────────────────────
if (flag.open && created.length && !flag.dry) {
  for (const f of created) context.exec({ command: `${editor} "${f}"` })
}
```
