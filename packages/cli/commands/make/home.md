---
title: make:home
description: Replace the starter tour at web/src/routes/index.mesa with the app's own home — what it is for, where its work stands, and a way into each model
examples:
  - fli make:home
  - fli make:home --title "Greenline" --summary "A lawn care company schedules its crews onto recurring visits."
  - fli make:home --force
  - fli make:home --dry
flags:
  title:
    type: string
    description: The app's name as a person says it. Defaults to the layout's siteName
    defaultValue: ''
  summary:
    type: string
    description: One or two sentences on what the app is for. Defaults to package.json's description
    defaultValue: ''
  force:
    type: boolean
    description: Replace a home page that is not the starter tour
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
</script>

`fli new` lands a person on the tour of the language. Once the app has models
and pages, that is the wrong first screen: this writes the app's own home in its
place. Signed out, it says what the app is for and offers a way in. Signed in,
it shows where the work stands: each `@@transitions` model counted by state,
the latest rows of the working model, and a tile with a count for every model
with a list page.

Only the file system is read at generate time: which models have a Resource in
`src/resources/` and a list page at `src/routes/<service>/index.mesa`, in the
order `db/schema.lite` declares them. A model's states, their labels and its
columns are asked of the Resource when the page runs, so a schema change shows
up on the next reload without running this again. Run it after
`fli scaffold`, or again with `--force` once a new model has pages.

A home page that is not the untouched tour is never replaced without `--force`.

```js
const { homePage, isStarterHome } =
  await import(resolve(global.fliRoot, 'core/home-template.js'))

const pages     = $.paths.webPages
const resources = $.paths.webResources
const target    = resolve(pages, 'index.mesa')

if (existsSync(target) && !flag.force && !isStarterHome(readFileSync(target, 'utf8'))) {
  log.warn(`${target} is not the starter tour — skipping (--force to replace it)`)
  return
}

// Each Resource file names its export, and the export is the service and the
// route directory (`make:scaffold` writes all three from one plural).
const resourceFiles = existsSync(resources) ? readdirSync(resources).filter(f => f.endsWith('.mesa')) : []
const found = []
for (const file of resourceFiles) {
  const src = readFileSync(join(resources, file), 'utf8')
  const m = src.match(/export\s+const\s+(\w+)\s*=\s*createResource\(/)
  if (!m) continue
  const service = m[1]
  if (!existsSync(join(pages, service, 'index.mesa'))) continue
  // Served lowercased (FJS-1821), which is the href the nav links too.
  found.push({ model: file.replace(/\.mesa$/, ''), service, href: `/${service.toLowerCase()}/` })
}

if (!found.length) {
  log.error('No model has both a Resource and a list page — run fli scaffold <Model> first')
  process.exitCode = 1
  return
}

// Schema order, with the people last: the app's own nouns are what it is for.
const schemaPath = resolve($.paths.db, 'schema.lite')
const declared = existsSync(schemaPath)
  ? [...readFileSync(schemaPath, 'utf8').matchAll(/^\s*model\s+([A-Za-z_]\w*)\s*\{/gm)].map(m => m[1])
  : []
const rank = (a) => a.model === 'User' ? Infinity : (declared.indexOf(a.model) + 1 || declared.length + 1)
const areas = found.sort((a, b) => rank(a) - rank(b) || a.model.localeCompare(b.model))

// The layout's siteName, which `fli new` sets to the app's name.
const layoutPath = resolve(pages, '_module.mesa')
const siteName = existsSync(layoutPath)
  ? readFileSync(layoutPath, 'utf8').match(/^siteName:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  : null
const pkgPath = resolve($.paths.root, 'package.json')
const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {}

const title   = flag.title || siteName || pkg.name || 'Home'
const summary = flag.summary || pkg.description || ''
const content = homePage({ title, summary, areas, register: existsSync(join(pages, 'register')) })

if (flag.dry) {
  log.dry(`Would write the home page:  ${target}`)
  echo(`  Areas: ${areas.map(a => a.model).join(', ')}`)
  return
}

writeFileSync(target, content, 'utf8')
log.success(`Wrote home page  ${target}`)
echo(`  Areas: ${areas.map(a => a.model).join(', ')}`)
```
