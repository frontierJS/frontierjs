/*
 * images.mjs — responsive images over a built site (config/images.js).
 *
 * Runs the step over a dist/ it writes, with the real Bun.Image, so it must
 * run under Bun: a stub transformer would pass a resize Bun.Image does not do.
 * The fixtures are PNGs drawn here, noisy enough that WebP cannot shrink them
 * to nothing, so a size comparison means something.
 *
 * Run: bun test/images.mjs
 */
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveSite } from '@frontierjs/sierra/site/serve'
import { bunImage, imgTags, optimizeImages, siteImages, widthsFor } from '../config/images.js'

if (!globalThis.Bun) throw new Error('images.mjs runs under Bun: bun test/images.mjs')

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

/** An RGB PNG of width × height, a gradient under seeded noise. */
function png(width, height, seed = 1) {
  const row = width * 3 + 1
  const raw = Buffer.alloc(row * height)
  let s = seed
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0
    for (let x = 0; x < width; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const n = s % 48
      const i = y * row + 1 + x * 3
      raw[i] = (x * 255 / width + n) & 255
      raw[i + 1] = (y * 255 / height + n) & 255
      raw[i + 2] = (128 + n) & 255
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(Bun.hash.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const TMP = mkdtempSync(join(tmpdir(), 'site-kit-images-'))
const write = (path, data) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data)
}
const tagsOf = (file) => imgTags(readFileSync(file, 'utf8'))
const bySrc = (tags, src) => tags.find((t) => t.attrs.src === src)?.attrs

try {
  // ─── widths ────────────────────────────────────────────────────────────────
  check('a source wider than 1920 gets the three widths', widthsFor(2560).join() === '480,1080,1920')
  check('a source between them gets the widths below it and its own', widthsFor(1500).join() === '480,1080,1500')
  check('a source narrower than 480 gets its own width only', widthsFor(300).join() === '300')
  check('a source of exactly 1920 is not encoded twice', widthsFor(1920).join() === '480,1080,1920')

  // ─── finding tags ──────────────────────────────────────────────────────────
  {
    const html = [
      '<img alt="a > b" src="/one.jpg">',
      '<!-- <img src="/comment.jpg"> -->',
      '<script>const t = \'<img src="/script.jpg">\'</script>',
      '<template><img src="/template.jpg"></template>',
      '<img src=/bare.png width=10 />',
      '<IMG SRC="/upper.jpg">',
    ].join('\n')
    const srcs = imgTags(html).map((t) => t.attrs.src)
    check('a quoted > does not end the tag', imgTags(html)[0].attrs.alt === 'a > b')
    check('tags in a comment, script or template are not images', srcs.join() === '/one.jpg,/bare.png,/upper.jpg', srcs.join())
    check('an unquoted value and a self-closing tag parse', imgTags(html)[1].attrs.width === '10')
  }

  // ─── a build ───────────────────────────────────────────────────────────────
  const dist = join(TMP, 'dist')
  const cacheDir = join(TMP, 'cache')
  write(join(dist, 'media/wide.png'), png(2400, 1200, 1))
  write(join(dist, 'media/mid.png'), png(1200, 800, 2))
  write(join(dist, 'media/small.png'), png(300, 200, 3))
  write(join(dist, 'about/team.png'), png(900, 600, 4))
  write(join(dist, 'media/broken.jpg'), 'not an image')
  write(join(dist, 'media/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const homeHtml = `<!doctype html><title>home</title>
<img src="/media/wide.png" alt="" width="768" height="430" loading="lazy">
<img src="/media/mid.png" alt="mid" sizes="100vw" loading="eager">
<img src="/media/small.png" alt="">
<img src="/media/broken.jpg" alt="">
<img src="/media/icon.svg" alt="">
<img src="https://example.com/x.jpg" alt="">
<img src="/media/missing.jpg" alt="">
<img src="/media/wide.png" srcset="/media/wide.png 2400w" alt="stated">
<img src="/media/wide.png" data-original alt="kept">
<img src="/media/mid.png" alt="width only" width="600">
<img src="/media/wide.png" alt="height only" height="300">
<script type="application/ld+json">{"image":"<img src=\\"/media/wide.png\\">"}</script>`
  write(join(dist, 'index.html'), homeHtml)
  const aboutHtml = `<!doctype html><title>about</title>
<img src="team.png" alt="relative" width="300" height="200" />
<img src="/media/wide.png" alt="again">`
  write(join(dist, 'about/index.html'), aboutHtml)

  const transform = bunImage()
  const first = await optimizeImages({ outDir: dist, transform, cacheDir })
  const home = tagsOf(join(dist, 'index.html'))
  const about = tagsOf(join(dist, 'about/index.html'))

  const wide = bySrc(home, '/media/wide.png')
  const urls = (a) => a.srcset.split(', ').map((c) => c.split(' ')[0])
  check('a wide source lists 480/1080/1920', wide.srcset && urls(wide).length === 3 && /\b480w.*1080w.*1920w$/.test(wide.srcset), wide.srcset)
  {
    const sizes = []
    for (const u of urls(wide)) {
      const file = join(dist, u)
      sizes.push(existsSync(file) ? (await new Bun.Image(readFileSync(file)).metadata()).width : 'missing')
    }
    check('each variant exists at the width its descriptor says', sizes.join() === '480,1080,1920', sizes.join())
    const webp = readFileSync(join(dist, urls(wide)[0]))
    check('variants are WebP (FJS-D926)', webp.subarray(8, 12).toString() === 'WEBP')
  }
  check('sizes is the rendered width, capped at the viewport, never auto', wide.sizes === '(max-width: 768px) 100vw, 768px', wide.sizes)
  check('the original stays the src fallback', wide.src === '/media/wide.png')

  const mid = bySrc(home, '/media/mid.png')
  check('a stated sizes is kept', mid.sizes === '100vw' && /\b1200w$/.test(mid.srcset), JSON.stringify(mid))
  check('a tag with neither dimension gets the intrinsic ones', mid.width === '1200' && mid.height === '800', `${mid.width}x${mid.height}`)

  const small = bySrc(home, '/media/small.png')
  check('a source under 480 is never upscaled', /^\S+ 300w$/.test(small.srcset), small.srcset)

  check('a file that will not decode is reported and left as it is', !bySrc(home, '/media/broken.jpg').srcset && first.failed.some((f) => f.src === '/media/broken.jpg'), JSON.stringify(first.failed))
  check('svg, external and missing files are left as they are', ['/media/icon.svg', 'https://example.com/x.jpg', '/media/missing.jpg'].every((s) => !bySrc(home, s).srcset))
  check('a stated srcset is kept', home.find((t) => t.attrs.alt === 'stated').attrs.srcset === '/media/wide.png 2400w')
  check('data-original opts out', !home.find((t) => t.attrs.alt === 'kept').attrs.srcset)
  check('an <img> inside a script is not rewritten', readFileSync(join(dist, 'index.html'), 'utf8').includes('{"image":"<img src=\\"/media/wide.png\\">"}'))

  const team = about.find((t) => t.attrs.alt === 'relative').attrs
  check('a relative src resolves from its page', /\b900w$/.test(team.srcset ?? ''), team.srcset)
  check('stated dimensions are kept', team.width === '300' && team.height === '200')
  {
    const byAlt = (alt) => home.find((t) => t.attrs.alt === alt).attrs
    const w = byAlt('width only')
    const h = byAlt('height only')
    check('a stated width gets the height the photo has at that width', w.width === '600' && w.height === '400', `${w.width}x${w.height}`)
    check('a stated height gets the width the photo has at that height', h.width === '600' && h.height === '300', `${h.width}x${h.height}`)
  }
  check('the same source on two pages is the same variants', about.find((t) => t.attrs.alt === 'again').attrs.srcset === wide.srcset)
  check('each source is encoded once, however many tags name it', first.sources === 4 && first.encoded === 3 + 3 + 1 + 2, JSON.stringify(first))

  // The invariant site-kit-images.md § The nine names: every local raster
  // <img> a site shows has a srcset, and every file it names exists.
  {
    const optedOut = new Set(['/media/broken.jpg', '/media/missing.jpg'])
    const loose = [...home, ...about].filter(({ attrs }) =>
      /\.(png|jpe?g|webp)$/.test(attrs.src) && !attrs.src.startsWith('http') && !optedOut.has(attrs.src) && !('data-original' in attrs))
      .filter(({ attrs }) => !attrs.srcset || urls(attrs).some((u) => !existsSync(join(dist, u))))
    check('every local raster <img> has a srcset whose files exist', loose.length === 0, loose.map((t) => t.attrs.src).join())
  }

  // ─── the cache ─────────────────────────────────────────────────────────────
  {
    const built = readFileSync(join(dist, 'index.html'), 'utf8')
    const variants = readdirSync(join(dist, 'assets')).sort()
    // A fresh build: the same sources and pages in a dist/ with no variants yet.
    rmSync(join(dist, 'assets'), { recursive: true })
    write(join(dist, 'index.html'), homeHtml)
    write(join(dist, 'about/index.html'), aboutHtml)
    const second = await optimizeImages({ outDir: dist, transform, cacheDir })
    check('a rebuild encodes nothing it has already encoded', second.encoded === 0 && second.cached > 0, JSON.stringify(second))
    check('and writes the same variants under the same names', readdirSync(join(dist, 'assets')).sort().join() === variants.join())
    check('and the same page', readFileSync(join(dist, 'index.html'), 'utf8') === built)
  }

  // A variant's URL names its bytes, so a host may cache it for good. Asked of
  // the server rather than of the name: the rule is Sierra's, and a variant
  // named outside it is revalidated on every page view (FJS-2755).
  {
    const server = await serveSite({ dir: dist })
    try {
      const named = [...new Set([...home, ...about].filter(({ attrs }) => attrs.srcset).flatMap(({ attrs }) => urls(attrs)).filter((u) => u.startsWith('/assets/')))]
      const answers = await Promise.all(named.map(async (u) => (await fetch(server.url + u)).headers.get('cache-control')))
      check('every variant is served immutable', named.length > 0 && answers.every((c) => /immutable/.test(c ?? '')), answers.join(' | '))
    } finally {
      await server.close()
    }
  }

  // ─── refusals ──────────────────────────────────────────────────────────────
  {
    const refused = async (opts, ctx) => {
      try {
        await siteImages(opts).closeBundle({ outDir: dist, root: TMP, ...ctx })
        return ''
      } catch (e) {
        return e.message
      }
    }
    check('a site with offline set is refused by name', /`offline`/.test(await refused({ transform }, { config: { offline: true } })))
    check('no transformer is refused by name', /no image transformer/.test(await refused({ transform: null }, { config: {} })))
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

if (failed.length) {
  console.error(`\n${failed.length} failed`)
  process.exit(1)
}
