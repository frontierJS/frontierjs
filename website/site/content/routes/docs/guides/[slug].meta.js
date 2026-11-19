// site/content/routes/docs/guides/[slug].meta.js — one owed guide's stub page,
// from data/docs-guides.js. `head()` titles each page: frontmatter is static
// text, and every guide would otherwise share one title.

import { loadGuides, loadGuidePage } from '../../../data/docs-guides.js'
import { docsNav }                    from '../../../data/docs-nav.js'

export async function getStaticPaths() {
  return loadGuides().flatMap((s) => s.guides.map((g) => ({ slug: g.slug })))
}

export async function load({ params }) {
  return { ...loadGuidePage(params.slug), nav: docsNav() }
}

export function head({ data }) {
  return {
    title:       `${data.title} — Guides | FrontierJS`,
    description: data.lede,
  }
}
