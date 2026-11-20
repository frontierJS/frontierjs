// site/content/routes/docs/litestone/index.meta.js — the Litestone guide's landing page:
// every section and page, in the order the guide's README gives.

import { litestoneGuide } from '../../../data/package-guide.js'
import { docsNav }       from '../../../data/docs-nav.js'

export async function load() {
  return { sections: litestoneGuide.loadGuide(), guide: litestoneGuide.info, nav: docsNav() }
}

export function head() {
  return {
    title:       `${litestoneGuide.name} | FrontierJS`,
    description: litestoneGuide.description,
  }
}
