// site/content/data/docs-nav.js — the docs sidebar: its areas and the tree
// under each, read at build time by every page under /docs/.
//
// A package guide's tree is its loadGuide(), so the sidebar and the guide's own
// README cannot disagree about which pages exist or in what order. The owed
// guides are data/docs-guides.js, each a stub page the sidebar tags as one.

import { existsSync }                from 'node:fs'
import { fileURLToPath }             from 'node:url'
import { mesaGuide, litestoneGuide, junctionGuide, sierraGuide, basecampGuide, testingGuide } from './package-guide.js'
import { loadGuides }                from './docs-guides.js'

const REPO = 'https://github.com/frontierjs/frontierjs/blob/main'

// An area is a door in the sidebar's top box. One that lives outside /docs/
// has no tree; the sidebar links to it and stays on the current area.
const AREAS = [
  { id: 'tutorial',  title: 'Tutorial',        href: '/start/tutorial/', icon: 'rocket' },
  { id: 'learn',     title: 'Learn',           href: '/docs/',           icon: 'book' },
  { id: 'mesa',      title: 'Mesa guide',      href: '/docs/mesa/',      icon: 'mesa' },
  { id: 'litestone', title: 'Litestone guide', href: '/docs/litestone/', icon: 'database' },
  { id: 'junction',  title: 'Junction guide',  href: '/docs/junction/',  icon: 'plug' },
  { id: 'sierra',    title: 'Sierra guide',    href: '/docs/sierra/',    icon: 'layout' },
  { id: 'basecamp',  title: 'Basecamp guide',  href: '/docs/basecamp/',  icon: 'server' },
  { id: 'testing',   title: 'Testing guide',   href: '/docs/testing/',   icon: 'check' },
  { id: 'reference', title: 'Reference',       href: '/packages/',       icon: 'info' },
]

// The areas whose tree is a package guide.
const GUIDES = { mesa: mesaGuide, litestone: litestoneGuide, junction: junctionGuide, sierra: sierraGuide, basecamp: basecampGuide, testing: testingGuide }

const START = { section: 'Start here', pages: [
  { title: 'Overview',  href: '/docs/' },
  { title: 'Concepts',  href: '/docs/concepts/' },
  { title: 'Ecosystem', href: '/docs/ecosystem/' },
] }

const ELSEWHERE = { section: 'Elsewhere', pages: [
  { title: 'The tour',   href: '/tour/' },
  { title: 'Vocabulary', href: `${REPO}/VOCABULARY.md` },
] }

// public/icons is the symlink to brand/assets/icons the home page reads too; a
// traced SVG wins over the PNG.
const ICONS = fileURLToPath(new URL('../public/icons/', import.meta.url))

const iconOf = (guide) => {
  if (!guide.pkg) return null
  const file = [`${guide.pkg}.svg`, `${guide.pkg}.png`].find((f) => existsSync(ICONS + f))
  if (!file) throw new Error(`docs-nav: ${guide.slug} names pkg ${guide.pkg}, which has no icon in brand/assets/icons`)
  return `/icons/${file}`
}

const learn = () => [
  START,
  ...loadGuides().map((s) => ({
    section: s.section,
    pages:   s.guides.map((g) => ({ title: g.title, href: g.href, stub: !g.page, icon: iconOf(g) })),
  })),
  ELSEWHERE,
]

/** The area a docs page belongs to, from its path. */
export const areaOf = (href) => AREAS.find((a) => a.id in GUIDES && String(href).startsWith(a.href))?.id ?? 'learn'

/** { areas, trees: { learn, mesa, litestone, junction, sierra, basecamp, testing } } — plain data, safe to hand to a page. */
export function docsNav() {
  return {
    areas: AREAS,
    trees: {
      learn: learn(),
      ...Object.fromEntries(Object.entries(GUIDES).map(([id, g]) => [id, g.loadGuide().map((s) => ({
        section: s.section,
        pages:   s.pages.map((p) => ({ title: p.title, href: p.href })),
      }))])),
    },
  }
}
