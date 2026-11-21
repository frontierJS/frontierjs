// site/content/data/docs-guides.js — the guides the docs owe, one per job,
// grouped by realm. Each is a stub page at /docs/guides/<slug>/ until written:
// `covers` is the brief, `from` the repo files that hold the material today,
// and `tutor` the fli lesson that already walks it, where one does.
//
// An entry with a `page` ('schema/models-and-fields') is written: it names a
// page of a package guide, links there, and has no stub. The guide is Litestone's
// unless `guide: 'junction'` says otherwise. A `page` the guide README does not
// list, or a `from` path that no longer exists, fails the build rather than
// publishing a link that 404s.
//
// `pkg` names the workspace folder whose brand icon (brand/assets/icons) the
// sidebar draws beside the entry; docs-nav.js refuses one with no icon file.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { litestoneGuide, junctionGuide } from './package-guide.js'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const BLOB = 'https://github.com/frontierjs/frontierjs/blob/main'

export const BASE = '/docs/guides/'

const SECTIONS = [
  { section: 'Data', lede: 'The Model realm: what db/schema.lite declares and Litestone enforces.', guides: [
    { slug: 'schema', title: 'A schema', page: 'schema/models-and-fields' },
    { slug: 'querying', title: 'Querying', page: 'querying/reading' },
    { slug: 'access', title: 'Access rules', page: 'access/gates' },
    { slug: 'validation', title: 'Validation', page: 'validation/validators' },
    { slug: 'state-machines', title: 'State machines', page: 'validation/state-machines' },
    { slug: 'protected-fields', title: 'Protected fields', page: 'protected/encryption' },
    { slug: 'audit-trail', title: 'The audit trail', page: 'protected/audit-trail' },
    { slug: 'changing-a-schema', title: 'Changing a schema', page: 'migrations/migrations' },
    { slug: 'tenancy', title: 'Multi-tenancy', page: 'advanced/multi-tenancy' },
    { slug: 'search', title: 'Search', page: 'built-in/full-text-search' },
    { slug: 'files', title: 'Files', page: 'built-in/files' },
    { slug: 'adopting-a-database', title: 'Adopting a database', page: 'migrations/adopting' },
  ] },

  { section: 'API', lede: 'The Service realm: what Junction serves for each model, and how to add to it.', guides: [
    { slug: 'service', title: 'A service', pkg: 'junction', guide: 'junction', page: 'services/a-service' },
    { slug: 'routes', title: 'Raw routes and middleware', pkg: 'junction', guide: 'junction', page: 'transport/raw-routes' },
    { slug: 'transactions', title: 'Transactions and effects', pkg: 'junction', guide: 'junction', page: 'writes/transactions' },
    { slug: 'live', title: 'Live updates', pkg: 'junction', guide: 'junction', page: 'transport/live-updates' },
    { slug: 'jobs', title: 'Jobs and schedules', pkg: 'caravan', guide: 'junction', page: 'plugins/caravan' },
    { slug: 'auth', title: 'Auth', pkg: 'auth',
      lede: 'Sign-in, sessions and the principal every call runs as.',
      covers: ['Adding @frontierjs/auth and the schema it brings', 'Sessions from a cookie, and bearer tokens', 'Running as somebody else, and as the system'],
      from: ['packages/auth/README.md'] },
    { slug: 'notifications', title: 'Notifications', pkg: 'notifications', guide: 'junction', page: 'plugins/notifications' },
    { slug: 'email', title: 'Email', pkg: 'email-kit', guide: 'junction', page: 'running/mail' },
    { slug: 'integrations', title: 'Integrations', pkg: 'conduit', guide: 'junction', page: 'plugins/conduit' },
    { slug: 'agents', title: 'Agents and MCP', pkg: 'mcp', guide: 'junction', page: 'plugins/mcp' },
  ] },

  { section: 'UI', lede: 'The Resource realm: the screens Sierra builds from Mesa components.', guides: [
    { slug: 'resource', title: 'A resource and its form',
      lede: 'Binding a page to a model, and the form read off the schema.',
      covers: ['A resource file and its <script module>', 'Lists, records and the form a model carries', 'The same schema rule refusing in the form and at the server'],
      from: ['packages/sierra/README.md'],
      tutor: 'ui' },
    { slug: 'routing', title: 'Routing and layouts',
      lede: 'The file tree as the route table, and layouts that nest.',
      covers: ['Pages under src/routes/', 'Params and dynamic routes', 'Layouts with _module.mesa'],
      from: ['packages/sierra/README.md'] },
    { slug: 'styling', title: 'Styling',
      lede: 'Tones and treatments instead of colors, with @frontierjs/css.',
      covers: ['A tone and a treatment', 'Theming an app', 'Adding UnoCSS as an opt-in layer'],
      from: ['packages/css/README.md'] },
    { slug: 'components', title: 'Components',
      lede: 'The ready-made forms, layout, overlays and feedback in @frontierjs/ui.',
      covers: ['What the kit has', 'Composing a screen from it', 'When to write your own'],
      from: ['packages/ui/README.md'] },
    { slug: 'public-site', title: 'A public site',
      lede: 'Pages built ahead of time, with the data in the HTML and islands where it needs to move.',
      covers: ['Prerendering a route', 'Islands', 'The build refusing to publish anything gated', 'A markdown site with site-kit'],
      from: ['packages/sierra/README.md', 'packages/site-kit/README.md'],
      tutor: 'site' },
    { slug: 'surfaces', title: 'Other surfaces',
      lede: 'The same app as a desktop app, a phone app, a browser extension, a widget or a CLI.',
      covers: ['What a surface is, and the directory each one takes', 'A browser extension with Jetty', 'Widgets embedded on someone else\'s page'],
      from: ['packages/jetty/README.md', 'example/README.md'] },
    { slug: 'printing', title: 'PDFs and images',
      lede: 'An HTML document to a PDF, or an element to a PNG.',
      covers: ['Printing a page to PDF', 'Capturing an element as an image', 'Running it in a job'],
      from: ['packages/print-kit/README.md'] },
  ] },

  { section: 'Ship', lede: 'Deployment: getting a release onto a machine and keeping it running.', guides: [
    { slug: 'deploy', title: 'Deploy',
      lede: 'A release onto a server: an image, a journal, a redeploy and a revert.',
      covers: ['What a release is', 'Deploying, redeploying and reverting', 'Secrets and environment'],
      from: ['docs/QUICKSTART.md'],
      tutor: 'deploy' },
    { slug: 'fleet', title: 'A fleet',
      lede: 'Basecamp as the control plane and Outpost on each machine.',
      covers: ['Provisioning a server', 'Enrolling it with Outpost', 'Releasing to it from Basecamp'],
      from: ['packages/basecamp/README.md', 'packages/outpost/README.md'],
      tutor: 'fleet' },
    { slug: 'observability', title: 'Health and metrics',
      lede: 'Knowing the app is up, and what it is doing.',
      covers: ['The health and metrics endpoints', 'Exporting to a collector', 'Where the logs go'],
      from: ['packages/junction/README.md'] },
    { slug: 'backups', title: 'Backups',
      lede: 'Copies of every database, and a restore that has been tried.',
      covers: ['What is backed up, and where to', 'Restoring', 'Rehearsing a restore'],
      from: ['packages/basecamp/README.md'] },
  ] },

  { section: 'Test', lede: 'The Testing realm: proving the app does what the schema says.', guides: [
    { slug: 'testing', title: 'Testing',
      lede: 'The checks a schema already contains, and your own on top.',
      covers: ['createTestEnv: a migrated database, factories and a principal', 'The checks derived from the schema', 'Mutating the schema to grade the checks'],
      from: ['packages/testing/README.md'],
      tutor: 'test' },
    { slug: 'browser-tests', title: 'Driving a browser',
      lede: 'Proving a screen works by using it.',
      covers: ['Driving a page: typing, clicking, reading', 'Catching console errors and failed requests', 'Screenshots as evidence'],
      from: ['packages/testing/README.md'] },
  ] },
]

const linkOf = (path) => {
  if (!existsSync(ROOT + path)) throw new Error(`docs-guides: ${path} does not exist`)
  return { label: path, href: `${BLOB}/${path}` }
}

const GUIDES = { litestone: litestoneGuide, junction: junctionGuide }

const guidePages = () => Object.fromEntries(Object.entries(GUIDES).map(([id, g]) =>
  [id, new Map(g.loadGuide().flatMap((s) => s.pages.map((p) => [`${p.dir}/${p.slug}`, p.href])))]))

const resolve = (g, pages) => {
  if (!g.page) return { ...g, href: `${BASE}${g.slug}/`, from: g.from.map(linkOf), tutor: g.tutor ?? null }
  const id = g.guide ?? 'litestone'
  if (!pages[id].has(g.page)) throw new Error(`docs-guides: ${g.slug} names ${g.page}, which the ${id} guide README does not list`)
  return { ...g, href: pages[id].get(g.page) }
}

/** [{ section, lede, guides: [{ slug, title, href, page? } | stub: { lede, covers, from: [{label, href}], tutor }] }] */
export function loadGuides() {
  const pages = guidePages()
  return SECTIONS.map((s) => ({ ...s, guides: s.guides.map((g) => resolve(g, pages)) }))
}

/** The stub guides: those not yet written as a guide page. */
export const stubs = () => loadGuides().flatMap((s) => s.guides.filter((g) => !g.page))

export function loadGuidePage(slug) {
  for (const s of loadGuides()) {
    const g = s.guides.find((x) => x.slug === slug && !x.page)
    if (g) return { ...g, section: s.section }
  }
  throw new Error(`docs-guides: no stub guide ${slug}`)
}
