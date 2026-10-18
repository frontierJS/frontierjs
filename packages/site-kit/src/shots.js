/*
 * shots.js — an exact before/after pixel diff of a site's own build (`FJS-2265`).
 *
 * A screenshot grade with a color threshold cannot see a light fill change: a
 * #F0F4F8 stripe that went white passes Playwright's default 0.2 tolerance. So
 * a change to what a block emits is graded against the SAME site's build from
 * before the change, byte for byte:
 *
 *   site-kit build <dir> && site-kit shots <dir> --accept   the "before" shots
 *   …change the engine…
 *   site-kit build <dir> && site-kit shots <dir>            compare
 *
 * Nothing is committed as a baseline. The "before" lives in
 * `<dir>/.site-kit/shots/before/` (gitignored), and a mismatch writes both PNGs
 * to `<dir>/.site-kit/shots/diff/`, named by page and width. Shots are taken
 * over CDP through `@frontierjs/mesa/drive`, as print-kit takes them.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { openChrome } from '@frontierjs/mesa/drive'
import { serveSite } from '@frontierjs/sierra/site/serve'
import { DIST, NOT_PAGES, walk } from '../check/context.js'

export const WIDTHS = [390, 768, 960, 1024, 1280, 1536]

const CACHE = '.site-kit/shots'

/** `/about/` → `about`, `/` → `index`: a file name for a page. */
export const slugOf = (path) => path.replace(/^\/|\/$/g, '').replace(/\//g, '__') || 'index'

/** The pages in a build: every directory index, as the path a browser asks. */
export function pagesIn(dist) {
  return walk(dist, (n) => n === 'index.html')
    .map((f) => relative(dist, f))
    .filter((rel) => !NOT_PAGES.has(rel.split('/')[0]) && !rel.includes('['))
    .map((rel) => '/' + rel.replace(/index\.html$/, ''))
    .sort()
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * @param {{ root: string, accept?: boolean, widths?: number[], only?: string[], log?: (msg: string) => void }} opts
 * @returns {Promise<{ taken: number, changed: { page: string, width: number }[], missing: { page: string, width: number }[] }>}
 */
export async function takeShots({ root, accept = false, widths = WIDTHS, only, log = () => {} }) {
  const dist = join(root, DIST)
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`no build in ${dist} — run site-kit build first`)
  const before = join(root, CACHE, 'before')
  const diff = join(root, CACHE, 'diff')
  if (accept) rmSync(before, { recursive: true, force: true })
  rmSync(diff, { recursive: true, force: true })
  mkdirSync(before, { recursive: true })

  const pages = pagesIn(dist).filter((p) => !only?.length || only.includes(p))
  if (!pages.length) throw new Error('shots: no page to shoot')

  const server = await serveSite({ dir: dist, port: 0, host: '127.0.0.1' })
  const chrome = await openChrome({ windowSize: `${Math.max(...widths)},900` })
  const out = { taken: 0, changed: [], missing: [] }
  try {
    for (const width of widths) {
      await chrome.cmd('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const page of pages) {
        await chrome.navigate(server.url.replace(/\/$/, '') + page)
        // Motion and lazy media are the two things two shots of one build can
        // differ by; a font still loading is a third.
        await chrome.evaluate(`
          const s = document.createElement('style');
          s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
          document.head.append(s);
          for (const i of document.images) i.loading = 'eager';
          await document.fonts.ready;
          await Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r })));
          return true;
        `)
        const { contentSize } = await chrome.cmd('Page.getLayoutMetrics')
        const { data } = await chrome.cmd('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height: Math.ceil(contentSize.height), scale: 1 },
        })
        const now = Buffer.from(data, 'base64')
        const name = `${slugOf(page)}@${width}.png`
        const kept = join(before, name)
        out.taken++
        if (accept) { writeFileSync(kept, now); continue }
        if (!existsSync(kept)) { out.missing.push({ page, width }); continue }
        if (hash(readFileSync(kept)) !== hash(now)) {
          mkdirSync(diff, { recursive: true })
          writeFileSync(join(diff, name.replace('.png', '.before.png')), readFileSync(kept))
          writeFileSync(join(diff, name.replace('.png', '.after.png')), now)
          out.changed.push({ page, width })
        }
      }
      log(`${width}px — ${pages.length} page(s)`)
    }
  } finally {
    await chrome.close()
    await server.close()
  }
  return out
}
