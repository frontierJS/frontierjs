---
title: web:route
description: Scaffold a Mesa route — optionally wired to a Resource, with a co-located component
examples:
  - fli web:route users/edit
  - fli web:route users/[id]
  - fli web:route invoices --resource Invoice
  - fli web:route invoices/[id] --resource Invoice --component InvoiceCard --open
  - fli web:route admin --layout
args:
  -
    name: path
    description: Route path relative to src/routes/ (e.g. users/edit or users/[id])
    required: true
flags:
  resource:
    char: r
    type: string
    description: Wire the page to the Resource for this model (PascalCase model name)
    defaultValue: ''
  component:
    char: c
    type: string
    description: Also create a named Mesa component in src/components/
    defaultValue: ''
  layout:
    char: l
    type: boolean
    description: Write _module.mesa — a layout wrapping this directory and everything under it — instead of a page
    defaultValue: false
  open:
    char: o
    type: boolean
    description: Open all created files in editor after scaffolding
    defaultValue: false
---

<script>
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname, basename } from 'path'

// A literal closing script tag ends this block — core/compiler.js extracts it
// with a non-greedy match and does not care that the tag is inside a string.
const SC = '<' + '/script>'

// Regular English plurals only, matching Sierra's registry. Irregulars are not
// guessed: `fli make:resource Person --service people` names it explicitly.
const servicePlural = (model) => {
  const a = model.charAt(0).toLowerCase() + model.slice(1)
  if (/[^aeiou]y$/.test(a))     return a.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/.test(a)) return a + 'es'
  return a + 's'
}

const toLabel = (name) => name
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase())
  .trim()

// ─── A plain page ─────────────────────────────────────────────────────────────
// Frontmatter is the route's meta: the scanner reads it into the route table and
// the router puts it on `page.meta`. `title` is the conventional key.

const makePage = (title, params) => {
  const head = params.length
    ? `  import { page } from '@frontierjs/sierra/router'\n\n` +
      `  // Params come from the filename. They are read once at setup because\n` +
      `  // navigating to a different one remounts the component.\n` +
      params.map(p => `  const ${p} = page.params.${p}`).join('\n') + '\n'
    : `  // Nothing imported yet. \`page\` from '@frontierjs/sierra/router' carries\n` +
      `  // params, meta and the matched route; a Resource carries the data.\n`

  const body = params.length
    ? params.map(p => `<p>${p}: {${p}}</p>`).join('\n')
    : '<p>New route.</p>'

  return `---
title: ${title}
---
<script>
${head}${SC}

<h1>${title}</h1>

${body}
`
}

// ─── A page wired to a Resource ───────────────────────────────────────────────

const makeResourcePage = (title, service, up) => `---
title: ${title}
---
<script>
  import { ${service} } from '${up}resources/${service}.mesa'
  import { useStore } from '@frontierjs/sierra/junction'
  import { $onDestroy } from '@frontierjs/mesa/runtime'

  // useStore wraps the Resource's store as a Mesa signal. Call it once here —
  // in the script block, never inside a reactive computation — and hand the
  // unsubscribe to $onDestroy so the subscription dies with the component.
  const { get: rows, unsubscribe } = useStore(${service}.store)
  $onDestroy(unsubscribe)

  let error = null

  ${service}.load().catch(e => { error = e.message })
${SC}

<h1>${title}</h1>

{#if error}<p class="err">{error}</p>{/if}

<ul>
  {#each rows() as row}
    <li>{row.id}</li>
  {/each}
</ul>

<style>
  .err { color: #b91c1c }
</style>
`

// ─── A layout ─────────────────────────────────────────────────────────────────
// _module.mesa wraps this directory and everything under it. Layouts nest: this
// one composes inside any layout above it rather than replacing it.

const makeLayout = (title) => `---
title: ${title}
---
<script>
  import { isActive } from '@frontierjs/sierra/router'
${SC}

<nav>
  <a href="/" class:on={isActive('/', { exact: true })}>Home</a>
</nav>

<main><slot /></main>

<style>
  nav { display: flex; gap: 14px; padding: 12px 0 }
  nav a { color: #6b7280; text-decoration: none }
  nav a.on { color: #111; font-weight: 600 }
</style>
`

// ─── A co-located component ───────────────────────────────────────────────────

const makeComponent = (name) => `<script>
  // A component takes props with \`export let\`. The route scanner classifies a
  // PascalCase or _underscore-prefixed name as a component, not a page, so this
  // file can live beside the routes that use it.
  export let label = '${name}'
${SC}

<div class="wrap">{label}</div>

<style>
  .wrap { display: block }
</style>
`
</script>

Creates a page under `src/routes/`. The filename is the URL: `users/edit.mesa`
serves `/users/edit/` and `users/[id].mesa` serves `/users/:id/`. A name
starting with a capital letter or an underscore is classified as a **co-located
component** rather than a page — that is how a component lives beside the routes
that use it.

`--layout` writes `_module.mesa` instead: a layout wrapping this directory and
everything beneath it. Layouts nest rather than replace.

`--resource Invoice` wires the page to `src/resources/invoices.mesa`. It does not
write that file — `fli make:resource` owns that template, and this command tells
you to run it when the resource is missing.

```js
const created = []
const editor  = process.env.EDITOR || 'vi'

// ─── The route file ───────────────────────────────────────────────────────────

const raw  = arg.path.replace(/\.(mesa|md)$/, '').replace(/^\/+|\/+$/g, '')
const file = flag.layout
  ? resolve(context.paths.webPages, raw, '_module.mesa')
  : resolve(context.paths.webPages, raw + '.mesa')

const display = toLabel(basename(raw).replace(/^\[\.\.\./, '').replace(/^\[/, '').replace(/\]$/, ''))

// Params the scanner will pull out of this path — [id] and [...rest] alike.
const params = raw.split('/')
  .filter(seg => /^\[.+\]$/.test(seg))
  .map(seg => seg.replace(/^\[\.\.\./, '').replace(/^\[/, '').replace(/\]$/, ''))

// How deep the file sits below src/routes/, so a relative import resolves.
// Sierra has no `@/` alias — imports are relative or bare package specifiers.
//   routes/invoices.mesa        → 1 segment  → ../resources/…
//   routes/invoices/[id].mesa   → 2 segments → ../../resources/…
//   routes/admin/_module.mesa   → counts the directory it was placed in
const segments = raw.split('/').length + (flag.layout ? 1 : 0)
const up       = '../'.repeat(segments)

const model   = flag.resource ? flag.resource.charAt(0).toUpperCase() + flag.resource.slice(1) : ''
const service = model ? servicePlural(model) : ''

const content = flag.layout ? makeLayout(display)
              : model       ? makeResourcePage(display, service, up)
              :               makePage(display, params)

if (flag.dry) {
  log.dry(`Would create route:     ${file}`)
} else if (existsSync(file)) {
  log.error(`${file} already exists — delete it or edit it directly`)
  return
} else {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  log.success(`Created route:     ${file}`)
  created.push(file)
}

// ─── Named component ──────────────────────────────────────────────────────────

if (flag.component) {
  const cname    = flag.component.replace(/\.mesa$/, '')
  const compPath = resolve(context.paths.webComponents, cname + '.mesa')

  if (flag.dry) {
    log.dry(`Would create component: ${compPath}`)
  } else if (existsSync(compPath)) {
    log.info(`Component ${cname}.mesa already exists — skipping`)
  } else {
    mkdirSync(dirname(compPath), { recursive: true })
    writeFileSync(compPath, makeComponent(cname), 'utf8')
    log.success(`Created component: ${compPath}`)
    created.push(compPath)
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

echo('')

if (!flag.layout) {
  echo(`  URL: /${raw.replace(/\[\.\.\.(\w+)\]/g, '*').replace(/\[(\w+)\]/g, ':$1')}/`)
}

// The route imports the resource whether or not it exists; say so rather than
// letting the dev server be the one to mention it.
if (flag.resource && !existsSync(resolve(context.paths.webResources, `${service}.js`))) {
  echo('')
  log.warn(`The page imports resources/${service}.mesa, which does not exist yet:`)
  echo(`    fli make:resource ${model}`)
}

echo('')
echo('  Sierra rescans src/routes on the next build — restart the dev server if it is running.')
echo('')

if (flag.open && created.length && !flag.dry) {
  for (const f of created) context.exec({ command: `${editor} "${f}"` })
}
```
