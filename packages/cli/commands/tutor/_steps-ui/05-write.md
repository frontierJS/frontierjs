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

// It LANDED on the detail screen, and until now nothing here asked what that
// screen drew. A record view is a subscription, and a subscription that never
// ran renders a spinner forever with no error on the page and none in the
// console — which is what every scaffolded app shipped doing, because a create
// page and a list page were the only two this lesson ever looked at.
//
// Asked as the input VALUES rather than as the visible text: innerText does not
// carry them, so a form drawn over a null record satisfies any assertion about
// what the page SAYS, which is the bug wearing the fix's face.
if (!await must(context, await probe.pageEval({
  page,
  ask:      `JSON.stringify([...document.querySelectorAll('form input, form textarea')].map(e => e.value))`,
  expect:   (v) => JSON.parse(v).includes(title),
  describe: 'the row it navigated to, in the form',
  name:     'the detail page drew the record',
  retries:  24,
}), {
  likely: 'a spinner that never resolves is a record subscription that never ran — a const whose initializer calls a local binding is a lazy derivation (FJS-D212), so it needs a let and an assignment',
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

// ── the filter bar, which is the other half of a list page ────────────────
//
// The lesson stood on this page and only ever asked whether a row was DRAWN, so
// every control above the table was untested: the bar rendered, the URL never
// moved, and no request was ever made — a filter that looks like a working
// control and is a no-op. Three things have to be true and each
// fails on its own, so each is asked separately: the bar writes the URL, the
// page notices, and the table narrows.
//
// The bar names its controls with `aria-label` and not `name` — a placeholder is
// a hint, not an accessible name — so that is what this finds them by.
const filterBox = `[...document.querySelectorAll('input')]
  .find(e => /title/i.test(e.getAttribute('aria-label') || ''))`

if (!await must(context, await probe.pageEval({
  page, ask: `!!(${filterBox})`, describe: 'a filter control for the title column',
  name: 'the bar offered a filter', retries: 12,
}), {
  likely: 'the bar names its controls with aria-label — a placeholder is a hint, not a name',
})) return

// `fill()` writes through the DOM's own value setter and dispatches `input`,
// which is the event `FilterBar` binds — the same helper the form steps use.
await page.eval(`(() => {
  const el = ${filterBox}
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(title.slice(0, 12))})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
})()`)

if (!await must(context, await probe.pageEval({
  page,
  ask:      `location.search`,
  expect:   (v) => /title/.test(v ?? '') && !/\?.*\?/.test(v ?? ''),
  describe: 'the filter in the URL, and exactly one ? in it',
  name:     'the bar wrote the filter to the URL',
  retries:  24,
}), {
  likely: '`page.path` already carries the search, so concatenating a second query builds /notes/?a=1?b=2 — pass the query as goto\'s second argument instead',
})) return

// A SECOND keystroke, which is a different failure and the reason the page hands
// the query to `goto` as an ARGUMENT. `page.path` already carries the search, so
// concatenating a freshly encoded query onto it builds
// `/notes/?title[contains]=ab?title[contains]=abc` — and the router percent-
// encodes the stray `?`, so the URL still LOOKS well formed and the filter value
// is now the literal text `ab?title[contains]=abc`, which matches nothing. So
// this is asserted on the VALUE rather than on the shape of the URL.
const wider = title.slice(0, 18)
await page.eval(`(() => {
  const el = ${filterBox}
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, ${JSON.stringify(wider)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
})()`)

if (!await must(context, await probe.pageEval({
  page,
  ask:      `new URLSearchParams(location.search).get('title[contains]')`,
  expect:   (v) => v === wider,
  describe: `the filter reads back as exactly ${JSON.stringify(wider)}`,
  name:     'a second filter replaces the first rather than appending to it',
  retries:  24,
}), {
  likely: 'page.path carries the search, so `goto(page.path + encoded)` concatenates two queries — pass the query as goto\'s second argument over a path stripped of its own',
})) return

// The narrowing, which is the only thing that proves the page ASKED again. Not
// asserted over HTTP: a signed-in app holds a socket, so the read rides a WS
// frame and the network panel shows nothing.
if (!await must(context, await probe.pageEval({
  page,
  ask:      `JSON.stringify([...document.querySelectorAll('tbody tr')].map(r => r.innerText))`,
  expect:   (v) => { const rows = JSON.parse(v); return rows.length > 0 && rows.every(r => r.includes(title)) },
  describe: 'every row left is a match',
  name:     'and the list re-asked the server',
  retries:  24,
}), {
  likely: 'the URL moved and the list did not — the router does not remount for a query change, so the page has to watch page.query',
})) return

if (!await must(context, probe.pageClean({ page }), {})) return

log.info('')
log.info(`  "${title}" — typed in a browser, read back out of db/app.db`)
log.info('')

remember(context, '05-write', { title })
```
