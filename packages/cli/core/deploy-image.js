// ─── deploy-image.js — what an API image needs beyond api/ and db/ ────────────
//
// The image `fli make:deploy` writes copies api/ and db/ onto oven/bun:1-slim,
// and two kinds of app need more than that at runtime. Each was found as a
// release that would not start rather than at any step before it (`FJS-2269`):
//
//   · an app that depends on @frontierjs/print-kit needs a Chrome, or
//     printerPlugin() refuses to boot — by design, and loudly, but only once
//     the container is already swapped in;
//   · an app whose API reads a template out of web/src (a .mesa document the
//     browser also draws) needs web/src in the image, and .dockerignore drops
//     web/ whole — so with Chrome present the render still fails, at the
//     first print.
//
// One owner, two callers: make:deploy writes the image these say is needed and
// `fli check`'s `deploy-image-needs` grades a Dockerfile written before either
// need existed. A second reading of "does this app print" would let the two
// disagree about the same app.

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, extname } from 'path'

const PRINT_KIT = '@frontierjs/print-kit'

// Debian's chromium is the one `findChrome` finds by name on PATH. Fonts are
// named because --no-install-recommends drops the ones chromium recommends,
// and a PDF with no fonts prints every glyph as a box.
export const CHROME_RUN = `RUN apt-get update \\
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core \\
 && rm -rf /var/lib/apt/lists/*`

/** What this app's image needs beyond api/ and db/. */
export function imageNeeds(root) {
  return { chrome: dependsOnPrintKit(root), webSrc: apiReadsWebSrc(root) }
}

function dependsOnPrintKit(root) {
  // devDependencies are not installed by the image's --production install, so
  // a print-kit there prints nothing in production and needs no browser.
  for (const manifest of ['package.json', 'api/package.json']) {
    const p = join(root, manifest)
    if (!existsSync(p)) continue
    try {
      if (PRINT_KIT in (JSON.parse(readFileSync(p, 'utf8')).dependencies ?? {})) return true
    } catch { /* an unparseable manifest is another rule's finding */ }
  }
  return false
}

const SOURCE = new Set(['.ts', '.js', '.mjs', '.mts'])
const SKIP = new Set(['node_modules', 'dist', 'build', 'test', 'tests'])

// A path into web/src in code — an import or a resolve() — not one a comment
// mentions. A comment that names it would only copy web/src into the image,
// which is the cheap way to be wrong.
function apiReadsWebSrc(root) {
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
      const code = readFileSync(p, 'utf8').split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      if (/['"`][^'"`\n]*\bweb\/src\b/.test(code)) return true
    }
  }
  return false
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
