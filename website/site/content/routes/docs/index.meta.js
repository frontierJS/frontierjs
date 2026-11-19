// site/content/routes/docs/index.meta.js — the docs sidebar for the docs home.

import { docsNav } from '../../data/docs-nav.js'

export async function load() {
  return { nav: docsNav() }
}
