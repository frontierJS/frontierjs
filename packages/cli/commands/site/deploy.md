---
title: site:deploy
description: Deploy the site via npm run deploy:site
alias: site-deploy
examples:
  - fli site:deploy
  - fli site:deploy --dry
---

```js
context.exec({ command: 'npm run deploy:site', dry: flag.dry })
```
