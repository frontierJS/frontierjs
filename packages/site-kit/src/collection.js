// src/collection.js — a collection's items, one shape for every block that lists one.
//
// A collection is a directory of Markdown under content/collections/, one item
// per file. The block that lists it writes the glob itself —
//
//   collection(import.meta.glob('/content/collections/reviews/*.md', { eager: true }))
//
// because the glob has to be a literal in the .mesa file: Vite expands it
// there, and so does the prerender, which compiles that file outside Vite
// (Sierra's build/glob-expand.js). A glob in this module would reach neither.
//
// An item's `order:` number places it (FJS-D1403), lower first, which is what
// an owner's reorder writes. Items without one follow in file-name order, so a
// site that never writes the key is ordered by naming its files (`1-stacy.md`,
// `2-jimmy.md`). Names compare by code unit, as the glob keys sort and as
// ksite's sites were written against: `9-grant.md` sorts before `91-alison.md`.

/**
 * @param {Record<string, { frontmatter?: Record<string, unknown>, default: unknown }>} modules — an eager glob over `.md`
 * @returns {Array<{ slug: string, frontmatter: Record<string, unknown>, Body: unknown }>}
 */
export function collection(modules) {
  return Object.keys(modules)
    .map((path) => ({ path, frontmatter: modules[path].frontmatter ?? {} }))
    .sort(byOrder)
    .map(({ path, frontmatter }) => ({
      slug: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
      frontmatter,
      Body: modules[path].default,
    }))
}

/**
 * A collection's order, as a sort comparator over its items: a numeric
 * `order` first, lower first, then the file path by code unit. The owner's
 * reorder (`@frontierjs/site-kit/editable`) sorts by it too, so the two agree.
 *
 * @param {{ path: string, frontmatter?: Record<string, unknown> }} a
 * @param {{ path: string, frontmatter?: Record<string, unknown> }} b
 */
export function byOrder(a, b) {
  const x = orderOf(a), y = orderOf(b)
  if ((x === null) !== (y === null)) return x === null ? 1 : -1
  if (x !== null && x !== y) return x - y
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

const orderOf = (item) => {
  const n = item.frontmatter?.order
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
