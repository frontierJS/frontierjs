// site/content/routes/docs/junction/[section]/[page].meta.js — one page of the Junction
// guide, from packages/junction/docs/guide/ by way of data/package-guide.js.
//
// `getStaticPaths()` is the guide README's list, so a page the README does not
// name is not built. `head()` gives each page its own title: frontmatter is
// static text, and every page would otherwise share one.

import { junctionGuide } from '../../../../data/package-guide.js'
import { docsNav }       from '../../../../data/docs-nav.js'

export async function getStaticPaths() {
  return junctionGuide.loadGuide().flatMap((s) => s.pages.map((p) => ({ section: p.dir, page: p.slug })))
}

export async function load({ params }) {
  return { ...junctionGuide.loadPage(params.section, params.page), nav: docsNav() }
}

export function head({ data }) {
  return {
    title:       `${data.title} — ${junctionGuide.name} | FrontierJS`,
    description: data.description,
  }
}
