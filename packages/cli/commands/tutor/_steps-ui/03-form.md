---
title: 03-form
description: The form, in a browser, with the controls the schema implies
---

## What renders

Both servers start, and Chrome opens `/notes/create/`.

Three things are asserted about the page, and the third is the one that is easy
to miss. **One control per writable column**, in schema order. **The control
the type implies** — a `String` is a text box, a `Boolean` is a checkbox, an
`Int` is a number box — off one table, `field-rules.js`, so a generated form
and a hand-written one cannot disagree about what a `Float` is. And **nothing
for the columns the server owns**: `id`, `createdAt` and `updatedAt` reach the
browser marked read-only, so the form does not offer them and `make()` does not
seed them.

That last one is why a generated form is safe to hand a person. A form that
offered `createdAt` would be a form whose every submit tries to write a column
the Data boundary refuses by name.

Sign-in happens through the app's own login page rather than over HTTP,
because what has to be true is that the token ends up where the browser's own
client reads it — and that is the half a `fetch` cannot stand in for.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app = context.config.appDir

const api = await ensureApi(context)
if (!await must(context, api, {
  likely:    'the API did not come up — see .tutor/api.log in the workspace',
  reproduce: `cd ${app} && bun run start`,
})) return

const web = await ensureWeb(context)
if (!await must(context, web, {
  likely:    'the dev server did not come up — see .tutor/web.log in the workspace',
  reproduce: `cd ${app} && bun run dev:web`,
})) return

// A fresh address per run: an app reused from an earlier lesson already has the
// other ones, and a session is not something the journal should hold.
const page = await openPage(context, '/')
if (!await must(context, await ensureCaller(context, page), {
  likely: 'the sign-in form is the app’s own /login/ page — open it and watch what it does',
})) return

await page.goto(`http://127.0.0.1:${context.config.webPort}/notes/create/`)

const CONTROLS = `JSON.stringify([...document.querySelectorAll('input, select, textarea')]
  .map(e => ({ name: e.name, tag: e.tagName.toLowerCase(), type: e.type })))`

const shown = await probe.pageEval({
  page,
  ask:      CONTROLS,
  expect:   (v) => JSON.parse(v).some((c) => c.name === 'title'),
  describe: 'a control for every writable column',
  name:     'the form generated itself',
})
if (!await must(context, shown, {
  likely: 'the page rendered and the form is empty — the resource may not have resolved its model',
})) return

const controls = JSON.parse(shown.value)
const byName   = Object.fromEntries(controls.map((c) => [c.name, c]))

// The type each column implies. Asserted as a MAP rather than a count, because
// three controls of the wrong kind is the same number as three of the right
// kind.
const wanted = { title: 'text', body: 'text', done: 'checkbox' }
const wrong  = Object.entries(wanted).filter(([n, t]) => byName[n]?.type !== t)

if (!await must(context, wrong.length === 0
  ? { ok: true,  name: 'each control is the one its type implies', asked: JSON.stringify(wanted), got: 'all three' }
  : { ok: false, name: 'each control is the one its type implies', asked: JSON.stringify(wanted),
      got: wrong.map(([n, t]) => `${n} wanted ${t}, got ${byName[n]?.type ?? 'no control'}`).join(' · ') }, {
  likely: 'the control for a type is one table — packages/sierra/src/junction/field-rules.js',
})) return

// The columns the server owns. A form that offered one would be a form whose
// every submit is refused by name at the Data boundary.
const owned = ['id', 'createdAt', 'updatedAt'].filter((n) => byName[n])
if (!await must(context, owned.length === 0
  ? { ok: true,  name: 'the server’s own columns are not offered', asked: 'no control for id, createdAt, updatedAt', got: 'none' }
  : { ok: false, name: 'the server’s own columns are not offered', asked: 'no control for id, createdAt, updatedAt', got: owned.join(', ') }, {
  likely: 'those reach the client as readOnly — a control for one means the write pipeline would have to strip it',
})) return

// A component that throws while rendering still leaves a partial tree, so
// every assertion above can pass over the top of a broken render.
if (!await must(context, probe.pageClean({ page }), {
  likely: 'the page drew something and complained while doing it — the messages are above',
})) return

log.info('')
log.info(`  ${controls.length} controls, none of them written by hand:`)
for (const c of controls) log.info(`    ${String(c.name).padEnd(12)} ${c.tag} ${c.type}`)
log.info('')

context.config.__page = page
remember(context, '03-form', {})
```
