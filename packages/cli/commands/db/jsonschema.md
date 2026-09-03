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

// Same destination as `fli db:push`, which regenerates it — one answer to
// where the derived document lives, or the two commands write two files and
// whichever ran last is the one you copy.
const { jsonSchemaPath } = await import(path.resolve(global.fliRoot, 'core/derived-paths.js'))
const jsonOut = jsonSchemaPath(path.dirname(schema))

log.info('Generating JSON Schema from schema.lite...')
context.exec({ command: `${litestone(context)} jsonschema --schema ${schema} --out ${jsonOut}` })
log.success(`JSON Schema written to ${jsonOut}`)
```
