// db/blueprints.js
// The starter catalogue — eight third-party applications, as `Blueprint` rows.
//
// Read out of `docs/mock/BasecampUI.jsx`'s own `BLUEPRINTS` constant rather than
// invented, and converted column for column: the mock's nested `app` block is
// flat here because `Blueprint`'s columns are `App`'s where they overlap, and
// its `params` array is `BlueprintParam` rows because that list is an ordered
// form rather than a document.
//
// **`brandColor` is set only where the mock carried a literal.** Four of the
// eight took their colour from the mock's own theme object (`T.blue`, `T.red`),
// which is a design-system token and not a vendor's brand — copying those would
// put this app's palette in a data column and call it somebody's identity. Null
// is the honest answer, and the card falls back to its own surface.
//
// This is seed data, not shipped data. A real installation curates its own; what
// this is for is having a catalogue on screen, because an empty grid looks
// exactly like a broken query.

export const BLUEPRINTS = [
  {
    slug: 'n8n', name: 'n8n', category: 'Automation', icon: '🔄', brandColor: '#ea4b71',
    description: 'Workflow automation platform. Connect anything to everything.',
    version: '1.1.1', image: 'n8nio/n8n:latest',
    appType: 'container', port: 5678, persistent: true,
    volumePath: '/home/node/.n8n', healthCheck: '/healthz',
    replicas: 1, cpuLimit: '500m', memLimit: '512Mi',
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
    appType: 'database', port: 5432, persistent: true,
    volumePath: '/var/lib/postgresql/data', healthCheck: null,
    replicas: 1, cpuLimit: '500m', memLimit: '1Gi',
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
    appType: 'container', port: 6379, persistent: false,
    volumePath: null, healthCheck: null,
    replicas: 1, cpuLimit: '250m', memLimit: '256Mi',
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
    appType: 'container', port: 7700, persistent: true,
    volumePath: '/meili_data', healthCheck: '/health',
    replicas: 1, cpuLimit: '500m', memLimit: '512Mi',
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
    appType: 'container', port: 8000, persistent: true,
    volumePath: '/var/lib/plausible', healthCheck: '/api/health',
    replicas: 1, cpuLimit: '500m', memLimit: '1Gi',
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
    appType: 'container', port: 3000, persistent: false,
    volumePath: null, healthCheck: '/api/heartbeat',
    replicas: 1, cpuLimit: '250m', memLimit: '256Mi',
    notes: 'Simpler than Plausible — no ClickHouse required. Just needs a Postgres database.',
    links: [{ label: 'Docs', url: 'https://umami.is/docs' }],
    params: [
      { key: 'DATABASE_URL', label: 'Postgres URL', required: true, secret: true, hint: 'postgresql://user:pass@postgres:5432/umami' },
      { key: 'APP_SECRET',   label: 'App secret', required: true, secret: true, generate: 'random_hex_32' },
    ],
  },
  {
    slug: 'minio', name: 'MinIO', category: 'Storage', icon: '🪣', brandColor: null,
    description: 'High-performance S3-compatible object storage.',
    version: 'latest', image: 'quay.io/minio/minio:latest',
    appType: 'container', port: 9000, persistent: true,
    volumePath: '/data', healthCheck: '/minio/health/live',
    replicas: 1, cpuLimit: '500m', memLimit: '512Mi',
    notes: 'Console available on port 9001. S3-compatible API on port 9000. Use in your apps with the AWS SDK pointed at this host.',
    links: [{ label: 'Docs', url: 'https://min.io/docs' }],
    params: [
      { key: 'MINIO_ROOT_USER',     label: 'Root user', defaultValue: 'minioadmin', required: true },
      { key: 'MINIO_ROOT_PASSWORD', label: 'Root password', required: true, secret: true, generate: 'random_hex_16' },
    ],
  },
  {
    slug: 'ghost', name: 'Ghost', category: 'CMS', icon: '👻', brandColor: null,
    description: 'Professional publishing platform. Blog, newsletter, membership.',
    version: '5.x', image: 'ghost:5-alpine',
    appType: 'container', port: 2368, persistent: true,
    volumePath: '/var/lib/ghost/content', healthCheck: '/ghost/api/v4/admin/site/',
    replicas: 1, cpuLimit: '500m', memLimit: '512Mi',
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
