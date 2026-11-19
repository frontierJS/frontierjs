// site/content/data/docs-guides.js — the guides the docs owe, one per job,
// grouped by realm. Each is a stub page at /docs/guides/<slug>/ until written:
// `covers` is the brief, `from` the repo files that hold the material today,
// and `tutor` the fli lesson that already walks it, where one does.
//
// A `from` path that no longer exists fails the build rather than publishing
// a link that 404s on GitHub, which links.internal cannot see.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const BLOB = 'https://github.com/frontierjs/frontierjs/blob/main'

export const BASE = '/docs/guides/'

const SECTIONS = [
  { section: 'Data', lede: 'The Model realm: what db/schema.lite declares and Litestone enforces.', guides: [
    { slug: 'schema', title: 'A schema',
      lede: 'Models, fields, relations and enums in db/schema.lite, and what each line turns into.',
      covers: ['A model and its fields, with the attributes that validate them', 'Relations: one-to-many, many-to-many, and the foreign key each writes', 'Enums, defaults and computed fields', 'Pushing the schema into a database with fli db:push'],
      from: ['packages/litestone/docs/schema.md', 'packages/litestone/docs/modeling.md', 'packages/litestone/docs/relations.md'],
      tutor: 'app' },
    { slug: 'querying', title: 'Querying',
      lede: 'Reading rows back: filters, sorting, paging, aggregates and relations in one call.',
      covers: ['findMany and findFirst, with where, orderBy and paging', 'Filter operators and the $or, $and and $not combinators', 'Aggregates and group-by', 'Loading related rows'],
      from: ['packages/litestone/docs/querying.md', 'packages/litestone/docs/filtering.md', 'packages/litestone/docs/sorting.md', 'packages/litestone/docs/aggregation.md'] },
    { slug: 'access', title: 'Access rules',
      lede: 'Who may read and write what, declared in the schema and enforced at the Data boundary.',
      covers: ['The gate ladder and @@gate', 'Row policies with @@allow and @@deny', 'Field policies: @guarded and friends', 'Why x-gate in the browser is an affordance and never the check'],
      from: ['packages/litestone/docs/access-control.md', 'packages/litestone/docs/guides/row-level-security.md'],
      tutor: 'access' },
    { slug: 'validation', title: 'Validation',
      lede: 'The rules a value must meet before it is written, and the same rules in the form.',
      covers: ['Field attributes that validate: @email, @length, @min and the rest', 'Model-level checks', 'The JSON Schema the browser validates against'],
      from: ['packages/litestone/docs/validate.md', 'packages/litestone/docs/jsonschema.md'] },
    { slug: 'state-machines', title: 'State machines',
      lede: 'A status field that only moves along declared transitions.',
      covers: ['@@transitions and the named transitions it defines', 'Calling a transition, and the refusal for one that is not allowed', 'Gating a transition'],
      from: ['packages/litestone/docs/schema.md'] },
    { slug: 'protected-fields', title: 'Protected fields',
      lede: 'Encrypted, hashed, secret and personal data, and what each one costs to query.',
      covers: ['@encrypted, @hashed, @secret, @personal and @opaque', 'Keys and rotation', 'How each shows in the audit trail'],
      from: ['packages/litestone/docs/encryption.md'] },
    { slug: 'audit-trail', title: 'The audit trail',
      lede: 'Every write recorded with who made it, and protected fields redacted.',
      covers: ['Turning the trail on for a model', 'Reading the history of a row', 'Redaction of protected fields'],
      from: ['packages/litestone/docs/trail.md', 'packages/litestone/docs/guides/audit-trail.md'] },
    { slug: 'changing-a-schema', title: 'Changing a schema',
      lede: 'Changing a schema that is already deployed without losing data or downtime.',
      covers: ['Migrations and what fli db:push writes', 'Expand and contract', 'Splitting a breaking change across three deploys'],
      from: ['packages/litestone/docs/migrations.md'],
      tutor: 'change' },
    { slug: 'tenancy', title: 'Multi-tenancy',
      lede: 'One app serving many customers, each seeing only their own rows.',
      covers: ['Row tenancy and database tenancy, and when to choose each', 'How the tenant reaches a query', 'A worked SaaS example'],
      from: ['packages/litestone/docs/multi-tenancy.md', 'packages/litestone/docs/guides/multi-tenant-saas.md'] },
    { slug: 'search', title: 'Search',
      lede: 'Finding rows by text and by meaning: full-text search, ranking and vectors.',
      covers: ['Full-text search on a model', 'Ranking results', 'Vector columns and similarity search'],
      from: ['packages/litestone/docs/full-text-search.md', 'packages/litestone/docs/rank.md', 'packages/litestone/docs/vectors.md'] },
    { slug: 'files', title: 'Files',
      lede: 'Uploads stored beside the row that owns them.',
      covers: ['A file field in the schema', 'Uploading through a service', 'Where the bytes live'],
      from: ['packages/litestone/docs/file-storage.md', 'packages/litestone/docs/guides/file-uploads.md'] },
    { slug: 'adopting-a-database', title: 'Adopting a database',
      lede: 'A SQLite database that predates the framework, read into a schema and served.',
      covers: ['Introspecting an existing database into db/schema.lite', 'Checking the schema against the data', 'Recording findings in check-baseline.json rather than fixing them first'],
      from: ['packages/litestone/docs/import.md'],
      tutor: 'adopt' },
  ] },

  { section: 'API', lede: 'The Service realm: what Junction serves for each model, and how to add to it.', guides: [
    { slug: 'service', title: 'A service',
      lede: 'The API a model gets for free, and where your own behavior goes.',
      covers: ['What a service answers with no code', 'Hooks: before, after and error, in pipeline order', 'Custom methods', 'What is on ctx, and what is not'],
      from: ['packages/junction/README.md'] },
    { slug: 'routes', title: 'Raw routes and middleware',
      lede: 'The HTTP that is not a service: a webhook receiver, a health check, a file stream.',
      covers: ['A raw route and its params', 'Middleware, in order', 'CSRF, idempotency keys and rate limits'],
      from: ['packages/junction/README.md'] },
    { slug: 'transactions', title: 'Transactions and effects',
      lede: 'Writes that commit together, and effects that wait for the commit.',
      covers: ['Transactions across services', 'ctx.afterCommit for effects that must not run early', 'ctx.enqueue for effects that must not be lost'],
      from: ['packages/junction/README.md'] },
    { slug: 'live', title: 'Live updates',
      lede: 'A write reaching every client that is allowed to see it, with no polling.',
      covers: ['Channels and the broadcast a write makes', 'The gate deciding which socket is told', 'Subscribing from the browser'],
      from: ['packages/junction/README.md'],
      tutor: 'live' },
    { slug: 'jobs', title: 'Jobs and schedules',
      lede: 'Work that outlives the request, on a queue that is a SQLite file.',
      covers: ['A job, named by its own filename', 'Enqueueing from a service', 'Retries, and cron schedules'],
      from: ['packages/caravan/README.md'],
      tutor: 'jobs' },
    { slug: 'auth', title: 'Auth',
      lede: 'Sign-in, sessions and the principal every call runs as.',
      covers: ['Adding @frontierjs/auth and the schema it brings', 'Sessions from a cookie, and bearer tokens', 'Running as somebody else, and as the system'],
      from: ['packages/auth/README.md'] },
    { slug: 'notifications', title: 'Notifications',
      lede: 'Telling somebody something once, across every transport they are reached on.',
      covers: ['A notification and its transports', 'Choosing transports per recipient', 'The in-app transport and its channel'],
      from: ['packages/notifications/README.md'],
      tutor: 'notify' },
    { slug: 'email', title: 'Email',
      lede: 'Sending mail from a service, with templates that render in every client.',
      covers: ['Sending from a service', 'Writing a template with email-kit', 'Previewing and testing mail'],
      from: ['packages/junction/README.md', 'packages/email-kit/README.md'] },
    { slug: 'integrations', title: 'Integrations',
      lede: 'Third-party APIs and their webhooks, each named once with its credentials and failure policy.',
      covers: ['Declaring a counterparty with Conduit', 'Calling it from a service', 'Receiving its webhooks', 'Using a published connector'],
      from: ['packages/conduit/README.md'] },
    { slug: 'agents', title: 'Agents and MCP',
      lede: 'An MCP server for your app, derived from the schema, with the gate as its permission model.',
      covers: ['Mounting the MCP surface', 'Which tools a caller sees, and why', 'Signing an agent in'],
      from: ['packages/mcp/README.md'] },
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

/** [{ section, lede, guides: [{ slug, title, lede, covers, from: [{label, href}], tutor, href }] }] */
export function loadGuides() {
  return SECTIONS.map((s) => ({
    ...s,
    guides: s.guides.map((g) => ({ ...g, href: `${BASE}${g.slug}/`, from: g.from.map(linkOf), tutor: g.tutor ?? null })),
  }))
}

export function loadGuidePage(slug) {
  for (const s of loadGuides()) {
    const g = s.guides.find((x) => x.slug === slug)
    if (g) return { ...g, section: s.section }
  }
  throw new Error(`docs-guides: no guide ${slug}`)
}
