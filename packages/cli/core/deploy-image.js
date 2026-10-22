// ─── deploy-image.js — what an API image needs beyond api/ and db/ ────────────
//
// The image `fli make:deploy` writes copies api/ and db/ onto oven/bun's slim image,
// and two kinds of app need more than that at runtime. Each was found as a
// release that would not start rather than at any step before it (`FJS-2269`):
//
//   · an app that depends on @frontierjs/print-kit, or whose API imports
//     @frontierjs/mesa/drive, needs a Chrome, or the first launch fails —
//     printer() loudly at boot, but only once the container is already
//     swapped in;
//   · an app whose API reads a template out of web/src (a .mesa document the
//     browser also draws) needs web/src in the image, and .dockerignore drops
//     web/ whole — so with Chrome present the render still fails, at the
//     first print.
//
// Those two are the only roads to a browser an app has (`FJS-D1214`), which is
// what makes this reading complete: a Playwright or Puppeteer dependency would
// want its own pinned browser build, so it is named as off the road rather
// than read as a third kind of Chrome.
//
// One owner, two callers: make:deploy writes the image these say is needed and
// `fli check`'s `deploy-image-needs` grades a Dockerfile written before either
// need existed. A second reading of "does this app print" would let the two
// disagree about the same app.

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, extname } from 'path'

const PRINT_KIT = '@frontierjs/print-kit'
const DRIVE = '@frontierjs/mesa/drive'
const OFF_ROAD = ['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core']

// Debian's chromium is the one `findChrome` finds by name on PATH. Fonts are
// named because --no-install-recommends drops the ones chromium recommends,
// and a PDF with no fonts prints every glyph as a box.
export const CHROME_RUN = `RUN apt-get update \\
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core \\
 && rm -rf /var/lib/apt/lists/*`

// Who the container runs as (`FJS-D1120`). oven/bun ships a `bun` user at 1000,
// and the db directory the deploy bind-mounts must belong to that uid or the
// first migration cannot open it, health fails and the swap rolls back. The
// image says who runs; `deploy:setup` and `deploy:doctor` say who owns, from
// these numbers, so a host directory and an image cannot name two users.
export const IMAGE_USER = Object.freeze({ name: 'bun', uid: 1000, gid: 1000 })

/**
 * What this app's image needs beyond api/ and db/. `chrome` names the package
 * that needs one, or is null; `offRoad` lists the browser drivers the app
 * depends on outside the two that own a browser.
 */
export function imageNeeds(root) {
  const deps = dependencies(root)
  const code = apiCode(root)
  const drives = code.some(c => /['"]@frontierjs\/mesa\/drive['"]/.test(c))
  return {
    chrome: deps.has(PRINT_KIT) ? PRINT_KIT : drives ? DRIVE : null,
    webSrc: code.some(c => /['"`][^'"`\n]*\bweb\/src\b/.test(c)),
    offRoad: OFF_ROAD.filter(name => deps.has(name)),
  }
}

// devDependencies are not installed by the image's --production install, so a
// browser named only there runs nothing in production and needs no binary.
function dependencies(root) {
  const names = new Set()
  for (const manifest of ['package.json', 'api/package.json']) {
    const p = join(root, manifest)
    if (!existsSync(p)) continue
    try {
      for (const name of Object.keys(JSON.parse(readFileSync(p, 'utf8')).dependencies ?? {})) names.add(name)
    } catch { /* an unparseable manifest is another rule's finding */ }
  }
  return names
}

const SOURCE = new Set(['.ts', '.js', '.mjs', '.mts'])
const SKIP = new Set(['node_modules', 'dist', 'build', 'test', 'tests'])

// API source with comment lines dropped: a path into web/src, or an import of
// mesa/drive, counts in code and not where a comment mentions it. A comment
// that named one would only put web/src or a Chrome into the image, which is
// the cheap way to be wrong.
function apiCode(root) {
  const out = []
  const stack = [join(root, 'api')]
  while (stack.length) {
    const dir = stack.pop()
    let names
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { stack.push(p); continue }
      if (!SOURCE.has(extname(name)) || /\.(test|spec)\.\w+$/.test(name)) continue
      out.push(readFileSync(p, 'utf8').split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'))
    }
  }
  return out
}

const instructions = (text) => String(text ?? '').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'))

/** Whether a Dockerfile installs or names a Chrome. */
export function installsChrome(dockerfile) {
  return instructions(dockerfile).some(l => /\b(chromium|google-chrome|FJS_CHROME)\b/i.test(l))
}

/** Whether a Dockerfile copies web/src, and .dockerignore lets it through. */
export function carriesWebSrc(dockerfile, dockerignore) {
  const copies = instructions(dockerfile).some(l => !/--from\b/.test(l) &&
    /^COPY\b/i.test(l) && /\s(\.\/?|\/?web(\/src)?(\/[^\s]*)?)\s/.test(l + ' '))
  if (!copies) return false
  const ignore = instructions(dockerignore)
  const dropped = ignore.some(l => /^\/?web(\/\*?)?$/.test(l))
  const restored = ignore.some(l => /^!\/?web\/src\b/.test(l))
  return !dropped || restored
}
