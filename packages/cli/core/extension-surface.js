/**
 * core/extension-surface.js — what an `extension/` surface IS.
 *
 * The sibling of `core/widget-surface.js`, and the same rule: one owner, called
 * by `fli new --extension` and by `fli make:extension`, so the app a scaffold
 * writes is the app the next command extends.
 *
 * ── Why an extension is a surface and not a folder in web/ ────────────────
 *
 * `extension/` sits at the app root beside `api/`, `web/` and `widgets/`, with
 * the same six directories. Every answer differs from the SPA's, and further
 * than a widget's do:
 *
 *   • **Config** — `config/jetty.config.js`, not a Vite config the app owns.
 *     Jetty's build emits a manifest, a service worker, a popup and N content
 *     scripts from one directory tree; `--browser=chrome|firefox|both` makes
 *     the same source two different builds, which no `vite build` models.
 *   • **Testing** — the artefact is loaded unpacked into a browser profile,
 *     against permissions declared in the manifest. There is no dev server to
 *     point a drive at.
 *   • **Deployment** — a signed upload to two web stores under a review
 *     process measured in days, on nobody else's cadence. `deploy/` here holds
 *     packaging, not a container.
 *
 * An app may have this surface and no `web/` at all: a project whose product is
 * a browser extension is a normal FrontierJS project.
 *
 * ── What jetty requires ───────────────────────────────────────────────────
 *
 * `src/harbor/index.js` and nothing else — the discovery contract is in
 * `packages/jetty/src/build/discover.js`, which is the source for this file's
 * shape rather than a copy made here:
 *
 *     src/harbor/index.js            required — the service worker
 *     src/dock/App.mesa | main.js    the popup
 *     src/options/App.mesa | main.js the options page
 *     src/piers/{name}/              a full-page surface, many
 *     src/islands/*.js               content scripts, FLAT — a subfolder throws
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

/** The six, minus `dist/`, which a build writes as `dist/chrome` + `dist/firefox`. */
export const EXTENSION_SURFACE_DIRS = [
  'config',
  'src/harbor',
  'src/dock',
  'src/islands',
  'public/icons',
  'test',
  'deploy',
]

// ─── config ───────────────────────────────────────────────────────────────────

export function jettyConfig({ appName = 'app', tokenKey = 'app_token', port = 8400 } = {}) {
  return `// extension/config/jetty.config.js
// One config, both browsers. \`--browser=chrome|firefox|both\` decides which
// manifest jetty emits; the fields that differ between them are the two blocks
// at the bottom, and everything above is shared.

export default {
  name:        '${appName}',
  description: 'A FrontierJS browser extension.',
  version:     '0.0.1',
  // A store upload needs one. Put a 128px PNG here and jetty derives the
  // manifest's icon sizes from it; with no icon the build still succeeds, which
  // is why this is a comment rather than a broken path.
  // icon:      'public/icons/icon-128.png',

  permissions: {
    // What the manifest asks the user for. The audit compares this against the
    // chrome.* calls it finds in the built bundles and reports both directions:
    // a permission you use and did not declare, and one you declared and do not
    // use. 'strict' fails the build instead of logging.
    declared: ['storage'],
    audit:    'warn',
  },
  hostPermissions: [],

  // 8400 = dev / ext / project 0 / service 0. The dev server pushes reloads to
  // the loaded-unpacked extension over this port; see CLAUDE.md § Ports.
  dev: { port: ${port} },

  // One entry per file in src/islands/. The file is discovered; this is where
  // the pages it runs on are declared, because a content script's matches[] end
  // up in the manifest and are a permission question.
  islands: {},

  browsers: ['chrome', 'firefox'],

  chrome:  { minVersion: 110 },
  firefox: {
    // Required by AMO for a stable id across releases. Change it before the
    // first upload; changing it after is a different add-on.
    geckoId:          '${appName}@example.com',
    strictMinVersion: 121,
  },

  junction: {
    // The harbor holds the only connection — a dock, an options page and every
    // island talk to Junction THROUGH it, over the port protocol, so a service
    // worker that sleeps does not leave four half-open sockets behind.
    url:      'ws://localhost:8100',
    tokenKey: '${tokenKey}',
  },
}
`
}

// ─── the entries ──────────────────────────────────────────────────────────────

export function harborEntry() {
  return `// extension/src/harbor/index.js — the service worker, and the only
// thing here that holds a connection.
//
// Required: jetty's discovery throws without it. MV3 stops a service worker
// whenever it feels like it, so treat \`run\` as something that happens many
// times and keep state in \`storage\`, never in a module-level variable.

import { defineHarbor } from '@frontierjs/jetty'
import jettyConfig      from '../../config/jetty.config.js'

export default defineHarbor({
  junction: jettyConfig.junction,

  // Passed through so the harbor can re-register content scripts on every
  // wake — chrome.scripting registrations do not survive an extension update.
  islands: jettyConfig.islands,

  async run({ storage, junction, pages, channels }) {
    channels.on('connection', ({ type, id }) => {
      console.log('[harbor] connection:', type, id)
    })

    await storage.local.set({ lastWake: Date.now() })
    console.log('[harbor] awake; junction connected?', junction.isConnected())
    void pages
  },
})
`
}

export function dockApp({ appName = 'app' } = {}) {
  return `<script>
  // The popup. It has no connection of its own — \`props.harbor\` is the port to
  // the service worker, and every service call goes through it.
  export let harbor = null

  let lastEvent = 'none'
</script>

<div class="dock">
  <h1>${appName}</h1>
  <p>Harbor: {harbor ? 'connected' : 'not connected'}</p>
  <p>Last event: {lastEvent}</p>
</div>

<style>
  .dock { font: 14px system-ui, sans-serif; padding: 1rem; min-width: 320px; }
  h1    { font-size: 1.1rem; margin: 0 0 0.5rem; }
</style>
`
}

/**
 * Two generated directories, and neither is source.
 *
 * `dist/` is the loaded-unpacked artefact, one per browser. `.jetty-cache/` is
 * where the build writes the entries it generates from what it discovered —
 * a dock's `main.js`, a popup's HTML — and it is regenerated on every build.
 * Written as the surface's OWN ignore file rather than merged into the app's:
 * a merge has to decide what to do with a rule that is already there, and this
 * cannot be wrong.
 */
export function extensionGitignore() {
  return `# Built by \`fli extension:build\` — one directory per browser, loaded
# unpacked from there. Never committed.
dist/

# The entries the build generates from what it discovered. Regenerated every
# time; committing it is committing a compiler's scratch directory.
.jetty-cache/
`
}

export function extensionTestReadme({ appName = 'app' } = {}) {
  return `# Testing ${appName}

An extension is proved in a browser profile, not against a dev server — there is
no URL to point a drive at, and the permissions being tested live in a manifest
the build emits.

\`\`\`sh
fli extension:build              # → extension/dist/chrome/
fli extension:dev                # watch + reload over the dev port (8400)
fli extension:audit              # permissions declared vs. chrome.* actually called
\`\`\`

Then **chrome://extensions → Developer mode → Load unpacked →
\`extension/dist/chrome/\`**, or, for Firefox, **about:debugging → This Firefox →
Load Temporary Add-on →** \`extension/dist/firefox/manifest.json\`.

What to check by hand, because nothing here can:

- the popup opens and reports the harbor connected
- a content script runs on the pages \`islands\` declares and on no others
- the service worker survives being stopped (\`chrome://serviceworker-internals\`)
  — state kept in a module-level variable does not
`
}

export function extensionDeployReadme({ appName = 'app' } = {}) {
  return `# Shipping ${appName}

Two stores, two review queues, and neither is the API's deploy. This directory
holds packaging; nothing is containerised.

\`\`\`sh
fli extension:build --browser both      # dist/chrome/ and dist/firefox/
cd extension/dist/chrome  && zip -r ../../deploy/chrome.zip .
cd extension/dist/firefox && zip -r ../../deploy/firefox.zip .
\`\`\`

- **Chrome Web Store** — upload the zip at the developer dashboard. Review is
  usually days; a permission added since the last version restarts it.
- **AMO (Firefox)** — the \`geckoId\` in \`config/jetty.config.js\` is the add-on's
  identity. Changing it after the first upload publishes a different add-on that
  nobody has installed.

**\`version\` in \`config/jetty.config.js\` is the manifest's**, and a store
refuses an upload that does not raise it.
`
}

// ─── writing it ───────────────────────────────────────────────────────────────

/**
 * Create the surface. Every file is written only when absent, for the reason
 * the widget surface does it: this is called to extend as often as to create.
 *
 * @returns {{ written: string[], skipped: string[] }} paths relative to `root`
 */
export function scaffoldExtensionSurface({
  root, dir = 'extension', appName = 'app', devPort = 8400,
} = {}) {
  const base = resolve(root, dir)
  for (const d of EXTENSION_SURFACE_DIRS) mkdirSync(resolve(base, d), { recursive: true })

  const files = [
    ['.gitignore',             extensionGitignore()],
    ['config/jetty.config.js', jettyConfig({ appName, tokenKey: `${appName}_token`, port: devPort })],
    ['src/harbor/index.js',    harborEntry()],
    ['src/dock/App.mesa',      dockApp({ appName })],
    ['test/README.md',         extensionTestReadme({ appName })],
    ['deploy/README.md',       extensionDeployReadme({ appName })],
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

/** The scripts an app with this surface runs. Merged by the caller. */
export function extensionScripts({ dir = 'extension' } = {}) {
  return {
    'dev:extension':   `bunx jetty-dev-ext --root=${dir} --browser=chrome`,
    'build:extension': `bunx jetty-build-ext --root=${dir} --browser=chrome`,
    'audit:extension': `bunx jetty-audit --root=${dir}`,
  }
}
