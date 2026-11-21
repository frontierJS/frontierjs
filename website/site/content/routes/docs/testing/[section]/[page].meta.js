// site/content/routes/docs/testing/[section]/[page].meta.js — one page of the Testing
// guide, from packages/testing/docs/guide/ by way of data/package-guide.js.
//
// `getStaticPaths()` is the guide README's list, so a page the README does not
// name is not built. `head()` gives each page its own title: frontmatter is
// static text, and every page would otherwise share one.

import { testingGuide } from '../../../../data/package-guide.js'
import { docsNav }      from '../../../../data/docs-nav.js'

export async function getStaticPaths() {
  return testingGuide.loadGuide().flatMap((s) => s.pages.map((p) => ({ section: p.dir, page: p.slug })))
}

export async function load({ params }) {
  return { ...testingGuide.loadPage(params.section, params.page), nav: docsNav() }
}

export function head({ data }) {
  return {
    title:       `${data.title} — ${testingGuide.name} | FrontierJS`,
    description: data.description,
  }
}
