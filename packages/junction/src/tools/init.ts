#!/usr/bin/env bun
// tools/init.ts
// Junction project initialiser — run once to scaffold a new project.
//
// Asks a focused set of questions up-front, then generates a complete,
// immediately-runnable project in one shot. No repair loops, no "press
// enter when done" pauses. Everything is generated at the end.
//
// Usage:
//   bunx @frontierjs/junction init           ← in an empty directory
//   bunx @frontierjs/junction init my-api    ← creates ./my-api/
//   bun run tools/init.ts                    ← from inside the framework repo

import * as fs       from 'node:fs'
import * as path     from 'node:path'
import * as readline from 'node:readline'

// ─── ANSI ─────────────────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  gray:    '\x1b[90m',
  bred:    '\x1b[91m',
  bgreen:  '\x1b[92m',
  byellow: '\x1b[93m',
  bcyan:   '\x1b[96m',
  bwhite:  '\x1b[97m',
}

const paint  = (col: string, t: string) => `${col}${t}${c.reset}`
const ok     = (t: string) => `  ${paint(c.bgreen,  '✓')} ${paint(c.gray, t)}`
const bullet = (t: string) => `  ${paint(c.bcyan,   '→')} ${paint(c.gray, t)}`
const header = (t: string) => paint(c.bold + c.bwhite, t)
const dim    = (t: string) => paint(c.dim + c.gray, t)
const sep    = () => paint(c.gray, `  ${'─'.repeat(54)}`)

// ─── Readline helpers ─────────────────────────────────────────────────────

const rl = readline.createInterface({
  input:    process.stdin,
  output:   process.stdout,
  terminal: true,
})

const ask = (q: string, def = ''): Promise<string> =>
  new Promise(res => {
    const hint = def ? ` ${paint(c.gray, `[${def}]`)}` : ''
    rl.question(`  ${paint(c.bcyan, '?')} ${q}${hint} `, ans => {
      res(ans.trim() || def)
    })
  })

// Single-select from a numbered list
async function select<T extends string>(
  question: string,
  options:  { value: T; label: string; desc?: string }[],
  def = 0
): Promise<T> {
  console.log()
  console.log(`  ${paint(c.bcyan, '?')} ${question}`)
  console.log()
  options.forEach((o, i) => {
    const marker = i === def ? paint(c.bgreen, '◉') : paint(c.gray, '○')
    const label  = i === def ? paint(c.bwhite, o.label) : paint(c.gray, o.label)
    const desc   = o.desc ? `  ${dim(o.desc)}` : ''
    console.log(`    ${marker}  ${i + 1}. ${label}${desc}`)
  })
  console.log()

  while (true) {
    const raw = await ask(`Enter number (default ${def + 1})`, String(def + 1))
    const n   = parseInt(raw, 10) - 1
    if (n >= 0 && n < options.length) return options[n].value
    console.log(`  ${paint(c.byellow, 'Please enter a number between 1 and ' + options.length)}`)
  }
}

// Multi-select with spacebar-style toggling (enter numbers separated by spaces)
async function multiSelect(
  question: string,
  options:  { value: string; label: string; desc?: string }[]
): Promise<string[]> {
  console.log()
  console.log(`  ${paint(c.bcyan, '?')} ${question}`)
  console.log(dim('    Enter numbers separated by spaces, or press enter to skip all'))
  console.log()
  options.forEach((o, i) => {
    const desc = o.desc ? `  ${dim(o.desc)}` : ''
    console.log(`    ${paint(c.gray, String(i + 1) + '.')} ${paint(c.bwhite, o.label)}${desc}`)
  })
  console.log()

  const raw  = await ask('Your choices (e.g. 1 3)', '')
  if (!raw) return []
  return raw
    .split(/[\s,]+/)
    .map(s => parseInt(s, 10) - 1)
    .filter(n => n >= 0 && n < options.length)
    .map(n => options[n].value)
}

// ─── Answers shape ────────────────────────────────────────────────────────

interface Answers {
  projectName:   string
  port:          number
  db:            'sqlite' | 'postgres' | 'mysql' | 'none'
  auth:          'better-auth' | 'api-keys' | 'none'
  firstService:  string        // empty = skip
  corsOrigins:   string[]      // empty = use '*' in dev config
  extras:        string[]      // 'channels' | 'webhooks' | 'openapi' | 'ai'
  apiPrefix:     string        // default '/api'
}

// ─── Interview ────────────────────────────────────────────────────────────

async function interview(targetDir: string): Promise<Answers> {

  console.log()
  console.log(`  ${header('Junction init')}`)
  console.log(`  ${paint(c.gray, 'Answer a few questions to scaffold your project.')}`)
  console.log(`  ${paint(c.gray, 'All choices can be changed later.')}`)
  console.log()
  console.log(sep())

  // ── Project name ────────────────────────────────────────────────
  console.log()
  const defaultName = path.basename(targetDir) || 'my-api'
  const projectName = await ask('Project name', defaultName)

  // ── Port ────────────────────────────────────────────────────────
  const portStr  = await ask('Port', '3000')
  const port     = parseInt(portStr, 10) || 3000

  // ── API prefix ──────────────────────────────────────────────────
  const apiPrefix = await ask('API prefix (e.g. /api or /api/v1)', '/api')

  // ── Database ────────────────────────────────────────────────────
  const db = await select('Database', [
    {
      value: 'sqlite',
      label: 'SQLite',
      desc:  'file-based, zero config, built into Bun — great for most apps',
    },
    {
      value: 'postgres',
      label: 'Postgres',
      desc:  'needs DATABASE_URL, works with Prisma/Litestone',
    },
    {
      value: 'mysql',
      label: 'MySQL',
      desc:  'needs DATABASE_URL, works with Prisma/Litestone',
    },
    {
      value: 'none',
      label: 'None — add later',
      desc:  'scaffolds without any database config',
    },
  ])

  // ── Auth ────────────────────────────────────────────────────────
  const auth = await select('Auth', [
    {
      value: 'none',
      label: 'None — stub it, add later',
      desc:  'app starts without auth; routes are unprotected until you wire it',
    },
    {
      value: 'better-auth',
      label: 'Better Auth',
      desc:  'full session/API-key auth; needs `bun add better-auth`',
    },
    {
      value: 'api-keys',
      label: 'API keys only',
      desc:  'simple bearer token validation from environment variable',
    },
  ])

  // ── First service ───────────────────────────────────────────────
  console.log()
  console.log(dim('  Scaffolding a starter service gives you a working CRUD endpoint immediately.'))
  const firstServiceRaw = await ask('First service name (leave blank to skip)', 'users')
  const firstService    = firstServiceRaw.toLowerCase().replace(/[^a-z0-9-]/g, '')

  // ── CORS origins ────────────────────────────────────────────────
  console.log()
  console.log(dim("  Production frontend URL(s) for CORS. Separate multiple with commas."))
  console.log(dim("  Leave blank to use '*' in dev — you can set this in config/production.ts later."))
  const originsRaw = await ask('Frontend URL(s) for CORS', '')
  const corsOrigins = originsRaw
    ? originsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : []

  // ── Extras ──────────────────────────────────────────────────────
  const extras = await multiSelect('Optional extras (all can be added later)', [
    {
      value: 'openapi',
      label: 'OpenAPI + Swagger UI',
      desc:  'auto-generated docs at /api/docs',
    },
    {
      value: 'channels',
      label: 'Real-time WebSocket channels',
      desc:  'push events to connected clients after service mutations',
    },
    {
      value: 'webhooks',
      label: 'Webhook delivery',
      desc:  'at-least-once HTTP delivery to external subscribers',
    },
    {
      value: 'ai',
      label: 'AI model adapter',
      desc:  'thin IAIModel abstraction over OpenAI, Anthropic, etc.',
    },
  ])

  return { projectName, port, apiPrefix, db, auth, firstService, corsOrigins, extras }
}

// ─── File generators ──────────────────────────────────────────────────────

function w(filePath: string, content: string): void {
  const full = path.join(cwd, filePath)
  const dir  = path.dirname(full)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(full, content)
}

function genPackageJson(a: Answers): string {
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

function genDefaultConfig(a: Answers): string {
  const dbBlock = a.db === 'none' ? '' : `
  database: {
    url: process.env.DATABASE_URL ?? ${a.db === 'sqlite' ? `'file:./${a.projectName}.db'` : `'${a.db === 'postgres' ? 'postgresql' : 'mysql'}://user:pass@localhost/${a.projectName}'`},
    log: false,
  },
`

  const apiPrefixLine = a.apiPrefix !== '/api'
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

function genProductionConfig(a: Answers): string {
  const originList = a.corsOrigins.length
    ? a.corsOrigins.map(o => `'${o}'`).join(', ')
    : "'https://yourapp.com'  // TODO: set your real domain"

  return `// config/production.ts
// Overrides applied only when NODE_ENV=production.
// Never put secrets here — use environment variables.
export default {
  debug: false,

  http: {
    cors: {
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

function genDotEnv(a: Answers): string {
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

function genGitignore(): string {
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

function genAuthModule(a: Answers): string | null {
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

function genService(name: string, a: Answers): string {
  const pascal = name.charAt(0).toUpperCase() + name.slice(1)

  const dbImport = a.db !== 'none'
    ? `import type { App } from '@frontierjs/junction'\n` : `import type { App } from '@frontierjs/junction'\n`

  return `// services/${name}.service.ts
${dbImport}import {
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

function genAppEntryPoint(a: Answers): string {
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
    pluginLines.push(`app.configure(openapi({ title: config.name, version: config.version, ui: \`\${config.apiPrefix ?? '/api'}/docs\` }))`)
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

  const apiPrefixLine = a.apiPrefix !== '/api'
    ? `// Routes live at ${a.apiPrefix}/{service}  (set via config.apiPrefix)\n` : ''

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
  ${a.extras.includes('openapi') ? `docs:    \`\${config.apiPrefix ?? '/api'}/docs\`,` : ''}
}))

await app.start()
`
}

function genTests(a: Answers): string {
  const pascal = a.firstService
    ? a.firstService.charAt(0).toUpperCase() + a.firstService.slice(1)
    : ''

  const serviceBlock = a.firstService ? `
  describe('${a.firstService} service', () => {

    it('find returns an empty list initially', async () => {
      const app = await makeApp()
      const res = await request(app).get(\`/api/${a.firstService}\`)
      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>
      expect(body.total).toBe(0)
      expect(Array.isArray(body.data)).toBe(true)
    })

    it('create requires auth', async () => {
      const app = await makeApp()
      const res = await request(app)
        .post(\`/api/${a.firstService}\`)
        .send({ name: 'Test' })
      expect(res.status).toBe(401)
    })

    it('create succeeds with auth', async () => {
      const app  = await makeApp()
      const token = app.auth.addUser({ id: 'u1', role: 'user' })
      const res  = await request(app)
        .post(\`/api/${a.firstService}\`)
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

function genReadme(a: Answers): string {
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
| API at   | \`${a.apiPrefix}\` |
| Port     | ${a.port} |

## Audit / setup wizard

\`\`\`bash
bun run setup audit         # check for configuration issues
bun run setup audit --prod  # check as if NODE_ENV=production
bun run setup               # interactive repair wizard
\`\`\`
`
}

function genMigrationsReadme(a: Answers): string {
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

// ─── Summary printer ──────────────────────────────────────────────────────

function printSummary(a: Answers, generated: string[]): void {
  console.log()
  console.log(sep())
  console.log()
  console.log(`  ${header('Generated files')}`)
  console.log()
  for (const f of generated) console.log(ok(f))
  console.log()
  console.log(sep())
  console.log()
  console.log(`  ${header('Next steps')}`)
  console.log()

  if (a.auth === 'better-auth') {
    console.log(bullet('bun add better-auth'))
  }
  if (a.db === 'postgres' || a.db === 'mysql') {
    console.log(bullet(`Update DATABASE_URL in .env to point at your ${a.db} instance`))
  }

  console.log(bullet('bun install'))
  console.log(bullet('bun run dev'))
  console.log()
  console.log(`  ${paint(c.gray, 'REPL:')}   bun run repl`)
  console.log(`  ${paint(c.gray, 'Audit:')}  bun run setup audit`)

  if (a.extras.includes('openapi')) {
    console.log(`  ${paint(c.gray, 'Docs:')}   http://localhost:${a.port}${a.apiPrefix ?? '/api'}/docs`)
  }

  console.log()
  console.log(`  ${paint(c.bgreen, '★')} ${paint(c.bwhite, 'Happy building!')}`)
  console.log()
}

// ─── Main ─────────────────────────────────────────────────────────────────

// Resolve target directory — optional first arg
const arg   = Bun.argv[2]
const isDir = arg && !arg.startsWith('--')
const cwd   = isDir ? path.resolve(process.cwd(), arg) : process.cwd()

// Guard: refuse to overwrite an existing project
if (fs.existsSync(path.join(cwd, 'package.json'))) {
  console.error()
  console.error(`  ${paint(c.bred, '✗')} ${paint(c.bwhite, `${cwd} already has a package.json`)}`)
  console.error()
  console.error(`  This looks like an existing project. Run ${paint(c.bcyan, 'bun run setup')} to audit it instead.`)
  console.error(`  If you really want to reinitialise, delete package.json first.`)
  console.error()
  process.exit(1)
}

if (isDir && !fs.existsSync(cwd)) {
  fs.mkdirSync(cwd, { recursive: true })
}

const answers  = await interview(cwd)
const generated: string[] = []

function write(filePath: string, content: string): void {
  const full = path.join(cwd, filePath)
  const dir  = path.dirname(full)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(full, content)
  generated.push(filePath)
}

console.log()
console.log(sep())
console.log()
console.log(`  ${header('Creating project...')}`)
console.log()

// Always generated
write('package.json',          genPackageJson(answers))
write('.env',                  genDotEnv(answers))
write('.gitignore',            genGitignore())
write('config/default.ts',    genDefaultConfig(answers))
write('config/production.ts', genProductionConfig(answers))
write('app.ts',                genAppEntryPoint(answers))
write('tests/app.test.ts',    genTests(answers))
write('README.md',             genReadme(answers))

// Auth module
const authContent = genAuthModule(answers)
if (authContent) write('auth/index.ts', authContent)

// First service
if (answers.firstService) {
  write(`services/${answers.firstService}.service.ts`, genService(answers.firstService, answers))
}

// Database migrations dir
if (answers.db !== 'none') {
  write('migrations/.gitkeep', '')
  const migrationsReadme = genMigrationsReadme(answers)
  if (migrationsReadme) write('migrations/README.md', migrationsReadme)
}

// AI placeholder
if (answers.extras.includes('ai')) {
  write('ai/index.ts', `// ai/index.ts
// AI model adapter. See @frontierjs/junction docs for IAIModel interface.
// Example with Anthropic:
//
//   import Anthropic from '@anthropic-ai/sdk'
//   import { createAnthropicAdapter } from '@frontierjs/junction/ai'
//   export const ai = createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })
//
// Then pass to createApp: createApp({ config, auth, ai })

export const ai = undefined  // replace with your adapter
`)
}

rl.close()
printSummary(answers, generated)
