---
title: 05-push
description: Push commits and tags to git remote
skip: "flag.dry"
---

```js
log.info('Pushing to git...')
context.exec({ command: 'git push' })
context.exec({ command: 'git push --tags' })

const elapsed = ((Date.now() - context.config.startTime) / 1000).toFixed(1)
log.success(`Released ${context.config.pkg.name}@${context.config.newVersion} in ${elapsed}s`)
```
