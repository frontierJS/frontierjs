// site/content/routes/docs/junction/index.meta.js — the Junction guide's landing page:
// every section and page, in the order the guide's README gives.

import { junctionGuide } from '../../../data/package-guide.js'
import { docsNav }       from '../../../data/docs-nav.js'

export async function load() {
  return { sections: junctionGuide.loadGuide(), guide: junctionGuide.info, nav: docsNav() }
}

export function head() {
  return {
    title:       `${junctionGuide.name} | FrontierJS`,
    description: junctionGuide.description,
  }
}
