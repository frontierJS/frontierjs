---
title: db:assistant
description: A schema assistant for any chat model — the instructions and this app's schema, to paste
alias: assistant
examples:
  - fli assistant | pbcopy
  - fli assistant --out schema-assistant.md
  - fli assistant --bare
flags:
  out:
    type: string
    description: Write the document to this file instead of stdout
    defaultValue: ''
  bare:
    type: boolean
    description: The instructions alone, without this app's schema
    defaultValue: false
---

```js
// --bare asks about the language and needs no schema, the same reason
// db:explain skips requireSchema. The ordinary run is about THIS app, and a
// document with no schema in it would open by asking for one.
if (!flag.bare && !requireSchema(context)) return

const opts = []
if (flag.bare) opts.push('--bare')
else           opts.push(`--schema ${resolveDb(context, flag).schema}`)
if (flag.out)  opts.push(`--out ${resolve(process.cwd(), flag.out)}`)

await context.stream({
  command: `${litestone(context)} assistant ${opts.join(' ')}`,
})
```

## Why this is here

Studio guides you to the right word for a schema change — the Explore panel, the
visibility interview, advise. This is the same guidance for somebody with a chat
window instead: one document holding the instructions for a guided conversation,
the whole `.lite` language with a worked example per word, the rules the parser
enforces later, and this app's `db/schema.lite` with every file it imports.

Paste it into Claude, ChatGPT or any other model and say what you want to change.
It summarizes the schema back, asks what you are trying to do one question at a
time, and proposes the smallest change as a before and after of the model block.
**It has read your schema; it has not run it** — so it ends every proposal on
`fli db:advise`, `fli db:explain` and `fli db:migrate`, which have.

## PURPOSE.md

A `PURPOSE.md` at the app's root goes into the paste too. It states what the
app is for and how far it means to go — Purpose, For whom, Ambition, In scope,
Out of scope, May grow into, Tradeoffs we choose, Open, Revisions — and it is
what decides a close call the schema cannot: the same request wants a simpler
shape in a quoting tool than in a CRM. A request past the stated scope is named
as a stretch, with the in-scope shape and a revision of `PURPOSE.md` offered side
by side. Without the file, the assistant asks for the purpose first and offers
to write one; the template is in the document.

## Without the CLI

The instructions without a schema are committed and served as
`https://raw.githubusercontent.com/frontierJS/frontierjs/main/packages/litestone/assistant.snapshot.md`
— point a model that can read URLs at it and paste the schema into the chat.
Pasting the document itself is the more reliable of the two: a model reading a
long page by URL may summarize it rather than read every word.
