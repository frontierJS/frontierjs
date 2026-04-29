---
title: site:fetch
description: Fetch markdown from a sitemap or single url, convert html to md, download images, write to site/content/pages
alias: fetch
examples:
  - fli site:fetch https://example.com/about
  - fli site:fetch --from https://example.com/sitemap.xml
  - fli site:fetch --config ./scrape.config.js
  - fli site:fetch https://example.com/about --meta-only
  - fli site:fetch --config ./scrape.config.js --limit 5 --dry
  - fli site:fetch --from https://example.com/sitemap.xml --prefix blog
  - fli site:fetch --from https://example.com/sitemap.xml --strip /posts --prefix blog
args:
  -
    name: target
    description: url, sitemap url, or local sitemap path (optional if --from or --config provides one)
flags:
  config:
    description: path to esm config file (export const config = {...})
  from:
    description: sitemap url override
  root:
    description: base domain override
  dest:
    description: output dir under siteContent
    defaultValue: pages
  prefix:
    description: path prefix prepended to each URL-derived path (e.g. --prefix blog)
  strip:
    description: leading URL path to remove before composing the output path (e.g. --strip /posts)
  select:
    description: css selector to scope content extraction
    defaultValue: body
  limit:
    type: number
    description: cap number of urls processed (0 = no limit)
  delay:
    type: number
    description: ms between fetches
    defaultValue: 1000
  timeout:
    type: number
    description: per-fetch timeout in ms
    defaultValue: 30000
  retry:
    type: boolean
    description: retry once on 5xx / network errors
  user-agent:
    description: User-Agent header for outbound requests
    defaultValue: fli-site-fetch/0.1
  meta-only:
    type: boolean
    description: only output frontmatter, skip markdown
  no-images:
    type: boolean
    description: skip image download and transform
  open:
    type: boolean
    char: o
    description: open files after creation
---

<script>
import TurndownService from 'turndown'
import { parseHTML } from 'linkedom'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, resolve as resolvePath } from 'path'
import { pathToFileURL } from 'url'

// One Turndown instance reused for the whole run
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-'
})
const htmlToMarkdown = (html) => turndown.turndown(html)

// ─── config loader ─────────────────────────────────────────────────────────
const loadConfig = async (path, log) => {
  const abs = resolvePath(process.cwd(), path)
  const mod = await import(pathToFileURL(abs).href)
  const cfg = mod.config ?? mod.default
  if (cfg === undefined) {
    log.warn(`${path}: no \`config\` or \`default\` export — using empty config`)
    return {}
  }
  return cfg
}

// ─── config validator ──────────────────────────────────────────────────────
// Walks a loaded config and returns { errors, warnings }. Errors are fatal
// and abort the run; warnings are surfaced but don't block. Unknown keys
// produce warnings (catches typos like `excludelist` vs `excludeList`).
const KNOWN_KEYS = new Set([
  'sitemap', 'select', 'prefix', 'strip',
  'excludeList', 'includeList',
  'frontmatter', 'image', 'cleanup',
])
const PLACEHOLDER_SITEMAP = 'https://example.com/sitemap.xml'

const validateConfig = (config) => {
  const errors = []
  const warnings = []
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
  const isStr = (v) => typeof v === 'string'

  // Unknown keys
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown config key '${key}' — possible typo? (known: ${[...KNOWN_KEYS].join(', ')})`)
    }
  }

  if ('sitemap' in config) {
    if (!isStr(config.sitemap)) errors.push(`'sitemap' must be a string`)
    else if (!/^https?:\/\//.test(config.sitemap) && !config.sitemap.endsWith('.xml')) {
      warnings.push(`'sitemap' doesn't look like a URL or sitemap file path: ${config.sitemap}`)
    }
    if (config.sitemap === PLACEHOLDER_SITEMAP) {
      warnings.push(`'sitemap' is still the placeholder URL — did you forget to edit the config?`)
    }
  }

  for (const key of ['select', 'prefix', 'strip']) {
    if (key in config && !isStr(config[key])) {
      errors.push(`'${key}' must be a string`)
    }
  }

  for (const key of ['excludeList', 'includeList']) {
    if (key in config) {
      if (!Array.isArray(config[key])) {
        errors.push(`'${key}' must be an array`)
      } else {
        const bad = config[key].findIndex(v => !isStr(v))
        if (bad >= 0) errors.push(`'${key}[${bad}]' must be a string, got ${typeof config[key][bad]}`)
      }
    }
  }

  if ('frontmatter' in config) {
    if (!isObj(config.frontmatter)) {
      errors.push(`'frontmatter' must be an object`)
    } else if (config.frontmatter._meta) {
      if (!isObj(config.frontmatter._meta)) {
        errors.push(`'frontmatter._meta' must be an object`)
      } else if ('include' in config.frontmatter._meta) {
        const inc = config.frontmatter._meta.include
        if (!isObj(inc)) {
          errors.push(`'frontmatter._meta.include' must be an object`)
        } else {
          for (const [k, v] of Object.entries(inc)) {
            if (!isStr(v)) errors.push(`'frontmatter._meta.include.${k}' must be a string (meta tag name)`)
          }
        }
      }
    }
  }

  if ('image' in config) {
    if (!isObj(config.image)) {
      errors.push(`'image' must be an object`)
    } else if ('transform' in config.image && typeof config.image.transform !== 'function') {
      errors.push(`'image.transform' must be a function`)
    }
  }

  if ('cleanup' in config) {
    if (!Array.isArray(config.cleanup)) {
      errors.push(`'cleanup' must be an array`)
    } else {
      config.cleanup.forEach((rule, i) => {
        if (!isObj(rule)) {
          errors.push(`'cleanup[${i}]' must be an object with find/replace`)
          return
        }
        if (!('find' in rule)) errors.push(`'cleanup[${i}].find' missing`)
        else if (!isStr(rule.find) && !(rule.find instanceof RegExp)) {
          errors.push(`'cleanup[${i}].find' must be a string or RegExp`)
        }
        if (!('replace' in rule)) errors.push(`'cleanup[${i}].replace' missing`)
        else if (!isStr(rule.replace)) errors.push(`'cleanup[${i}].replace' must be a string`)
      })
    }
  }

  return { errors, warnings }
}

// ─── mode detection ────────────────────────────────────────────────────────
// Resolves to one of: 'single' | 'sitemap' | 'local-sitemap' | 'sitemap-config' | 'error'
// flag.from always wins over a positional target — caller logs that.
const detectMode = (target, flag, config) => {
  if (flag.from) return 'sitemap'
  if (config.sitemap && !target) return 'sitemap-config'
  if (!target) return 'error'
  if (target.startsWith('http')) {
    return target.endsWith('.xml') ? 'sitemap' : 'single'
  }
  if (target.endsWith('.xml')) return 'local-sitemap'
  return 'single'
}

// ─── sitemap parsing ───────────────────────────────────────────────────────
// Strip namespaced loc elements (image:loc, video:loc, news:loc) before
// extracting top-level <loc>. Otherwise asset URLs from sitemap extensions
// flood the queue and we try to fetch them as HTML pages.
const stripNamespacedLocs = (xml) =>
  xml.replace(/<(\w+):loc>[\s\S]*?<\/\1:loc>/g, '')

const extractLocs = (xml) => {
  const cleaned = stripNamespacedLocs(xml)
  return [...cleaned.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => m[1].trim())
}

const isSitemapIndex = (xml) => /<sitemapindex[\s>]/i.test(xml)

const fetchSitemap = async (url, log, depth = 0, fetchOpts) => {
  if (depth > 3) {
    log.warn(`sitemap nesting too deep, stopping at ${url}`)
    return []
  }
  const res = await fetchWithRetry(url, fetchOpts)
  const xml = await res.text()
  const locs = extractLocs(xml)

  if (isSitemapIndex(xml)) {
    log.info(`sitemap index — ${locs.length} child sitemap(s)`)
    // Concurrent fetches with a small cap — these are read-only.
    const all = await mapConcurrent(locs, 4, async (child) => {
      try {
        return await fetchSitemap(child, log, depth + 1, fetchOpts)
      } catch (err) {
        log.warn(`skip sitemap ${child}: ${err.message}`)
        return []
      }
    })
    return all.flat()
  }
  return locs
}

const readLocalSitemap = async (path) => {
  const xml = await readFile(resolvePath(process.cwd(), path), 'utf8')
  return extractLocs(xml)
}

// ─── url filtering ─────────────────────────────────────────────────────────
const filterUrls = (urls, config) => {
  let out = urls
  if (config.excludeList?.length) {
    out = out.filter((u) => !config.excludeList.includes(u))
  }
  if (config.includeList?.length) {
    out = out.filter((u) => config.includeList.includes(u))
  }
  return out
}

// ─── fetch helpers ─────────────────────────────────────────────────────────
// AbortController-based timeout + optional 1x retry on 5xx / network error.
const fetchWithRetry = async (url, { timeout, retry, userAgent } = {}) => {
  const attempt = async () => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeout ?? 30000)
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: userAgent ? { 'User-Agent': userAgent } : undefined
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } finally {
      clearTimeout(t)
    }
  }
  try {
    return await attempt()
  } catch (err) {
    const transient = /HTTP 5\d\d|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message)
    if (retry && transient) {
      await sleep(2000)
      return await attempt()
    }
    throw err
  }
}

// Verifies the response really is HTML before we hand it to the parser.
const fetchHtml = async (url, fetchOpts) => {
  const res = await fetchWithRetry(url, fetchOpts)
  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('html')) {
    throw new Error(`not html (content-type: ${ctype || 'none'})`)
  }
  return res.text()
}

// Promise.all with a hard concurrency cap. Order preserved.
const mapConcurrent = async (items, limit, fn) => {
  const out = new Array(items.length)
  let next = 0
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

// ─── HTML extraction ───────────────────────────────────────────────────────
// Single parseHTML call per page — extractMeta, scopeHtml, and extractImages
// all run against the same parsed document for free.
const parsePage = (html) => parseHTML(html).document

const extractMeta = (doc) => {
  const meta = {}
  const title = doc.querySelector('title')?.textContent?.trim()
  if (title) meta.title = title.replace(/&#039;/g, "'")
  doc.querySelectorAll('meta').forEach((el) => {
    const key = el.getAttribute('property') || el.getAttribute('name')
    const value = el.getAttribute('content')
    if (key && value) meta[key] = value
  })
  return meta
}

const scopeElement = (doc, selector) =>
  doc.querySelector(selector) || doc.querySelector('body') || doc

// Pull <img> info from a scoped element. Resolves relative `src` against
// the page URL so the markdown swap below sees the same form Turndown emits.
const extractImages = (scopeEl, pageUrl) =>
  [...scopeEl.querySelectorAll('img')].map((img) => {
    const rawSrc = img.getAttribute('src') || ''
    let resolvedSrc = rawSrc
    try {
      if (rawSrc) resolvedSrc = new URL(rawSrc, pageUrl).href
    } catch {
      // leave as-is; the swap regex will simply not match
    }
    return {
      src: rawSrc,
      resolvedSrc,
      alt: img.getAttribute('alt') || '',
      width: img.getAttribute('width') || '',
      height: img.getAttribute('height') || ''
    }
  })

const downloadImage = async (url, destPath, fetchOpts) => {
  const res = await fetchWithRetry(url, fetchOpts)
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(destPath), { recursive: true })
  await writeFile(destPath, buf)
}

// Apply config.image.transform per image, download local copies (parallel,
// capped), then swap the markdown image references to the user's component.
// `dryRun` skips the disk write but still does the markdown swap so output
// reflects the final shape.
const transformImagesInMarkdown = async (
  md, images, transform, mediaRoot, log, dryRun, fetchOpts
) => {
  // Phase 1 — run transforms; collect download tasks
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
    if (!result?.component) continue
    ops.push({ image, result })
  }

  // Phase 2 — parallel downloads (cap 4)
  const downloadable = ops.filter(({ result }) =>
    result.url && !/^https?:\/\//.test(result.source)
  )
  await mapConcurrent(downloadable, 4, async ({ result }) => {
    if (dryRun) {
      log.dry(`would download ${result.url} → ${result.source}`)
      return
    }
    try {
      const destPath = resolvePath(mediaRoot, result.source.replace(/^\//, ''))
      await downloadImage(result.url, destPath, fetchOpts)
    } catch (err) {
      log.warn(`download failed ${result.url}: ${err.message}`)
    }
  })

  // Phase 3 — swap markdown references. Match against both the raw src
  // (Turndown often passes through unchanged) and the resolved absolute URL
  // (Turndown sometimes resolves relative paths to absolute).
  let out = md
  for (const { image, result } of ops) {
    const candidates = [image.src, image.resolvedSrc].filter(Boolean)
    for (const candidate of new Set(candidates)) {
      const esc = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`!\\[[^\\]]*\\]\\(${esc}\\)`, 'g')
      out = out.replace(re, result.component)
    }
  }
  return out
}

// ─── frontmatter ───────────────────────────────────────────────────────────
// `frontmatter._meta.include` maps output keys → meta keys, e.g.
//   frontmatter: {
//     _meta: { include: { title: 'og:title', date: 'article:published_time' } },
//     layout: 'page'
//   }
// When _meta.include is omitted, a minimal default whitelist is used so the
// command produces useful output without config.
const DEFAULT_META_INCLUDE = {
  title: 'title',
  description: 'description',
  ogTitle: 'og:title',
  ogDescription: 'og:description',
  ogImage: 'og:image',
  ogType: 'og:type'
}

const composeFrontmatter = (meta, includeMetaList, frontmatterDefaults = {}) => {
  const lines = []
  const { _meta, ...defaults } = frontmatterDefaults
  const include = includeMetaList || DEFAULT_META_INCLUDE

  for (const [outKey, metaKey] of Object.entries(include)) {
    const val = meta[metaKey]
    if (val) lines.push(`${outKey}: ${JSON.stringify(val)}`)
  }
  for (const [key, val] of Object.entries(defaults)) {
    lines.push(`${key}: ${JSON.stringify(val)}`)
  }
  return lines.join('\n') + '\n'
}

const applyCleanup = (text, rules = []) => {
  let out = text
  for (const { find, replace } of rules) {
    out = out.replaceAll(find, replace)
  }
  return out
}

// ─── url → file path ───────────────────────────────────────────────────────
// Pipeline:
//   1. Reduce URL to its path part (relative to root or origin)
//   2. Strip /index.html, leading/trailing slashes
//   3. Apply --strip: remove a leading path segment if present, anchored at
//      the start, with a / boundary so partial-segment matches don't fire
//   4. Apply --prefix: prepend a path segment
const urlToFilePath = (url, root, contentRoot, dest, opts = {}) => {
  const { strip, prefix } = opts
  let pathPart = url
  if (root && url.startsWith(root)) {
    pathPart = url.slice(root.length)
  } else if (url.startsWith('http')) {
    pathPart = new URL(url).pathname
  }
  // Strip trailing /index.html and trailing slashes — both should map to /index
  pathPart = pathPart.replace(/\/?index\.html?$/i, '')
  pathPart = pathPart.replace(/^\/+|\/+$/g, '')

  // Apply --strip: remove leading "<strip>" or "<strip>/..." with a / boundary
  if (strip) {
    const cleanStrip = strip.replace(/^\/+|\/+$/g, '')
    if (cleanStrip) {
      // Anchored at start; matches the segment exactly OR the segment followed by /
      const re = new RegExp(`^${cleanStrip.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(/|$)`)
      pathPart = pathPart.replace(re, '')
    }
  }

  // After URL normalization + strip, if there's no path content fall back to
  // "index" — this lives BEFORE prefix application so a root URL with --prefix
  // foo becomes foo/index.md (not foo.md).
  if (!pathPart) pathPart = 'index'

  // Apply --prefix
  if (prefix) {
    const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '')
    if (cleanPrefix) {
      pathPart = `${cleanPrefix}/${pathPart}`
    }
  }

  return resolvePath(contentRoot, dest, `${pathPart}.md`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
</script>

Fetch one or many pages, extract their HTML, convert to markdown, and write
them into your site's content folder. Supports single URLs, remote sitemap
URLs, local sitemap files, and config-driven runs with cleanup rules and
image transforms. Sitemap-index files are walked recursively, and sitemap
extensions (`<image:loc>`, `<video:loc>`, `<news:loc>`) are filtered out so
asset URLs don't get fetched as pages.

```js
const config = flag.config ? await loadConfig(flag.config, log) : {}

// Validate config — abort on errors, surface warnings
if (flag.config) {
  const { errors, warnings } = validateConfig(config)
  for (const w of warnings) log.warn(w)
  if (errors.length) {
    log.error(`config validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):`)
    for (const e of errors) log.error(`  ${e}`)
    return
  }
}

const sitemap = flag.from ?? config.sitemap
const root = flag.root ?? (sitemap ? new URL(sitemap).origin : null)
const dest = flag.dest ?? 'pages'
const select = flag.select ?? config.select ?? 'body'
const prefix = flag.prefix ?? config.prefix ?? null
const strip  = flag.strip  ?? config.strip  ?? null

if (flag.from && arg.target) {
  log.info(`--from set, ignoring positional target: ${arg.target}`)
}

const fetchOpts = {
  timeout: flag.timeout ?? 30000,
  retry: !!flag.retry,
  userAgent: flag['user-agent'] ?? 'fli-site-fetch/0.1'
}

const mode = detectMode(arg.target, { from: flag.from }, config)
if (mode === 'error') {
  log.error('provide a target url, --from sitemap, or --config with sitemap key')
  return
}

// Surface the output destination upfront so users can sanity-check before
// the run starts. paths.site might not be where they expect in a monorepo.
const contentRoot = `${context.paths.site}/content`
const mediaRoot   = `${context.paths.site}/content/media`
const destRoot    = `${contentRoot}/${dest}${prefix ? '/' + prefix.replace(/^\/+|\/+$/g, '') : ''}`
log.info(`writing to: ${destRoot}/`)

let urls = []
if (mode === 'single') {
  urls = [arg.target]
} else if (mode === 'sitemap' || mode === 'sitemap-config') {
  const src = flag.from ?? config.sitemap ?? arg.target
  log.info(`fetching sitemap: ${src}`)
  try {
    urls = await fetchSitemap(src, log, 0, fetchOpts)
  } catch (err) {
    log.error(`failed to fetch sitemap: ${err.message}`)
    return
  }
} else if (mode === 'local-sitemap') {
  log.info(`reading local sitemap: ${arg.target}`)
  try {
    urls = await readLocalSitemap(arg.target)
  } catch (err) {
    log.error(`failed to read sitemap file: ${err.message}`)
    return
  }
}

urls = filterUrls(urls, config)
// --limit 0 means no limit
if (flag.limit && flag.limit > 0) urls = urls.slice(0, flag.limit)

if (!urls.length) {
  log.warn('no urls to process')
  return
}

log.info(`processing ${urls.length} url(s)`)

const written = new Set()

for (let i = 0; i < urls.length; i++) {
  const url = urls[i]
  log.info(`(${i + 1}/${urls.length}) ${url}`)

  try {
    const html = await fetchHtml(url, fetchOpts)
    const doc = parsePage(html)
    const meta = extractMeta(doc)
    const scopeEl = scopeElement(doc, select)
    const scopedHtml = scopeEl.innerHTML
    const filePath = urlToFilePath(url, root, contentRoot, dest, { strip, prefix })

    if (written.has(filePath)) {
      log.warn(`path collision — overwriting ${filePath}`)
    }

    let final
    if (flag['meta-only']) {
      const fm = composeFrontmatter(meta, config.frontmatter?._meta?.include, config.frontmatter)
      final = `---\n${fm}---\n`
    } else {
      let md = htmlToMarkdown(scopedHtml)

      if (!flag['no-images'] && config.image?.transform) {
        const images = extractImages(scopeEl, url)
        md = await transformImagesInMarkdown(
          md, images, config.image.transform, mediaRoot, log, flag.dry, fetchOpts
        )
      }

      md = applyCleanup(md, config.cleanup)
      const fm = composeFrontmatter(meta, config.frontmatter?._meta?.include, config.frontmatter)
      final = `---\n${fm}---\n\n${md}`
    }

    if (flag.dry) {
      log.dry(filePath)
      echo(final)
    } else {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, final)
      written.add(filePath)
      log.success(`wrote ${filePath}`)

      if (flag.open) {
        const opener = context.env.OPEN_COMMAND ?? 'vi'
        context.exec({ command: `${opener} ${filePath}` })
      }
    }
  } catch (err) {
    log.warn(`skip ${url}: ${err.message}`)
  }

  if (i < urls.length - 1) await sleep(flag.delay ?? 1000)
}

log.success(`done — ${urls.length} url(s) processed`)
```
