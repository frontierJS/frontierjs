---
title: 05-push
description: Push commits and tags to git remote
skip: "flag.dry"
---

```js
log.info('Pushing to git...')
// One invocation, so a pre-push hook runs once rather than twice — in a repo
// whose hook is a CI tier, the second run is pure duplicate cost.
$.exec({ command: 'git push origin HEAD --tags' })

const elapsed = ((Date.now() - $.config.startTime) / 1000).toFixed(1)
log.success(`Released ${$.config.pkg.name}@${$.config.newVersion} in ${elapsed}s`)
```
