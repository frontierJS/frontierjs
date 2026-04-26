---
title: make:resource
description: Create a Svelte resource component in src/resources/
alias: mkresource
examples:
  - fli make:resource Client
  - fli mkresource Invoice --open
args:
  -
    name: name
    description: Resource name (PascalCase)
    required: true
flags:
  open:
    char: o
    type: boolean
    description: Open the file in editor after creating
    defaultValue: false
---

<script>
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const makeResource = (name) => {
  const lower   = name.toLowerCase()
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
  import Input from '@/components/Forms/Input.svelte'
  import { useForm } from '@/components/Forms/Form.svelte'
  import { back, goto } from '@/core/router'

  export let ${lower} = make()
  setContext('resource', ${lower})

  let { form, status, errors } = useForm({
    submit: async () => { await service.upsert(${lower}); $goto('/${plural}/[${idField}]', { ${idField}: ${lower}.id }) },
    reset: () => $back(),
    afterChange: () => ($errors = {}),
    afterFinish: () => $errors ? '' : (${lower} = make()),
  })
${sc}

<form id='${lower}-form' use:form={${lower}}>
  <fieldset class='space-y-4'>
    <Input bind:value={${lower}.id} />
  </fieldset>
  <footer>
    <button class='btn' type='submit'>{$status || 'Save'}</button>
    <button type='reset' class='btn secondary'>Back</button>
  </footer>
</form>
`
}
</script>

```js
const name     = arg.name.replace(/\.svelte$/, '')
const filePath = resolve(context.paths.webResources, name + '.svelte')

if (flag.dry) { log.dry(`Would create: ${filePath}`); return }

mkdirSync(context.paths.webResources, { recursive: true })
writeFileSync(filePath, makeResource(name), 'utf8')
log.success(`Created ${filePath}`)
if (flag.open) { const e = process.env.EDITOR||'vi'; context.exec({ command: `${e} "${filePath}"` }) }
```
