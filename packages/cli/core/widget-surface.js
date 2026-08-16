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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

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
    // Every widget's tag and class take this. Two vendors' widgets land on the
    // same page more often than anyone expects, and a prefix is what keeps
    // <booking> from being a name both of them claimed.
    prefix: ${JSON.stringify(prefix)},
  },
}
`
}

export function widgetViteConfig({ port = 8200 } = {}) {
  return `// widgets/config/vite.config.js
// \`vite dev\` here is how a widget is WRITTEN — index.html hosts them live.
// \`fli widgets:build\` (sierra widgets) is what emits the embeddable scripts,
// because each one is its own library build. See sierra build/widget-build.js.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

// The Vite root is the surface root, one level up from config/ — the same
// relationship web/config/vite.config.js has to web/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const base = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...base,
  root: ROOT,
  server: {
    ...base.server,
    // 8200 = dev / widgetDev / project 0. The SPA is 8000 and the API is 8100;
    // a widget surface is a third server and needs a slot of its own. See
    // packages/cli/core/ports.js.
    port:       parseInt(process.env.WIDGET_PORT ?? process.env.FLI_PORT_WIDGET ?? '${port}', 10),
    // Vite hops to the next free port without a word, and the drive pointed at
    // the port it hopped from then tests whatever else is listening.
    strictPort: true,
  },
})
`
}

// ─── the dev harness page ─────────────────────────────────────────────────────

export function widgetIndexHtml({ appName = 'app', name, tag } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${appName} widgets</title>
  </head>
  <body>
    <!-- The dev harness: what a widget looks like while it is being written.
         The pages that PROVE one live in test/, where each has the host CSS
         and the script tag a real embed has. -->
    <h1>${appName} widgets</h1>
    <${tag}></${tag}>
    <script type="module" src="/src/dev.js"></script>
  </body>
</html>
`
}

export function widgetDevEntry({ name } = {}) {
  return `// widgets/src/dev.js — the dev harness entry, not part of any bundle.
// \`sierra widgets\` generates its own entry per widget; this file exists so
// \`vite dev\` has something to load while a widget is being written.

import './Embeds/${name}.mesa'
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

export function widgetHostPage({ name, prefix = '', appName = 'app' }) {
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
    <script defer src="http://localhost:8300/${name}.js"></script>
  </body>
</html>
`
}

// ─── deployment ───────────────────────────────────────────────────────────────

export function widgetServeEntry() {
  return `// widgets/deploy/serve.js — the widget origin.
//
// Static files and nothing else, with the two headers an embed depends on: CORS
// (the host page is on another origin by definition) and a cache answer per file
// kind (the entry's URL was pasted into a CMS a year ago and cannot change, so
// only content-addressed assets may be immutable).
//
// The server itself is Sierra's, so what is tested locally is what runs here.

import { serveWidgets } from '@frontierjs/sierra/widget/serve'

const { url } = await serveWidgets({
  dir:  new URL('../dist/embeds', import.meta.url).pathname,
  port: Number(process.env.PORT ?? 8300),
})

console.log(\`widgets serving at \${url}\`)
`
}

export function widgetDockerfile() {
  return `# widgets/deploy/Dockerfile — the widget surface ships on its own.
#
# It is not in the API's image: a widget is released when the pages embedding it
# are ready, which is not when the API is, and a static origin is a different
# thing to run from an application server.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN cd widgets && bunx sierra widgets --config config/sierra.config.js

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/widgets/dist/embeds ./widgets/dist/embeds
COPY --from=build /app/widgets/deploy ./widgets/deploy
COPY --from=build /app/node_modules ./node_modules
ENV PORT=8300
EXPOSE 8300
CMD ["bun", "run", "widgets/deploy/serve.js"]
`
}

// ─── writing it ───────────────────────────────────────────────────────────────

/**
 * Create the surface, and the widget named in it.
 *
 * Every file is written only when it is absent — this is called to ADD a widget
 * to a surface that already exists as often as it is called to create one, and
 * a scaffold that overwrites a config is a scaffold nobody runs twice.
 *
 * @returns {{ written: string[], skipped: string[] }} paths relative to `root`
 */
export function scaffoldWidgetSurface({
  root, dir = 'widgets', name = 'Hello', prefix = '', appName = 'app', devPort = 8200,
} = {}) {
  if (!isWidgetName(name)) {
    throw new Error(
      `"${name}" is not a widget name — PascalCase, singular, like a component ` +
      `(Invariant 19). It is also the tag a host page writes.`
    )
  }

  const base = resolve(root, dir)
  for (const d of WIDGET_SURFACE_DIRS) mkdirSync(resolve(base, d), { recursive: true })

  const files = [
    ['config/sierra.config.js',       widgetSierraConfig({ prefix })],
    ['config/vite.config.js',         widgetViteConfig({ port: devPort })],
    ['index.html',                    widgetIndexHtml({ appName, name, tag: widgetTag(name, prefix) })],
    ['src/dev.js',                    widgetDevEntry({ name })],
    [`src/Embeds/${name}.mesa`,       widgetStarter({ name, prefix })],
    [`test/${widgetTag(name, prefix)}.html`, widgetHostPage({ name, prefix, appName })],
    ['deploy/serve.js',               widgetServeEntry()],
    ['deploy/Dockerfile',             widgetDockerfile()],
  ]

  const written = []
  const skipped = []
  for (const [rel, body] of files) {
    const abs = resolve(base, rel)
    if (existsSync(abs)) { skipped.push(`${dir}/${rel}`); continue }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
    written.push(`${dir}/${rel}`)
  }
  return { written, skipped }
}

/**
 * The scripts an app with this surface runs. Merged into package.json by the
 * caller, because `fli new` writes that file once and `make:widget` edits one
 * that exists.
 */
export function widgetScripts({ dir = 'widgets' } = {}) {
  return {
    'dev:widgets':   `cd ${dir} && vite -c config/vite.config.js`,
    'build:widgets': `cd ${dir} && bunx sierra widgets --config config/sierra.config.js`,
    'serve:widgets': `cd ${dir} && bunx sierra widgets --config config/sierra.config.js --serve --port 8300`,
  }
}
