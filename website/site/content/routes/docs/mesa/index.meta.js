// site/content/routes/docs/mesa/index.meta.js — the Mesa guide's landing page:
// every section and page, in the order the guide's README gives.

import { loadGuide } from '../../../data/mesa-guide.js'
import { docsNav }   from '../../../data/docs-nav.js'

export async function load() {
  return { guide: loadGuide(), nav: docsNav() }
}

export function head() {
  return {
    title:       'Mesa guide | FrontierJS',
    description: 'How to write Mesa, one short page per primitive: reactivity, template syntax, styling, runtime and reference.',
  }
}
