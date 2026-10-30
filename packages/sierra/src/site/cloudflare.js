/**
 * site/cloudflare.js — the Cloudflare adapter: a built site → what a Worker runs
 *
 * The only code in the tree that names Cloudflare (`IDEAS/site-hosting.md`).
 * It writes two files into `.sierra/` and states nothing a site wrote: every
 * key of the wrangler config is derived (`FJS-D1213`).
 *
 *   name       `siteUrl`'s host, dots as dashes — `frontierjs.com` → `frontierjs-com`
 *   routes     that host as a custom domain
 *   assets.*   the outDir, `trailingSlash`, and whether the build wrote `404.html`
 *   main       `.sierra/worker.js`, only when the site has host functions
 *   preview_urls  on, because with `routes` set wrangler turns it off
 *
 * A preview is a version of the same Worker, uploaded and not deployed, at
 * `<alias>-<name>.<account>.workers.dev`. The build decides which kind a dist
 * is: a preview build stamps `data-fjs-loc` (`FJS-D838`), so a deploy refuses
 * a dist carrying one and a preview refuses a dist without, and the source
 * paths a reviewer's pins need never reach the production host from here.
 *
 * With functions, `run_worker_first` lists exactly their paths. Workers serves
 * a matching asset BEFORE the script otherwise, and `serveSite` answers a
 * function before its static files, so a function sharing a path with a page
 * would answer under one and not the other. Listing only their paths keeps every
 * page request off the script.
 *
 * Wrangler resolves a config's paths from the config file, not from where it
 * ran, so `directory` is written relative to `.sierra/`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FUNCTIONS_ENTRY, functionRoutes } from '../postbuild/functions.js'
import { htmlFiles } from '../postbuild/html-files.js'

export const WORKER_ENTRY    = join('.sierra', 'worker.js')
export const WRANGLER_CONFIG = join('.sierra', 'wrangler.json')

// What the Worker runtime promises the script. A constant, not a site key: the
// script is Sierra's, and it is Sierra that has been run against this date.
export const COMPATIBILITY_DATE = '2026-09-30'

const HANDLER = fileURLToPath(new URL('../postbuild/function-handler.js', import.meta.url))

const HTML_HANDLING = {
  always:   'force-trailing-slash',
  never:    'drop-trailing-slash',
  preserve: 'auto-trailing-slash',
}

// Cloudflare's own limit. A truncated name could be another site's Worker.
const MAX_NAME = 63

/**
 * The Worker's name, from the one URL a site states.
 *
 * @param {string} [siteUrl]
 * @returns {string}
 */
export function workerName(siteUrl) {
  if (!siteUrl) {
    throw new Error('[Sierra] cloudflare: no siteUrl — the Worker is named for the site\'s host and served at it, so a deploy needs `siteUrl` in the Sierra config')
  }
  let url
  try { url = new URL(siteUrl) } catch {
    throw new Error(`[Sierra] cloudflare: siteUrl ${JSON.stringify(siteUrl)} is not a URL`)
  }
  if (url.pathname !== '/') {
    throw new Error(`[Sierra] cloudflare: siteUrl ${siteUrl} has a path, and a Worker is served at a whole host — name the host alone`)
  }
  const name = url.hostname.replaceAll('.', '-')
  if (name.length > MAX_NAME) {
    throw new Error(`[Sierra] cloudflare: ${url.hostname} makes the Worker name ${name}, ${name.length} characters past Cloudflare's ${MAX_NAME}`)
  }
  return name
}

// Cloudflare's alias rule, and the spelling wrangler gives a branch name.
const ALIAS = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * The alias a preview is uploaded under: the branch, or the name the deployer
 * gave, spelled as wrangler spells a branch.
 *
 * @param {string} name  the Worker's name
 * @param {string} [given]
 * @returns {string}
 */
export function previewAlias(name, given) {
  if (!given) throw new Error('[Sierra] cloudflare: no preview alias — it is the git branch, and HEAD names none; name one')
  const alias = given.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  if (!ALIAS.test(alias)) {
    throw new Error(`[Sierra] cloudflare: preview alias ${JSON.stringify(given)} makes ${JSON.stringify(alias)}, and an alias starts with a letter`)
  }
  const host = `${alias}-${name}`
  if (host.length > MAX_NAME) {
    throw new Error(`[Sierra] cloudflare: preview alias ${alias} makes ${host}, ${host.length} characters past Cloudflare's ${MAX_NAME}; name a shorter one`)
  }
  return alias
}

/** The first page a preview build stamped, or null for a production build. */
export async function stampedPage(outDir) {
  for (const file of await htmlFiles(outDir)) {
    if ((await readFile(file, 'utf8')).includes('data-fjs-loc=')) return file
  }
  return null
}

/**
 * The wrangler config for a built site.
 *
 * @param {object} opts
 * @param {string} opts.root  project root, where `.sierra/` is
 * @param {object} opts.config  the Sierra config — `siteUrl`, `outDir`, `trailingSlash`, `functions`
 * @returns {object}
 */
export function wranglerConfig({ root, config }) {
  const name   = workerName(config.siteUrl)
  const outDir = resolve(root, config.outDir ?? 'dist')
  if (!existsSync(outDir)) {
    throw new Error(`[Sierra] cloudflare: no build at ${relative(root, outDir) || '.'} — the adapter reads what the build wrote; build first`)
  }

  const trailingSlash = config.trailingSlash ?? 'always'
  const assets = {
    directory:          relative(join(root, '.sierra'), outDir),
    html_handling:      HTML_HANDLING[trailingSlash],
    not_found_handling: existsSync(join(outDir, '404.html')) ? '404-page' : 'none',
  }
  if (!assets.html_handling) {
    throw new Error(`[Sierra] cloudflare: trailingSlash ${JSON.stringify(trailingSlash)} has no Workers html_handling — it is one of ${Object.keys(HTML_HANDLING).join(', ')}`)
  }

  const out = { name, compatibility_date: COMPATIBILITY_DATE }
  if (config.functions) {
    const paths = functionRoutes(resolve(root, config.functions)).map(r => r.path)
    out.main = 'worker.js'
    assets.binding = 'ASSETS'
    assets.run_worker_first = paths.flatMap(p => p === '/' ? [p] : [p, `${p}/`])
  }
  out.assets = assets
  // custom_domain has wrangler create the DNS record and the certificate, so
  // the zone must be on the deploying account. www is a zone redirect rule:
  // serving it here too would put every page at two addresses.
  out.routes = [{ pattern: new URL(config.siteUrl).hostname, custom_domain: true }]
  out.preview_urls = true
  return out
}

/** The script: a function where one answers the path, the assets otherwise. */
function workerSource() {
  return [
    '// worker.js — written by Sierra\'s Cloudflare adapter; edit the functions directory instead',
    `import { routes } from './${basename(FUNCTIONS_ENTRY)}'`,
    `import { functionHandler } from ${JSON.stringify(HANDLER)}`,
    '',
    'export default {',
    '  fetch(request, env) {',
    '    const fns = functionHandler(routes, env)',
    '    return fns.has(new URL(request.url).pathname) ? fns.handle(request) : env.ASSETS.fetch(request)',
    '  },',
    '}',
    '',
  ].join('\n')
}

/**
 * Write `.sierra/wrangler.json`, and `.sierra/worker.js` when the site has
 * functions. Reads the build, so it runs after one, and refuses a build of
 * the other kind.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {object} opts.config  the Sierra config
 * @param {boolean} [opts.preview]  the build ships as a preview version
 * @returns {Promise<{ config: string, worker: string | null, wrangler: object }>}
 */
export async function writeCloudflare({ root, config, preview = false }) {
  const wrangler = wranglerConfig({ root, config })
  const outDir   = resolve(root, config.outDir ?? 'dist')
  const stamped  = await stampedPage(outDir)
  if (stamped && !preview) {
    throw new Error(`[Sierra] cloudflare: ${relative(root, stamped)} is a preview build's, stamped with source paths — rebuild without preview, or ship it as a preview`)
  }
  if (!stamped && preview) {
    throw new Error(`[Sierra] cloudflare: ${relative(root, outDir)} is a production build, and a preview needs the source paths a pin anchors to — build it with preview: true (site-kit build --preview, fli site:build --preview)`)
  }
  const dir = join(root, '.sierra')
  await mkdir(dir, { recursive: true })

  let worker = null
  if (wrangler.main) {
    if (!existsSync(join(root, FUNCTIONS_ENTRY))) {
      throw new Error(`[Sierra] cloudflare: no ${FUNCTIONS_ENTRY} — the build writes it from \`functions:\`; build first`)
    }
    worker = join(root, WORKER_ENTRY)
    await writeFile(worker, workerSource(), 'utf8')
  }

  const path = join(root, WRANGLER_CONFIG)
  await writeFile(path, JSON.stringify(wrangler, null, 2) + '\n', 'utf8')
  return { config: path, worker, wrangler }
}

/** What wrangler names a preview after when nothing else does; undefined on a detached HEAD. */
export function gitBranch(cwd) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' })
  const branch = r.status === 0 ? r.stdout.trim() : ''
  return branch && branch !== 'HEAD' ? branch : undefined
}

/**
 * Ship the dist the last build wrote, never a rebuild, so what goes out is
 * what the drive just passed. The one caller of `wrangler deploy` and
 * `wrangler versions upload`: site-kit, `sierra site --deploy` and fli's
 * `site:deploy` all reach Cloudflare through here.
 *
 * Wrangler is the site's, resolved from `root` and run under node; Sierra does
 * not depend on it, so a site that never deploys never installs it.
 *
 * @param {object} opts
 * @param {string} opts.root  project root, where `.sierra/` is
 * @param {object} opts.config  the Sierra config
 * @param {boolean} [opts.preview]  upload a version under an alias, never deployed
 * @param {string} [opts.alias]  the preview's name; the git branch otherwise
 * @param {boolean} [opts.dry]  wrangler's `--dry-run`: bundle, upload nothing
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ name: string, alias: string | null, exitCode: number }>}
 */
export async function deploySite({ root, config, preview = false, alias, dry = false, log = console.log }) {
  const made = await writeCloudflare({ root, config, preview })
  const name = made.wrangler.name
  const named = preview ? previewAlias(name, alias ?? gitBranch(root)) : null

  let wrangler
  try {
    wrangler = resolve(dirname(createRequire(join(root, 'package.json')).resolve('wrangler/package.json')), 'bin/wrangler.js')
  } catch {
    throw new Error(`[Sierra] cloudflare: wrangler does not resolve from ${root}; the site installs it`)
  }

  // A preview is uploaded and never deployed: wrangler prints its version URL,
  // and `<alias>-<name>` follows the latest upload under that alias.
  const verb = named
    ? ['versions', 'upload', '--preview-alias', named, '--tag', 'preview', '--message', `preview: ${named}`]
    : ['deploy']
  const dist = relative(root, resolve(root, config.outDir ?? 'dist'))
  log(named
    ? `\n  ·  ${dist} → a preview version of Worker ${name}, aliased ${named}\n`
    : `\n  ·  ${dist} → Worker ${name} at ${made.wrangler.routes[0].pattern}\n`)
  const run = spawnSync('node', [wrangler, ...verb, '-c', made.config, ...(dry ? ['--dry-run'] : [])], {
    cwd: root, stdio: 'inherit',
  })
  return { name, alias: named, exitCode: run.status ?? 1 }
}
