---
title: npm:install
description: Install dependencies (or add new ones)
alias: ni
examples:
  - fli ni
  - fli ni zx dotenv
  - fli ni lodash --save-dev
  - fli ni --frozen
  - fli ni --dry
args:
  -
    name: packages
    description: Package(s) to install (omit to install all from package.json)
    variadic: true
flags:
  dev:
    char: D
    type: boolean
    description: Save as devDependency
    defaultValue: false
  frozen:
    type: boolean
    description: Install from lockfile without updating it (ci mode)
    defaultValue: false
  global:
    char: g
    type: boolean
    description: Install globally
    defaultValue: false
---

```js
const root = context.paths.root

if (flag.frozen) {
  context.exec({ command: `npm ci --prefix ${root}`, dry: flag.dry })
  return
}

const packages = arg.packages?.trim() || ''
const parts    = ['npm', packages ? 'install' : 'install']
if (packages) parts.push(packages)
if (flag.dev)    parts.push('--save-dev')
if (flag.global) parts.push('--global')
if (!flag.global) parts.push(`--prefix ${root}`)

context.exec({ command: parts.join(' '), dry: flag.dry })
```
