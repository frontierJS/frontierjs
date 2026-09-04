---
title: 06-model
description: A model of your own, across all three realms at once
---

## A model of your own

One command writes a **vertical slice** — the stanza in the seed, the service,
the Resource and three routes:

```console
fli scaffold Note --fields "title:string body:text done:boolean"
```

Six files, and the only one you would edit by hand is the first. Look at what it
put in `db/schema.lite`:

```text
@@gate("0.4.4.6")
```

Different four numbers from `User`'s. **Reads are public** — anyone may list
notes — **and writing needs a signed-in caller**. Nothing in
`api/src/services/notes.service.ts` says so; the service derives it, and the
next two steps show it holding.

The route files are Mesa. `web/src/routes/notes/index.mesa` is the URL
`/notes/` — the file tree *is* the route table, so there is no table to keep in
step with it.

```js
narrate(context)

context.config.__step = 6

if (!needs(context, ['appDir'], { from: '02-new' })) return

context.exec({
  command: `${context.fli} scaffold Note --fields "title:string body:text done:boolean"`,
  cwd:     context.config.appDir,
})

const app = context.config.appDir
for (const [path, what] of [
  ['api/src/services/notes.service.ts', 'the service'],
  ['web/src/resources/Note.mesa',       'the Resource'],
  ['web/src/routes/notes/index.mesa',   'the list route'],
  ['web/src/routes/notes/create.mesa',  'the create route'],
]) {
  if (!await must(context, probe.fileExists({ path: join(app, path), name: `${path} — ${what}` }), {
    likely:    'fli scaffold stopped part way — its output is above',
    reproduce: `cd ${app} && fli scaffold Note --fields "title:string body:text done:boolean"`,
  })) return
}

const schema = join(app, 'db', 'schema.lite')

if (!await must(context, probe.fileContains({ path: schema, needle: /^model Note \{/m, name: 'the seed declares model Note' }), {
  likely: '--skip-schema was passed, or the stanza went to another file',
})) return

// The gate is the point of the step, so it is asserted rather than described.
if (!await must(context, probe.fileContains({ path: schema, needle: /@@gate\("0\.4\.4\.6"\)/, name: 'Note reads at 0 and writes at 4' }), {
  likely:    'the scaffold template changed its default gate — the lesson text below it is now wrong',
  reproduce: `grep -A 14 '^model Note' ${schema}`,
})) return

remember(context, '06-model', { model: 'Note', service: 'notes' })
```
