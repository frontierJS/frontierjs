// config/images.js — responsive images for a built site (FJS-2737).
//
// Every local raster <img> in the prerendered pages gets WebP variants and a
// srcset. It reads the built HTML because that is where a photo from a
// markdown line, a frontmatter list, a kit block and a client's own block all
// arrive as the same tag (FJS-D932): an image written any other way than the
// one blessed component would otherwise ship at source size with nothing
// saying so. WebP only, on every host, so a commit builds the same dist/
// wherever it runs (FJS-D926).
//
// The transformer is GIVEN (FJS-D311): Bun.Image by default, which exists only
// under Bun — `site-kit build` runs there. A test hands in its own.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { htmlFiles } from '@frontierjs/sierra/postbuild'

export const WIDTHS = [480, 1080, 1920]
const QUALITY = 75
const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp'])
// Vite's directory and Vite's name shape, `<name>-<hash8>.<ext>`, because that
// is the one shape Sierra's cache rule reads as content-addressed. Under any
// other name a variant answers must-revalidate: a conditional request per
// image per page view for bytes that can never change at that URL (FJS-2755).
const OUT = 'assets'

/** Bun.Image as a transformer, or null outside Bun. */
export function bunImage() {
  const Image = globalThis.Bun?.Image
  if (!Image) return null
  return {
    name: 'bun-image',
    // metadata() reports the size AFTER EXIF orientation, which is the size
    // the browser displays, so a portrait phone photo is measured portrait.
    async metadata(bytes) {
      const { width, height } = await new Image(bytes).metadata()
      return { width, height }
    },
    webp(bytes, width, quality) {
      return new Image(bytes).resize(width).webp({ quality }).bytes()
    },
  }
}

/**
 * The Sierra config plugin. Sierra calls a config plugin's closeBundle once the
 * pages are written, so this sees each page after the dialect check and any
 * preset step has.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.transform] — `{ name, metadata(bytes), webp(bytes, width, quality) }`
 * @param {string} [opts.cacheDir] — default `<site>/node_modules/.cache/site-kit/images`
 */
export function siteImages({ transform = bunImage(), cacheDir } = {}) {
  return {
    name: 'site-kit:images',
    async closeBundle({ outDir, root, config }) {
      // Sierra runs a config plugin AFTER the offline shell digests the pages,
      // so a rewrite here would leave the service worker precaching pages
      // the host no longer serves.
      if (config?.offline) {
        throw new Error('[site-kit] images: a site with `offline` set cannot have its pages rewritten after the offline shell is written. Responsive images move into Sierra ahead of that step before the two can combine (IDEAS/site-kit-images.md).')
      }
      if (!transform) {
        throw new Error('[site-kit] images: no image transformer. The default is Bun.Image, which exists only under Bun, and `site-kit build` runs there; a build run another way passes siteImages({ transform }).')
      }
      const r = await optimizeImages({
        outDir,
        transform,
        cacheDir: cacheDir ?? resolve(root, 'node_modules/.cache/site-kit/images'),
      })
      const mb = (n) => (n / 1e6).toFixed(1)
      console.log(`    ✓ images → ${r.images} tags on ${r.pages} pages, ${r.sources} sources → ${r.variants} variants (${r.encoded} encoded, ${r.cached} cached), ${mb(r.sourceBytes)} MB → ${mb(r.variantBytes)} MB`)
      for (const f of r.failed) console.warn(`    ⚠ images: ${f.src} left as it is — ${f.reason}`)
    },
  }
}

/**
 * Rewrite every page under outDir. Exported for the test, which runs it over a
 * fixture with a fake transformer.
 */
export async function optimizeImages({ outDir, transform, cacheDir }) {
  outDir = resolve(outDir)
  const cache = join(cacheDir, transform.name ?? 'transform')
  mkdirSync(cache, { recursive: true })
  mkdirSync(join(outDir, OUT), { recursive: true })

  const r = { pages: 0, images: 0, sources: 0, variants: 0, encoded: 0, cached: 0, sourceBytes: 0, variantBytes: 0, failed: [] }
  const seen = new Map()

  // One source is encoded once however many pages show it.
  const variantsOf = (file) => {
    if (!seen.has(file)) seen.set(file, encode(file).catch((e) => ({ error: e.code ?? e.message })))
    return seen.get(file)
  }

  const encode = async (file) => {
    const bytes = new Uint8Array(readFileSync(file))
    const digest = createHash('sha256').update(bytes).digest('hex')
    const { width, height } = await transform.metadata(bytes)
    const name = slug(basename(file, extname(file)))
    const candidates = []
    r.sources++
    r.sourceBytes += bytes.length
    for (const w of widthsFor(width)) {
      const cached = join(cache, `${digest}.${w}.q${QUALITY}.webp`)
      let out
      if (existsSync(cached)) {
        out = readFileSync(cached)
        r.cached++
      } else {
        out = await transform.webp(bytes, w, QUALITY)
        writeFileSync(cached, out)
        r.encoded++
      }
      // At its own width a source the encoder cannot beat is its own best
      // candidate — a small, already-tight PNG often is.
      if (w === width && out.length >= bytes.length) {
        candidates.push({ url: urlOf(outDir, file), w })
        continue
      }
      const fileName = `${name}-${digest.slice(0, 8)}.${w}.webp`
      writeFileSync(join(outDir, OUT, fileName), out)
      candidates.push({ url: `/${OUT}/${fileName}`, w })
      r.variants++
      r.variantBytes += out.length
    }
    return { width, height, candidates }
  }

  for (const page of await htmlFiles(outDir)) {
    const html = await readFile(page, 'utf8')
    const edits = []
    for (const tag of imgTags(html)) {
      const { attrs } = tag
      if ('srcset' in attrs || 'data-original' in attrs) continue
      const file = localFile(attrs.src, page, outDir)
      if (!file) continue
      const v = await variantsOf(file)
      if (v.error) {
        r.failed.push({ src: attrs.src, reason: v.error })
        continue
      }
      edits.push({ tag, add: addedAttrs(attrs, v) })
      r.images++
    }
    if (!edits.length) continue
    await writeFile(page, applyEdits(html, edits))
    r.pages++
  }
  r.failed = [...new Map(r.failed.map((f) => [f.src, f])).values()]
  return r
}

/**
 * The widths to encode: the kit's three below the source, then the source's
 * own width as the largest candidate. Never above it — Bun.Image upscales
 * when asked, and an upscale is bytes that buy no detail.
 */
export function widthsFor(sourceWidth) {
  const max = WIDTHS[WIDTHS.length - 1]
  if (sourceWidth > max) return WIDTHS
  return [...WIDTHS.filter((w) => w < sourceWidth), sourceWidth]
}

/**
 * `sizes` is what the browser needs before layout to pick a candidate. A tag
 * that states one keeps it — a block that knows it is full-bleed says 100vw.
 * Otherwise it is the rendered width attribute, capped at the viewport. Not
 * `auto`: Chromium then holds a lazy image's fetch until layout, so the photo
 * lands later than its original did and the page reflows after first paint.
 */
export function addedAttrs(attrs, { width, height, candidates }) {
  const add = { srcset: candidates.map((c) => `${c.url} ${c.w}w`).join(', ') }
  if (!('sizes' in attrs)) {
    const w = parseInt(attrs.width, 10)
    add.sizes = w > 0 ? `(max-width: ${w}px) 100vw, ${w}px` : '100vw'
  }
  // Without both the box is unknown until the bytes arrive, and the page
  // jumps when they do. One stated dimension is the layout's; the other comes
  // from the photo, since a guessed one reserves a box of the wrong shape.
  const w = parseInt(attrs.width, 10)
  const h = parseInt(attrs.height, 10)
  if (!('width' in attrs) && !('height' in attrs)) {
    add.width = String(width)
    add.height = String(height)
  } else if (w > 0 && !('height' in attrs)) {
    add.height = String(Math.round((w * height) / width))
  } else if (h > 0 && !('width' in attrs)) {
    add.width = String(Math.round((h * width) / height))
  }
  return add
}

/**
 * Every <img> outside a script, style, template, textarea or comment, with its
 * attributes parsed and the offset of its closing `>` or `/>`. Attribute values
 * are read quoted, so a `>` inside an alt does not end the tag.
 */
export function imgTags(html) {
  const tags = []
  const skip = /<!--[\s\S]*?-->|<(script|style|template|textarea)\b[\s\S]*?<\/\1\s*>|<img\b/gi
  const attr = /\s*(?:([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?|(\/?>))/y
  let m
  while ((m = skip.exec(html))) {
    if (m[0].toLowerCase() !== '<img') continue
    const attrs = {}
    attr.lastIndex = m.index + m[0].length
    let a
    let close = -1
    while ((a = attr.exec(html))) {
      if (a[5]) {
        close = a.index + a[0].length - a[5].length
        break
      }
      if (!a[1]) break
      attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '')
    }
    if (close < 0) continue
    tags.push({ start: m.index, close, attrs })
    skip.lastIndex = close
  }
  return tags
}

function applyEdits(html, edits) {
  let out = ''
  let at = 0
  for (const { tag, add } of edits) {
    const extra = Object.entries(add).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')
    // Before a self-closing slash, keep a space so `/` never joins the value.
    const slash = html[tag.close] === '/'
    out += html.slice(at, tag.close).replace(/\s+$/, '') + extra + (slash ? ' ' : '')
    at = tag.close
  }
  return out + html.slice(at)
}

/** The file in outDir a src names, or null for anything that is not a local raster. */
export function localFile(src, page, outDir) {
  if (!src || src.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null
  let path
  try {
    path = decodeURIComponent(src.split(/[?#]/)[0])
  } catch {
    return null
  }
  if (!RASTER.has(extname(path).toLowerCase())) return null
  const file = path.startsWith('/') ? join(outDir, path) : resolve(dirname(page), path)
  if (!file.startsWith(outDir + sep)) return null
  return existsSync(file) ? file : null
}

function urlOf(outDir, file) {
  return '/' + relative(outDir, file).split(sep).map(encodeURIComponent).join('/')
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'image'
}

function decode(v) {
  return v.replace(/&(amp|quot|#39|lt|gt);/g, (_, e) => ({ amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>' })[e])
}

function escapeAttr(v) {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
