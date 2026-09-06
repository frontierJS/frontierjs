/**
 * build/prune-unreachable.js — publish only what a page can reach.
 *
 * A `target: 'static'` build runs the SPA client build and then prerenders over
 * the top of it, so the client entry, the route table and one chunk per route
 * are produced and then referenced by nothing: `dist/index.html` is overwritten
 * by the prerendered home page, and a prerendered page loads its islands and
 * nothing else. On `example/site` that was 12 files and 205 KB of the 313 KB
 * published — fetchable and cached like everything else, and loadable by no
 * page in the directory (`FJS-904`).
 *
 * A static site has exactly one way to start a fetch: the HTML it emitted. So
 * the emitted pages ARE the specification of what may be published, and this
 * walks them rather than carrying a list of what the SPA build is known to
 * produce — a list would be a second statement of the bundler's chunking, and
 * would go stale the first time a route was added.
 *
 * ── Why removal rather than not building it ───────────────────────────────
 * The stylesheet comes out of that same graph: an app's entry imports
 * `@frontierjs/css` and its routes import their own CSS, and `cssCodeSplit:
 * false` collects all of it into the one file every prerendered page links.
 * Cutting the graph to skip the JS would take the CSS with it. So the build is
 * unchanged and the directory is corrected, which is the same thing
 * `removeOrphanIslandChunks` already does one step above.
 *
 * ── Strict about the walk, permissive about files ─────────────────────────
 * Removing a chunk a page needs is a broken site; leaving one nothing loads is
 * wasted bytes. The two costs are nowhere near each other, so anything named
 * anywhere is kept — the walk follows any assets filename appearing as text in
 * a page or a kept chunk, which is how Vite writes a dynamic import — and the
 * refusal is on the walk itself looking wrong (no page, or no root), never on
 * an individual file.
 */

import { readdir, readFile, rm, stat } from 'fs/promises'
import { join, resolve } from 'path'

/** Every `.html` under `dir`, at any depth. */
async function htmlFiles(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await htmlFiles(p))
    else if (e.name.endsWith('.html')) out.push(p)
  }
  return out
}

/**
 * Delete every JS asset no emitted page can reach.
 *
 * @param {object} opts
 * @param {string} opts.outDir — the published directory (holds `assets/`)
 * @returns {Promise<{removed: string[], kept: string[], bytes: number}>}
 */
export async function pruneUnreachable({ outDir }) {
  const assetsDir = resolve(outDir, 'assets')
  let all
  try {
    all = (await readdir(assetsDir)).filter((f) => f.endsWith('.js'))
  } catch {
    return { removed: [], kept: [], bytes: 0 }   // no assets/ — nothing to do
  }
  if (!all.length) return { removed: [], kept: [], bytes: 0 }

  const pages = await htmlFiles(outDir)
  if (!pages.length) {
    // Every caller here has just prerendered. No page means the walk has no
    // roots at all, and an empty root set would read as "nothing is reachable"
    // and delete the entire bundle.
    throw new Error(
      `[Sierra] prune: ${outDir} holds ${all.length} JavaScript asset(s) and no HTML page, ` +
      `so there is nothing to walk reachability FROM. Refusing to publish or prune.`
    )
  }

  const named = new Set(all)
  const roots = new Set()
  for (const page of pages)
    for (const m of (await readFile(page, 'utf8')).matchAll(/[A-Za-z0-9_.-]+\.js/g))
      if (named.has(m[0])) roots.add(m[0])

  const kept  = new Set()
  const queue = [...roots]
  while (queue.length) {
    const f = queue.pop()
    if (kept.has(f)) continue
    kept.add(f)
    const src = await readFile(join(assetsDir, f), 'utf8')
    for (const m of src.matchAll(/[A-Za-z0-9_.-]+\.js/g))
      if (named.has(m[0]) && !kept.has(m[0])) queue.push(m[0])
  }

  const removed = all.filter((f) => !kept.has(f))
  let bytes = 0
  for (const f of removed) {
    const p = join(assetsDir, f)
    bytes += (await stat(p)).size
    await rm(p, { force: true })
    // Its sourcemap, when the app builds them. An orphan `.map` is the same
    // thing this pass is about — a published file nothing can load.
    await rm(`${p}.map`, { force: true }).catch(() => {})
  }
  return { removed, kept: [...kept], bytes }
}
