---
title: tutor:ui
description: The form nobody wrote — generated from the schema, in a real browser
steps: _steps-ui
examples:
  - fli tutor:ui --workspace ~/frontier-tutorial
  - fli tutor:ui --tmp --yes
flags:
  workspace:
    char: w
    type: string
    description: Directory to build the app in — kept when the lesson ends
    defaultValue: ''
  tmp:
    type: boolean
    description: Build in a throwaway directory instead (the default with no --workspace)
    defaultValue: false
  restart:
    type: boolean
    description: Begin this lesson again, forgetting what an earlier run finished
    defaultValue: false
  yes:
    char: y
    type: boolean
    description: Run the whole lesson without stopping — no confirmation between steps
    defaultValue: false
  keep:
    type: boolean
    description: Keep a throwaway workspace when the lesson ends
    defaultValue: false
  source:
    type: string
    description: Where @frontierjs packages come from — local (this tree) or npm
    defaultValue: ''
  api-port:
    type: number
    description: Port for the API — refused rather than moved if something holds it
    defaultValue: 8100
  web-port:
    type: number
    description: Port for the web app — refused rather than moved if something holds it
    defaultValue: 8000
---

```js
// The servers and the browser are processes, and a process is the one thing a
// journal cannot hold: replayed into a no-op, a step that opened a page is
// recorded as done with nothing open.
openTutor(context, 'tutor:ui', {
  ephemeral: ['03-form', '04-rule', '05-write', '06-finish'],
})

context.config.source  = flag.source || defaultSource()
context.config.apiPort = flag['api-port']
context.config.webPort = flag['web-port']

context.vars.apiPort = context.config.apiPort
context.vars.webPort = context.config.webPort
```

## Lesson 3 — a screen you did not write

Lesson 1 scaffolded a `Note` model and, with it, three routes and a resource
file. Nothing has looked at them. This lesson does, in a real browser, because
the claim being made is one you have to see refused before you believe it:

> **A form is not written. It is read off the schema.**

`<Form {resource} />` with no children IS the form — every writable column, in
declaration order, each with the control its type implies. No field list, no
validation rules restated, no required list. A column added to `db/schema.lite`
appears on the screen with no edit to any `.mesa` file, and a rule added to
that column becomes a constraint on the control.

That last half is the one worth watching. Partway through, this lesson adds
**one attribute** to one column of the schema and nothing else — no form is
touched — and then submits the form empty. Before the attribute the write goes
through; after it the browser refuses, marks the field, and never makes the
request at all.

Everything here is asserted against the DOM of a page Chrome really rendered,
and against the database afterwards. A screen that renders and does not save is
the failure this shape of lesson exists to catch.

**This lesson needs Chrome.** Install Chrome or Chromium, or point `$FJS_CHROME`
at a binary. Without one the lesson stops with a sentence rather than failing —
a missing browser is a fact about the machine, not about your app.
