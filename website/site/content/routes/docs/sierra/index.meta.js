// site/content/routes/docs/sierra/index.meta.js — the Sierra guide's landing page:
// every section and page, in the order the guide's README gives.

import { sierraGuide } from '../../../data/package-guide.js'
import { docsNav }      from '../../../data/docs-nav.js'

export async function load() {
  return { sections: sierraGuide.loadGuide(), guide: sierraGuide.info, nav: docsNav() }
}

export function head() {
  return {
    title:       `${sierraGuide.name} | FrontierJS`,
    description: sierraGuide.description,
  }
}
