// site/content/routes/docs/basecamp/index.meta.js — the Basecamp guide's landing page:
// every section and page, in the order the guide's README gives.

import { basecampGuide } from '../../../data/package-guide.js'
import { docsNav }      from '../../../data/docs-nav.js'

export async function load() {
  return { sections: basecampGuide.loadGuide(), guide: basecampGuide.info, nav: docsNav() }
}

export function head() {
  return {
    title:       `${basecampGuide.name} | FrontierJS`,
    description: basecampGuide.description,
  }
}
