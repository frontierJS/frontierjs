// fetch/run.js — `runFetch(opts)`: an existing site's pages into a site-kit
// site, for `site-kit fetch <dir> <target>`. Each page's HTML becomes a
// Markdown route under content/routes/, its <meta> becomes front-matter, and
// an image a config's transform names is downloaded under content/public/.
//
// The target is a page URL, a sitemap URL or a local sitemap file. A sitemap
// index is walked (three levels), and a sitemap extension's <image:loc> or
// <video:loc> is dropped first, or every asset URL is fetched as a page.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const KNOWN_KEYS = new Set([
  'sitemap', 'select', 'prefix', 'strip',
  'excludeList', 'includeList',
  'frontmatter', 'image', 'cleanup',
])
const PLACEHOLDER_SITEMAP = 'https://example.com/sitemap.xml'

/** A config file's `config` (or default) export. */
export async function loadFetchConfig(path) {
  const mod = await import(pathToFileURL(resolve(path)).href)
  return mod.config ?? mod.default ?? {}
}

/** `{ errors, warnings }` for a loaded config: an error stops the run, an unknown key warns (a typo is the usual cause). */
export function validateFetchConfig(config) {
  const errors = []
  const warnings = []
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
  const isStr = (v) => typeof v === 'string'

  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown config key '${key}' — possible typo? (known: ${[...KNOWN_KEYS].join(', ')})`)
  }

  if ('sitemap' in config) {
    if (!isStr(config.sitemap)) errors.push(`'sitemap' must be a string`)
    else if (!/^https?:\/\//.test(config.sitemap) && !config.sitemap.endsWith('.xml')) {
      warnings.push(`'sitemap' doesn't look like a URL or sitemap file path: ${config.sitemap}`)
    }
    if (config.sitemap === PLACEHOLDER_SITEMAP) warnings.push(`'sitemap' is still the placeholder URL`)
  }

  for (const key of ['select', 'prefix', 'strip']) {
    if (key in config && !isStr(config[key])) errors.push(`'${key}' must be a string`)
  }

  for (const key of ['excludeList', 'includeList']) {
    if (!(key in config)) continue
    if (!Array.isArray(config[key])) { errors.push(`'${key}' must be an array`); continue }
    const bad = config[key].findIndex((v) => !isStr(v))
    if (bad >= 0) errors.push(`'${key}[${bad}]' must be a string, got ${typeof config[key][bad]}`)
  }

  if ('frontmatter' in config) {
    if (!isObj(config.frontmatter)) errors.push(`'frontmatter' must be an object`)
    else if (config.frontmatter._meta) {
      const inc = config.frontmatter._meta.include
      if (!isObj(config.frontmatter._meta)) errors.push(`'frontmatter._meta' must be an object`)
      else if (inc !== undefined) {
        if (!isObj(inc)) errors.push(`'frontmatter._meta.include' must be an object`)
        else for (const [k, v] of Object.entries(inc)) {
          if (!isStr(v)) errors.push(`'frontmatter._meta.include.${k}' must be a string (meta tag name)`)
        }
      }
    }
  }

  if ('image' in config) {
    if (!isObj(config.image)) errors.push(`'image' must be an object`)
    else if ('transform' in config.image && typeof config.image.transform !== 'function') {
      errors.push(`'image.transform' must be a function`)
    }
  }

  if ('cleanup' in config) {
    if (!Array.isArray(config.cleanup)) errors.push(`'cleanup' must be an array`)
    else config.cleanup.forEach((rule, i) => {
      if (!isObj(rule)) { errors.push(`'cleanup[${i}]' must be an object with find/replace`); return }
      if (!('find' in rule)) errors.push(`'cleanup[${i}].find' missing`)
      else if (!isStr(rule.find) && !(rule.find instanceof RegExp)) errors.push(`'cleanup[${i}].find' must be a string or RegExp`)
      if (!('replace' in rule)) errors.push(`'cleanup[${i}].replace' missing`)
      else if (!isStr(rule.replace)) errors.push(`'cleanup[${i}].replace' must be a string`)
    })
  }

  return { errors, warnings }
}

const stripNamespacedLocs = (xml) => xml.replace(/<(\w+):loc>[\s\S]*?<\/\1:loc>/g, '')
const extractLocs = (xml) => [...stripNamespacedLocs(xml).matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => m[1].trim())
const isSitemapIndex = (xml) => /<sitemapindex[\s>]/i.test(xml)

async function fetchWithRetry(url, { timeout = 30000, retry, userAgent } = {}) {
  const attempt = async () => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeout)
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: userAgent ? { 'User-Agent': userAgent } : undefined })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } finally {
      clearTimeout(t)
    }
  }
  try {
    return await attempt()
  } catch (err) {
    if (retry && /HTTP 5\d\d|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message)) {
      await new Promise((r) => setTimeout(r, 2000))
      return attempt()
    }
    throw err
  }
}

async function mapConcurrent(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

async function fetchSitemap(url, log, fetchOpts, depth = 0) {
  if (depth > 3) {
    log.warn(`sitemap nesting too deep, stopping at ${url}`)
    return []
  }
  const xml = await (await fetchWithRetry(url, fetchOpts)).text()
  const locs = extractLocs(xml)
  if (!isSitemapIndex(xml)) return locs
  log.info(`sitemap index — ${locs.length} child sitemap(s)`)
  const all = await mapConcurrent(locs, 4, (child) =>
    fetchSitemap(child, log, fetchOpts, depth + 1).catch((err) => {
      log.warn(`skip sitemap ${child}: ${err.message}`)
      return []
    }))
  return all.flat()
}

async function fetchHtml(url, fetchOpts) {
  const res = await fetchWithRetry(url, fetchOpts)
  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('html')) throw new Error(`not html (content-type: ${ctype || 'none'})`)
  return res.text()
}

function extractMeta(doc) {
  const meta = {}
  const title = doc.querySelector('title')?.textContent?.trim()
  if (title) meta.title = title.replace(/&#039;/g, "'")
  for (const el of doc.querySelectorAll('meta')) {
    const key = el.getAttribute('property') || el.getAttribute('name')
    const value = el.getAttribute('content')
    if (key && value) meta[key] = value
  }
  return meta
}

// Relative srcs are resolved against the page, so the swap below matches
// whichever of the two forms Turndown wrote.
const extractImages = (scope, pageUrl) =>
  [...scope.querySelectorAll('img')].map((img) => {
    const src = img.getAttribute('src') || ''
    let resolvedSrc = src
    try { if (src) resolvedSrc = new URL(src, pageUrl).href } catch {}
    return {
      src,
      resolvedSrc,
      alt: img.getAttribute('alt') || '',
      width: img.getAttribute('width') || '',
      height: img.getAttribute('height') || '',
    }
  })

async function swapImages(md, images, transform, publicDir, log, dry, fetchOpts) {
  const ops = []
  for (const image of images) {
    if (!image.src) continue
    let result
    try {
      result = transform(image)
    } catch (err) {
      log.warn(`image transform failed: ${err.message}`)
      continue
    }
    if (result?.component) ops.push({ image, result })
  }

  const downloads = ops.filter(({ result }) => result.url && !/^https?:\/\//.test(result.source))
  await mapConcurrent(downloads, 4, async ({ result }) => {
    const dest = resolve(publicDir, result.source.replace(/^\//, ''))
    if (dry) return log.dry(`would download ${result.url} → ${dest}`)
    try {
      const buf = Buffer.from(await (await fetchWithRetry(result.url, fetchOpts)).arrayBuffer())
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, buf)
    } catch (err) {
      log.warn(`download failed ${result.url}: ${err.message}`)
    }
  })

  let out = md
  for (const { image, result } of ops) {
    for (const candidate of new Set([image.src, image.resolvedSrc].filter(Boolean))) {
      const esc = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(`!\\[[^\\]]*\\]\\(${esc}\\)`, 'g'), result.component)
    }
  }
  return out
}

// Without `_meta.include`, these six, so a run with no config still writes
// a title and a description.
const DEFAULT_META_INCLUDE = {
  title: 'title',
  description: 'description',
  ogTitle: 'og:title',
  ogDescription: 'og:description',
  ogImage: 'og:image',
  ogType: 'og:type',
}

function frontMatter(meta, frontmatter = {}) {
  const { _meta, ...defaults } = frontmatter
  const lines = []
  for (const [outKey, metaKey] of Object.entries(_meta?.include ?? DEFAULT_META_INCLUDE)) {
    if (meta[metaKey]) lines.push(`${outKey}: ${JSON.stringify(meta[metaKey])}`)
  }
  for (const [key, val] of Object.entries(defaults)) lines.push(`${key}: ${JSON.stringify(val)}`)
  return `${lines.join('\n')}\n`
}

const applyCleanup = (text, rules = []) => rules.reduce((out, { find, replace }) => out.replaceAll(find, replace), text)

/**
 * A page URL to its route file. `strip` drops a leading path segment on a
 * segment boundary, then an empty path is `index`, then `prefix` is prepended,
 * so a root URL under `--prefix blog` is blog/index.md and not blog.md.
 */
export function routeFileFor(url, { origin, routesDir, strip, prefix }) {
  let path = origin && url.startsWith(origin) ? url.slice(origin.length) : url.startsWith('http') ? new URL(url).pathname : url
  path = path.replace(/\/?index\.html?$/i, '').replace(/^\/+|\/+$/g, '')
  const cut = strip?.replace(/^\/+|\/+$/g, '')
  if (cut) path = path.replace(new RegExp(`^${cut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`), '')
  if (!path) path = 'index'
  const pre = prefix?.replace(/^\/+|\/+$/g, '')
  if (pre) path = `${pre}/${path}`
  return resolve(routesDir, `${path}.md`)
}

/**
 * Fetch `target` (or `from`, or the config's sitemap) into `<root>/content`.
 * Returns `{ written, skipped }`, the route files written and the URLs that failed.
 */
export async function runFetch({
  root, target, from, config = {}, select, prefix, strip, limit, delay = 1000,
  timeout = 30000, retry = false, userAgent = 'site-kit-fetch', metaOnly = false,
  images = true, dry = false, log,
}) {
  const sitemap = from ?? config.sitemap
  if (from && target) log.info(`--from set, ignoring the target ${target}`)

  const mode = from ? 'sitemap'
    : !target ? (config.sitemap ? 'sitemap' : null)
    : target.startsWith('http') ? (target.endsWith('.xml') ? 'sitemap' : 'single')
    : target.endsWith('.xml') ? 'local-sitemap' : 'single'
  if (!mode) throw new Error('give a page URL, a sitemap (URL or file), --from <sitemap>, or a --config with a sitemap key')

  const scope = select ?? config.select ?? 'body'
  const opts = {
    origin: sitemap ? new URL(sitemap).origin : null,
    routesDir: resolve(root, 'content/routes'),
    prefix: prefix ?? config.prefix,
    strip: strip ?? config.strip,
  }
  const publicDir = resolve(root, 'content/public')
  const fetchOpts = { timeout, retry, userAgent }

  let urls
  if (mode === 'single') urls = [target]
  else if (mode === 'local-sitemap') urls = extractLocs(await readFile(resolve(target), 'utf8'))
  else urls = await fetchSitemap(from ?? target ?? config.sitemap, log, fetchOpts)

  if (config.excludeList?.length) urls = urls.filter((u) => !config.excludeList.includes(u))
  if (config.includeList?.length) urls = urls.filter((u) => config.includeList.includes(u))
  if (limit > 0) urls = urls.slice(0, limit)
  if (!urls.length) {
    log.warn('no urls to process')
    return { written: [], skipped: [] }
  }

  const { default: TurndownService } = await import('turndown')
  const { parseHTML } = await import('linkedom')
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })

  log.info(`processing ${urls.length} url(s) into ${opts.routesDir}`)
  const written = []
  const skipped = []
  for (const [i, url] of urls.entries()) {
    log.info(`(${i + 1}/${urls.length}) ${url}`)
    try {
      const doc = parseHTML(await fetchHtml(url, fetchOpts)).document
      const meta = extractMeta(doc)
      const el = doc.querySelector(scope) || doc.querySelector('body') || doc
      const file = routeFileFor(url, opts)
      if (written.includes(file)) log.warn(`path collision — overwriting ${file}`)

      const fm = frontMatter(meta, config.frontmatter)
      let body = ''
      if (!metaOnly) {
        body = turndown.turndown(el.innerHTML)
        if (images && config.image?.transform) {
          body = await swapImages(body, extractImages(el, url), config.image.transform, publicDir, log, dry, fetchOpts)
        }
        body = `\n${applyCleanup(body, config.cleanup)}`
      }
      const text = `---\n${fm}---\n${body}`

      if (dry) {
        log.dry(file)
        log.info(text)
      } else {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text)
        log.success(`wrote ${file}`)
      }
      written.push(file)
    } catch (err) {
      log.warn(`skip ${url}: ${err.message}`)
      skipped.push(url)
    }
    if (i < urls.length - 1 && delay > 0) await new Promise((r) => setTimeout(r, delay))
  }
  return { written, skipped }
}
