// site/content/data/docs-nav.js — the docs sidebar: its areas and the tree
// under each, read at build time by every page under /docs/.
//
// The Mesa guide's tree is loadGuide(), so the sidebar and the guide's own
// README cannot disagree about which pages exist or in what order. The owed
// guides are data/docs-guides.js, each a stub page the sidebar tags as one.

import { loadGuide }  from './mesa-guide.js'
import { loadGuides } from './docs-guides.js'

const REPO = 'https://github.com/frontierjs/frontierjs/blob/main'

// An area is a door in the sidebar's top box. One that lives outside /docs/
// has no tree; the sidebar links to it and stays on the current area.
const AREAS = [
  { id: 'tutorial',  title: 'Tutorial',   href: '/start/tutorial/', icon: 'rocket' },
  { id: 'learn',     title: 'Learn',      href: '/docs/',           icon: 'book' },
  { id: 'mesa',      title: 'Mesa guide', href: '/docs/mesa/',      icon: 'mesa' },
  { id: 'reference', title: 'Reference',  href: '/packages/',       icon: 'info' },
]

const START = { section: 'Start here', pages: [
  { title: 'Overview',  href: '/docs/' },
  { title: 'Concepts',  href: '/docs/concepts/' },
  { title: 'Ecosystem', href: '/docs/ecosystem/' },
] }

const ELSEWHERE = { section: 'Elsewhere', pages: [
  { title: 'The tour',   href: '/tour/' },
  { title: 'Vocabulary', href: `${REPO}/VOCABULARY.md` },
] }

const learn = () => [
  START,
  ...loadGuides().map((s) => ({
    section: s.section,
    pages:   s.guides.map((g) => ({ title: g.title, href: g.href, stub: true })),
  })),
  ELSEWHERE,
]

/** The area a docs page belongs to, from its path. */
export const areaOf = (href) => (String(href).startsWith('/docs/mesa/') ? 'mesa' : 'learn')

/** { areas, trees: { learn, mesa } } — plain data, safe to hand to a page. */
export function docsNav() {
  return {
    areas: AREAS,
    trees: {
      learn: learn(),
      mesa:  loadGuide().map((s) => ({
        section: s.section,
        pages:   s.pages.map((p) => ({ title: p.title, href: p.href })),
      })),
    },
  }
}
