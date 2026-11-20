// site/content/routes/docs/mesa/index.meta.js — the Mesa guide's landing page:
// every section and page, in the order the guide's README gives.

import { mesaGuide } from '../../../data/package-guide.js'
import { docsNav }       from '../../../data/docs-nav.js'

export async function load() {
  return { sections: mesaGuide.loadGuide(), guide: mesaGuide.info, nav: docsNav() }
}

export function head() {
  return {
    title:       `${mesaGuide.name} | FrontierJS`,
    description: mesaGuide.description,
  }
}
