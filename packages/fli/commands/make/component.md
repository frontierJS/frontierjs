---
title: make:component
description: Create a new Svelte component in src/components/
alias: mkc
examples:
  - fli make:component Button
  - fli mkc forms/Input --open
  - fli make:component Modal
args:
  -
    name: name
    description: Component name or path (e.g. Button or forms/Input)
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
import { resolve, dirname } from 'path'
</script>

```js
const file     = arg.name.endsWith('.svelte') ? arg.name : arg.name + '.svelte'
const dirPath  = resolve(context.paths.webComponents, dirname(file))
const filePath = resolve(context.paths.webComponents, file)

if (flag.dry) { log.dry(`Would create: ${filePath}`); return }

mkdirSync(dirPath, { recursive: true })
writeFileSync(filePath, '', 'utf8')
log.success(`Created ${filePath}`)
if (flag.open) { const e = process.env.EDITOR||'vi'; context.exec({ command: `${e} "${filePath}"` }) }
```
