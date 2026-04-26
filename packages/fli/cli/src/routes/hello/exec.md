---
title: hello:exec
description: Lists files in a directory (tests exec and dry flag)
alias: lsd
examples:
  - fli hello:exec
  - fli hello:exec /tmp
  - fli hello:exec /tmp --dry
args:
  -
    name: dir
    description: Directory to list
    defaultValue: .
flags:
  all:
    type: boolean
    char: a
    description: Show hidden files
    defaultValue: false
---

<script>
const buildCommand = (dir, all) => {
  return `ls ${all ? '-la' : '-l'} ${dir}`
}
</script>

List files in a directory. Uses `exec` to demonstrate dry-run support.

```js
arg.dir ??= '.'

const command = buildCommand(arg.dir, flag.all)

log.info(`Running: ${command}`)

context.exec({ command, dry: flag.dry })
```
