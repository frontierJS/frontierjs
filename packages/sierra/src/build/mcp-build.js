/**
 * build/mcp-build.js — one MCP App view per resource file.
 *
 * ── What a view IS ────────────────────────────────────────────────────────
 * The agent's host (Claude, VS Code, Goose) runs a tool's screen in a sandboxed
 * iframe: one HTML document under `text/html;profile=mcp-app`, with no network
 * of its own — every call leaves as `tools/call` through the host
 * (`IDEAS/agent-client-ui.md` § The wire). So a view is a WHOLE document, the
 * Mesa runtime and the stylesheet inside it, and nothing beside it: the host
 * loads no second file, which is the widget build's reason one build over, and
 * why this is a loop of N library builds rather than one build. A shared chunk
 * is the one thing a bundler exists to emit and the one thing this host cannot
 * load.
 *
 * ── Where a view COMES FROM ───────────────────────────────────────────────
 * `src/resources/<Model>.mesa` — the file Invariant 18 already requires, named
 * for its model (Invariant 19), one Resource per file. Nothing new is written
 * in the app; a model with no resource file has no view, and `mcp()`
 * answers text for it, which is not wrong. The output is `<Model>.html`, the
 * name `mcp({ ui: { root } })` reads a document by (`FJS-D955`).
 *
 * ── Where it LANDS ────────────────────────────────────────────────────────
 * `api/dist/mcp/` — the surface that SHIPS it, never `web/dist/`: the API image
 * copies `api/` and drops `web/`, and the SPA build empties its own `dist/`
 * (`FJS-D955`, `FJS-D127`). The directory is handed in absolute by `fli
 * mcp:build`, since fli is the one thing that knows the app's layout.
 *
 * ── Two generated files, in order ─────────────────────────────────────────
 * A resource file calls `createResource()` at IMPORT, and that call reads the
 * schema registry and the page's client the moment it runs. So the boot — the
 * model schemas `virtual:sierra` registers for the SPA, and the relay client
 * `mcpApp()` installs — is its own module, imported FIRST by every entry. An
 * entry that registered schemas in its own body would do so after the
 * resource had already read an empty registry, with every form empty and
 * nothing failing.
 *
 * ── What the view IS ──────────────────────────────────────────────────────
 * The resource file's markup half, where it has one — the model's default
 * form, which Invariant 18 says the file carries (`FJS-D112`). A file with no
 * markup half still compiles, to a component that renders nothing, and a view
 * over it would be an empty document that built clean. So the build reads the
 * file with Mesa's own parser and, where nothing but script and style is in
 * it, writes a THIRD generated module: the form `fli make:resource` would
 * have written, over the file's own Resource — `<Form>` reads the field list
 * off the schema, and `save()` decides create against patch (`FJS-D114`), so
 * the wrapper states neither.
 */

import { readdirSync, statSync } from 'node:fs'
import { mkdir, writeFile, rm, readdir, readFile, stat } from 'node:fs/promises'
import { resolve, join, basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

// The parser that decides whether a resource file has a markup half. Mesa's
// own, found the way the build plugin finds the compiler: a regex over the
// source reads a `'</script>'` string literal as the end of the script, and
// the rest of the file as markup.
import { findMesaFile } from './mesa-plugin.js'

// The device database's worker is a chunk `new Worker(new URL(…))` makes a bundler
// emit wherever the pattern appears, reachable or not. A view never has one —
// the store inside the host is request-response, with no device to persist to —
// so the stub is applied unconditionally, whatever the app's own `offline` says.
import { localDbPlugin } from './local-db-plugin.js'
import { createSierraViteConfig, resolveHtmlClass } from './index.js'
import { resolveSchemaPath, clientSchemas }         from './schema-plugin.js'

/** The runtime a generated entry imports — `src/mcp/index.js`. */
export const VIEW_RUNTIME = '@frontierjs/sierra/mcp'

/**
 * Everything under `dir` that is a Resource.
 *
 * A flat listing on purpose: a Resource is one file (Invariant 19), so a
 * directory here is something else — a resource's own parts, or a mistake —
 * and is left alone rather than guessed at. Leading `.` and `_` are skipped,
 * as the widget build skips them.
 *
 * @param {string} dir  absolute path to the resources directory
 * @returns {Array<{ name: string, entry: string }>} sorted by name
 */
export function discoverResources(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const found = []
  for (const name of names.sort()) {
    if (name.startsWith('.') || name.startsWith('_')) continue
    if (extname(name) !== '.mesa') continue
    const full = join(dir, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isFile()) continue
    found.push({ name: basename(name, '.mesa'), entry: full })
  }
  return found
}

/**
 * The boot every view shares.
 *
 * `schemas` is what `generateSchemas()` answers — the same four tables
 * `virtual:sierra` registers for the SPA, inlined here because the view is
 * one document and has nowhere else to read them from. Null is a build with
 * no schema, which the SPA also tolerates: the boot then says so in the page,
 * as `virtual:sierra` does (`FJS-1649`), because an empty generated form on an
 * agent's screen looks finished.
 *
 * `@frontierjs/css` is imported here because it is the styling language
 * (Invariant 13) and a resource file's default form is the kit's `<Form>`,
 * which is written in it. It resolves from the app's own `node_modules`, as
 * every other import in the entry does.
 *
 * `theme` is the app's `sierra.config.js` theme block, booted as
 * `virtual:sierra` boots it so the host's `hostContext.theme` has the app's
 * own light/dark pair to land on (`applyHostContext`, `mcp/index.js`). With
 * none the switch's defaults are the kit's pair, which is the stylesheet
 * imported above. `persist` is off whatever the app says: a view has no
 * preference of its own — the host states the scheme — and under a sandbox
 * without `allow-same-origin`, reading `localStorage` THROWS, which a
 * `typeof` guard does not catch.
 *
 * @param {{ schemas?: object|null, schemaFailure?: string|null, stylesheet?: string, theme?: object|null }} [opts]
 */
export function viewBootSource({ schemas = null, schemaFailure = null, stylesheet = '@frontierjs/css', theme = null } = {}) {
  const lines = [
    `// Generated by @frontierjs/sierra — do not edit.`,
    `// The boot every view shares. Imported FIRST by each entry: a resource`,
    `// file reads the registry and the client when it is imported.`,
    `import ${JSON.stringify(stylesheet)}`,
    `import { registerSchemas } from '@frontierjs/sierra/resource'`,
    `import { initTheme } from '@frontierjs/sierra/theme'`,
    `import { mcpApp } from ${JSON.stringify(VIEW_RUNTIME)}`,
    ``,
  ]
  if (schemas?.defs) {
    lines.push(
      `registerSchemas(${JSON.stringify(schemas.defs)}, ` +
      `${JSON.stringify(schemas.models ?? null)}, ` +
      `${JSON.stringify(schemas.updatePatch ?? null)}, ` +
      `${JSON.stringify(schemas.readPatch ?? null)})`,
    )
  } else {
    lines.push(
      `console.error(${JSON.stringify(
        `[Sierra] no model schemas reached this view, so every generated form in it is empty: ` +
        (schemaFailure ?? 'no schema.lite was found beside the web root'),
      )})`,
    )
  }
  lines.push(``, `initTheme(${JSON.stringify({ ...(theme ?? {}), persist: false })})`)
  lines.push(``, `mcpApp()`, ``)
  return lines.join('\n')
}

/**
 * The generated entry for one view.
 *
 * Generated for the widget build's reason: identical in every copy, so the
 * build knows it instead. `view` is the module whose default export is
 * mounted — the resource file itself where it has a markup half, and the
 * generated form (`viewFormSource`) where it has none. The resource file's
 * exports go to `startView` either way, since the row the host sends is read
 * through its Resource. The boot is imported first, so it is evaluated before
 * the resource file whichever import reaches that file.
 *
 * @param {{ name: string, entry: string }} resource
 * @param {{ boot: string, view?: string, runtime?: string }} opts
 *   `boot` is the boot module's path; `view` defaults to the resource file
 */
export function viewEntrySource(resource, { boot, view = resource.entry, runtime = VIEW_RUNTIME }) {
  return `// Generated by @frontierjs/sierra — do not edit.
// One view, one document. The host loads this and nothing else.
import ${JSON.stringify(boot)}
import View from ${JSON.stringify(view)}
import * as Resource from ${JSON.stringify(resource.entry)}
import { startView } from ${JSON.stringify(runtime)}

export default startView(View, { name: ${JSON.stringify(resource.name)}, module: Resource })
`
}

/**
 * Does a resource file have a markup half?
 *
 * Over Mesa's own parse: script, style and comment nodes are not markup, and
 * whitespace between them is not either. Anything else — an element, a
 * block, text — is the form the file carries. The question is asked of the
 * SOURCE because the compiled file answers it wrong: a file with no markup
 * still has a default export, a component rendering nothing, and a view over
 * it is an empty document that built clean.
 *
 * @param {string} source
 * @param {(src: string) => { body: Array<{ type: string, value?: string }> }} parseHTML  Mesa's
 */
export function hasMarkupHalf(source, parseHTML) {
  const { body } = parseHTML(source)
  return body.some(n => {
    if (n.type === 'script' || n.type === 'script-module' || n.type === 'style' || n.type === 'comment') return false
    if (n.type === 'text') return n.value.trim() !== ''
    return true
  })
}

/**
 * The generated form over a resource file with no markup half.
 *
 * What `fli make:resource` writes as the file's markup half, cut to what a
 * view has: no cancel (there is no page to go back to), no caption prop, one
 * submit, locked where the model's gate says no caller edits a row. The
 * resource is picked off the module at runtime — the file exports
 * it under the service's name, which the build does not know and does not
 * guess (`resourceIn`). `method` is not stated: `save()` creates when the
 * record has no id and patches when it has one, and that decision has one
 * owner (`FJS-D114`). The kit resolves from the app's node_modules, as the
 * stylesheet does from the boot.
 *
 * @param {{ name: string, entry: string }} resource
 * @param {{ runtime?: string, kit?: string }} [opts]
 */
export function viewFormSource(resource, { runtime = VIEW_RUNTIME, kit = '@frontierjs/ui' } = {}) {
  return `<script module>
  // Generated by @frontierjs/sierra — do not edit.
  // ${resource.name}.mesa has no markup half, so this is its default form.
  import * as Resource from ${JSON.stringify(resource.entry)}
  import { resourceIn } from ${JSON.stringify(runtime)}
  import Form   from ${JSON.stringify(`${kit}/components/forms/Form.mesa`)}
  import Button from ${JSON.stringify(`${kit}/components/forms/Button.mesa`)}

  const resource = resourceIn(Resource, ${JSON.stringify(resource.name)})
  // A view has no level of its own, so only a SYSTEM or LOCKED gate answers
  // no here; the server grades every save regardless (Invariant 6).
  const locked   = !resource.can('update')
</script>

<script>
  export let record = undefined
</script>

<Form {resource} bind:record={record} disabled={locked}>
  <Button slot="actions" type="submit" disabled={locked}>Save</Button>
</Form>
`
}

/**
 * The document around a built view.
 *
 * `htmlClass` is the theme class the SPA would carry on `<html>` — the build's
 * `resolveHtmlClass`, since Sierra owns the theme switch and the class has to
 * be in the FILE here as it is on a prerendered page. The host's own scheme
 * replaces it once `ui/initialize` answers (`applyHostContext`, over the
 * theme the boot initialized). `.app` on `<body>` is the
 * kit's page surface, the class `index.html` carries for the same reason.
 *
 * A `</script` inside the bundle would end the element early and hand the
 * rest of the script to the parser as markup — the one way a file that
 * builds clean fails to parse — so it is escaped on the way in. `\/` is the
 * same character to JavaScript in every string and regex a bundle can hold.
 */
export function viewDocument({ name, htmlClass = '', css = '', script = '' }) {
  const safeScript = script.replace(/<\/script/gi, '<\\/script')
  const safeCss    = css.replace(/<\/style/gi, '<\\/style')
  const cls        = htmlClass ? ` class="${htmlClass}"` : ''
  return `<!doctype html>
<html lang="en"${cls}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>${safeCss}</style>
</head>
<body class="app">
<script>${safeScript}</script>
</body>
</html>
`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/**
 * Fold one library build into one document.
 *
 * Vite's library mode writes a script and, beside it, `style.css`. A view is
 * neither: it is one HTML file, so at `generateBundle` the stylesheet and the
 * entry chunk are taken OUT of the bundle and the document is emitted in their
 * place — the only file this build writes.
 *
 * Anything else in the bundle is refused by name. A second chunk or an asset
 * file is a thing the host would have to load beside the document, which it
 * cannot; shipping the document without it would be a view that half works
 * in a place no console shows.
 */
export function viewDocumentPlugin({ name, htmlClass = '' }) {
  return {
    name: 'sierra:mcp-view',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      let css    = ''
      let script = null
      const left = []

      for (const [key, item] of Object.entries(bundle)) {
        if (item.type === 'asset' && item.fileName.endsWith('.css')) {
          css += typeof item.source === 'string' ? item.source : ''
          delete bundle[key]
        } else if (item.type === 'chunk' && item.isEntry && script === null) {
          script = item.code
          delete bundle[key]
        } else {
          left.push(item.fileName)
        }
      }

      if (script === null) {
        throw new Error(`[Sierra] view ${name}: the build produced no entry chunk, so there is nothing to put in the document.`)
      }
      if (left.length) {
        throw new Error(
          `[Sierra] view ${name}: the build emitted ${left.join(', ')} beside the document. ` +
          `A view is ONE file — the host loads nothing beside it — so a second chunk or an ` +
          `asset file cannot ship. Inline the import (\`?inline\`) or take it out of the resource file.`
        )
      }

      this.emitFile({
        type:     'asset',
        fileName: `${name}.html`,
        source:   viewDocument({ name, htmlClass, css: css.trim(), script }),
      })
    },
  }
}

/**
 * Build every resource file in `dir` into `outDir`, one document each.
 *
 * @param {object}   opts
 * @param {string}   opts.root        Vite root (the app's web root)
 * @param {string}   [opts.dir='src/resources']  relative to root
 * @param {string}   opts.outDir      where the documents go — absolute, from
 *                                    `fli mcp:build` (`FJS-D955`); relative is
 *                                    taken against root, for a test
 * @param {string}   [opts.htmlClass=''] the theme class on `<html>`
 * @param {object|null} [opts.theme]    the app's `theme` config, for the boot
 * @param {object|null} [opts.schemas]  `generateSchemas()`'s answer, or null
 * @param {string|null} [opts.schemaFailure]  why it is null, when a schema was found
 * @param {Array}    opts.plugins     the Sierra plugin list — the same Mesa
 *                                    compiler the app builds with
 * @param {Function} opts.viteBuild   `build` from vite, injected so this module
 *                                    stays testable without spawning a build
 * @param {boolean}  [opts.minify=true]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Array<{ name: string, fileName: string, generated: boolean }>>}
 *   `generated` — the view is the generated form, not the file's own markup
 */
export async function buildViews(opts) {
  const {
    root, dir = 'src/resources', outDir, htmlClass = '', theme = null, schemas = null, schemaFailure = null,
    plugins = [], viteBuild, minify = true, log = () => {},
  } = opts
  if (!outDir) throw new Error('[Sierra] buildViews: outDir is required — fli mcp:build supplies the app\'s own')

  const resourcesDir = resolve(root, dir)
  const resources    = discoverResources(resourcesDir)
  const outAbs       = resolve(root, outDir)

  if (!resources.length) {
    // Not an error: an app with no resource file yet has no view to build.
    // Saying where it looked is the whole message.
    log(`no resource files found in ${dir}/ — a view is built from src/resources/<Model>.mesa`)
    return []
  }

  if (!schemas?.defs) {
    log(`no model schemas — every generated form in these views is empty` +
        (schemaFailure ? `: ${schemaFailure}` : ''))
  }

  const tmpDir = resolve(root, 'node_modules/.sierra')
  await mkdir(tmpDir, { recursive: true })
  await mkdir(outAbs, { recursive: true })

  // Written to disk rather than served virtually, for the widget build's
  // reason: an entry imports its resource file by absolute path, and a
  // virtual module has no directory to resolve anything against.
  const bootFile = resolve(tmpDir, 'mcp-boot.js')
  await writeFile(bootFile, viewBootSource({ schemas, schemaFailure, theme }), 'utf8')

  const parseHTML = await loadParseHTML(root)

  const built = []
  try {
    for (const resource of resources) {
      const entryFile = resolve(tmpDir, `mcp-${resource.name}.js`)
      const formFile  = resolve(tmpDir, `mcp-${resource.name}.form.mesa`)
      const generated = !hasMarkupHalf(await readFile(resource.entry, 'utf8'), parseHTML)
      if (generated) await writeFile(formFile, viewFormSource(resource), 'utf8')
      await writeFile(entryFile, viewEntrySource(resource, { boot: bootFile, view: generated ? formFile : resource.entry }), 'utf8')

      try {
        await viteBuild({
          root,
          configFile: false,          // do not re-read the app's config and recurse
          // Vite copies `public/` into every outDir, library build or not, and
          // a favicon beside the views is a file `mcp()` would read as one.
          publicDir: false,
          logLevel: 'warn',
          plugins: [localDbPlugin({}, {}), ...plugins, viewDocumentPlugin({ name: resource.name, htmlClass })],
          build: {
            outDir: outAbs,
            // Every view writes into the same directory, one after another.
            emptyOutDir: false,
            minify,
            // One stylesheet, folded into the document by the plugin above.
            cssCodeSplit: false,
            lib: {
              entry:    entryFile,
              name:     `FjsView_${resource.name.replace(/[^A-Za-z0-9_]/g, '_')}`,
              formats:  ['iife'],
              fileName: () => `${resource.name}.js`,
            },
          },
        })
        built.push({ name: resource.name, fileName: `${resource.name}.html`, generated })
        // The size, beside the name: the runtime and the schema ride in every
        // document, and a number in the log is what makes the next complaint a
        // measurement (`FJS-785`). Which half the view is, beside it: a form
        // nobody wrote is the one to go looking for.
        log(`${resource.name} → ${resource.name}.html (${await sizeOf(resolve(outAbs, `${resource.name}.html`))}` +
            `${generated ? ', generated form' : ''})`)
      } catch (err) {
        // A failed build can leave the document from the LAST run in place,
        // and `mcp()` serves whatever the directory holds. An absent
        // file is a model with no view; a stale one is a screen that lies.
        await rm(resolve(outAbs, `${resource.name}.html`), { force: true }).catch(() => {})
        throw err
      } finally {
        await rm(entryFile, { force: true }).catch(() => {})
        await rm(formFile, { force: true }).catch(() => {})
      }
    }
  } finally {
    await rm(bootFile, { force: true }).catch(() => {})
  }

  await pruneUnbuilt(outAbs, built, log)
  return built
}

/**
 * Build the views for an app's `sierra.config.js` — `sierra mcp`'s whole body
 * past its refusals.
 *
 * Everything a view shares with the SPA is read off the config by the SPA's
 * own functions: the plugin list (a library build, so `target: 'widget'`, as
 * `sierra widgets` builds), the schema `resolveSchemaPath` finds, the class
 * `resolveHtmlClass` puts on `<html>`, and the `theme` block the boot hands to
 * the switch. A second wiring of any of them is a view that disagrees with the
 * page it was built beside.
 *
 * @param {object} config  the app's sierra config
 * @param {{ outDir: string, viteBuild: Function, minify?: boolean, log?: (msg: string) => void, warn?: (msg: string) => void }} opts
 */
export async function buildViewsFor(config, { outDir, viteBuild, minify = true, log = () => {}, warn = () => {} }) {
  const viteConfig = createSierraViteConfig({ ...config, target: 'widget' })
  const root       = resolve(viteConfig.root ?? process.cwd())
  const schemaPath = resolveSchemaPath(config, root)
  const { generated, failure } = schemaPath
    ? await clientSchemas(schemaPath, warn, root)
    : { generated: null, failure: null }

  return buildViews({
    root, outDir, viteBuild, minify, log,
    htmlClass:     resolveHtmlClass(config),
    theme:         config.theme ?? null,
    schemas:       generated,
    schemaFailure: failure,
    plugins:       viteConfig.plugins ?? [],
  })
}

/**
 * Mesa's `parseHTML`, from the install the build compiles with.
 *
 * Found rather than imported: a bare `@frontierjs/mesa/compiler` from this
 * file resolves to whichever copy sits beside Sierra, which in a workspace is
 * the last install's snapshot, and the one the app's resources compile under
 * is what `findMesaFile` answers.
 */
async function loadParseHTML(root) {
  const file = findMesaFile('compiler.js', root)
  if (!file) throw new Error('[Sierra] buildViews: @frontierjs/mesa is not installed beside this app, so no resource file can be read')
  const { parseHTML } = await import(pathToFileURL(file).href)
  return parseHTML
}

/**
 * Remove the documents in `outDir` that no resource file here built.
 *
 * The widget build REPORTS its strays and keeps them, because a host page has
 * that script's URL pasted into it. Nothing outside this directory names a
 * view: `mcp()` lists what the directory holds, so a document left
 * behind by a deleted resource file would keep being offered to every agent
 * as that model's screen, forever, with nothing to say so. The directory is
 * this loop's own, and it is made to agree with `src/resources/`.
 */
async function pruneUnbuilt(outAbs, built, log) {
  const claimed = new Set(built.map(b => b.fileName))
  let names
  try { names = await readdir(outAbs) } catch { return }
  const stale = names.filter(n => n.endsWith('.html') && !claimed.has(n)).sort()
  for (const n of stale) await rm(join(outAbs, n), { force: true }).catch(() => {})
  if (stale.length) {
    log(`removed ${stale.join(', ')} — built by no resource file in this surface, and mcp() would have served them`)
  }
}

async function sizeOf(file) {
  try { return `${Math.round((await stat(file)).size / 1024)} kB` } catch { return '? kB' }
}
