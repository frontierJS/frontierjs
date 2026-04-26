---
title: make:deploy
description: Scaffold deployment artifacts — Dockerfile, deploy config, and health endpoint
alias: mkdeploy
examples:
  - fli make:deploy
  - fli make:deploy --server myapp.com
  - fli make:deploy --server myapp.com --domain myapp.com --open
flags:
  server:
    char: s
    type: string
    description: Server hostname or IP to pre-fill in frontier.config.js
    defaultValue: ''
  domain:
    char: d
    type: string
    description: Web domain to pre-fill in frontier.config.js
    defaultValue: ''
  open:
    char: o
    type: boolean
    description: Open created files in editor after scaffolding
    defaultValue: false
---

<script>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

// ─── Dockerfile ───────────────────────────────────────────────────────────────

const makeDockerfile = (appId) => `# FrontierJS API — ${appId}
# Built on the server via: docker build -t ${appId}:latest -f api/deploy/Dockerfile .
# No registry required — image lives on the server.

FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY api/package.json api/bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY api/src ./src
COPY api/tsconfig*.json ./

# Runtime image
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=base /app .

# DB directory — mounted at runtime via --volume ./db:/db
RUN mkdir -p /db

EXPOSE 3000

# Entrypoint: run migrations first, then start the server.
# If migrations fail, the container exits non-zero — deploy pipeline
# detects the failed health check and rolls back automatically.
CMD ["sh", "-c", "bun run db:migrate && bun run src/server.ts"]
`

// ─── Health endpoint hint ─────────────────────────────────────────────────────

const healthHint = `// Add this route to your Junction API server (api/src/server.ts)
//
// Junction health endpoint — deploy pipeline polls this after container swap.
// Returns 200 once the server is ready. Keep it fast and dependency-free.
//
// app.get('/health', (ctx) => ctx.json({ ok: true }))
`

// ─── frontier.config.js deploy block ─────────────────────────────────────────

const makeDeployBlock = (appId, server, domain) => {
  const serverLine = server ? `    server: '${server}',` : `    server: 'your-server.com',   // ← set this`
  const domainLine = domain ? `      domain: '${domain}',` : `      domain: 'your-app.com',   // ← set this`

  return `  deploy: {
${serverLine}
    user: 'deploy',              // SSH user on the server
    path: '/apps/${appId}',      // deploy root on the server
    app_id: '${appId}',

    api: {
      port:       3000,
      health:     '/health',
      dockerfile: 'api/deploy/Dockerfile',
      env:        '/apps/${appId}/.env.production',

      // Set to true to validate server env against .env.example before deploying
      envCheck: true,
    },

    web: {
${domainLine}
      keep_releases: 3,
      // ssl: {
      //   cert: '/etc/ssl/certs/${appId}.pem',
      //   key:  '/etc/ssl/private/${appId}.key',
      // },
    },

    db: {
      path:         '/apps/${appId}/db',
      file:         'production.db',
      keep_backups: 5,
    },

    // Per-target overrides (server/user/path only)
    // production: { server: 'prod.your-app.com' },
    // stage:      { server: 'stg.your-app.com' },
  },`
}

// ─── Inject deploy block into existing frontier.config.js ────────────────────

const injectDeployBlock = (existing, deployBlock) => {
  // Try to inject before the closing brace of the default export object
  const lastBrace = existing.lastIndexOf('}')
  if (lastBrace === -1) return null

  // Check if there's already a deploy block
  if (/deploy\s*:/.test(existing)) return null  // already exists

  // Find a good insertion point — after the last property
  const before = existing.slice(0, lastBrace).trimEnd()
  const after  = existing.slice(lastBrace)
  const comma  = before.endsWith(',') ? '' : ','

  return `${before}${comma}\n\n${deployBlock}\n${after}\n`
}
</script>

```js
// ─── Resolve app identity ─────────────────────────────────────────────────────
const appId    = context.paths.root.split('/').pop().replace(/[^a-z0-9-]/gi, '-').toLowerCase()
const server   = flag.server  || ''
const domain   = flag.domain  || ''
const editor   = process.env.EDITOR || 'vi'
const created  = []

echo(`\nScaffolding deploy artifacts for: ${appId}\n`)

// ─── 1. Dockerfile ────────────────────────────────────────────────────────────
const dockerfileDir  = resolve(context.paths.root, 'api/deploy')
const dockerfilePath = resolve(dockerfileDir, 'Dockerfile')

if (existsSync(dockerfilePath)) {
  log.warn(`Dockerfile already exists: api/deploy/Dockerfile — skipping`)
} else {
  if (!flag.dry) {
    mkdirSync(dockerfileDir, { recursive: true })
    writeFileSync(dockerfilePath, makeDockerfile(appId), 'utf8')
  }
  log.success(`Created: api/deploy/Dockerfile`)
  created.push(dockerfilePath)
}

// ─── 2. .dockerignore ─────────────────────────────────────────────────────────
const dockerignorePath = resolve(context.paths.root, '.dockerignore')
if (existsSync(dockerignorePath)) {
  log.info(`.dockerignore already exists — skipping`)
} else {
  const dockerignore = [
    '# FrontierJS .dockerignore',
    '.git',
    '.env*',
    '!.env.example',
    'node_modules',
    'web/',
    'db/*.db',
    'db/backups/',
    'dist/',
    '*.test.ts',
    '*.test.js',
  ].join('\n') + '\n'

  if (!flag.dry) writeFileSync(dockerignorePath, dockerignore, 'utf8')
  log.success(`Created: .dockerignore`)
  created.push(dockerignorePath)
}

// ─── 3. frontier.config.js deploy block ──────────────────────────────────────
const configPath = resolve(context.paths.root, 'frontier.config.js')
const deployBlock = makeDeployBlock(appId, server, domain)

if (!existsSync(configPath)) {
  // Create a minimal frontier.config.js
  const content = `export default {\n\n${deployBlock}\n}\n`
  if (!flag.dry) writeFileSync(configPath, content, 'utf8')
  log.success(`Created: frontier.config.js (with deploy block)`)
  created.push(configPath)
} else {
  const existing = readFileSync(configPath, 'utf8')
  if (/deploy\s*:/.test(existing)) {
    log.warn(`frontier.config.js already has a deploy block — skipping`)
  } else {
    const updated = injectDeployBlock(existing, deployBlock)
    if (updated) {
      if (!flag.dry) writeFileSync(configPath, updated, 'utf8')
      log.success(`Updated: frontier.config.js (deploy block added)`)
      created.push(configPath)
    } else {
      log.warn(`Could not inject deploy block into frontier.config.js — add it manually`)
      echo('')
      echo(deployBlock)
    }
  }
}

// ─── 4. .env.example hint ─────────────────────────────────────────────────────
const envExamplePath = resolve(context.paths.root, '.env.example')
if (!existsSync(envExamplePath)) {
  log.warn(`.env.example not found`)
  log.info('  Create one to enable pre-deploy env validation (deploy.api.envCheck)')
  log.info('  Example: echo "JWT_SECRET=" >> .env.example')
}

// ─── 5. Health endpoint reminder ─────────────────────────────────────────────
const serverPath  = resolve(context.paths.root, 'api/src/server.ts')
const serverPathJ = resolve(context.paths.root, 'api/src/server.js')
const hasServer   = existsSync(serverPath) || existsSync(serverPathJ)

if (hasServer) {
  const serverFile = existsSync(serverPath) ? serverPath : serverPathJ
  const content    = readFileSync(serverFile, 'utf8')
  if (/\/health/.test(content)) {
    log.success(`Health endpoint: found in ${existsSync(serverPath) ? 'api/src/server.ts' : 'api/src/server.js'} ✓`)
  } else {
    log.warn(`Health endpoint not found in your API server`)
    log.info('  Add this line to api/src/server.ts:')
    log.info(`  app.get('/health', (ctx) => ctx.json({ ok: true }))`)
  }
} else {
  log.info('Health endpoint: add to your server when ready:')
  log.info(`  app.get('/health', (ctx) => ctx.json({ ok: true }))`)
}

// ─── Summary ──────────────────────────────────────────────────────────────────
echo('')
log.success('Done. Next steps:')
echo('')
echo('  1. Review api/deploy/Dockerfile and adjust for your app')
echo('  2. Set server/domain in frontier.config.js deploy block')
echo('  3. Add /health to your Junction server if not present')
echo('  4. Create .env.example with your required env keys')
echo('  5. Test locally:      fli deploy:local')
echo('  6. Set up server:     fli deploy:setup')
echo('  7. Deploy:            fli deploy')
echo('')

if (flag.open && created.length && !flag.dry) {
  for (const f of created) {
    try { context.exec({ command: `${editor} "${f}"` }) } catch {}
  }
}
```
