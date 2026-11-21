// site/content/routes/docs/basecamp/[section]/[page].meta.js — one page of the Basecamp
// guide, from packages/basecamp/docs/guide/ by way of data/package-guide.js.
//
// `getStaticPaths()` is the guide README's list, so a page the README does not
// name is not built. `head()` gives each page its own title: frontmatter is
// static text, and every page would otherwise share one.

import { basecampGuide } from '../../../../data/package-guide.js'
import { docsNav }      from '../../../../data/docs-nav.js'

export async function getStaticPaths() {
  return basecampGuide.loadGuide().flatMap((s) => s.pages.map((p) => ({ section: p.dir, page: p.slug })))
}

export async function load({ params }) {
  return { ...basecampGuide.loadPage(params.section, params.page), nav: docsNav() }
}

export function head({ data }) {
  return {
    title:       `${data.title} — ${basecampGuide.name} | FrontierJS`,
    description: data.description,
  }
}
