/**
 * core/widget-surface.js — what a `widgets/` surface IS.
 *
 * The one owner of the widget surface's shape, called by `fli make:widget` and
 * by `fli new --widgets`. Two generators writing the same directory is how an
 * app scaffolded one way ends up unable to run the command that extends it.
 *
 * ── Why widgets are a surface and not a folder in web/ ────────────────────
 *
 * `widgets/` sits at the app root beside `api/` and `web/`, with the same six
 * directories every sub-project has. That is not symmetry for its own sake —
 * every answer differs from the SPA's:
 *
 *   • **Config** — one Vite root per surface, and a widget's is not the SPA's.
 *     `target: 'widget'` builds N self-contained IIFEs; `spa` builds one app.
 *   • **Testing** — a widget is proved on a page the app does not own, by a
 *     host page per widget in `widgets/test/`. There is no router to drive and
 *     no app shell to mount.
 *   • **Deployment** — static files on an origin a stranger's page links to,
 *     released on the cadence of the pages that embed them, which is nobody
 *     else's cadence. The API's container and the SPA's bundle ship separately
 *     and can ship without it.
 *
 * An app may have this surface and no `web/` at all: a project whose whole
 * product is embeddable widgets is a normal FrontierJS project, and `db/` +
 * `api/` + `widgets/` is its layout.
 */

import {
  scaffoldPort, writeAbsent, viteScript, surfaceViteConfig, surfaceIndexHtml, surfaceServe, surfaceDockerfile,
} from './scaffold/surface.js'

/** The six, minus the ones a build writes. `dist/` is output, never scaffolded. */
export const WIDGET_SURFACE_DIRS = [
  'config',
  'src/Embeds',
  'src/styles',
  'public',
  'test',
  'deploy',
]

/**
 * PascalCase, singular — a widget name is a component name (Invariant 19), and
 * it is also the tag a host page writes, so a bad one is visible on somebody
 * else's site.
 */
export function isWidgetName(name) {
  return /^[A-Z][A-Za-z0-9]*$/.test(name)
}

/**
 * Is this a tag a browser will register?
 *
 * Mirrors sierra's `isLegalTag`, which owns the runtime half — the cli does not
 * depend on sierra, the same reason `widgetTag` mirrors `kebab`. A custom
 * element name must contain a dash, and the prefix defaults to empty, so a
 * one-word widget scaffolds a tag that builds, deploys and then throws on every
 * page that embeds it. The check exists; without this it runs in a stranger's
 * browser.
 */
export function isLegalWidgetTag(tag) {
  return /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(String(tag))
}

/** `LeadForm` → `lead-form`. Mirrors sierra's `kebab`, which owns the runtime half. */
export function widgetTag(name, prefix = '') {
  return prefix + String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

// ─── config ───────────────────────────────────────────────────────────────────

export function widgetSierraConfig({ prefix = '' } = {}) {
  return `// widgets/config/sierra.config.js
// One config is one target. Paths are relative to the Vite root — the widgets/
// surface — since every widget command runs from here, never from the app root.

export default {
  target: 'widget',

  widgets: {
    // A widget is a .mesa file in here, or a directory holding index.mesa. A
    // .mesa BESIDE an index.mesa is that widget's own component and is not
    // built as a second script.
    dir:    'src/Embeds',
    outDir: 'dist/embeds',
    // Every widget's tag and class take this, glued to the name with no
    // separator, so end it in a dash: 'mt-' gives <mt-basic-lead>, 'mt' gives
    // <mtbasic-lead>. Two vendors' widgets land on the same page more often
    // than anyone expects, and a prefix is what keeps <booking> from being a
    // name both of them claimed.
    prefix: ${JSON.stringify(prefix)},
  },
}
`
}

export function widgetViteConfig({ port = scaffoldPort('widgetDev') } = {}) {
  return surfaceViteConfig({ surface: 'widgets', port, about: `
vite dev here is how a widget is WRITTEN -- index.html hosts them live.
fli widgets:build (sierra widgets) is what emits the embeddable scripts,
because each one is its own library build. See sierra build/widget-build.js.
` })
}

// ─── the dev harness page ─────────────────────────────────────────────────────

export function widgetIndexHtml({ appName = 'app', tag } = {}) {
  return surfaceIndexHtml({ title: `${appName} widgets`, body: `    <!-- The dev harness: what a widget looks like while it is being written.
         The pages that PROVE one live in test/, where each has the host CSS
         and the script tag a real embed has. -->
    <h1>${appName} widgets</h1>
    <${tag}></${tag}>
    <script type="module" src="/src/dev.js"></script>
` })
}

export function widgetDevEntry() {
  return `// widgets/src/dev.js — the dev harness entry, not part of any bundle.
// \`sierra widgets\` generates its own entry per widget; this one is served by
// Sierra's dev plugin and calls the same embed() for every widget in
// src/Embeds/, with each stylesheet routed to its shadow root.

import 'virtual:sierra-widgets'
`
}

// ─── a starter widget, and the page that proves it ────────────────────────────

export function widgetStarter({ name, prefix = '' }) {
  const tag = widgetTag(name, prefix)
  return `<script module>
  // A widget declares how a host page finds it. Anything not said here comes
  // from the build config — the tag is the file name, kebab-cased, under the
  // configured prefix: <${tag}>.
  export const widget = {
    // Uncomment for pages that already ship markup nobody can edit:
    // selector: '.${tag}',
  }
</script>

<script>
  // Props are data-* attributes, so they arrive as STRINGS — <${tag}
  // data-label="Book now"> is \`label\`. A widget parses what it needs; guessing
  // here would make data-id="007" a number.
  //
  // They are read ONCE, at mount: a host page that rewrites data-label after the
  // widget is up changes nothing. A widget that has to follow a value on the
  // host page reads it from an endpoint instead.
  export let label = 'Book now'
</script>

<button class="widget-button" onclick={() => alert('${name}')}>{label}</button>

<style>
  /* Scoped to this component and mounted in a shadow root, so the host page's
     own button rules cannot reach it and these cannot reach the host page. */
  .widget-button {
    font: inherit;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    border: 1px solid currentColor;
    cursor: pointer;
  }
</style>
`
}

export function widgetHostPage({ name, prefix = '', appName = 'app', servePort = scaffoldPort('widgetServe') }) {
  const tag = widgetTag(name, prefix)
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${name} — on a page ${appName} does not own</title>
    <style>
      /* A host page's CSS is not written to be helpful. Keep something hostile
         here: a widget that is not isolated only looks broken elsewhere. */
      * { box-sizing: content-box; }
      button { background: red !important; font-size: 40px !important; }
    </style>
  </head>
  <body>
    <h1>Host page</h1>
    <${tag} data-label="Book now"></${tag}>

    <!-- Point this at wherever the widgets are served from. \`fli widgets:serve\`
         serves dist/embeds with the CORS and cache headers it deploys with, so
         a local check and the real thing answer the same. -->
    <script defer src="http://localhost:${servePort}/${name}.js"></script>
  </body>
</html>
`
}

// ─── deployment ───────────────────────────────────────────────────────────────

export function widgetServeEntry({ servePort = scaffoldPort('widgetServe') } = {}) {
  return surfaceServe({
    surface: 'widgets', dist: 'dist/embeds', label: 'widgets', servePort,
    serve: 'serveWidgets', from: '@frontierjs/sierra/widget/serve',
    about: `
Static files and nothing else, with the two headers an embed depends on: CORS
(the host page is on another origin by definition) and a cache answer per file
kind (the entry's URL was pasted into a CMS a year ago and cannot change, so
only content-addressed assets may be immutable).
`,
  })
}

export function widgetDockerfile({ servePort = scaffoldPort('widgetServe') } = {}) {
  return surfaceDockerfile({
    surface: 'widgets', dist: 'dist/embeds', servePort,
    script: 'build:widgets',
    about: `
It is not in the API's image: a widget is released when the pages embedding it
are ready, which is not when the API is, and a static origin is a different
thing to run from an application server.
`,
  })
}

// ─── writing it ───────────────────────────────────────────────────────────────

/**
 * Create the surface, and the widget named in it, writing only what is absent
 * (`writeAbsent`) — this is called to ADD a widget to a surface that exists as
 * often as to create one.
 */
export function scaffoldWidgetSurface({
  root, dir = 'widgets', name = 'HelloWidget', prefix = '', appName = 'app',
  devPort = scaffoldPort('widgetDev'), servePort = scaffoldPort('widgetServe'),
} = {}) {
  if (!isWidgetName(name)) {
    throw new Error(
      `"${name}" is not a widget name — PascalCase, singular, like a component ` +
      `(Invariant 19). It is also the tag a host page writes.`
    )
  }

  if (prefix && !prefix.endsWith('-')) {
    throw new Error(
      `--prefix ${JSON.stringify(prefix)} is glued to the widget name, so ${name} would be ` +
      `<${widgetTag(name, prefix)}>, not <${widgetTag(name, prefix + '-')}>. End the prefix in a dash (e.g. '${prefix}-').`
    )
  }

  const scaffoldTag = widgetTag(name, prefix)
  if (!isLegalWidgetTag(scaffoldTag)) {
    throw new Error(
      `"${name}" under prefix ${JSON.stringify(prefix)} is the tag <${scaffoldTag}>, which no ` +
      `browser will register — a custom element name must contain a dash. Pass ` +
      `--prefix (e.g. 'mt-'), or name the widget with two words.`
    )
  }

  return writeAbsent(root, dir, { dirs: WIDGET_SURFACE_DIRS, files: [
    ['config/sierra.config.js',      widgetSierraConfig({ prefix })],
    ['config/vite.config.js',        widgetViteConfig({ port: devPort })],
    ['index.html',                   widgetIndexHtml({ appName, tag: scaffoldTag })],
    ['src/dev.js',                   widgetDevEntry()],
    [`src/Embeds/${name}.mesa`,      widgetStarter({ name, prefix })],
    [`test/${scaffoldTag}.html`,     widgetHostPage({ name, prefix, appName, servePort })],
    ['deploy/serve.js',              widgetServeEntry({ servePort })],
    ['deploy/Dockerfile',            widgetDockerfile({ servePort })],
  ] })
}

/**
 * The scripts an app with this surface runs. Merged into package.json by the
 * caller, because `fli new` writes that file once and `make:widget` edits one
 * that exists.
 */
export function widgetScripts({ dir = 'widgets', servePort = scaffoldPort('widgetServe') } = {}) {
  return {
    'dev:widgets':   viteScript(dir),
    'build:widgets': `cd ${dir} && sierra widgets --config config/sierra.config.js`,
    'serve:widgets': `cd ${dir} && sierra widgets --config config/sierra.config.js --serve --port ${servePort}`,
  }
}
