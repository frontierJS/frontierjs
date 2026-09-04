---
title: 05-build
description: A page with data in it, and one HTML file per route
---

## Baked

Two files. The page, `site/src/routes/notes/index.mesa`:

```text
---
title: Notes
render: static
---
```

whose script half takes what the companion returned — all of it, as one prop
called `data`:

```text
export let data = null

const notes = data?.notes ?? []
```

and its **companion**, `site/src/routes/notes/index.meta.js`, which is where
that data comes from:

```text
export async function load() {
  const notes = await db.asSystem().note.findMany({ limit: 20 })
  return { notes }
}
```

`load()` runs **in Node, at build time**. Whatever it returns is baked into the
file. The companion is a separate module for a reason that only shows up in the
build: it never enters the browser graph, so importing the app's own database
client there does not ship the database client to the public.

Then:

```console
fli site:build
```

What comes out is `site/dist/notes/index.html` with the three titles already in
it — no request, no loading state, no server. That is the whole trade.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir', 'titles'], { from: '03-rows' })) return

const app  = context.config.appDir
const site = join(app, 'site')
const dir  = join(site, 'src', 'routes', 'notes')

mkdirSync(dir, { recursive: true })

writeFileSync(join(dir, 'index.mesa'), [
  '---',
  'title: Notes',
  'render: static',
  '---',
  '<' + 'script>',
  '  // Whatever load() returned arrives as ONE prop, called data.',
  '  export let data = null',
  '',
  '  const notes = data?.notes ?? []',
  '</' + 'script>',
  '',
  '<h1>Notes</h1>',
  '',
  '<ul>',
  '  {#each notes as note}',
  '    <li>{note.title}</li>',
  '  {/each}',
  '</ul>',
  '',
].join('\n'), 'utf8')

writeFileSync(join(dir, 'index.meta.js'), [
  '// site/src/routes/notes/index.meta.js — this page\'s build-time data.',
  '//',
  '// load() runs in Node at BUILD time and what it returns is baked into a',
  '// public HTML file. Sierra taps the client named by config/sierra.config.js',
  '// while this runs and refuses to emit the page if anything read here is',
  '// gated above what the route declares.',
  '//',
  '// A companion is build-time only: it never enters the browser graph, which',
  '// is why importing the database client here does not ship it to the public.',
  '',
  "import { db } from '../../../../api/src/core/db.ts'",
  '',
  'export async function load() {',
  '  const notes = await db.asSystem().note.findMany({ limit: 20 })',
  '  return { notes }',
  '}',
  '',
].join('\n'), 'utf8')

try {
  context.exec({ command: `${context.fli} site:build`, cwd: app })
} catch (err) {
  await must(context, {
    ok:    false,
    name:  'the site built',
    asked: 'one HTML file per route',
    got:   'the build stopped',
  }, {
    likely:    'the page or its companion did not compile — the build output is above',
    reproduce: `cd ${app} && fli site:build`,
    detail:    String(err?.message ?? err).slice(0, 400),
  })
  return
}

const page = join(site, 'dist', 'notes', 'index.html')

if (!await must(context, probe.fileExists({ path: page, name: 'site/dist/notes/index.html' }), {
  likely:    'the route did not declare render: static, so nothing was prerendered',
  reproduce: `ls -R ${join(site, 'dist')}`,
})) return

// The titles, in the FILE. A page that fetched them at runtime would look
// identical in a browser and would be empty here, which is the difference this
// whole surface is about.
for (const title of context.config.titles) {
  if (!await must(context, probe.fileContains({ path: page, needle: title, name: `the file already says "${title}"` }), {
    likely: 'load() ran and returned nothing — the rows may have been written to another database',
  })) return
}

log.info('')
log.info(`  ${page}`)
log.info('')
```
