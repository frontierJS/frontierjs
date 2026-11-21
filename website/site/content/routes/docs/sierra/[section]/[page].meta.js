// site/content/routes/docs/sierra/[section]/[page].meta.js — one page of the Sierra
// guide, from packages/sierra/docs/guide/ by way of data/package-guide.js.
//
// `getStaticPaths()` is the guide README's list, so a page the README does not
// name is not built. `head()` gives each page its own title: frontmatter is
// static text, and every page would otherwise share one.

import { sierraGuide } from '../../../../data/package-guide.js'
import { docsNav }      from '../../../../data/docs-nav.js'

export async function getStaticPaths() {
  return sierraGuide.loadGuide().flatMap((s) => s.pages.map((p) => ({ section: p.dir, page: p.slug })))
}

export async function load({ params }) {
  return { ...sierraGuide.loadPage(params.section, params.page), nav: docsNav() }
}

export function head({ data }) {
  return {
    title:       `${data.title} — ${sierraGuide.name} | FrontierJS`,
    description: data.description,
  }
}
