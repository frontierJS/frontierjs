---
title: utils:note
description: Scaffold a new dated markdown note in the current directory
alias: note
examples:
  - fli note "My New Note"
  - fli note meeting-recap --open
args:
  -
    name: name
    description: Note title or filename
    required: true
flags:
  open:
    char: o
    type: boolean
    description: Open the note in your editor after creating it
    defaultValue: false
---

<script>
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'
</script>

```js
const date    = new Date().toJSON().slice(0, 10).replace(/-/g, '')
const cleaned = arg.name.trim().replace(/ /g, '_').toLowerCase()
const file    = `${cleaned}.${date}.md`
const meta    = [
  '---',
  `title: ${arg.name}`,
  `tags: []`,
  `createdAt: ${date}`,
  '---',
  '',
  `# ${arg.name}`,
  '',
].join('\n')

const filePath = resolve(process.cwd(), file)

if (flag.dry) {
  log.dry(`Would create: ${filePath}`)
} else {
  writeFileSync(filePath, meta, 'utf8')
  log.success(`Created: ${file}`)
}

if (flag.open && !flag.dry) {
  const editor = process.env.EDITOR || 'vi'
  context.exec({ command: `${editor} "${filePath}"` })
}
```
