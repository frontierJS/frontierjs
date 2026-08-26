---
title: ksite:deploy
description: Deploy the site via npm run deploy:site
alias: ksite-deploy
examples:
  - fli ksite:deploy
  - fli ksite:deploy --dry
---

```js
context.exec({ command: 'npm run deploy:site', dry: flag.dry })
```
