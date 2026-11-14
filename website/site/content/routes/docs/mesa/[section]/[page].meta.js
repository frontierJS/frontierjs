// site/content/routes/docs/mesa/[section]/[page].meta.js — one page of the Mesa
// guide, from packages/mesa/docs/guide/ by way of data/mesa-guide.js.
//
// `getStaticPaths()` is the guide README's list, so a page the README does not
// name is not built. `head()` gives each page its own title: frontmatter is
// static text, and fifty-nine pages would otherwise share one.

import { loadGuide, loadPage } from '../../../../data/mesa-guide.js'

export async function getStaticPaths() {
  return loadGuide().flatMap((s) => s.pages.map((p) => ({ section: p.dir, page: p.slug })))
}

export async function load({ params }) {
  return loadPage(params.section, params.page)
}

export function head({ data }) {
  return {
    title:       `${data.title} — Mesa guide | FrontierJS`,
    description: data.description,
  }
}
