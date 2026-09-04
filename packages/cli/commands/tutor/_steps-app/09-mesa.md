---
title: 09-mesa
description: The language the screens are written in, and a component of your own
---

## Mesa

Every screen in this app is a `.mesa` file, and there is less to the language
than there looks. Five things carry almost all of it.

**State is a variable.** `let count = 0`, then `count++`. No store, no setter,
no hook. What updates is the markup that read it.

**A `$:` line re-runs when what it read changes.** The subscription is the line
itself — nothing is declared as a dependency, so nothing can fall out of step
with the body.

**Blocks are markup.** `{#if}`, `{#each}` and `{#await}` compile to DOM
operations rather than re-running a function, which is why there is no
key-and-memo discipline to keep.

**Styles are scoped to the file.** A `<style>` block cannot leak out and cannot
reach into a child component; `:global(...)` is how you say you meant to, and is
a thing you can grep for.

**Everything the runtime offers is on `$`** — `$.onMount`, `$.emit`, `$.tick`.
Five members keep a bare spelling because they are read as a bag in the middle
of markup: `$props`, `$attributes`, `$slots`, `$context` and `$async`.

The scaffold wrote a running version of all five into
`web/src/routes/index.mesa`, so the page you already have open is the reference:
every point on it is doing the thing it describes.

### A component of your own

This step writes one, imports it into the home page, and then asks the **dev
server** for the compiled module. That is the assertion, and it is a real one: a
file that compiles is a fact about the compiler, and the dev server is the only
thing here that can be asked without a browser.

Its script half — one prop, one variable, one derived value:

```mesa
export let label = 'clicks'

let n = 0
$: plenty = n >= 5
```

and its markup half:

```mesa
<button on:click={() => n++}>{label}: {n}</button>
{#if plenty}<em>that is plenty</em>{/if}
```

`export let` is how a component declares a prop, and it is one of exactly two
export forms a `.mesa` instance script may use — the other is `export function`,
which becomes a method on the instance.

The two halves are shown apart because a literate command file cannot show a
`.mesa` file whole: `fli`'s own compiler hoists the first line-leading script
tag it finds to module scope, and everything down to the last closing tag in the
file goes with it. A sample carrying one is executed as JavaScript.

```js
if (!await narrate(context)) return

context.config.__step = 9

if (!needs(context, ['appDir'], { from: '02-new' })) return

const up = await ensureWeb(context)
if (!await must(context, up, {
  likely:    'vite is not running and would not start — the last of its output is below',
  reproduce: `cd ${context.config.appDir} && bun run dev:web`,
  detail:    serverLog(context.config.__servers?.web ?? {}),
})) return

const app  = context.config.appDir
const dir  = join(app, 'web', 'src', 'components')
const comp = join(dir, 'Tally.mesa')
const home = join(app, 'web', 'src', 'routes', 'index.mesa')

mkdirSync(dir, { recursive: true })
writeFileSync(comp, [
  '<script>',
  "  export let label = 'clicks'",
  '',
  '  let n = 0',
  '  $: plenty = n >= 5',
  '</' + 'script>',
  '',
  '<button on:click={() => n++}>{label}: {n}</button>',
  '{#if plenty}<em>that is plenty</em>{/if}',
  '',
  '<style>',
  '  button { padding: 6px 12px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; cursor: pointer }',
  '</style>',
  '',
].join('\n'), 'utf8')

// Both edits refuse rather than writing the file back unchanged. A rewrite that
// silently missed its anchor leaves the probe below asserting the scaffold's
// own page and reporting the lesson green.
const IMPORT = "  import { status } from '@frontierjs/sierra/junction'"
const MOUNT  = '<section class="tour">'
const TAG    = '<Tally label="notes read" />'

let src = readFileSync(home, 'utf8')

if (!src.includes('Tally')) {
  if (!src.includes(IMPORT) || !src.includes(MOUNT)) {
    await must(context, {
      ok:    false,
      name:  'the home page carries the two lines this step edits',
      asked: "the scaffold's own index.mesa",
      got:   'a page that has been changed under the lesson',
    }, {
      likely:    'web/src/routes/index.mesa was edited by hand — add the component to it yourself',
      reproduce: `sed -n '1,20p' ${home}`,
    })
    return
  }
  src = src
    .replace(IMPORT, `${IMPORT}\n  import Tally from '../components/Tally.mesa'`)
    .replace(MOUNT,  `${TAG}\n\n${MOUNT}`)
  writeFileSync(home, src, 'utf8')
}

if (!await must(context, probe.fileExists({ path: comp, name: 'web/src/components/Tally.mesa' }), {
  likely: 'the component could not be written — check the permissions on the app directory',
})) return

if (!await must(context, probe.fileContains({ path: home, needle: TAG, name: 'the home page renders it' }), {
  likely: 'the edit missed — the import went in and the tag did not',
})) return

// The assertion: this is the Mesa plugin's output for the file written a few
// lines ago, and `$$runtime` is the import every compiled component carries.
//
// `?import` is load-bearing. Vite decides whether to transform by EXTENSION,
// and `.mesa` is not one it knows — so the bare path is served as a static
// file and answers 200 with the source, which reads as a component that
// compiled to itself. The query is what Vite appends when a module imports a
// file it cannot recognise, and it is the only spelling that runs the plugin.
//
// A file that does not compile answers 500 with the compiler's own sentence in
// the body, which is why the probe reports a status separately from a missing
// needle.
if (!await must(context, probe.httpText({
  url:      `http://127.0.0.1:${context.config.webPort}/src/components/Tally.mesa?import`,
  needle:   '$$runtime',
  describe: 'the dev server compiled it',
  name:     'Tally.mesa reaches the browser as JavaScript',
  retries:  6,
}), {
  likely:    'the component did not compile — the dev server answered with the reason',
  reproduce: `curl -s 'http://127.0.0.1:${context.config.webPort}/src/components/Tally.mesa?import' | head -20`,
})) return

log.info('')
log.info(`  open http://127.0.0.1:${context.config.webPort} and press it`)
log.info('')

remember(context, '09-mesa', { component: 'Tally' })
```
