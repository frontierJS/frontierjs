---
title: web:route
description: Create a new Svelte route — alias for make:route
examples:
  - fli web:route users/edit
  - fli make-route users/[user]
  - fli web:route dashboard --open
args:
  -
    name: path
    description: Route path (e.g. users/edit or users/[user])
    required: true
flags:
  open:
    char: o
    type: boolean
    description: Open the file in editor after creating
    defaultValue: false
---

<script>
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname, basename } from 'path'

const makeRoute = (name) => `<script>
  import { title } from '@/core/app'
  $title = '${name}'
<\/script>
`
</script>

```js
const file    = arg.path.endsWith('.svelte') ? arg.path : arg.path + '.svelte'
const dirPath = resolve(context.paths.webPages, dirname(file))
const filePath = resolve(context.paths.webPages, file)

const name = basename(file, '.svelte').replace(/[\[\]]/g, '')
const displayName = name.charAt(0).toUpperCase() + name.slice(1)

if (flag.dry) {
  log.dry(`Would create: ${filePath}`)
  return
}

mkdirSync(dirPath, { recursive: true })
writeFileSync(filePath, makeRoute(displayName), 'utf8')
log.success(`Created ${filePath}`)

if (flag.open) {
  const editor = process.env.EDITOR || 'vi'
  context.exec({ command: `${editor} "${filePath}"` })
}
```
