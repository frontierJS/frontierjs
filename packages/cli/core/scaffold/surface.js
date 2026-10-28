// ─── scaffold/surface.js — what every UI surface's scaffold shares ─────────
//
// web/, site/, widgets/ and desktop/ are each one Vite root beside db/, and
// each scaffold wrote its own vite config, runner, write loop and port
// literals. Hand copies drift: two surfaces lost envDir, so FRONTIER_PUBLIC_*
// from the app's .env never reached them, and the runner had four spellings.
// What differs per surface stays in its own module; what is the same is here.
// A backtick inside a comment inside one of these literals closes the
// literal — plain words or -- quoting.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname }                     from 'node:path'
import { port, PROJECTS, surfacePort }          from '../ports.js'

// ─── ports ────────────────────────────────────────────────────────────────────

/** The port a template falls back to: dev, project 0, which is what fli new writes. */
export function scaffoldPort(category) {
  return port(category, { env: 'dev', projectId: PROJECTS.scaffold })
}

// The name a person or a drive sets to move one surface by hand, read before
// the broker's variable from ports.js.
const OVERRIDE = { web: 'WEB_PORT', site: 'SITE_PORT', widgets: 'WIDGET_PORT', desktop: 'DESKTOP_PORT' }

const commented = (text, mark) => text.trim().split('\n').map(l => l ? `${mark} ${l}` : mark).join('\n')

// ─── writing ──────────────────────────────────────────────────────────────────

/**
 * Create `dirs` and write each `[rel, body]` of `files` under `root/dir` that
 * is absent. A scaffold is called to top a surface up as often as to create
 * one, and one that overwrites a config is a scaffold nobody runs twice.
 *
 * @returns {{ written: string[], skipped: string[] }} paths relative to `root`
 */
export function writeAbsent(root, dir, { dirs = [], files = [] }) {
  const base = resolve(root, dir)
  for (const d of dirs) mkdirSync(resolve(base, d), { recursive: true })

  const written = []
  const skipped = []
  for (const [rel, body] of files) {
    const abs  = resolve(base, rel)
    const name = dir ? `${dir}/${rel}` : rel
    if (existsSync(abs)) { skipped.push(name); continue }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
    written.push(name)
  }
  return { written, skipped }
}

// ─── running vite ─────────────────────────────────────────────────────────────

/**
 * How every vite surface runs vite, from the surface root.
 *
 * `bun --bun`: a route's load() imports the app's own Litestone client, which
 * is TypeScript and opens bun:sqlite. Under node the build reports it as
 * "could not load the db" and dev as an unsupported bun: protocol, and neither
 * names anything the author did.
 *
 * `--env-file=../.env`: the command runs from the surface, so bun auto-loads a
 * .env there and the app's own is not read; a client validating a required
 * variable then refuses to load. A missing file is silently fine.
 *
 * `--configLoader native`: the default loader bundles the config and the whole
 * sierra build tree it imports on every start, before vite reads the app.
 */
export function viteCommand({ build = false } = {}) {
  return `bun --bun --env-file=../.env vite${build ? ' build' : ''} -c config/vite.config.js --configLoader native`
}

/** A package.json script running vite in `dir`. */
export function viteScript(dir, opts) {
  return `cd ${dir} && ${viteCommand(opts)}`
}

// ─── config/vite.config.js ────────────────────────────────────────────────────

/**
 * A surface's vite config. `about` is the header's surface-specific lines.
 * `proxy` sends the API's paths on from the page's own origin; it keys on
 * sierra.config.js's junction.apiPrefix, so the generated sierra config must
 * have one.
 */
export function surfaceViteConfig({ surface, about, port, proxy = false, apiPort = scaffoldPort('be') }) {
  const { category, env } = surfacePort(surface)
  const api = proxy
    ? `
// FRONTIER_PORT_BE is set by the port broker when the app is started through fli,
// which probes before it assigns; the literal is this app's static slot.
const API  = process.env.FRONTIER_API_URL || 'http://localhost:' + (process.env.FRONTIER_PORT_BE ?? ${apiPort})
`
    : ''
  const proxyBlock = proxy
    ? `
    // The page calls its own origin, so every API path has to reach the API
    // from here. Without it they hit Vite's SPA fallback instead: 200, an HTML
    // body, and a client that reports the API answered nonsense. apiPrefix
    // moves every route the app registers, raw ones and the auth plugin's
    // included; /ws is the socket, which is not a route.
    proxy: {
      [sierraConfig.junction.apiPrefix]: { target: API, changeOrigin: true },
      '/ws': { target: API, ws: true },
    },`
    : ''
  return `// ${surface}/config/vite.config.js
${commented(about, '//')}

import { dirname, resolve } from 'node:path'
import { fileURLToPath }    from 'node:url'
import { defineConfig }     from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

// The Vite root is the surface root, one level up from config/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
${api}
const base = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...base,
  root: ROOT,
  // An app has ONE .env, at its root; vite reads the Vite root's otherwise and a
  // FRONTIER_PUBLIC_ variable there reaches nothing.
  envDir: resolve(ROOT, '..'),
  server: {
    // Spread, never replace: Sierra's own server block carries the HMR overlay.
    ...base.server,
    // dev / ${category} / this app's project id -- derived, never chosen. Sierra's
    // own default, 3000, is nobody's slot. See packages/cli/core/ports.js.
    port:       parseInt(process.env.${OVERRIDE[surface]} ?? process.env.${env} ?? '${port}', 10),
    // Vite hops to the next free port without a word, and a drive pointed at
    // the port it hopped from then tests whatever else is listening.
    strictPort: true,${proxyBlock}
  },
})
`
}

// ─── index.html ───────────────────────────────────────────────────────────────

/** A surface's dev shell. `head` and `body` are its own lines, indented by the caller. */
export function surfaceIndexHtml({ title, head = '', bodyClass = '', body }) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
${head}  </head>
  <body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}  </body>
</html>
`
}

// ─── a served surface: deploy/serve.js and deploy/Dockerfile ─────────────────

/**
 * `deploy/serve.js` for a surface that is static files on an origin of its
 * own. The server is Sierra's, so what is tested locally is what runs there.
 */
export function surfaceServe({ surface, dist, serve, from, label, about, servePort }) {
  return `// ${surface}/deploy/serve.js — the ${label} origin.
//
${commented(about, '//')}
//
// The server itself is Sierra's, so what is tested locally is what runs here.

import { ${serve} } from '${from}'

const { url } = await ${serve}({
  dir:  new URL('../${dist}', import.meta.url).pathname,
  port: Number(process.env.PORT ?? ${servePort}),
})

console.log(\`${label} serving at \${url}\`)
`
}

/**
 * `deploy/Dockerfile` for the same. It builds with the app's own `script`, so
 * the image runs what `bun run build` does rather than a second spelling of it.
 */
export function surfaceDockerfile({ surface, dist, script, about, servePort }) {
  return `# ${surface}/deploy/Dockerfile — the ${surface} surface ships on its own.
#
${commented(about, '#')}

# Bun is the version fli ran under when this file was written, so the image
# runs what the app was developed on. Move both FROM lines together.
FROM oven/bun:${Bun.version} AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun run ${script}

FROM oven/bun:${Bun.version}-slim
WORKDIR /app
COPY --from=build /app/${surface}/${dist} ./${surface}/${dist}
COPY --from=build /app/${surface}/deploy ./${surface}/deploy
COPY --from=build /app/node_modules ./node_modules
ENV PORT=${servePort}
EXPOSE ${servePort}
CMD ["bun", "run", "${surface}/deploy/serve.js"]
`
}
