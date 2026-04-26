---
title: web:component
description: Create a new Svelte component in src/components/
examples:
  - fli web:component Button
  - fli web:component forms/Input --open
  - fli make-component Modal
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

if (flag.dry) {
  log.dry(`Would create: ${filePath}`)
  return
}

mkdirSync(dirPath, { recursive: true })
writeFileSync(filePath, '', 'utf8')
log.success(`Created ${filePath}`)

if (flag.open) {
  const editor = process.env.EDITOR || 'vi'
  context.exec({ command: `${editor} "${filePath}"` })
}
```
