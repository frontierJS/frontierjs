---
title: 02-resource
description: The resource file, and what is not in it
---

## `web/src/resources/Note.mesa`

A Resource is a UI-realm noun, so it is written in the UI-realm language. The
file has two halves and they run at different times.

**`<script module>` runs once at import**, and is what every other module
imports. It is one call:

```text
export const notes = createResource('notes', {
  model: 'Note', coerce: true, blankToNull: true, validate: true,
})
```

**The markup below it is this model's default form** — which is why a create
page can be `<Note />` and nothing else, and why the same tag with `method` set
is an edit page.

What is worth reading is what the file does NOT contain. No field list. No
types. No required list. No enum values. No relations. No validation rules. All
of that is read back off the schema at runtime, which is what the next step
watches happen.

The three flags are each one sentence:

| | |
| --- | --- |
| `coerce` | every DOM control hands back a string — `<input type="number">` included — and the schema is the only thing that knows the column is an `Int` |
| `blankToNull` | an empty text box submits `''`, which SQLite does not agree is `NULL` |
| `validate` | check against the schema before the request, rather than round-tripping to be told the same thing. The server validates regardless |

```js
if (!await narrate(context)) return

context.config.__step = 2

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app  = context.config.appDir
const file = join(app, 'web', 'src', 'resources', 'Note.mesa')

if (!await must(context, probe.fileContains({
  path:   file,
  needle: /createResource\('notes'/,
  name:   'the resource names its service',
}), {
  likely: 'this file is written by fli scaffold — a hand-written one may name it differently',
})) return

if (!await must(context, probe.fileContains({
  path:   file,
  needle: /<Form\s+resource=\{notes\}/,
  name:   'the form is <Form resource={notes}> and names no field',
}), {
  likely: 'a form that lists its own fields is a form that stops matching the schema',
})) return

// The assertion the claim actually rests on. A file that named `title` would
// be a file somebody has to edit when the schema moves — and every other
// assertion in this lesson would still pass.
const text = readFileSync(file, 'utf8')
const named = ['title', 'body', 'done'].filter((f) => new RegExp(`name=["']${f}|field=["']${f}`).test(text))

if (!await must(context, named.length === 0
  ? { ok: true,  name: 'no column of the model is named in the file', asked: 'no field names', got: 'none' }
  : { ok: false, name: 'no column of the model is named in the file', asked: 'no field names', got: named.join(', ') }, {
  likely: 'a resource that names a column has to be edited when that column moves — which is the thing this design removes',
})) return

log.info('')
log.info(`  ${file}`)
log.info('')

remember(context, '02-resource', { resourceFile: file })
```
