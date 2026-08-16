---
title: make:extension
description: Create the extension/ surface — a jetty browser extension beside api/ and web/
alias: mke
examples:
  - fli make:extension
  - fli make:extension --dir browser-ext
flags:
  dir:
    type: string
    description: Surface directory, relative to the app root
    defaultValue: extension
  open:
    char: o
    type: boolean
    description: Open the harbor in $EDITOR after creating
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve, join, basename } from 'path'
</script>

Creates `extension/` — a browser extension built by `@frontierjs/jetty`, a
sub-project at the app root beside `api/`, `web/` and `widgets/`.

**It is a surface, not a folder in `web/`**, and further from the SPA than a
widget is. The config emits a *manifest*, and `--browser chrome|firefox|both`
makes the same source two builds. The artefact is loaded unpacked into a browser
profile rather than served, so there is no URL for a drive to point at. And it
ships to two web stores under a review measured in days — on nobody else's
cadence, and never inside the API's container.

```
extension/
  config/jetty.config.js     name, permissions, islands, both browsers' blocks
  src/harbor/index.js        REQUIRED — the service worker, and the only thing
                             here holding a Junction connection
  src/dock/App.mesa          the popup
  src/options/               the options page          (optional)
  src/piers/<name>/          a full-page surface, many (optional)
  src/islands/*.js           content scripts, FLAT — a subfolder throws
  public/icons/              a 128px PNG; a store upload needs one
  test/                      what to load unpacked, and what to check by hand
  deploy/                    packaging for the two stores
  dist/chrome/ dist/firefox/
```

Everything but the harbor is optional and discovered by position —
`packages/jetty/src/build/discover.js` is the contract.

```js
const { scaffoldExtensionSurface, extensionScripts } =
  await import(resolve(global.fliRoot, 'core/extension-surface.js'))

const dir  = flag.dir || 'extension'
const root = context.paths.root
const surface = join(root, dir)
const fresh   = !existsSync(surface)
const appName = basename(root)

if (flag.dry) {
  log.dry(`Would ${fresh ? 'create' : 'top up'} the ${dir}/ surface`)
  return
}

const { written, skipped } = scaffoldExtensionSurface({ root, dir, appName })

for (const f of written) log.success(`Created ${f}`)
if (skipped.length) log.info(`Kept ${skipped.length} existing file(s) — a scaffold never overwrites your config.`)

// jetty is a dependency of the app, not of the CLI: the build binaries come
// from the installed package, so an app without it has a surface that cannot
// be built and nothing saying why.
const pkgPath = join(root, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.scripts ??= {}
  const added = []
  for (const [key, value] of Object.entries(extensionScripts({ dir }))) {
    if (pkg.scripts[key]) continue
    pkg.scripts[key] = value
    added.push(key)
  }
  const hasJetty = pkg.dependencies?.['@frontierjs/jetty'] || pkg.devDependencies?.['@frontierjs/jetty']
  if (!hasJetty) {
    pkg.dependencies ??= {}
    pkg.dependencies['@frontierjs/jetty'] = 'latest'
    log.info('Added @frontierjs/jetty to dependencies — run bun install before building.')
  }
  if (added.length || !hasJetty) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    if (added.length) log.success(`Added scripts: ${added.join(', ')}`)
  }
}

log.info('')
log.info('  fli extension:build     → extension/dist/chrome/')
log.info('  fli extension:dev       watch + reload, dev port 8400')
log.info('  fli extension:audit     permissions declared vs. chrome.* called')
log.info('')
log.info(`  Then load ${dir}/dist/chrome/ unpacked — see ${dir}/test/README.md`)
log.info('')

if (flag.open) {
  const editor = process.env.EDITOR || 'vi'
  context.exec({ command: `${editor} "${join(surface, 'src/harbor/index.js')}"` })
}
```
