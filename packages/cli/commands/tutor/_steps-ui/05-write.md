---
title: 05-write
description: Type into the form, and read the row out of the database
---

## The one that counts

A screen that renders is not a screen that works. This step fills the three
boxes in the browser, presses the button, and then asks the **database** what
it holds — not the page, and not the response.

That is the shape every drive in this repo settles on for anything a person
types. A page can show a row it did not write; a response can be correct about
a write that was rolled back. The only thing that answers *did this happen* is
the store on the other side.

Then the list page, because a create that works and a list that does not show
it is the failure a person actually reports.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app  = context.config.appDir
const page = context.config.__page ?? await openPage(context, '/')

if (!await must(context, await ensureCaller(context, page), {
  likely: 'the API is up but registering or signing in did not work — step 3 diagnoses that',
})) return

// A title this run and no other could have written, so what comes back out of
// the database cannot be a row an earlier run left.
const title = `typed in a browser ${Date.now()}`

await page.goto(`http://127.0.0.1:${context.config.webPort}/notes/create/`)
if (!await must(context, await probe.pageEval({
  page, ask: `!!document.querySelector('input[name=title]')`, name: 'the create form is up',
}), { likely: 'step 3 is where a form that does not render is diagnosed' })) return

await page.eval(fill('input[name=title]', title))
await page.eval(fill('input[name=body]', 'and read back out of the database'))
// `.click()` and not `el.checked = true`: a checkbox's own click fires the
// events a real toggle fires, in the order a framework listens for them.
// Assigning the property changes what is drawn and notifies nobody, which looks
// identical on screen and stores the wrong value.
await page.eval(`(() => { const el = document.querySelector('input[name=done]')
                          if (el.checked) return el.checked
                          el.click(); return el.checked })()`)

await page.eval(`document.querySelector('button[type=submit]').click()`)

// A save navigates to the record it made. Waiting for THAT rather than for a
// duration is what makes this assertion about the save rather than about how
// fast the machine is.
if (!await must(context, await probe.pageEval({
  page,
  ask:      `location.pathname`,
  expect:   (p) => /^\/notes\/[^/]+\/$/.test(p) && p !== '/notes/create/',
  describe: 'the page moved to the record it created',
  name:     'the form saved',
  retries:  24,
}), {
  likely: 'a form that stays put was refused — the field errors are on the page, and the console feed on 8503 has the call',
})) return

// Whether the TICK is part of the assertion depends on the schema, which a
// later lesson changes: `tutor:access` puts `@allow('write', auth().isAdmin)`
// on this column, and after that a plain caller's `true` is accepted and
// dropped — deliberately, and in silence, which is the thing that lesson is
// about. So the column is asked about only where this caller may write it.
const guarded = /done .*@allow\('write'/.test(readFileSync(schemaFile(context), 'utf8'))
if (guarded)
  log.info('  (done carries a field policy in this workspace, so it is not part of what follows)')

// The row, asked of the API rather than of the page. `?title=` is a filter the
// Data boundary parses; a title nothing else wrote is the whole key.
if (!await must(context, await probe.httpJson({
  url:      apiUrl(context, `/notes?title=${encodeURIComponent(title)}`),
  headers:  asCaller(context.config.userToken),
  expect:   (j) => j.total === 1
                && j.data[0].body === 'and read back out of the database'
                && (guarded || j.data[0].done === true),
  describe: guarded
    ? 'exactly one row, with the text that was typed'
    : 'exactly one row — the two strings that were typed, and the box that was ticked',
  name:     'the database holds what was typed',
  retries:  6,
}), {
  likely: 'the page navigated and the row is not there — the response said one thing and the store another',
})) return

// The list, because a create nobody can see is the failure that gets reported.
await page.goto(`http://127.0.0.1:${context.config.webPort}/notes/`)
if (!await must(context, await probe.pageEval({
  page,
  ask:      `document.body.innerText.includes(${JSON.stringify(title)})`,
  describe: 'the new note is on the list page',
  name:     'and the list shows it',
  retries:  24,
}), {
  likely: 'the row is in the database and the list does not draw it — that is a read, not a write',
})) return

if (!await must(context, probe.pageClean({ page }), {})) return

log.info('')
log.info(`  "${title}" — typed in a browser, read back out of db/app.db`)
log.info('')

remember(context, '05-write', { title })
```
