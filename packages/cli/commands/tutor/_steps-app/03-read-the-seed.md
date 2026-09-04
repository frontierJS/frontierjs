---
title: 03-read-the-seed
description: The one file everything else is derived from
---

## The seed

Open **db/schema.lite**. It is the whole of what this app knows, and three other
things are generated from it rather than written beside it: the API's validation,
the browser's forms, and the database itself.

The line worth finding is on `model User`, at the bottom of its block:

```text
@@gate("4.4.4.5")
```

Four numbers, in the order **read · create · update · delete**, each one the
lowest standing that may do it. `0` is a stranger, `4` is a signed-in user, `5`
is an administrator, `6` is the owner. So: any signed-in caller may read a user
and write one, and only an administrator may delete.

That single line is the whole of the authorization for this model. You will not
write it again in the service, and you will not be able to forget it — the API
derives its 401s from it and the browser reads it back to decide which buttons
to offer. The model you add later in this lesson gets a different four, and the
difference will be visible without you writing a check anywhere.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir'], { from: '02-new' })) return

const schema = join(context.config.appDir, 'db', 'schema.lite')

if (!await must(context, probe.fileContains({ path: schema, needle: /@@gate/, name: 'the seed declares a gate' }), {
  likely:    'the scaffold changed shape, or --source npm installed an older framework',
  reproduce: `cat ${schema}`,
})) return

if (!await must(context, probe.fileContains({ path: schema, needle: /^\s*model\s+\w+/m, name: 'the seed declares a model' }), {
  likely: 'fli new wrote a schema with no models in it',
})) return

log.info('the seed is the source — everything after this is derived from it')
```
