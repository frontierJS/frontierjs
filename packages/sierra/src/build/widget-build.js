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

import { readdirSync, statSync } from 'node:fs'
import { mkdir, writeFile, rm }  from 'node:fs/promises'
import { resolve, join, basename, extname } from 'node:path'

// The mark is the RUNTIME's: that is the side which has to recognise a
// placeholder nothing replaced (a dev server, where Vite serves the stylesheet
// into the document). It holds only the PREFIX, and the full marker is built
// here — this module is not bundled into a widget, so the concatenation is
// harmless, while the same concatenation in the runtime would be folded into
// the whole literal and then replaced along with the entry's.
import { CSS_MARK } from '../widget/index.js'

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
 */
export function widgetEntrySource(widget, { prefix = '', runtime = '@frontierjs/sierra/widget' } = {}) {
  return `// Generated by @frontierjs/sierra — do not edit.
// One widget, one script. The host page writes a tag and nothing else.
import Component, * as mod from ${JSON.stringify(widget.entry)}
import { embed } from ${JSON.stringify(runtime)}

// A widget declares its own tag, selector and shadow behaviour in
// <script module>; everything it does not say is taken from the build config.
const declared = mod.widget ?? {}

export default embed(Component, {
  name:   ${JSON.stringify(widget.name)},
  prefix: ${JSON.stringify(prefix)},
  // Swapped for the bundle's own stylesheet at generateBundle — see
  // widgetCssPlugin. Passed as a bare literal on purpose: anything the
  // bundler can evaluate, it evaluates, so a comparison against the
  // placeholder here folds to an empty string before the swap can happen.
  // The runtime recognises an unreplaced placeholder instead.
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
            `${CSS_PLACEHOLDER} in a way this plugin does not recognise — widgetCssPlugin's ` +
            `matcher needs updating. Shipping is worse than failing here: the CSS asset is ` +
            `already deleted, so the widget would carry the placeholder as its stylesheet.`
          )
        }
        chunk.code = swapped
      }
    },
  }
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

  const tmpDir = resolve(root, 'node_modules/.sierra')
  await mkdir(tmpDir, { recursive: true })

  const built = []
  for (const widget of widgets) {
    // Written to disk rather than served virtually, for buildIslandBundle's
    // reason: the entry imports its component by absolute path, and a virtual
    // module has no directory to resolve anything against.
    const entryFile = resolve(tmpDir, `widget-${widget.name}.js`)
    await writeFile(entryFile, widgetEntrySource(widget, { prefix }), 'utf8')

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
    } finally {
      await rm(entryFile, { force: true }).catch(() => {})
    }
  }

  return built
}
