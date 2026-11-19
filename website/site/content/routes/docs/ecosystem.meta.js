// site/content/routes/docs/ecosystem.meta.js — the docs sidebar for the
// Ecosystem page; the page itself is static markup.

import { docsNav } from '../../data/docs-nav.js'

export async function load() {
  return { nav: docsNav() }
}
