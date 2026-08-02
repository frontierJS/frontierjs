// tools/generators.ts
// Canonical project-file generators, shared by init.ts and setup.ts.
//
// Every generator is pure: it takes an options object and returns the file
// content as a string. Callers decide where (and whether) to write it.
//
// Options default so a caller with less context (e.g. the setup wizard,
// which only asks for a name and port) can pass a partial object and still
// get complete, runnable output.

export interface GenOptions {
  projectName:   string
  port:          number
  apiPrefix:     string        // '' = Junction's default, services at /{service}
  db:            'sqlite' | 'postgres' | 'mysql' | 'none'
  auth:          'better-auth' | 'api-keys' | 'none'
  firstService:  string        // empty = skip
  corsOrigins:   string[]      // empty = use '*' in dev config
  extras:        string[]      // 'channels' | 'webhooks' | 'openapi' | 'ai'
}

export type GenInput = Partial<GenOptions>

export const GEN_DEFAULTS: GenOptions = {
  projectName:  'my-api',
  port:         3000,
  apiPrefix:    '',
  db:           'sqlite',
  auth:         'none',
  firstService: '',
  corsOrigins:  [],
  extras:       [],
}

const opts = (o: GenInput): GenOptions => ({ ...GEN_DEFAULTS, ...o })

// ─── package.json ─────────────────────────────────────────────────────────

export function genPackageJson(o: GenInput): string {
  const a = opts(o)
  const scripts: Record<string, string> = {
    dev:            'bun run --watch app.ts',
    start:          'NODE_ENV=production bun run app.ts',
    test:           'bun test',
    repl:           'bunx @frontierjs/junction repl',
    setup:          'bunx @frontierjs/junction setup',
    'setup:audit':  'bunx @frontierjs/junction setup audit',
  }

  const deps: Record<string, string> = {
    '@frontierjs/junction': 'latest',
  }

  if (a.auth === 'better-auth')       deps['better-auth'] = 'latest'
  if (a.extras.includes('openapi'))   deps['swagger-ui-dist'] = 'latest'

  return JSON.stringify({
    name:    a.projectName,
    version: '0.1.0',
    type:    'module',
    scripts,
    dependencies: deps,
  }, null, 2) + '\n'
}

// ─── config/default.ts ────────────────────────────────────────────────────

export function genDefaultConfig(o: GenInput): string {
  const a = opts(o)
  const dbBlock = a.db === 'none' ? '' : `
  database: {
    url: process.env.DATABASE_URL ?? ${a.db === 'sqlite' ? `'file:./${a.projectName}.db'` : `'${a.db === 'postgres' ? 'postgresql' : 'mysql'}://user:pass@localhost/${a.projectName}'`},
    log: false,
  },
`

  // Emit the line whenever a prefix was chosen. This used to skip it when the
  // prefix was '/api', on the belief that '/api' was the framework default — it
  // is not (core/app.ts uses `config.apiPrefix ?? ''`). Choosing '/api' at the
  // prompt therefore generated a config with no prefix at all, so services
  // mounted at /{service} while every generated URL below said /api/{service}.
  const apiPrefixLine = a.apiPrefix
    ? `  apiPrefix: '${a.apiPrefix}',\n` : ''

  return `// config/default.ts
// Base configuration — values here are overridden by production.ts in production.
// Secrets must always come from environment variables, never hardcoded.
export default {
  name:    '${a.projectName}',
  version: '1.0.0',
  port:    ${a.port},
  debug:   true,
${apiPrefixLine}
  auth: {
    secret:        process.env.AUTH_SECRET ?? 'change-me-in-production',
    sessionExpiry: '7d',
  },
${dbBlock}
  http: {
    maxBodySize: 256 * 1024,
    compress:    true,
    cors: {
      origins: ['*'],  // restricted in config/production.ts
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      headers: ['Content-Type', 'Authorization', 'X-API-Key'],
    },
    ddos:    { enabled: false, limit: 100, window: 60_000 },
    powered: '${a.projectName}',
  },

  cache: {
    defaultTtl: '5 minutes',
    maxSize:    10_000,
  },
}
`
}

// ─── config/production.ts ─────────────────────────────────────────────────

export function genProductionConfig(o: GenInput): string {
  const a = opts(o)
  const originList = a.corsOrigins.length
    ? a.corsOrigins.map(x => `'${x}'`).join(', ')
    : "'https://yourapp.com'  // TODO: set your real domain"

  return `// config/production.ts
// Overrides applied only when NODE_ENV=production.
// Never put secrets here — use environment variables.
export default {
  debug: false,

  http: {
    cors: {
      // Restrict to your actual frontend domain(s)
      origins: [${originList}],
    },
    ddos: {
      enabled: true,
      limit:   100,
      window:  60_000,
    },
    drainTimeout: 5_000,   // ms to drain in-flight requests on shutdown
  },
}
`
}

// ─── .env ─────────────────────────────────────────────────────────────────

export function genDotEnv(o: GenInput): string {
  const a = opts(o)
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('')

  const dbLine = a.db === 'sqlite'
    ? `DATABASE_URL="file:./${a.projectName}.db"`
    : a.db === 'postgres'
      ? `DATABASE_URL="postgresql://user:password@localhost:5432/${a.projectName}"`
      : a.db === 'mysql'
        ? `DATABASE_URL="mysql://user:password@localhost:3306/${a.projectName}"`
        : ''

  const betterAuthLine = a.auth === 'better-auth'
    ? '\nBETTER_AUTH_SECRET="' + secret + '"'
    : ''

  const apiKeyLine = a.auth === 'api-keys'
    ? `\nAPI_KEY="${secret}"`
    : ''

  return `# ${a.projectName} environment variables
# Never commit this file to source control.
AUTH_SECRET="${secret}"
${dbLine}${betterAuthLine}${apiKeyLine}
NODE_ENV=development
`
}

// ─── .gitignore ───────────────────────────────────────────────────────────

export function genGitignore(): string {
  return `.env
.env.local
.env.*.local
node_modules/
dist/
*.db
*.db-shm
*.db-wal
.DS_Store
`
}

// ─── auth/index.ts ────────────────────────────────────────────────────────

export function genAuthModule(o: GenInput): string | null {
  const a = opts(o)
  if (a.auth === 'none') return null

  if (a.auth === 'api-keys') {
    return `// auth/index.ts
// Simple API-key auth backed by the API_KEY environment variable.
// Replace with a database lookup for production multi-tenant usage.

import type { IAuth, SessionContext } from '@frontierjs/junction'

const VALID_KEY = process.env.API_KEY

export const auth: IAuth = {
  async verifySession(token: string): Promise<SessionContext | null> {
    if (!VALID_KEY || token !== VALID_KEY) return null
    return {
      userId:     'system',
      userType:   'api',
      role:        'admin',
      authMethod: 'apiKey',
      scopes:      [],
    }
  },

  async verifyApiKey(key: string): Promise<SessionContext | null> {
    return this.verifySession(key)
  },

  async login() { throw new Error('Login not supported — use API key') },
  async logout() {},
  async createUser() { throw new Error('Not implemented') },
  async deleteUser() { throw new Error('Not implemented') },
  async createApiKey() { throw new Error('Not implemented') },
  async revokeApiKey() { throw new Error('Not implemented') },
}
`
  }

  // better-auth
  return `// auth/index.ts
// Better Auth adapter. See https://www.better-auth.com for full configuration.
// Run: bun add better-auth

import { betterAuth }               from 'better-auth'
import { createBetterAuthAdapter }  from '@frontierjs/junction'

// ── Better Auth instance ────────────────────────────────────────────
// Configure your database adapter, providers, plugins etc. here.
// See https://www.better-auth.com/docs/installation

export const betterAuthInstance = betterAuth({
  secret:   process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET,
  database: {
    // Example with SQLite via Bun:
    // db: new Database('./auth.db'),
    // type: 'sqlite',
  },
  emailAndPassword: { enabled: true },
})

// ── Junction adapter ────────────────────────────────────────────────
// Wraps betterAuthInstance in the IAuth interface so the rest of
// the framework doesn't depend on better-auth types directly.

export const auth = createBetterAuthAdapter({ auth: betterAuthInstance })
`
}

// ─── services/{name}.service.ts ───────────────────────────────────────────

export function genService(name: string, _o: GenInput = {}): string {
  const pascal = name.charAt(0).toUpperCase() + name.slice(1)

  return `// services/${name}.service.ts
import type { App } from '@frontierjs/junction'
import {
  createService, createSchema, v,
  NotFound, authenticate,
} from '@frontierjs/junction'

// ─── Schema ────────────────────────────────────────────────────────────────

const Create${pascal}Schema = createSchema({
  name: v.required.string({ minLength: 1, maxLength: 200, trim: true }),
})

const Patch${pascal}Schema = Create${pascal}Schema.partial()

// ─── In-memory store (replace with your DB layer) ──────────────────────────

interface ${pascal} {
  id:        string
  name:      string
  createdAt: string
}

const store = new Map<string, ${pascal}>()

// ─── Service ───────────────────────────────────────────────────────────────

export function create${pascal}Service(_app: App) {
  return createService({
    name: '${name}',

    async find(_ctx) {
      const data = Array.from(store.values())
      return { total: data.length, limit: 20, skip: 0, data }
    },

    async get(ctx) {
      const item = store.get(String(ctx.id))
      if (!item) throw new NotFound(\`${pascal} \${ctx.id} not found\`)
      return item
    },

    async create(ctx) {
      const data = Create${pascal}Schema.parse(ctx.data)
      const item: ${pascal} = {
        id:        crypto.randomUUID(),
        name:      data.name as string,
        createdAt: new Date().toISOString(),
      }
      store.set(item.id, item)
      return item
    },

    async patch(ctx) {
      const item = store.get(String(ctx.id))
      if (!item) throw new NotFound(\`${pascal} \${ctx.id} not found\`)
      const data    = Patch${pascal}Schema.parse(ctx.data)
      const updated = { ...item, ...data, id: item.id }
      store.set(item.id, updated)
      return updated
    },

    async remove(ctx) {
      const item = store.get(String(ctx.id))
      if (!item) throw new NotFound(\`${pascal} \${ctx.id} not found\`)
      store.delete(String(ctx.id))
      return item
    },

    hooks: {
      before: {
        create: [authenticate],
        patch:  [authenticate],
        remove: [authenticate],
      },
    },
  })
}
`
}

// ─── app.ts ───────────────────────────────────────────────────────────────

export function genAppEntryPoint(o: GenInput): string {
  const a = opts(o)
  const pascal = a.firstService
    ? a.firstService.charAt(0).toUpperCase() + a.firstService.slice(1)
    : ''

  const authImport = a.auth === 'none'
    ? `// No auth configured — import and wire your IAuth implementation here when ready`
    : `import { auth${a.auth === 'better-auth' ? ', betterAuthInstance' : ''} } from './auth/index.ts'`

  const serviceImport = a.firstService
    ? `import { create${pascal}Service } from './services/${a.firstService}.service.ts'`
    : ''

  const pluginImports: string[] = [
    'createApp', 'loadConfig',
    'healthPlugin', 'correlationId', 'requestLogger', 'cors',
  ]
  if (a.extras.includes('openapi'))   pluginImports.push('openapi')
  if (a.extras.includes('channels'))  pluginImports.push('channels')
  if (a.extras.includes('webhooks'))  pluginImports.push('webhooks')

  const pluginLines: string[] = [
    `app.configure(cors({ origins: config.http.cors.origins }))`,
    `app.configure(correlationId())`,
    `app.configure(requestLogger())`,
    `app.configure(healthPlugin())`,
  ]

  if (a.extras.includes('openapi')) {
    pluginLines.push(`app.configure(openapi({ title: config.name, version: config.version, ui: \`\${config.apiPrefix ?? ''}/docs\` }))`)
  }
  if (a.extras.includes('channels')) {
    pluginLines.push(`\napp.configure(channels(app => {\n  app.channels.on('connection', (_session, conn) => {\n    app.channel('all').join(conn)\n  })\n}))`)
  }
  if (a.extras.includes('webhooks')) {
    pluginLines.push(`\napp.configure(webhooks({ events: ['*'] }))`)
  }

  const betterAuthMount = a.auth === 'better-auth'
    ? `\n// ── Better Auth routes (/auth/sign-in, /auth/sign-out, etc.) ─────────\nimport { createBetterAuthPlugin } from '@frontierjs/junction'\napp.configure(createBetterAuthPlugin(betterAuthInstance))\n` : ''

  const serviceRegister = a.firstService
    ? `app.services.register(create${pascal}Service(app))\n` : `// app.services.register(createMyService(app))\n`

  const apiPrefixLine = a.apiPrefix
    ? `// Routes live at ${a.apiPrefix}/{service}  (set via config.apiPrefix)\n`
    : `// Routes live at /{service}  (Junction's default — set config.apiPrefix to move them)\n`

  return `// app.ts — ${a.projectName} entry point
import {
  ${pluginImports.join(',\n  ')}
} from '@frontierjs/junction'
${a.extras.includes('channels') ? "import { channels } from '@frontierjs/junction'" : ''}
${a.auth !== 'none' ? authImport : '// ' + authImport}
${serviceImport}

const config = await loadConfig('./config')

const app = createApp({
  config,
  auth: ${a.auth === 'none' ? 'undefined  // wire your IAuth here' : 'auth'},
})

// ── Middleware & plugins ────────────────────────────────────────────────────
${pluginLines.join('\n')}
${betterAuthMount}
// ── Services ───────────────────────────────────────────────────────────────
${apiPrefixLine}${serviceRegister}
// ── Custom routes ──────────────────────────────────────────────────────────
app.get('/', ctx => ctx.json({
  name:    config.name,
  version: config.version,
  health:  '/health',
  ${a.extras.includes('openapi') ? `docs:    \`\${config.apiPrefix ?? ''}/docs\`,` : ''}
}))

await app.start()
`
}

// ─── tests/app.test.ts ────────────────────────────────────────────────────

export function genTests(o: GenInput): string {
  const a = opts(o)
  const pascal = a.firstService
    ? a.firstService.charAt(0).toUpperCase() + a.firstService.slice(1)
    : ''

  // The generated tests hit the same paths the app actually registers. These
  // used to hardcode /api/{service}, which only matched when apiPrefix was
  // '/api' — a scaffolded project with no prefix produced tests that 404'd.
  const routeBase = `${a.apiPrefix}/${a.firstService}`

  const serviceBlock = a.firstService ? `
  describe('${a.firstService} service', () => {

    it('find returns an empty list initially', async () => {
      const app = await makeApp()
      const res = await request(app).get(\`${routeBase}\`)
      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>
      expect(body.total).toBe(0)
      expect(Array.isArray(body.data)).toBe(true)
    })

    it('create requires auth', async () => {
      const app = await makeApp()
      const res = await request(app)
        .post(\`${routeBase}\`)
        .send({ name: 'Test' })
      expect(res.status).toBe(401)
    })

    it('create succeeds with auth', async () => {
      const app  = await makeApp()
      const token = app.auth.addUser({ id: 'u1', role: 'user' })
      const res  = await request(app)
        .post(\`${routeBase}\`)
        .auth(token)
        .send({ name: 'Test ${pascal}' })
      expect(res.status).toBe(201)
      const body = res.body as Record<string, unknown>
      expect(body.name).toBe('Test ${pascal}')
      expect(typeof body.id).toBe('string')
    })

  })
` : ''

  return `// tests/app.test.ts
import { describe, it, expect } from 'bun:test'
import { createTestApp, request, healthPlugin${a.firstService ? `, createService` : ''} } from '@frontierjs/junction'
${a.firstService ? `import { create${pascal}Service } from '../services/${a.firstService}.service.ts'` : ''}

async function makeApp() {
  const app = await createTestApp({
    services: [${a.firstService ? `(app) => create${pascal}Service(app)` : ''}],
  })
  app.configure(healthPlugin())
  return app
}

describe('App', () => {

  it('health check returns ok', async () => {
    const app = await makeApp()
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).status).toBe('ok')
  })

  it('returns 404 for unknown routes', async () => {
    const app = await makeApp()
    const res = await request(app).get('/does-not-exist')
    expect(res.status).toBe(404)
  })
${serviceBlock}})
`
}

// ─── README.md ────────────────────────────────────────────────────────────

export function genReadme(o: GenInput): string {
  const a = opts(o)
  const dbNote = a.db === 'sqlite'
    ? 'SQLite (file-based, built into Bun, zero config)'
    : a.db === 'postgres' ? 'Postgres (set DATABASE_URL in .env)'
    : a.db === 'mysql'    ? 'MySQL (set DATABASE_URL in .env)'
    : 'No database configured'

  const authNote = a.auth === 'better-auth' ? 'Better Auth (run `bun add better-auth` first)'
    : a.auth === 'api-keys' ? 'API key auth (set API_KEY in .env)'
    : 'No auth — add your IAuth implementation to auth/index.ts'

  const extrasNote = a.extras.length
    ? a.extras.join(', ')
    : 'none — add via app.configure() as needed'

  return `# ${a.projectName}

Built with [Junction](https://github.com/frontierjs/junction) — a batteries-included Bun framework.

## Quick start

\`\`\`bash
bun install
bun run dev        # starts with --watch
\`\`\`

## REPL

\`\`\`bash
bun run repl       # interactive HTTP REPL
\`\`\`

## Tests

\`\`\`bash
bun test
\`\`\`

## Project structure

\`\`\`
config/
  default.ts       ← base config (committed)
  production.ts    ← production overrides (committed)
.env               ← secrets (git-ignored)
app.ts             ← entry point
services/          ← one file per service
tests/             ← test files
\`\`\`

## Choices made at init

| | |
|---|---|
| Database | ${dbNote} |
| Auth     | ${authNote} |
| Extras   | ${extrasNote} |
| API at   | \`${a.apiPrefix || '/'}\` |
| Port     | ${a.port} |

## Audit / setup wizard

\`\`\`bash
bun run setup audit         # check for configuration issues
bun run setup audit --prod  # check as if NODE_ENV=production
bun run setup               # interactive repair wizard
\`\`\`
`
}

// ─── migrations/README.md ─────────────────────────────────────────────────

export function genMigrationsReadme(o: GenInput): string {
  const a = opts(o)
  if (a.db === 'none') return ''
  return `# migrations

SQL migration files — numbered, applied in order.

Naming: \`001_description.sql\`, \`002_description.sql\`, etc.

Run via:
\`\`\`bash
# migrations run automatically on app.start()
# or manually:
bun run tools/litestone.ts   # if using Litestone ORM
\`\`\`
`
}
