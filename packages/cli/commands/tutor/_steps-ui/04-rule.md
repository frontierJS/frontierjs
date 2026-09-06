---
title: 04-rule
description: One attribute in the schema, and the form starts refusing
---

## The half you have to see

The form generated itself. That is easy to believe and easy to fake — a page
could hard-code three boxes and look identical.

So this step changes **one column of `db/schema.lite`** and touches nothing
else:

```text
title     String    @length(3, 80)
```

No `.mesa` file is edited. No form is restarted. The same page is loaded again
and it now carries `minlength="3"` and `maxlength="80"` on a real `<input>` —
which is what a screen reader and the browser's own validation read, before any
JavaScript runs.

Then the form is submitted empty, twice over: once before the attribute and
once after. The difference is the whole lesson.

**Before**, an empty submit is a legal write. `String` means a string, and `''`
is one — *required* is about the key being present, not about the value being
interesting. The row is created.

**After**, the browser refuses. The field is marked invalid, the page does not
navigate, and — the assertion that matters — **the row count over HTTP does not
move**, because the request was never made. `validate: true` on the resource is
what moves the first *no* to the person's screen instead of a round trip.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app  = context.config.appDir
const page = context.config.__page ?? await openPage(context, '/')

// A step run on its own has neither a caller nor a signed-in page.
if (!await must(context, await ensureCaller(context, page), {
  likely: 'the API is up but registering or signing in did not work — step 3 diagnoses that',
})) return

// Counted AS THE SIGNED-IN CALLER. Which levels this model grades at is the
// app's to change — a later lesson raises its read gate — and a count asked
// anonymously would answer 401 there and turn every assertion below into a
// comparison against null.
const countNotes = async () => {
  const r = await probe.httpJson({
    url:      apiUrl(context, '/notes'),
    headers:  asCaller(context.config.userToken),
    expect:   (j) => typeof j.total === 'number',
    describe: 'the note count', name: 'how many notes there are',
  })
  return r.ok ? r.json.total : null
}

const openForm = async () => {
  await page.goto(`http://127.0.0.1:${context.config.webPort}/notes/create/`)
  return probe.pageEval({ page, ask: `!!document.querySelector('input[name=title]')`, name: 'the create form is up' })
}

const submitEmpty = async () => {
  await page.eval(`document.querySelector('button[type=submit]').click()`)
  // A refusal is the ABSENCE of a navigation, so there is nothing to wait for
  // and the wait has to be real time. Short, because the alternative — waiting
  // for a change — cannot tell "refused" from "not yet".
  await new Promise((r) => setTimeout(r, 1500))
  return {
    path:    await page.eval('location.pathname'),
    invalid: JSON.parse(await page.eval(
      `JSON.stringify([...document.querySelectorAll('[aria-invalid="true"]')].map(e => e.name))`)),
  }
}

// ── before ──────────────────────────────────────────────────────────────────
//
// The whole step is a before and an after, so the BEFORE has to be real. A
// workspace this lesson has already run in still carries the attribute, and
// asking then would be asking about the after twice. Taken back out first —
// which is also the fastest way to watch the change in the other direction.
if (readFileSync(schemaFile(context), 'utf8').includes('@length(3, 80)')) {
  log.info('this workspace already has the rule — taking it out, so the before is a real before')
  editSchema(context, '  title     String    @length(3, 80)\n', '  title     String\n')
  pushSchema(context)
  const undone = await restartApi(context)
  if (!await must(context, undone.up, {
    likely: 'the API did not come back — its output is below',
    detail: serverLog(undone),
  })) return
}

if (!await must(context, await openForm(), { likely: 'the form did not render — step 3 is where that is diagnosed' })) return

const before = await countNotes()
const first  = await submitEmpty()
const after  = await countNotes()

if (!await must(context, after === before + 1
  ? { ok: true,  name: 'with nothing declared, an empty title is a legal write',
      asked: `${before} notes to become ${before + 1}`, got: `${after}, at ${first.path}` }
  : { ok: false, name: 'with nothing declared, an empty title is a legal write',
      asked: `${before} notes to become ${before + 1}`, got: `${after}` }, {
  likely: '`String` means a string and `\'\'` is one — if this refused, something already constrains the column',
})) return

// ── the one line ────────────────────────────────────────────────────────────
const edit = editSchema(context, '  title     String\n', '  title     String    @length(3, 80)\n')
if (!edit.ok) {
  log.error(`${edit.why} — this step adds @length(3, 80) to Note.title`)
  context.config.abort = true
  return
}

pushSchema(context)

const back = await restartApi(context)
if (!await must(context, back.up, {
  likely: 'the API did not come back after the schema change — its output is below',
  detail: serverLog(back),
})) return

// ── after ───────────────────────────────────────────────────────────────────
if (!await must(context, await openForm(), { likely: 'the dev server rebuilds the schema it hands the browser — see .tutor/web.log' })) return

// The attribute, on the control. Nothing edited a form to put it there.
if (!await must(context, await probe.pageEval({
  page,
  ask:      `(() => { const el = document.querySelector('input[name=title]')
                      return JSON.stringify({ min: el.getAttribute('minlength'), max: el.getAttribute('maxlength') }) })()`,
  expect:   (v) => { const a = JSON.parse(v); return a.min === '3' && a.max === '80' },
  describe: 'minlength="3" and maxlength="80" on the control',
  name:     'the rule reached the box, with no form edited',
}), {
  likely: 'the browser reads the schema the build handed it — a stale one means the dev server did not pick up db/.json/schema.json',
})) return

const was     = await countNotes()
const refused = await submitEmpty()
const now     = await countNotes()

if (!await must(context, refused.invalid.includes('title')
  ? { ok: true,  name: 'the browser refuses, and says which field',
      asked: 'title marked aria-invalid', got: refused.invalid.join(', ') || 'nothing' }
  : { ok: false, name: 'the browser refuses, and says which field',
      asked: 'title marked aria-invalid', got: refused.invalid.join(', ') || 'nothing marked' }, {
  likely: 'validate: true on the resource is what checks before the request — it is in web/src/resources/Note.mesa',
})) return

// The assertion the beat rests on: not that an error appeared, but that
// nothing was sent. An error message is renderable by a page that also wrote
// the row.
if (!await must(context, now === was && refused.path === '/notes/create/'
  ? { ok: true,  name: 'and the request was never made',
      asked: `${was} notes to stay ${was}, still on the create page`, got: `${now}, at ${refused.path}` }
  : { ok: false, name: 'and the request was never made',
      asked: `${was} notes to stay ${was}, still on the create page`, got: `${now}, at ${refused.path}` }, {
  likely: 'a row that appeared means the check ran on the server and the message came back — which works, and is a round trip',
})) return

if (!await must(context, probe.pageClean({ page }), {})) return

remember(context, '04-rule', {})
```
