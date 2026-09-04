---
title: 07-stale
description: Change the row, and the published file does not change
---

## Out of date, on purpose

The build is over, so the page is a file. Change a note through the API — the
same call that worked in every earlier lesson — and then read the file again.

It still says the old title.

That is not a bug and it is not a cache. It is what *prerendered* means: the
page was true when it was built and nothing on disk is watching the database.
Every static site generator has this property; what differs is what you do about
it, and the answer here has a name.

An **island** is a component on a prerendered page that does enter the browser
graph, mounts, and asks the API for the current value — so the page ships
readable and correct-as-of-the-build, and the one number that must be current
corrects itself a moment later. The baked value stays visible while it does,
which is the difference between a stale price and a blank space.

That is a page in `example/site/`, which is worth reading next: a whole
storefront built ahead of time, with prices that correct themselves and a basket
a stranger can buy from.

```js
if (!await narrate(context)) return

context.config.__step = 7

if (!needs(context, ['appDir', 'siteDir', 'titles'], { from: '05-build' })) return

if (!await must(context, await ensureApi(context), {
  likely: 'nothing is answering on the API port — run this lesson from the start',
})) return

const page = join(context.config.siteDir, 'dist', 'notes', 'index.html')
const was  = context.config.titles[0]
const now  = `${was} — edited after the build`

// The gate went up in step 6, so this read needs the session that wrote them.
const found = await probe.httpJson({
  url:      apiUrl(context, `/notes?title=${encodeURIComponent(was)}`),
  headers:  { authorization: `Bearer ${context.config.userToken}` },
  expect:   (j) => Array.isArray(j.data) && j.data.length > 0,
  describe: 'the note this lesson baked',
  name:     'the row is still there to change',
})
if (!await must(context, found, {
  likely: 'the notes were written under a different account, or the gate refuses this one',
})) return

const id      = found.json.data[0].id
const patched = await probe.httpJson({
  url:      apiUrl(context, `/notes/${id}`),
  method:   'PATCH',
  headers:  { 'content-type': 'application/json', authorization: `Bearer ${context.config.userToken}` },
  body:     JSON.stringify({ title: now }),
  expect:   (j) => j.title === now,
  describe: 'the new title',
  name:     'the note is changed',
})
if (!await must(context, patched, { likely: 'the patch was refused — the body is above' })) return

if (!await must(context, probe.fileContains({ path: page, needle: was, name: 'the published file still says the old title' }), {
  likely: 'something rebuilt the site between the two — which would make this step pass for the wrong reason',
})) return

if (!await must(context, {
  ok:    !readFileSync(page, 'utf8').includes(now),
  name:  'and does not know about the new one',
  asked: 'the new title absent from the file',
  got:   'it is in there, which means the file is not the one that was built',
}, {
  likely: 'the dist directory was rebuilt after the patch',
})) return

log.info('')
log.info('  the row moved, the file did not — an island is how one value catches up')
log.info('')
```
