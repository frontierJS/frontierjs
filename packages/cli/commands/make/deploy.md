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

// The layout is the one in the root README § Project Structure, which is
// canonical (Invariant 3) and is what `fli new` writes: ONE manifest at the app
// root, `api/index.ts` as the entry, and the schema under `db/`. This template
// used to assume an `api/package.json`, an `api/tsconfig.json` and an
// `api/src/server.ts` — none of which the scaffold produces — so `fli new` →
// `fli make:deploy` → `fli deploy` could never have completed once (FJS-232).
//
// `db/` is copied, not just `api/`: the entrypoint migrates and the deploy's
// pre-swap backup runs `litestone backup`, and both resolve databases by
// reading the schema.
//
// It installs from deploy/generated/ rather than from package.json, and that is
// not an optimization. An app scaffolded with `--source local` depends on the
// framework by `link:`, which resolves to the workspace on the machine that made
// it and to nothing inside a build — so `bun install` failed five times over and
// this image could not be built at all (FJS-241). `fli deploy:local` and the
// deploy's build step now run the vendor step first, which packs those packages
// into deploy/generated/vendor and writes a manifest pointing at the tarballs.
// With nothing linked it writes a verbatim copy and the lockfile beside it, so
// ONE template serves both source modes — which it has to, because the source
// mode can change long after `fli make:deploy` ran once.
const makeDockerfile = (appId) => `# FrontierJS API — ${appId}
# Built on the server via: docker build -t ${appId}:latest -f deploy/Dockerfile .
# No registry required — image lives on the server.
#
# Requires deploy/generated/, which \`fli deploy:local\` and \`fli deploy\` write
# before they build. A bare \`docker build\` from a clean tree has none of it —
# run \`fli deploy:vendor\` first.

FROM oven/bun:1 AS base
WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the tree. The manifest
# and the tarballs it names have to land in the same layer: the specs are
# relative to the manifest, which sits right here.
COPY deploy/generated/ ./deploy/generated/

# A rewritten manifest has no lockfile that matches it — \`--frozen-lockfile\`
# refuses rather than resolving — so the freeze is conditional. A lock present
# means npm sources and a lock worth honouring; absent means \`file:\` specs,
# which name their own content and are the stronger pin. The tarballs are removed
# in the same layer they were installed from, so the runtime image never carries
# them.
#
# \`--production\` skips INSTALLING devDependencies and still RESOLVES them, so a
# dev-only package this image would never run can fail the build outright — an
# unpublished one 404s here with the app otherwise perfect. Pruning them from the
# vendored manifest was tried and rejected: a manifest that no longer matches the
# lockfile beside it fails \`--frozen-lockfile\` on the line above.
RUN cp deploy/generated/app-manifest.json package.json \\
 && (cp deploy/generated/bun.lock* ./ 2>/dev/null || true) \\
 && if [ -f bun.lock ] || [ -f bun.lockb ]; \\
    then bun install --frozen-lockfile --production; \\
    else bun install --production; fi \\
 && rm -rf deploy/generated

# Source. db/ carries schema.lite and migrations/ — the entrypoint and the
# deploy's backup both read the schema to find the databases.
COPY tsconfig*.json ./
COPY api ./api
COPY db  ./db

# Runtime image
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=base /app .

# Mount point for the live database — the deploy runs --volume {db path}:/db.
# The database files themselves are NOT in the image: point DATABASE_URL at /db
# in .env.production, or the app opens a copy inside the container and every
# write is lost on the next swap.
#
# The audit trail is the same problem and is easy to forget, because nothing
# fails when it is wrong: a logger-driver database is a DIRECTORY of JSONL,
# and left on its default the container writes it beside the code and the next
# swap takes it with the rows in it. Bind AUDIT_PATH=/db/audit/ beside
# DATABASE_URL -- fli check's log-db-unbound is what says so.
#
# A Caravan jobs database is the third, and its default path is inside the
# container too: a deploy starts an empty queue and a deploy while paused starts
# one with no pause in it. Put it beside DATABASE_URL. The deploy asks the running
# app where its jobs database is before the swap, and says so when it is not here.
RUN mkdir -p /db

EXPOSE 3000

# Migrate, then serve. A failed migration exits non-zero, the health check fails
# and the pipeline restores the previous container.
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
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

// `resolveHealthPath` and `declaresHealth` both live in core/health-target.js:
// `fli deploy:doctor` asks the same two questions, and the copies disagreed —
// neither read `plugins: { health: true }` out of junction.config.js, which is
// where `fli new` puts it, so the scaffold warned about the app it had just
// written.
const { resolveHealthPath, declaresHealth } =
  await import(new URL('file://' + global.fliRoot + '/core/health-target.js'))

const makeDeployBlock = (appId, server, domain, healthPath) => {
  const serverLine = server ? `    server: '${server}',` : `    server: 'your-server.com',   // ← set this`
  const domainLine = domain ? `      domain: '${domain}',` : `      domain: 'your-app.com',   // ← set this`

  return `  deploy: {
${serverLine}
    // user: 'deploy',           // absent: the bare server, so an alias in
    //                           // ~/.ssh/config supplies User, Port and key
    path: '/apps/${appId}',      // deploy root on the server
    app_id: '${appId}',
    // transport: 'ssh',         // inferred from the server name; 'local' runs
    //                           // the same scripts here, which is what a
    //                           // localhost server already gets

    // Where the image is BUILT. Absent, it is built on the api target — which
    // means dev, stage and production each build their own bytes and no two can
    // be shown to be one artefact. Name a machine here and it is built once and
    // shipped (docker save | docker load), so one digest serves them all.
    // builder: { server: 'build.your-app.com', path: '/apps/${appId}' },

    api: {
      port:       3000,
      // Must include the app's apiPrefix — healthPlugin() registers through
      // app.get(), which moves with it. A wrong path here rolls back a good deploy.
      health:     '${healthPath}',
      dockerfile: 'deploy/Dockerfile',
      env:        '/apps/${appId}/.env.production',

      // Set to true to validate server env against .env.example before deploying
      envCheck: true,

      // The API on a domain of its own (api.your-app.com beside the web domain).
      // Unset, the web domain proxies /api/ and /ws and the page and the API are
      // one origin. Set, setup writes a second Caddy route and the web build is
      // run with VITE_API_URL=https://<this domain>. Caddy fetches the
      // certificate for each domain, so there is no ssl key.
      // domain: 'api.your-app.com',
    },

    web: {
${domainLine}
      keep_releases: 3,
    },

    db: {
      path:         '/apps/${appId}/db',
      file:         'production.db',
      keep_backups: 5,
    },

    // Docker's default log driver caps nothing, so a container that logs on
    // every request fills the disk and the database stops writing first.
    // Set logs to false if the daemon is already pointed somewhere.
    logs: {
      max_size:  '10m',
      max_files: 5,
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
const appId    = $.paths.root.split('/').pop().replace(/[^a-z0-9-]/gi, '-').toLowerCase()
const server   = flag.server  || ''
const domain   = flag.domain  || ''
const editor   = process.env.EDITOR || 'vi'
const created  = []

echo(`\nScaffolding deploy artifacts for: ${appId}\n`)

// ─── 1. Dockerfile ────────────────────────────────────────────────────────────
const dockerfileDir  = resolve($.paths.root, 'deploy')
const dockerfilePath = resolve(dockerfileDir, 'Dockerfile')

if (existsSync(dockerfilePath)) {
  log.warn(`Dockerfile already exists: deploy/Dockerfile — skipping`)
} else {
  if (!flag.dry) {
    mkdirSync(dockerfileDir, { recursive: true })
    writeFileSync(dockerfilePath, makeDockerfile(appId), 'utf8')
  }
  log.success(`Created: deploy/Dockerfile`)
  created.push(dockerfilePath)
}

// ─── 2. .dockerignore ─────────────────────────────────────────────────────────
const dockerignorePath = resolve($.paths.root, '.dockerignore')
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
    // `**/` and every SQLite sidecar, and both halves are measured. A plain `*`
    // does not cross a separator (`FJS-555`), so `db/*.db` protects one directory
    // and nothing under it — and `*.db` alone never matched `app.db-wal`, so the
    // running app's write-ahead log was copied into every image after the first.
    // That is one deployment's live data in the artefact, and it moved the image
    // digest on every deploy, which made an unchanged redeploy a new Release.
    '**/*.db',
    '**/*.db-wal',
    '**/*.db-shm',
    '**/*.sqlite',
    '**/*.sqlite3',
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
const configPath = resolve($.paths.root, 'frontier.config.js')
const health      = resolveHealthPath($.paths.root)
const deployBlock = makeDeployBlock(appId, server, domain, health.path)

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
const envExamplePath = resolve($.paths.root, '.env.example')
if (!existsSync(envExamplePath)) {
  log.warn(`.env.example not found`)
  log.info('  Create one to enable pre-deploy env validation (deploy.api.envCheck)')
  log.info('  Example: echo "JWT_SECRET=" >> .env.example')
}

// ─── 5. Health endpoint reminder ─────────────────────────────────────────────
// Two places can serve it and both count: `app.configure(healthPlugin())` in the
// API source, and `plugins: { health: true }` in junction.config.js — which is
// what `fli new` writes, so a reader that only grepped the source warned about
// every scaffold it had just produced. core/health-target.js owns the question.
const declared = declaresHealth($.paths.root, health.path)

if (health.from) {
  log.info(`Health path: ${health.path}  (apiPrefix '${health.prefix}' read from ${health.from.replace($.paths.root + '/', '')})`)
}

if (declared.clash) {
  // start() refuses a plugin configured by hand AND declared in config, by name.
  // A deploy finds that as a container that exits; this finds it here.
  log.warn(`Health is declared twice — healthPlugin() in the API source and plugins.health in the config.`)
  log.info(`  Junction refuses both at start(). Keep one: the config, unless you pass checks or authFn.`)
} else if (declared.declared) {
  const where = declared.sources.map(s => s.file).join(', ')
  log.success(`Health endpoint: declared in ${where} — the deploy will poll ${health.path}`)
} else {
  log.warn(`Nothing found that answers ${health.path}`)
  log.info(`  Declare it:  plugins: { health: true }  in api/config/junction.config.js`)
  log.info(`  Or by hand:  app.configure(healthPlugin())  where the plugin needs checks or authFn.`)
  log.info(`  apiPrefix moves it, which is why the deploy block above names the full`)
  log.info(`  path rather than '/health'.`)
}

// ─── Summary ──────────────────────────────────────────────────────────────────
echo('')
log.success('Done. Next steps:')
echo('')
echo('  1. Review deploy/Dockerfile and adjust for your app')
echo('  2. Set server/domain in frontier.config.js deploy block')
echo(`  3. Make sure something answers ${health.path} (plugins: { health: true })`)
echo('  4. Create .env.example with your required env keys')
echo('  5. Test locally:      fli deploy:local')
echo('  6. Set up server:     fli deploy:setup')
echo('  7. Deploy:            fli deploy')
echo('')

if (flag.open && created.length && !flag.dry) {
  for (const f of created) {
    try { $.exec({ command: `${editor} "${f}"` }) } catch {}
  }
}
```
