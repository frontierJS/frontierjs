---
title: db:jsonschema
description: Generate JSON Schema from schema.lite — consumed by Junction and Sierra
alias: db-jsonschema
examples:
  - fli db:jsonschema
---

```js
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)

log.info('Generating JSON Schema from schema.lite...')
context.exec({ command: `${litestone(context)} jsonschema --schema ${schema}` })
log.success('JSON Schema written to db/schema.json')
```
