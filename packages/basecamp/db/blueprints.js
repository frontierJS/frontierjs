// db/blueprints.js
// The starter catalog — nine third-party applications, as `Blueprint` rows.
//
// The first eight were read out of the UI prototype's own `BLUEPRINTS` constant
// rather than invented, and converted column for column: the mock's nested `app` block is
// flat here because `Blueprint`'s columns are `App`'s where they overlap, and
// its `params` array is `BlueprintParam` rows because that list is an ordered
// form rather than a document.
//
// **`brandColor` is set only where the mock carried a literal.** Four of the
// eight took their color from the mock's own theme object (`T.blue`, `T.red`),
// which is a design-system token and not a vendor's brand — copying those would
// put this app's palette in a data column and call it somebody's identity. Null
// is the honest answer, and the card falls back to its own surface.
//
// This is seed data, not shipped data. A real installation curates its own; what
// this is for is having a catalog on screen, because an empty grid looks
// exactly like a broken query.

export const BLUEPRINTS = [
  {
    slug: 'n8n', name: 'n8n', category: 'Automation', icon: '🔄', brandColor: '#ea4b71',
    description: 'Workflow automation platform. Connect anything to everything.',
    version: '1.1.1', image: 'n8nio/n8n:latest',
    appType: 'container', port: 5678,
    volumePath: '/home/node/.n8n', healthCheck: '/healthz',
    cpuLimit: 0.5, memLimitMb: 512,
    notes: 'n8n stores credentials and workflow data in /home/node/.n8n. The persistent volume ensures nothing is lost on redeploy.',
    links: [{ label: 'Docs', url: 'https://docs.n8n.io' },
            { label: 'Docker Hub', url: 'https://hub.docker.com/r/n8nio/n8n' }],
    params: [
      { key: 'N8N_BASIC_AUTH_ACTIVE',   label: 'Enable basic auth', defaultValue: 'true' },
      { key: 'N8N_BASIC_AUTH_USER',     label: 'Admin username', defaultValue: 'admin', required: true, hint: 'Your login username' },
      { key: 'N8N_BASIC_AUTH_PASSWORD', label: 'Admin password', required: true, secret: true, hint: 'Min 8 characters' },
      { key: 'WEBHOOK_URL',             label: 'Public URL', hint: 'https://n8n.acme.com — used for webhooks' },
      { key: 'N8N_ENCRYPTION_KEY',      label: 'Encryption key', required: true, secret: true, generate: 'random_hex_32', hint: 'Random string to encrypt credentials' },
      { key: 'GENERIC_TIMEZONE',        label: 'Timezone', defaultValue: 'UTC', hint: 'e.g. America/New_York' },
    ],
  },
  {
    slug: 'postgres', name: 'PostgreSQL', category: 'Database', icon: '🐘', brandColor: null,
    description: "The world's most advanced open source relational database.",
    version: '16', image: 'postgres:16-alpine',
    appType: 'database', port: 5432,
    volumePath: '/var/lib/postgresql/data', healthCheck: null,
    cpuLimit: 0.5, memLimitMb: 1024,
    notes: 'Accessible only on the private mesh network. Connect your apps using the service name as the host.',
    links: [{ label: 'Docs', url: 'https://www.postgresql.org/docs/16/index.html' }],
    params: [
      { key: 'POSTGRES_DB',       label: 'Database name', defaultValue: 'app_db', required: true },
      { key: 'POSTGRES_USER',     label: 'Superuser', defaultValue: 'postgres', required: true },
      { key: 'POSTGRES_PASSWORD', label: 'Superuser password', required: true, secret: true, generate: 'random_hex_16' },
    ],
  },
  {
    slug: 'redis', name: 'Redis', category: 'Cache', icon: '💾', brandColor: null,
    description: 'In-memory data structure store. Cache, queue, pub/sub.',
    version: '7.2', image: 'redis:7.2-alpine',
    appType: 'container', port: 6379,
    volumePath: null, healthCheck: null,
    cpuLimit: 0.25, memLimitMb: 256,
    notes: 'For production, always set a password. Use allkeys-lru as the eviction policy for a general-purpose cache.',
    links: [{ label: 'Docs', url: 'https://redis.io/docs' }],
    params: [
      { key: 'REDIS_PASSWORD',   label: 'Password (optional)', secret: true, hint: 'Leave blank for no auth (not recommended for production)' },
      { key: 'MAXMEMORY',        label: 'Max memory', defaultValue: '256mb', hint: 'e.g. 256mb, 1gb' },
      { key: 'MAXMEMORY_POLICY', label: 'Eviction policy', defaultValue: 'allkeys-lru' },
    ],
  },
  {
    slug: 'meilisearch', name: 'Meilisearch', category: 'Search', icon: '🔍', brandColor: null,
    description: 'Fast, typo-tolerant, open-source search engine.',
    version: 'v1.6', image: 'getmeili/meilisearch:v1.6',
    appType: 'container', port: 7700,
    volumePath: '/meili_data', healthCheck: '/health',
    cpuLimit: 0.5, memLimitMb: 512,
    notes: 'The master key is used to generate API keys for your applications. Changing it invalidates all existing keys.',
    links: [{ label: 'Docs', url: 'https://www.meilisearch.com/docs' }],
    params: [
      { key: 'MEILI_MASTER_KEY', label: 'Master key', required: true, secret: true, generate: 'random_hex_32', hint: 'All API keys are derived from this. Keep it safe.' },
      { key: 'MEILI_ENV',        label: 'Environment', defaultValue: 'production' },
    ],
  },
  {
    slug: 'plausible', name: 'Plausible Analytics', category: 'Analytics', icon: '📊', brandColor: null,
    description: 'Privacy-friendly, lightweight web analytics. No cookies.',
    version: 'v2.1', image: 'ghcr.io/plausible/community-edition:v2.1',
    appType: 'container', port: 8000,
    volumePath: '/var/lib/plausible', healthCheck: '/api/health',
    cpuLimit: 0.5, memLimitMb: 1024,
    notes: 'Requires a Postgres and ClickHouse database. Deploy those first, then fill in their connection strings here.',
    links: [{ label: 'Docs', url: 'https://plausible.io/docs/self-hosting' }],
    params: [
      { key: 'BASE_URL',                label: 'Public URL', required: true, hint: 'https://analytics.acme.com' },
      { key: 'SECRET_KEY_BASE',         label: 'Secret key base', required: true, secret: true, generate: 'random_hex_64' },
      { key: 'DATABASE_URL',            label: 'Postgres URL', required: true, secret: true, hint: 'postgresql://user:pass@postgres:5432/plausible_db' },
      { key: 'CLICKHOUSE_DATABASE_URL', label: 'ClickHouse URL', defaultValue: 'http://clickhouse:8123/plausible_events_db', required: true },
      { key: 'MAILER_EMAIL',            label: 'From email' },
    ],
  },
  {
    slug: 'umami', name: 'Umami', category: 'Analytics', icon: '📈', brandColor: null,
    description: 'Simple, fast, privacy-focused web analytics.',
    version: 'v2.10', image: 'ghcr.io/umami-software/umami:postgresql-latest',
    appType: 'container', port: 3000,
    volumePath: null, healthCheck: '/api/heartbeat',
    cpuLimit: 0.25, memLimitMb: 256,
    notes: 'Simpler than Plausible — no ClickHouse required. Just needs a Postgres database.',
    links: [{ label: 'Docs', url: 'https://umami.is/docs' }],
    params: [
      { key: 'DATABASE_URL', label: 'Postgres URL', required: true, secret: true, hint: 'postgresql://user:pass@postgres:5432/umami' },
      { key: 'APP_SECRET',   label: 'App secret', required: true, secret: true, generate: 'random_hex_32' },
    ],
  },
  {
    // The drives' S3 server too (`FJS-D1507`). Both keys are required because
    // with neither set it serves every bucket to anyone, unsigned.
    slug: 'seaweedfs', name: 'SeaweedFS', category: 'Storage', icon: '🪣', brandColor: null,
    description: 'S3-compatible object storage in one container.',
    version: '4.48', image: 'chrislusf/seaweedfs:4.48',
    appType: 'container', port: 8333,
    volumePath: '/data', healthCheck: '/healthz',
    cpuLimit: 0.5, memLimitMb: 512,
    notes: 'S3 API on port 8333, path-style. The image runs `weed mini`, which also starts an Admin UI on 23646 with no password, so never publish that port. Once 10 GiB are stored it reports anonymous usage to telemetry.seaweedfs.com.',
    links: [{ label: 'Docs', url: 'https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API' }],
    params: [
      { key: 'AWS_ACCESS_KEY_ID',     label: 'Access key', required: true, generate: 'random_hex_16' },
      { key: 'AWS_SECRET_ACCESS_KEY', label: 'Secret key', required: true, secret: true, generate: 'random_hex_32' },
    ],
  },
  {
    // A phone notification for the Frontier post, kept on the operator's own
    // box (IDEAS/frontier-files.md). Without `serve` the image prints its help
    // and exits. ntfy's own default lets anyone publish, so this one denies
    // all and provisions its users and tokens from env.
    slug: 'ntfy', name: 'ntfy', category: 'Notifications', icon: '🔔', brandColor: '#338574',
    description: 'Push notifications to your phone or desktop with one HTTP request.',
    version: 'v2.14.0', image: 'binwiederhier/ntfy:v2.14.0',
    appType: 'container', port: 2586,
    command: ['serve', '--listen-http', ':2586', '--cache-file', '/var/lib/ntfy/cache.db', '--auth-file', '/var/lib/ntfy/user.db', '--behind-proxy'],
    volumePath: '/var/lib/ntfy', healthCheck: '/v1/health',
    cpuLimit: 0.25, memLimitMb: 128,
    notes: 'Install the ntfy app on your phone and subscribe it to your server. A password hash comes from `docker run --rm -i binwiederhier/ntfy user hash`. iOS delivers through Apple, so a self-hosted server forwards a content-free poll request to the upstream URL and the phone fetches the message from you; leave it blank and iOS hears nothing in the background.',
    links: [{ label: 'Docs', url: 'https://docs.ntfy.sh/config/' },
            { label: 'Docker Hub', url: 'https://hub.docker.com/r/binwiederhier/ntfy' }],
    params: [
      { key: 'NTFY_BASE_URL',            label: 'Public URL', required: true, hint: 'https://ntfy.acme.com — the address phones subscribe to' },
      { key: 'NTFY_AUTH_USERS',          label: 'Users', required: true, secret: true, hint: 'name:hash:admin, comma-separated; hash from `ntfy user hash`' },
      { key: 'NTFY_AUTH_TOKENS',         label: 'Access tokens', secret: true, hint: 'name:tk_<29 letters or digits>:label — what a sender such as the Frontier post publishes with' },
      { key: 'NTFY_AUTH_DEFAULT_ACCESS', label: 'Access without a login', defaultValue: 'deny-all', hint: 'deny-all, read-only, write-only or read-write' },
      { key: 'NTFY_UPSTREAM_BASE_URL',   label: 'iOS relay', defaultValue: 'https://ntfy.sh', hint: 'Where iOS poll requests go; blank keeps everything on this box' },
    ],
  },
  {
    slug: 'ghost', name: 'Ghost', category: 'CMS', icon: '👻', brandColor: null,
    description: 'Professional publishing platform. Blog, newsletter, membership.',
    version: '5.x', image: 'ghost:5-alpine',
    appType: 'container', port: 2368,
    volumePath: '/var/lib/ghost/content', healthCheck: '/ghost/api/v4/admin/site/',
    cpuLimit: 0.5, memLimitMb: 512,
    notes: 'Requires a MySQL/MariaDB database. Deploy a database app first and fill in the connection details here.',
    links: [{ label: 'Docs', url: 'https://ghost.org/docs/self-hosting' }],
    params: [
      { key: 'url',                              label: 'Public URL', required: true, hint: 'https://blog.acme.com' },
      { key: 'database__client',                 label: 'DB client', defaultValue: 'mysql' },
      { key: 'database__connection__host',       label: 'DB host', required: true },
      { key: 'database__connection__user',       label: 'DB user', defaultValue: 'ghost', required: true },
      { key: 'database__connection__password',   label: 'DB password', required: true, secret: true },
      { key: 'database__connection__database',   label: 'DB name', defaultValue: 'ghost_db', required: true },
      { key: 'mail__transport',                  label: 'Mail transport', defaultValue: 'SMTP' },
      { key: 'mail__options__host',              label: 'SMTP host' },
    ],
  },
]
