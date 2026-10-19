/**
 * build/widget-build.js — one embeddable script per widget.
 *
 * ── Why this is a loop and not a build ────────────────────────────────────
 * A widget is loaded by a `<script src>` on a page that has no bundler, so each
 * one must be a complete IIFE with its runtime and its CSS inside it. Vite's
 * library mode does exactly that and takes ONE entry, so N widgets is N builds.
 * There is no configuration of a single build that emits N self-contained IIFEs:
 * shared chunks are the thing a bundler exists to produce, and they are the one
 * thing a host page cannot load.
 *
 * The cost is real — the Mesa runtime is in every bundle, once per widget on a
 * page that embeds several — and it buys the property that matters: a widget is
 * one file, and a page embedding it needs to know nothing about the others.
 *
 * `buildIslandBundle` is the same shape one realm over (a second Vite build over
 * a generated entry) and for the same reason: what to build is not known until
 * something has been scanned.
 *
 * ── Where a widget LIVES ──────────────────────────────────────────────────
 * `widgets/` is a surface of its own at the app root, a peer of `api/` and
 * `web/` and never a folder inside one. It carries the same six directories
 * every sub-project carries, and every path here is relative to it:
 *
 *     widgets/config/sierra.config.js   target: 'widget'
 *     widgets/src/Embeds/               the entries — this module's `dir`
 *     widgets/test/                     host pages, one per widget
 *     widgets/dist/embeds/              the built scripts
 *     widgets/deploy/                   static hosting, its own release
 *
 * The separation is not tidiness: a widget ships to pages the app does not own,
 * on its own cadence, to a static origin rather than the API's container — so
 * its config, its tests and its release are a different set of answers from the
 * SPA's. An app may have this surface and no `web/` at all.
 *
 * ── What a widget IS ──────────────────────────────────────────────────────
 * A file, or a directory holding one:
 *
 *     src/Embeds/Booking.mesa              → Booking  → dist/embeds/Booking.js
 *     src/Embeds/CleaningLead/index.mesa   → CleaningLead
 *       CleaningLead/AddonCounter.mesa       …its own components, not widgets
 *
 * The directory form is what a widget with parts looks like, and it is why
 * discovery is not a glob: everything under `CleaningLead/` belongs to that
 * widget, and only `index.mesa` is the widget. A flat glob would emit five
 * widgets for one, four of which are half a form with no host page.
 *
 * The name is the file's or the directory's — PascalCase, the same rule a
 * Resource follows (Invariant 19), kebab-cased when it reaches HTML as a tag.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { mkdir, writeFile, rm }  from 'node:fs/promises'
import { resolve, join, basename, extname } from 'node:path'

// The mark is the RUNTIME's: that is the side which has to recognize a
// placeholder nothing replaced (a dev server, where Vite serves the stylesheet
// into the document). It holds only the PREFIX, and the full marker is built
// here — this module is not bundled into a widget, so the concatenation is
// harmless, while the same concatenation in the runtime would be folded into
// the whole literal and then replaced along with the entry's.
import { CSS_MARK, isLegalTag, kebab } from '../widget/index.js'

/**
 * The literal the CSS is swapped into. A widget's stylesheet cannot be a
 * separate file: the host page loads one script, and a `<link>` would land in
 * the host DOCUMENT — where it cannot reach into the shadow root, and where its
 * own rules would leak onto the host page. Those are the two things a widget
 * exists not to do.
 */
export const CSS_PLACEHOLDER = `${CSS_MARK}-css`

/** The widget's declared entry inside a directory form. */
const DIR_ENTRY = ['index.mesa', 'index.js']

/**
 * Everything under `dir` that is a widget.
 *
 * @param {string} dir  absolute path to the embeds directory
 * @returns {Array<{ name: string, entry: string }>} sorted by name
 */
export function discoverWidgets(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const found = []
  for (const name of names.sort()) {
    if (name.startsWith('.') || name.startsWith('_')) continue
    const full = join(dir, name)

    let stat
    try { stat = statSync(full) } catch { continue }

    if (stat.isDirectory()) {
      const entry = DIR_ENTRY.map(f => join(full, f)).find(f => {
        try { return statSync(f).isFile() } catch { return false }
      })
      // A directory with no index is not a widget and not an error — it is
      // where a widget's own components live, one level up from its entry.
      if (entry) found.push({ name, entry })
      continue
    }

    const ext = extname(name)
    if (ext !== '.mesa' && ext !== '.js') continue
    found.push({ name: basename(name, ext), entry: full })
  }
  return found
}

/**
 * Whether a component's source exports `widget`. A false positive costs the
 * bundler warning; a false negative would drop a declaration, so `export *`
 * counts as a yes.
 */
export function declaresWidget(source) {
  return /\bexport\s*(?:(?:const|let|var|function|class)\s+widget\b|\{[^}]*\bwidget\b[^}]*\}|\*)/.test(source)
}

/**
 * The generated entry for one widget.
 *
 * It is generated rather than authored because the alternative is four lines of
 * identical boilerplate in every widget — import the component, import the
 * runtime, read the options, call embed — and boilerplate that is the same in
 * every copy is a thing the build should know instead.
 *
 * `widget` is the component's own declaration, from its `<script module>`, and
 * it wins over the config: the tag a host page writes belongs with the widget,
 * not with the app that happens to build it.
 *
 * `declares` is whether the component exports one. A read of an export that
 * does not exist is a bundler warning about code the author never wrote, and
 * reading it by name through the namespace instead keeps the whole namespace in
 * the bundle.
 */
export function widgetEntrySource(widget, { prefix = '', runtime = '@frontierjs/sierra/widget', declares = true } = {}) {
  return `// Generated by @frontierjs/sierra — do not edit.
// One widget, one script. The host page writes a tag and nothing else.
import Component, * as mod from ${JSON.stringify(widget.entry)}
import { embed } from ${JSON.stringify(runtime)}

// A widget declares its own tag, selector and shadow behavior in
// <script module>; everything it does not say is taken from the build config.
${declares ? 'const declared = mod.widget ?? {}' : 'const declared = {}'}

export default embed(Component, {
  name:   ${JSON.stringify(widget.name)},
  prefix: ${JSON.stringify(prefix)},
  // Swapped for the bundle's own stylesheet at generateBundle — see
  // widgetCssPlugin. Passed as a bare literal on purpose: anything the
  // bundler can evaluate, it evaluates, so a comparison against the
  // placeholder here folds to an empty string before the swap can happen.
  // The runtime recognizes an unreplaced placeholder instead.
  css:    ${JSON.stringify(CSS_PLACEHOLDER)},
  ...declared,
})
`
}

/**
 * Fold the bundle's CSS into its JS.
 *
 * Vite's library mode emits a `style.css` beside the script. For a library that
 * is right; for a widget it is a second request the host page was never told to
 * make, landing in the wrong DOM. So the asset is deleted and its text swapped
 * into the entry chunk, where the runtime puts it in the shadow root.
 *
 * `generateBundle` runs after minification, so the placeholder is matched with
 * ANY of the three quote characters — esbuild rewrites quotes, and a literal
 * search for one of them silently stops matching. It writes BACKTICKS when
 * minifying, which is the default and is what every app ships; the two-quote
 * matcher this replaces therefore worked for exactly the unminified case that
 * the fixture builds and failed for every real one.
 *
 * The failure was total and silent: the CSS asset is deleted here whether or
 * not the swap lands, so an imported stylesheet vanished from the bundle and
 * the literal string `@sierra-widget-css` was handed to the shadow root as its
 * stylesheet. A widget's own scoped `<style>` blocks were unaffected — Mesa
 * registers those through the runtime — which is what made it invisible: the
 * widget looked styled and its imported CSS was simply gone.
 *
 * So the swap is now ASSERTED. The entry always contains the placeholder
 * (`widgetEntrySource` writes it unconditionally), so failing to find one means
 * the matcher no longer matches what the bundler emits, and that must be a
 * failed build rather than a widget shipped with a stylesheet made of nonsense.
 */
export function widgetCssPlugin() {
  return {
    name: 'sierra:widget-css',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      let css = ''
      for (const [key, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'asset' && chunk.fileName.endsWith('.css')) {
          css += typeof chunk.source === 'string' ? chunk.source : ''
          delete bundle[key]
        }
      }

      const marker = new RegExp(`["'\`]${CSS_PLACEHOLDER}["'\`]`, 'g')
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) continue

        const swapped = chunk.code.replace(marker, JSON.stringify(css.trim()))
        if (swapped === chunk.code) {
          throw new Error(
            `[Sierra] widget ${chunk.fileName}: the CSS placeholder was not found in the built ` +
            `entry, so its stylesheet could not be inlined. The bundler has quoted ` +
            `${CSS_PLACEHOLDER} in a way this plugin does not recognize — widgetCssPlugin's ` +
            `matcher needs updating. Shipping is worse than failing here: the CSS asset is ` +
            `already deleted, so the widget would carry the placeholder as its stylesheet.`
          )
        }
        chunk.code = swapped
      }
    },
  }
}

/** The id `widgets/src/dev.js` imports — one module that embeds every widget. */
export const DEV_WIDGETS_ID = 'virtual:sierra-widgets'

/**
 * Where a dev server collects the stylesheets the widgets import. On `globalThis`
 * under a global symbol for the reason `MARK` is one in the runtime: the rewritten
 * module and the dev entry are separate modules and share nothing else.
 */
const DEV_CSS = 'sierra.widget.devcss'

const STYLE_IMPORT = /^([ \t]*)import\s+(['"])([^'"?]+\.(?:css|scss|sass|less|styl|stylus))\2[ \t]*;?[ \t]*$/gm

/**
 * Turn a bare stylesheet import into one that hands its text to the dev entry.
 *
 * Vite serves `import './x.css'` by injecting a `<style>` into the document —
 * right for a page, wrong for a widget, whose stylesheet belongs in the shadow
 * root. The built widget gets that from `widgetCssPlugin`; this is the same
 * routing under `vite dev`, so the harness shows the widget the host page will
 * get and does not restyle its own `<h1>`.
 */
export function inlineStyleImports(code) {
  let n = 0
  return code.replace(STYLE_IMPORT, (_m, indent, q, spec) => {
    const id = `__sierraWidgetCss${n++}`
    return `${indent}import ${id} from ${q}${spec}?inline${q}; ` +
      `(globalThis[Symbol.for('${DEV_CSS}')] ??= new Set()).add(${id})`
  })
}

/**
 * One module that embeds every widget, for `vite dev` to load.
 *
 * Importing a widget's `.mesa` mounts nothing — `embed()` is what defines the
 * tag — so a dev entry that only imported them showed empty tags and no error.
 * This calls the same `embed` the build's generated entry does, with the same
 * options, so the harness and the built script cannot disagree about a tag.
 *
 * Each widget's stylesheet is everything imported up to that point, because
 * module evaluation does not say which import came from which widget. It can
 * carry a neighbor's rules; it cannot miss its own.
 */
export function widgetDevSource(widgets, { prefix = '', runtime = '@frontierjs/sierra/widget' } = {}) {
  const imports = widgets.map((w, i) => `import C${i}, * as M${i} from ${JSON.stringify(w.entry)}`)
  const embeds = widgets.map((w, i) => `embed(C${i}, {
  name:   ${JSON.stringify(w.name)},
  prefix: ${JSON.stringify(prefix)},
  css:    [...(globalThis[Symbol.for('${DEV_CSS}')] ?? [])].join('\\n'),
  ...(M${i}.widget ?? {}),
})`)
  return `// Generated by @frontierjs/sierra for the dev server — do not edit.
${imports.join('\n')}
import { embed } from ${JSON.stringify(runtime)}

${embeds.join('\n')}
`
}

/**
 * Serve `DEV_WIDGETS_ID` and route stylesheet imports to the shadow root.
 * Dev server only; a build never loads either.
 */
export function widgetDevPlugin({ dir = 'src/Embeds', prefix = '' } = {}) {
  let root = process.cwd()
  const resolved = '\0' + DEV_WIDGETS_ID
  return {
    name: 'sierra:widget-dev',
    apply: 'serve',
    // After the Mesa compiler, so what is rewritten is the compiled JS.
    enforce: 'post',
    configResolved(c) { root = c.root },
    resolveId(id) { return id === DEV_WIDGETS_ID ? resolved : null },
    load(id) {
      if (id !== resolved) return null
      return widgetDevSource(discoverWidgets(resolve(root, dir)), { prefix })
    },
    transform(code, id) {
      if (id.startsWith('\0') || !/\.(?:mesa|[mc]?[jt]sx?)(?:$|\?)/.test(id)) return null
      const out = inlineStyleImports(code)
      return out === code ? null : { code: out, map: null }
    },
  }
}

/**
 * Refuse a widget whose tag a browser cannot register — here, not on a
 * stranger's page.
 *
 * `assertTag` throws in the RUNTIME, at module scope, which is correct and is
 * delivered to the wrong person: the prefix defaults to `''` everywhere, so a
 * one-word widget yields the dashless tag `booking`, the build is clean, the
 * deploy is clean, and the script throws on load in every customer's console.
 * Everything needed to know that is here — the name and the prefix — so this is
 * decidable before the first Vite call.
 *
 * A widget may name its own `tag` in `<script module>`, which the build cannot
 * evaluate and the runtime still checks. So the source is asked whether it
 * declares one, and a widget that does is left to the runtime rather than
 * failed on a tag it does not use.
 */
function assertBuildableTags(widgets, prefix) {
  // The prefix is glued to the name, not joined to it: 'mt' + 'basic-lead' is
  // the legal tag <mtbasic-lead>, so the dash check below passes and the host
  // page's <mt-basic-lead> stays an unknown element with no console error.
  if (prefix && !prefix.endsWith('-')) {
    throw new Error(
      `[Sierra] widgets.prefix is ${JSON.stringify(prefix)}, which is glued to each widget name ` +
      `with no separator — a widget named BasicLead becomes <${prefix}basic-lead>, not ` +
      `<${prefix}-basic-lead>. End the prefix in a dash (e.g. '${prefix}-').`
    )
  }
  const bad = []
  for (const widget of widgets) {
    const tag = `${prefix}${kebab(widget.name)}`
    if (isLegalTag(tag)) continue
    let src = ''
    try { src = readFileSync(widget.entry, 'utf8') } catch { /* unreadable is not a tag claim */ }
    if (/(^|[^\w$])tag\s*:/.test(src)) continue
    bad.push({ name: widget.name, tag })
  }
  if (!bad.length) return
  throw new Error(
    `[Sierra] ${bad.map(b => `${b.name} → <${b.tag}>`).join(', ')} — a custom element name must ` +
    `contain a dash, and widgets.prefix is ${JSON.stringify(prefix)}. This builds and deploys ` +
    `clean and then throws on every page that embeds it. Set widgets.prefix (e.g. 'mt-'), give ` +
    `the widget a two-word name, or declare a tag in its <script module>.`
  )
}

/**
 * Build every widget in `dir` into `outDir`, one self-contained IIFE each.
 *
 * @param {object}   opts
 * @param {string}   opts.root       Vite root (the app's web root)
 * @param {string}   [opts.dir='src/Embeds']  relative to root
 * @param {string}   [opts.outDir='dist/embeds'] relative to root
 * @param {string}   [opts.prefix='']  tag/class prefix for every widget
 * @param {Array}    opts.plugins    the Sierra plugin list — the same Mesa
 *                                   compiler the app builds with, not a second
 *                                   one configured by hand
 * @param {Function} opts.viteBuild  `build` from vite, injected so this module
 *                                   stays testable without spawning a build
 * @param {boolean}  [opts.minify=true]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Array<{ name: string, fileName: string }>>}
 */
export async function buildWidgets(opts) {
  const {
    root, dir = 'src/Embeds', outDir = 'dist/embeds', prefix = '',
    plugins = [], viteBuild, minify = true, log = () => {},
  } = opts

  const widgetsDir = resolve(root, dir)
  const widgets    = discoverWidgets(widgetsDir)

  if (!widgets.length) {
    // Not an error: a widget target with nothing in it is a project that has
    // not written one yet. Saying WHERE it looked is the whole message — the
    // failure this replaces was an empty dist and no explanation.
    log(`no widgets found in ${dir}/ — a widget is a .mesa file there, or a directory holding index.mesa`)
    return []
  }

  assertBuildableTags(widgets, prefix)

  const tmpDir = resolve(root, 'node_modules/.sierra')
  await mkdir(tmpDir, { recursive: true })

  const built = []
  for (const widget of widgets) {
    // Written to disk rather than served virtually, for buildIslandBundle's
    // reason: the entry imports its component by absolute path, and a virtual
    // module has no directory to resolve anything against.
    const entryFile = resolve(tmpDir, `widget-${widget.name}.js`)
    const declares = declaresWidget(readFileSync(widget.entry, 'utf8'))
    await writeFile(entryFile, widgetEntrySource(widget, { prefix, declares }), 'utf8')

    try {
      await viteBuild({
        root,
        configFile: false,          // do not re-read the app's config and recurse
        logLevel: 'warn',
        plugins: [...plugins, widgetCssPlugin()],
        build: {
          outDir,
          // Every widget writes into the same directory, one after another.
          emptyOutDir: false,
          minify,
          // A separate .css file is a second thing for the host page to load,
          // and it would land in the document rather than in the shadow root.
          cssCodeSplit: false,
          lib: {
            entry:    entryFile,
            name:     `FjsWidget_${widget.name.replace(/[^A-Za-z0-9_]/g, '_')}`,
            formats:  ['iife'],
            fileName: () => `${widget.name}.js`,
          },
        },
      })
      built.push({ name: widget.name, fileName: `${widget.name}.js` })
      log(`${widget.name} → ${outDir}/${widget.name}.js`)
    } catch (err) {
      // Vite writes the chunk before whatever failed after it, so a failed build
      // leaves a broken script on disk beside the widgets that did build — and
      // `COPY dist/embeds` in the next deploy step ships it. An absent file is
      // loud; a stale one is a page that half works.
      await rm(resolve(root, outDir, `${widget.name}.js`), { force: true }).catch(() => {})
      throw err
    } finally {
      await rm(entryFile, { force: true }).catch(() => {})
    }
  }

  reportUnclaimed(resolve(root, outDir), widgets, log)
  return built
}

/**
 * Name the scripts in `outDir` that no widget here claims.
 *
 * `emptyOutDir: false` is necessary — N builds write into one directory — so
 * nothing prunes, and a widget deleted from `src/Embeds/` keeps shipping
 * forever. Keeping it is the right DEFAULT (a host page still has that URL
 * pasted into it), but it should be an answer rather than an accident, and
 * *what is on this origin and why* has to be askable.
 */
function reportUnclaimed(outAbs, widgets, log) {
  const claimed = new Set(widgets.map(w => `${w.name}.js`))
  let names
  try { names = readdirSync(outAbs) } catch { return }
  const stale = names.filter(n => n.endsWith('.js') && !claimed.has(n)).sort()
  if (!stale.length) return
  log(
    `${stale.join(', ')} — in ${outAbs} and built by no widget in this surface. ` +
    `They are still served: a host page has that URL. Delete them when no page embeds them.`
  )
}
