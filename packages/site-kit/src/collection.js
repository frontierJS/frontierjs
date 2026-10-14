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
// Items come in file-name order, so an author orders a collection by naming
// its files (`1-stacy.md`, `2-jimmy.md`). The order is by code unit, as the
// glob keys sort and as ksite's sites were written against: `9-grant.md`
// sorts before `91-alison.md`.

/**
 * @param {Record<string, { frontmatter?: Record<string, unknown>, default: unknown }>} modules — an eager glob over `.md`
 * @returns {Array<{ slug: string, frontmatter: Record<string, unknown>, Body: unknown }>}
 */
export function collection(modules) {
  return Object.keys(modules).sort().map((path) => ({
    slug: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
    frontmatter: modules[path].frontmatter ?? {},
    Body: modules[path].default,
  }))
}
