// site/content/routes/docs/testing/index.meta.js — the Testing guide's landing page:
// every section and page, in the order the guide's README gives.

import { testingGuide } from '../../../data/package-guide.js'
import { docsNav }      from '../../../data/docs-nav.js'

export async function load() {
  return { sections: testingGuide.loadGuide(), guide: testingGuide.info, nav: docsNav() }
}

export function head() {
  return {
    title:       `${testingGuide.name} | FrontierJS`,
    description: testingGuide.description,
  }
}
