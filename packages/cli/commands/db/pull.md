---
title: db:pull
description: Introspect a live database and generate a schema.lite from it
alias: db-pull
examples:
  - fli db:pull
---

```js
const { schema } = resolveDb($, flag)

log.info('Introspecting database...')
$.exec({ command: `${litestone($)} introspect --schema ${schema}` })
log.success('schema.lite updated')
log.warn('Review the generated schema — introspection cannot recover @@gate, @@allow, @secret, or policy rules')
```
