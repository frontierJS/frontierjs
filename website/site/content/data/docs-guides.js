// site/content/data/docs-guides.js — the guides the docs offer, one per job,
// grouped by realm. Each entry names a `page` of a package guide
// ('schema/models-and-fields') and links there; the guide is Litestone's unless
// `guide: 'junction'` says otherwise. A `page` the guide README does not list
// fails the build rather than publishing a link that 404s.
//
// `pkg` names the workspace folder whose brand icon (brand/assets/icons) the
// sidebar draws beside the entry; docs-nav.js refuses one with no icon file.

import { litestoneGuide, junctionGuide, sierraGuide, basecampGuide, testingGuide } from './package-guide.js'

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
    { slug: 'auth', title: 'Auth', pkg: 'auth', guide: 'junction', page: 'identity/auth' },
    { slug: 'notifications', title: 'Notifications', pkg: 'notifications', guide: 'junction', page: 'plugins/notifications' },
    { slug: 'email', title: 'Email', pkg: 'email-kit', guide: 'junction', page: 'running/mail' },
    { slug: 'integrations', title: 'Integrations', pkg: 'conduit', guide: 'junction', page: 'plugins/conduit' },
    { slug: 'agents', title: 'Agents and MCP', pkg: 'mcp', guide: 'junction', page: 'plugins/mcp' },
  ] },

  { section: 'UI', lede: 'The Resource realm: the screens Sierra builds from Mesa components.', guides: [
    { slug: 'resource', title: 'A resource and its form', pkg: 'sierra', guide: 'sierra', page: 'resources/a-resource' },
    { slug: 'routing', title: 'Routing and layouts', pkg: 'sierra', guide: 'sierra', page: 'routing/pages-and-paths' },
    { slug: 'styling', title: 'Styling', pkg: 'css', guide: 'sierra', page: 'around/styling' },
    { slug: 'components', title: 'Components', pkg: 'ui', guide: 'sierra', page: 'around/components' },
    { slug: 'public-site', title: 'A public site', pkg: 'sierra', guide: 'sierra', page: 'build/prerendering' },
    { slug: 'surfaces', title: 'Other surfaces', pkg: 'jetty', guide: 'sierra', page: 'around/surfaces' },
    { slug: 'printing', title: 'PDFs and images', guide: 'sierra', page: 'around/print-kit' },
  ] },

  { section: 'Ship', lede: 'Deployment: getting a release onto a machine and keeping it running.', guides: [
    { slug: 'deploy', title: 'Deploy', pkg: 'basecamp', guide: 'basecamp', page: 'deploy/a-release' },
    { slug: 'fleet', title: 'A fleet', pkg: 'outpost', guide: 'basecamp', page: 'fleet/basecamp-and-outpost' },
    { slug: 'observability', title: 'Health and metrics', pkg: 'junction', guide: 'junction', page: 'running/health-and-metrics' },
    { slug: 'backups', title: 'Backups', pkg: 'basecamp', guide: 'basecamp', page: 'backups/what-is-backed-up' },
  ] },

  { section: 'Test', lede: 'The Testing realm: proving the app does what the schema says.', guides: [
    { slug: 'testing', title: 'Testing', pkg: 'testing', guide: 'testing', page: 'environment/a-test-env' },
    { slug: 'browser-tests', title: 'Driving a browser', pkg: 'testing', guide: 'testing', page: 'browser/driving-a-page' },
  ] },
]

const GUIDES = { litestone: litestoneGuide, junction: junctionGuide, sierra: sierraGuide, basecamp: basecampGuide, testing: testingGuide }

const guidePages = () => Object.fromEntries(Object.entries(GUIDES).map(([id, g]) =>
  [id, new Map(g.loadGuide().flatMap((s) => s.pages.map((p) => [`${p.dir}/${p.slug}`, p.href])))]))

const resolve = (g, pages) => {
  const id = g.guide ?? 'litestone'
  if (!pages[id].has(g.page)) throw new Error(`docs-guides: ${g.slug} names ${g.page}, which the ${id} guide README does not list`)
  return { ...g, href: pages[id].get(g.page) }
}

/** [{ section, lede, guides: [{ slug, title, href, page, guide?, pkg? }] }] */
export function loadGuides() {
  const pages = guidePages()
  return SECTIONS.map((s) => ({ ...s, guides: s.guides.map((g) => resolve(g, pages)) }))
}
