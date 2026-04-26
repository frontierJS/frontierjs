---
title: utils:diff-env
description: Diff local .env files against project template defaults
alias: diff-env
examples:
  - fli diff-env
  - fli utils:diff-env --dry
---

```js
const root      = context.paths.root
const templates = `${global.fliRoot}/src/templates/project`

context.exec({ command: `git diff ${templates}/env ${root}/.env`, dry: flag.dry })
context.exec({ command: `git diff ${templates}/env.test ${root}/.env.test`, dry: flag.dry })
```
