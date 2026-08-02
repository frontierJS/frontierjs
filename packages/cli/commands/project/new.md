---
title: project:new
description: Create a new FrontierJS project — Junction + Sierra/Mesa, optional auth, ready to deploy
alias: new
examples:
  - fli new my-app
  - fli new my-app --here
  - fli new my-app --no-auth
  - fli new my-app --auth --yes
  - fli new my-app --template api-only
  - fli new my-app --workspace --server prod.example.com --domain myapp.com
  - fli new my-app --minimal
  - fli new my-app --full --yes
args:
  -
    name: name
    description: Project name (creates ./<name>/ unless --here)
flags:
  here:
    type: boolean
    description: Use current directory instead of creating <name>/
    defaultValue: false
  force:
    type: boolean
    description: Allow non-empty target directory
    defaultValue: false
  template:
    type: string
    description: full-stack (default) | api-only
    defaultValue: full-stack
  with:
    type: string
    description: "Comma-list of additional FJS packages: conduit,caravan,notifications,litestream"
    defaultValue: ''
  minimal:
    type: boolean
    description: Only @frontierjs/junction; skip all prompts
    defaultValue: false
  full:
    type: boolean
    description: Install all tier-1 packages; skip all prompts
    defaultValue: false
  yes:
    char: y
    type: boolean
    description: Accept all interactive prompts
    defaultValue: false
  auth:
    type: boolean
    description: Force-include or force-skip auth (use --auth or --no-auth); without flag, prompts during execution
  deploy:
    type: boolean
    description: Scaffold Dockerfile and frontier.config.js deploy block (default true; use --no-deploy to skip)
    defaultValue: true
  fli:
    type: boolean
    description: Scaffold cli/src/routes via fli:init (default true; use --no-fli to skip)
    defaultValue: true
  web:
    type: boolean
    description: Scaffold web/ folder with Sierra+Mesa shell (default true; use --no-web for api-only)
    defaultValue: true
  example:
    type: boolean
    description: Force-include or force-skip the User example (use --example or --no-example); default depends on auth state
  git:
    type: boolean
    description: Run git init and create initial commit (default true; use --no-git to skip)
    defaultValue: true
  install:
    type: boolean
    description: Run bun install at the end (default true; use --no-install to skip)
    defaultValue: true
  workspace:
    type: boolean
    description: Add to $WORKSPACE_DIR/packages/ via workspace:add
    defaultValue: false
  scope:
    type: string
    description: npm scope for the package name
    defaultValue: '@frontierjs'
  server:
    type: string
    description: Passed to make:deploy
    defaultValue: ''
  domain:
    type: string
    description: Passed to make:deploy
    defaultValue: ''
  source:
    type: string
    description: "Where @frontierjs packages install from: local (symlink to <root>/packages, live edits) | npm (published). Default: $FJS_SOURCE or local"
    defaultValue: ''
---

<script>
import { mkdirSync } from 'fs'
import { join } from 'path'

// `existsSync, readFileSync, readdirSync, writeFileSync` come from _module.md
// `resolve, basename` come from _module.md
// `execSync` comes from _module.md (used via context.exec which wraps it)

// Split closing-script tags inside template strings — stops the FLI compiler
// from treating them as the outer script block's closing tag.
const sc = '</' + 'script>'

// ─── Validators ───────────────────────────────────────────────────────────────

function isValidProjectName(name) {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)
}

// ─── Package versions ─────────────────────────────────────────────────────────
// Frontier packages installed from npm. Using `latest` keeps fresh installs
// pulling the most recent published version while we're in beta.

const FJS_VERSIONS = {
  '@frontierjs/junction':       'latest',
  '@frontierjs/sierra':         'latest',
  '@frontierjs/mesa':           'latest',
  '@frontierjs/litestone':      'latest',
  '@frontierjs/auth':           'latest',
  '@frontierjs/conduit':        'latest',
  '@frontierjs/caravan':        'latest',
  '@frontierjs/notifications':  'latest',
  '@frontierjs/litestream':     'latest',
}

const VITE_VERSION = '^8.0.0'

// ─── Root template builders ───────────────────────────────────────────────────

function makePackageJson(spec) {
  const { name, scope, useAuth, useWeb, withPkgs, source } = spec
  const pkgName = scope ? `${scope}/${name}` : name

  // local source → `link:@frontierjs/x` (resolves to a live symlink via bun link);
  // npm source → the pinned/`latest` version from FJS_VERSIONS.
  const specFor = (key) => source === 'local' ? `link:${key}` : (FJS_VERSIONS[key] || 'latest')

  const deps = {
    '@frontierjs/junction':  specFor('@frontierjs/junction'),
    '@frontierjs/litestone': specFor('@frontierjs/litestone'),
  }
  if (useAuth) deps['@frontierjs/auth'] = specFor('@frontierjs/auth')
  if (useWeb) {
    deps['@frontierjs/sierra'] = specFor('@frontierjs/sierra')
    deps['@frontierjs/mesa']   = specFor('@frontierjs/mesa')
  }
  for (const pkg of withPkgs) {
    const key = `@frontierjs/${pkg}`
    if (FJS_VERSIONS[key]) deps[key] = specFor(key)
  }

  const devDeps = { 'bun-types': 'latest' }
  if (useWeb) {
    devDeps['vite'] = VITE_VERSION
  }

  // Scripts
  const scripts = {}
  if (useWeb) {
    scripts['dev']     = 'bun run --parallel dev:api dev:web'
    scripts['dev:api'] = 'bun --watch run api/index.ts'
    scripts['dev:web'] = 'cd web && vite -c config/vite.config.js'
    scripts['build']     = 'bun run build:web'
    scripts['build:web'] = 'cd web && vite build -c config/vite.config.js'
    scripts['start']   = 'bun run api/index.ts'
  } else {
    scripts['dev']   = 'bun --watch run api/index.ts'
    scripts['start'] = 'bun run api/index.ts'
  }

  return JSON.stringify({
    name:    pkgName,
    version: '0.1.0',
    private: true,
    type:    'module',
    scripts,
    dependencies:    deps,
    devDependencies: devDeps,
  }, null, 2) + '\n'
}

function makeGitignore() {
  return [
    'node_modules/',
    '.env',
    '.env.local',
    'db/*.db',
    'db/*.db-shm',
    'db/*.db-wal',
    'db/backups/',
    '.DS_Store',
    'dist/',
    '.fli-tmp/',
    '.deploy.lock',
    '',
  ].join('\n')
}

function makeEnvExample(useAuth) {
  const lines = [
    '# Required — generate with: openssl rand -hex 32',
    'ENCRYPTION_KEY=',
    '',
    '# Database file. Use :memory: for tests.',
    'DATABASE_URL=./db/app.db',
    '',
    '# App',
    'PORT=3000',
    'APP_URL=http://localhost:3000',
    'NODE_ENV=development',
    '',
  ]
  return lines.join('\n')
}

function makeFliJson(name) {
  return JSON.stringify({
    routesDir:        'cli/src/routes',
    defaultNamespace: name,
    editor:           'code',
  }, null, 2) + '\n'
}

function makeTsconfig() {
  return JSON.stringify({
    compilerOptions: {
      target:           'ESNext',
      module:           'ESNext',
      moduleResolution: 'bundler',
      strict:           true,
      esModuleInterop:  true,
      skipLibCheck:     true,
      types:            ['bun-types'],
      paths:            { '@/*': ['./web/src/*'] },
      jsx:              'preserve',
      allowImportingTsExtensions: true,
      noEmit:           true,
    },
    include: ['api/**/*', 'web/**/*'],
  }, null, 2) + '\n'
}

function makeReadme(spec) {
  const { name, useAuth, useWeb, withPkgs } = spec
  const features = [
    `- ${useAuth ? 'Auth (sessions, password reset, email verify) via `@frontierjs/auth`' : 'No auth (add later with `fli auth:install`)'}`,
    `- Litestone client with gate plugin for level-based authorization`,
    `- ${useWeb ? 'Sierra + Mesa frontend with Vite' : 'API-only (no frontend)'}`,
  ]
  if (withPkgs.length) features.push(`- Additional packages: ${withPkgs.map(p => `\`@frontierjs/${p}\``).join(', ')}`)

  return `# ${name}

A FrontierJS application — Junction + Litestone${useAuth ? ' + Auth' : ''}${useWeb ? ' + Sierra' : ''}.

## What's included

${features.join('\n')}

## Run

\`\`\`bash
# 1. Install deps
bun install

# 2. Set up env
cp .env.example .env
# Generate ENCRYPTION_KEY: openssl rand -hex 32

# 3. Start
bun run dev
\`\`\`

${useWeb
  ? 'This runs both the api (port 3000) and the web (Vite default port) concurrently.'
  : 'This runs the api server with watch mode.'}

Schema DDL runs automatically on first start — no migration step.

## Common commands

\`\`\`bash
# Add a new model with full vertical slice (schema → service → resource → routes)
fli scaffold ModelName --fields "name:string email:email"

# Generate a CRUD admin UI from schema.lite
fli admin:generate

# Validate cross-realm integrity
fli validate

# Pre-flight checks before deploying
fli deploy:doctor

# Deploy via SSH + Docker (after fli deploy:setup)
fli deploy
\`\`\`

## Layout

\`\`\`
${name}/
├── package.json
├── frontier.config.js          # FLI deploy config
├── .env.example
├── README.md
├── db/
│   └── schema.lite             # Single source of truth — data + auth
├── deploy/
│   └── Dockerfile              # Built on the server
├── cli/
│   └── src/routes/             # Project-specific FLI commands
├── api/
│   ├── index.ts                # bun --watch entry
│   ├── config/
│   │   └── junction.config.js  # Autoload paths, middleware, plugins
│   └── src/
│       ├── app.ts              # createApp + plugin wiring
│       ├── core/
│       │   ├── env.ts           # Typed, validated env
│       │   ├── db.ts           # Litestone client + GatePlugin
│       │   ├── auth.ts         # createLitestoneAuth + plugin (if auth)
│       │   └── hooks.ts        # withLitestoneDb
│       └── services/           # Service files autoloaded at boot
${useWeb
  ? `└── web/
    ├── index.html
    ├── config/
    │   ├── vite.config.js      # Thin wrapper — createSierraViteConfig
    │   └── sierra.config.js    # Routes dir, target, junction url
    └── src/
        ├── App.mesa            # Root: <RouterView />
        ├── routes/             # Sierra file-based routes (.mesa)
        └── resources/          # Junction stores (.js)
\`\`\``
  : '\`\`\`'}

## Where to grow

- **Add a model:** \`fli scaffold Lead --fields "name:string email:email status:string"\`
- **Background jobs:** add \`@frontierjs/caravan\` and configure under the \`caravan\` block in \`junction.config.js\`
- **Outbound integrations:** add \`@frontierjs/conduit\` and place targets in \`api/src/conduit/\`
- **Real-time:** add channels in \`api/src/core/channels.ts\` and wire in \`app.ts\`
`
}

// ─── API templates ────────────────────────────────────────────────────────────

function makeApiIndexTs() {
  return `// api/index.ts
// Run with: bun run api/index.ts

import app from './src/app.ts'

await app.start()
`
}

function makeApiAppTs(useAuth) {
  if (useAuth) {
    return `// api/src/app.ts
// The construction site — createApp + every plugin registration lives here.
// Read top-to-bottom for "how this app is wired."
//
// The default export is the configured but-not-yet-started app. The actual
// \`app.start()\` call lives in api/index.ts so that test code can import this
// file without binding a port.

import { createApp, cors, requestLogger, correlationId } from '@frontierjs/junction'
import { auth, authPlugin } from './core/auth.ts'
import { withDb }           from './core/hooks.ts'
import { env }              from './core/env.ts'

const app = createApp({
  auth,
  config: {
    port: env.PORT,
    apiPrefix: '/api',
  },
})

// ─── Middleware ───────────────────────────────────────────────────────────
app.configure(cors({ origins: ['*'], credentials: true }))
app.configure(correlationId())
app.configure(requestLogger())

// ─── Auth routes ──────────────────────────────────────────────────────────
// Mounts /auth/register, /auth/login, /auth/logout, /auth/me, etc.
app.configure(authPlugin)

// ─── Per-request db scoping ──────────────────────────────────────────────
// withLitestoneDb attaches a request-scoped db client to ctx.params.db.
// Every service call sees a db with auth context applied.
app.hooks({
  around: { all: [withDb] },
})

// Services in api/src/services/*.service.ts are autoloaded at boot
// (configured in api/config/junction.config.js).

export default app
`
  }

  return `// api/src/app.ts
// The construction site — createApp + every plugin registration lives here.

import { createApp, cors, requestLogger, correlationId } from '@frontierjs/junction'
import { withDb }                                        from './core/hooks.ts'
import { env }                                           from './core/env.ts'

const app = createApp({
  config: {
    port: env.PORT,
    apiPrefix: '/api',
  },
})

// ─── Middleware ───────────────────────────────────────────────────────────
app.configure(cors({ origins: ['*'], credentials: true }))
app.configure(correlationId())
app.configure(requestLogger())

// ─── Per-request db scoping ──────────────────────────────────────────────
app.hooks({
  around: { all: [withDb] },
})

// Services in api/src/services/*.service.ts are autoloaded at boot
// (configured in api/config/junction.config.js).

export default app
`
}

function makeApiEnvTs() {
  return `// api/src/core/env.ts
// Validated at module load — a missing required var crashes the app
// before anything else runs. Import this from app.ts and other places
// that need env values.

import { defineEnv } from '@frontierjs/junction'

export const env = defineEnv({
  // Required — used for HMAC of API keys, encrypted columns, OAuth state.
  // Generate with: openssl rand -hex 32
  ENCRYPTION_KEY: { type: 'string', required: true },

  // Database file path. Use ':memory:' for tests.
  DATABASE_URL: { type: 'string', default: './db/app.db' },

  // App
  PORT:     { type: 'port',   default: 3000 },
  APP_URL:  { type: 'url',    default: 'http://localhost:3000' },
  NODE_ENV: { type: 'string', default: 'development' },
})
`
}

function makeApiCoreDbTs() {
  return `// api/src/core/db.ts
// One Litestone client for the whole app. Gate plugin maps the
// SessionContext from auth into Litestone's level system:
//   no user        → STRANGER (0)
//   role: 'admin'  → ADMINISTRATOR (5)
//   anyone else    → USER (4)
//
// Schema is loaded from disk; createClient runs the DDL automatically
// on first run. No separate apply() step needed for fresh DBs.

import { createClient, GatePlugin, LEVELS } from '@frontierjs/litestone'
import { env } from './env.ts'

const gate = new GatePlugin({
  async getLevel(user: unknown) {
    if (!user) return LEVELS.STRANGER
    if ((user as { role?: string }).role === 'admin') return LEVELS.ADMINISTRATOR
    return LEVELS.USER
  },
})

export const db = await createClient({
  schema:        './db/schema.lite',
  db:            env.DATABASE_URL,
  encryptionKey: env.ENCRYPTION_KEY,
  plugins:       [gate],
})
`
}

function makeApiCoreHooksTs() {
  return `// api/src/core/hooks.ts
// Global hooks attached at the App level — run on every service call.
// withLitestoneDb scopes the db client to the current request's user
// (ctx.params.db = db.$setAuth(ctx.user)) so policies + plugins see
// who's calling. createService reads ctx.params.db automatically.

import { withLitestoneDb } from '@frontierjs/junction/litestone'
import { db } from './db.ts'

export const withDb = withLitestoneDb(db)
`
}

function makeApiCoreAuthTs() {
  return `// api/src/core/auth.ts
// Auth instance + plugin. The instance exposes IAuth for use in
// createApp({ auth }); the plugin mounts /auth/* HTTP routes.
//
// Both reference the same \`db\` import — auth uses db.asSystem()
// internally so its writes bypass gates and policies.

import { createLitestoneAuth, createAuthPlugin } from '@frontierjs/auth'
import { db }   from './db.ts'
import { env }  from './env.ts'

export const auth = createLitestoneAuth(db, {
  encryptionKey:        env.ENCRYPTION_KEY,
  sessionTtl:           '30 days',
  passwordResetTtl:     '1 hour',
  emailVerificationTtl: '24 hours',

  // In a real app these send email via the mailer plugin.
  // For now we just log — wire to mail.send() once you add it.
  onPasswordResetRequested: async (email, token) => {
    console.log(\`[auth] password reset for \${email}: token=\${token}\`)
  },
  onEmailVerificationRequested: async (email, token) => {
    console.log(\`[auth] verify email for \${email}: token=\${token}\`)
  },
})

export const authPlugin = createAuthPlugin(auth, {
  // Token in response body by default. Set true for httpOnly session cookie.
  cookieAuth: false,
})
`
}

function makeJunctionConfig(appName) {
  return `// api/config/junction.config.js
// Loaded automatically by createApp() when called with no opts, or merged
// with opts.config when both are present. Tells Junction's autoloaders
// where to find services / jobs / conduit targets, and configures the
// built-in middleware.

export default {
  app: {
    name:      '${appName}',
    apiPrefix: '/api',
  },

  services: {
    dir: './api/src/services',
  },

  middleware: {
    cors:          { origins: ['*'], credentials: true },
    helmet:        true,
    requestLogger: true,
    correlationId: true,
  },

  plugins: {
    health:   true,
    manifest: true,
  },
}
`
}

// ─── Schema starter (no auth path) ────────────────────────────────────────────

function makeSchemaLiteEmpty() {
  return `// db/schema.lite
// Single source of truth for data shape + authorization.
// Add models here; Litestone generates DDL automatically on first start.

`
}

// ─── Web templates (Sierra + Mesa + Vite) ─────────────────────────────────────

function makeIndexHtml(appName) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${appName}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/App.mesa">${sc}
  </body>
</html>
`
}

function makeViteConfig() {
  return `// web/config/vite.config.js
// Thin wrapper — Sierra produces the actual Vite config from sierra.config.js.

import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

export default defineConfig(createSierraViteConfig(sierraConfig))
`
}

function makeSierraConfig(appName) {
  return `// web/config/sierra.config.js
// Sierra runtime config — routes dir, build target, junction connection.
// Paths are relative to the Vite root (web/), since dev:web cd's into web/
// before invoking vite -c config/vite.config.js.

export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',

  junction: {
    url:      \`\${location.protocol === 'https:' ? 'wss:' : 'ws:'}//\${location.host}\`,
    tokenKey: '${appName}_token',
    // Must match the API's config.apiPrefix (api/config/default.ts). Junction
    // defaults to no prefix — services at /{service} — so this line and that
    // one move together or the client requests paths the server never
    // registered.
    apiPrefix: '/api',
  },
}
`
}

function makeAppMesa() {
  return `<script>
  import { RouterView } from '@frontierjs/sierra/router'
${sc}

<RouterView />
`
}

function makeRouteModule(appName, useAuth) {
  if (useAuth) {
    return `---
siteName: ${appName}
---
<script>
  import { goto, isActive, page } from '@frontierjs/sierra/router'
  import { connected, logout } from '@frontierjs/sierra/junction'
${sc}

<div class="shell">
  <nav class="nav">
    <span class="brand">{page.siteName}</span>

    <div class="links">
      <a href="/" class:active={isActive('/')}>Home</a>
      <a href="/users/" class:active={isActive('/users/')}>Users</a>
    </div>

    <div class="status">
      <span class="dot" class:connected={connected}></span>
      <button on:click={() => { logout(); goto('/login/') }}>Sign out</button>
    </div>
  </nav>

  <main>
    <slot />
  </main>
</div>

<style>
  .shell { display: flex; flex-direction: column; min-height: 100vh; font-family: system-ui }
  .nav { display: flex; align-items: center; gap: 24px; padding: 12px 24px; border-bottom: 1px solid #e5e7eb }
  .brand { font-weight: 600; margin-right: auto }
  .links { display: flex; gap: 16px }
  .links a { text-decoration: none; color: #6b7280 }
  .links a.active { color: #111 }
  main { padding: 24px; flex: 1 }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #e5e7eb; display: inline-block }
  .dot.connected { background: #22c55e }
  button { background: none; border: 1px solid #e5e7eb; border-radius: 6px; padding: 4px 12px; cursor: pointer }
</style>
`
  }

  return `---
siteName: ${appName}
---
<script>
  import { isActive, page } from '@frontierjs/sierra/router'
  import { connected } from '@frontierjs/sierra/junction'
${sc}

<div class="shell">
  <nav class="nav">
    <span class="brand">{page.siteName}</span>

    <div class="links">
      <a href="/" class:active={isActive('/')}>Home</a>
    </div>

    <div class="status">
      <span class="dot" class:connected={connected}></span>
    </div>
  </nav>

  <main>
    <slot />
  </main>
</div>

<style>
  .shell { display: flex; flex-direction: column; min-height: 100vh; font-family: system-ui }
  .nav { display: flex; align-items: center; gap: 24px; padding: 12px 24px; border-bottom: 1px solid #e5e7eb }
  .brand { font-weight: 600; margin-right: auto }
  .links { display: flex; gap: 16px }
  .links a { text-decoration: none; color: #6b7280 }
  .links a.active { color: #111 }
  main { padding: 24px; flex: 1 }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #e5e7eb; display: inline-block }
  .dot.connected { background: #22c55e }
</style>
`
}

function makeRouteIndex(appName) {
  return `---
title: Home
---
<script>
  import { connected } from '@frontierjs/sierra/junction'
${sc}

<h1>Welcome to ${appName}</h1>
<p>Junction: {connected ? 'connected ✓' : 'connecting…'}</p>
<p>Edit <code>web/src/routes/index.mesa</code> to start.</p>
`
}

function makeRouteLogin() {
  return `---
title: Sign in
---
<script>
  import { goto } from '@frontierjs/sierra/router'
  import { login } from '@frontierjs/sierra/junction'

  let email    = ''
  let password = ''
  let error    = ''
  let loading  = false

  async function handleSubmit() {
    loading = true
    error   = ''
    try {
      const res = await fetch('/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
      })
      if (!res.ok) throw new Error(await res.text())
      const { token } = await res.json()
      login(token)
      goto('/')
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }
${sc}

<div class="login">
  <h1>Sign in</h1>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  <input bind:value={email}    type="email"    placeholder="Email" />
  <input bind:value={password} type="password" placeholder="Password" />
  <button on:click={handleSubmit} disabled={loading}>
    {loading ? 'Signing in…' : 'Sign in'}
  </button>
</div>

<style>
  .login { max-width: 320px; margin: 80px auto; display: flex; flex-direction: column; gap: 12px }
  input { padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px }
  button { padding: 8px 12px; background: #111; color: #fff; border: none; border-radius: 6px; cursor: pointer }
  button:disabled { opacity: .5 }
  .error { color: #ef4444; font-size: 14px }
</style>
`
}

// ─── Helper: spawn a subcommand via fli ───────────────────────────────────────
// Runs `fli <args>` in the project root. Inherits stdio so the user sees the
// subcommand's output. Throws on non-zero exit.

function runFli(context, args, cwd) {
  const cmd = `fli ${args.join(' ')}`
  context.exec({ command: cmd, cwd, stdio: 'inherit' })
}
</script>

Creates a brand-new FrontierJS project from scratch — Junction API, optional auth, optional Sierra/Mesa frontend, deploy-ready out of the box. Composes existing FLI commands (`auth:install`, `make:scaffold`, `make:deploy`, `fli:init`, `workspace:add`) so the output stays consistent with what those generators produce when run on existing projects.

The default install set is just `@frontierjs/junction`. Auth is asked about during execution unless `--auth` or `--no-auth` is passed. Use `--minimal` (junction only) or `--full` (all tier-1 packages) to skip prompts entirely. `--yes` accepts every prompt.

Templates: `full-stack` (default — api + web) and `api-only` (no web/ folder).

```js
// ─── 1. Validate inputs ───────────────────────────────────────────────────────

const name = arg.name
const useHere = flag.here === true

if (!useHere && !name) {
  log.error('Project name is required. Use `fli new <name>` or `fli new --here`.')
  return
}

if (name && !isValidProjectName(name)) {
  log.error(`Invalid project name: "${name}". Use lowercase letters, digits, and hyphens.`)
  return
}

// ─── 2. Resolve target directory ──────────────────────────────────────────────

const targetDir = useHere ? context.paths.root : resolve(context.paths.root, name)
const appName   = useHere ? basename(context.paths.root) : name

if (!useHere && existsSync(targetDir)) {
  log.error(`Directory ${name}/ already exists. Use --here if you meant to scaffold into it, or pick a different name.`)
  return
}

if (useHere && !flag.force) {
  const entries = readdirSync(targetDir).filter(f => !f.startsWith('.'))
  if (entries.length > 0) {
    log.error(`Current directory is not empty (${entries.length} entries). Use --force to override.`)
    return
  }
}

// ─── 3. Resolve template + flags ──────────────────────────────────────────────

const template  = flag.template
const useWeb    = (template === 'full-stack' || template === undefined) && flag.web !== false
const useDeploy = flag.deploy !== false
const useFli    = flag.fli !== false
const useGit    = flag.git !== false
const useInstall = flag.install !== false
const useWorkspace = flag.workspace === true
const skipPrompts = flag.yes === true || flag.minimal === true || flag.full === true || flag.dry === true

// Parse --with packages
const withInput = (flag.with || '').split(',').map(p => p.trim()).filter(Boolean)
const validExtras = ['conduit', 'caravan', 'notifications', 'litestream']
const withPkgs = []
for (const pkg of withInput) {
  if (validExtras.includes(pkg)) withPkgs.push(pkg)
  else log.warn(`Unknown package "${pkg}" — skipping. Valid: ${validExtras.join(', ')}`)
}
if (flag.full) {
  for (const p of validExtras) if (!withPkgs.includes(p)) withPkgs.push(p)
}

// ─── 4. Auth decision ─────────────────────────────────────────────────────────
// Three states: --auth (true), --no-auth (false), neither (prompt)

let useAuth
if (flag.auth === true)  useAuth = true
else if (flag.auth === false) useAuth = false
else if (flag.minimal) useAuth = false
else if (flag.full)    useAuth = true
else if (flag.yes)     useAuth = true
else if (skipPrompts)  useAuth = true   // --dry treats prompts as accepted
else {
  // Interactive prompt
  const answer = await question(`\n  Install @frontierjs/auth? (sessions, password reset, email verify) [Y/n] › `)
  useAuth = !(answer && answer.toLowerCase().startsWith('n'))
}

// ─── 5. Example decision ──────────────────────────────────────────────────────
// Default: on if auth, off otherwise. Flags override.

let useExample
if (flag.example === true)  useExample = true
else if (flag.example === false) useExample = false
else useExample = useAuth

// ─── 6. Workspace mode — adjust target dir ────────────────────────────────────

let finalTarget = targetDir
if (useWorkspace) {
  const wsRoot = process.env.WORKSPACE_DIR || process.env.OUTLAW_DIR
  if (!wsRoot) {
    log.error('--workspace requires $WORKSPACE_DIR to be set.')
    return
  }
  const wsResolved = resolve(wsRoot.replace(/^~/, process.env.HOME || ''))
  if (!existsSync(wsResolved)) {
    log.error(`$WORKSPACE_DIR does not exist: ${wsResolved}`)
    return
  }
  const wsTarget = resolve(wsResolved, 'packages', name)
  if (existsSync(wsTarget)) {
    log.error(`Workspace package already exists: packages/${name}/`)
    return
  }
  log.info(`Workspace mode — creating at ${wsTarget}`)
  finalTarget = wsTarget
}

// ─── 6.5 FJS package source — local (symlink) or npm (published) ──────────────
// Default resolves from $FJS_SOURCE (set once during buildout), else 'local'.
// GitHub is not supported yet.
const fjsSource = (flag.source || process.env.FJS_SOURCE || 'local').toLowerCase()

if (fjsSource !== 'local' && fjsSource !== 'npm') {
  const hint = fjsSource === 'github'
    ? '--source github is not supported yet.'
    : `Unknown --source "${fjsSource}".`
  log.error(`${hint} Use local (symlink to your packages) or npm (published).`)
  return
}

// The @frontierjs packages this project will actually depend on
const neededPkgs = ['@frontierjs/junction', '@frontierjs/litestone']
if (useAuth) neededPkgs.push('@frontierjs/auth')
if (useWeb)  neededPkgs.push('@frontierjs/sierra', '@frontierjs/mesa')
for (const p of withPkgs) neededPkgs.push(`@frontierjs/${p}`)

// Where local package sources live. fli lives at <root>/packages/cli, so the
// FJS packages are its siblings under <root>/packages/. Override with
// $FJS_PACKAGES_DIR or $WORKSPACE_DIR if your layout differs.
const expandHome = (p) => p.replace(/^~/, process.env.HOME || '')
const packagesDir = process.env.FJS_PACKAGES_DIR
  ? resolve(expandHome(process.env.FJS_PACKAGES_DIR))
  : process.env.WORKSPACE_DIR
    ? resolve(expandHome(process.env.WORKSPACE_DIR), 'packages')
    : resolve(global.fliRoot, '..')

const pkgDir = (pkgName) => resolve(packagesDir, pkgName.slice('@frontierjs/'.length))

// For local source every needed package must exist on disk before we link it
if (fjsSource === 'local') {
  const missing = neededPkgs.filter(p => !existsSync(resolve(pkgDir(p), 'package.json')))
  if (missing.length) {
    log.error(`--source local: package(s) not found under ${packagesDir}:`)
    for (const m of missing) log.error(`  ${m}  (expected ${pkgDir(m)})`)
    log.info('Set $FJS_PACKAGES_DIR or $WORKSPACE_DIR, or use --source npm.')
    return
  }
}

// ─── 7. Plan summary (always shown) ───────────────────────────────────────────

echo('')
log.info(`Creating ${appName} at ${finalTarget}`)
echo('')
echo(`  Template:  ${template}`)
echo(`  FJS pkgs:  ${fjsSource === 'local' ? `local — symlink to ${packagesDir}` : 'npm (published)'}`)
echo(`  Auth:      ${useAuth ? 'yes' : 'no'}`)
echo(`  Web:       ${useWeb ? 'yes (Sierra + Mesa + Vite)' : 'no'}`)
echo(`  Deploy:    ${useDeploy ? 'yes (deploy/Dockerfile + frontier.config.js)' : 'no'}`)
echo(`  FLI:       ${useFli ? 'yes (cli/src/routes/)' : 'no'}`)
echo(`  Example:   ${useExample ? 'yes (User CRUD vertical slice)' : 'no'}`)
echo(`  Git:       ${useGit ? 'yes' : 'no'}`)
echo(`  Install:   ${useInstall ? 'yes' : 'no'}`)
echo(`  Workspace: ${useWorkspace ? `yes (${process.env.WORKSPACE_DIR})` : 'no'}`)
if (withPkgs.length) echo(`  Extras:    ${withPkgs.join(', ')}`)
echo('')

if (flag.dry) {
  log.dry('--dry — stopping here. Nothing written.')
  return
}

// ─── 8. Create directory tree ─────────────────────────────────────────────────

mkdirSync(finalTarget, { recursive: true })

const dirs = [
  'db',
  'api',
  'api/config',
  'api/src',
  'api/src/core',
  'api/src/services',
]
if (useFli)    dirs.push('cli/src/routes')
if (useDeploy) dirs.push('deploy')
if (useWeb) {
  dirs.push('web', 'web/config', 'web/src', 'web/src/routes', 'web/src/resources', 'web/src/components')
  if (useAuth) dirs.push('web/src/routes/login')
}

for (const d of dirs) {
  mkdirSync(resolve(finalTarget, d), { recursive: true })
}

// ─── 9. Write base files ──────────────────────────────────────────────────────

const spec = { name: appName, scope: flag.scope, useAuth, useWeb, withPkgs, source: fjsSource }

const filesToWrite = [
  ['package.json',                makePackageJson(spec)],
  ['.gitignore',                  makeGitignore()],
  ['.env.example',                makeEnvExample(useAuth)],
  ['.fli.json',                   makeFliJson(appName)],
  ['tsconfig.json',               makeTsconfig()],
  ['README.md',                   makeReadme(spec)],
  ['db/schema.lite',              makeSchemaLiteEmpty()],
  ['api/index.ts',                makeApiIndexTs()],
  ['api/src/app.ts',              makeApiAppTs(useAuth)],
  ['api/src/core/env.ts',         makeApiEnvTs()],
  ['api/src/core/db.ts',          makeApiCoreDbTs()],
  ['api/src/core/hooks.ts',       makeApiCoreHooksTs()],
  ['api/config/junction.config.js', makeJunctionConfig(appName)],
]

if (useAuth) {
  filesToWrite.push(['api/src/core/auth.ts', makeApiCoreAuthTs()])
}

if (useWeb) {
  filesToWrite.push(
    ['web/index.html',                      makeIndexHtml(appName)],
    ['web/config/vite.config.js',           makeViteConfig()],
    ['web/config/sierra.config.js',         makeSierraConfig(appName)],
    ['web/src/App.mesa',                    makeAppMesa()],
    ['web/src/routes/_module.mesa',         makeRouteModule(appName, useAuth)],
    ['web/src/routes/index.mesa',           makeRouteIndex(appName)],
  )
  if (useAuth) {
    filesToWrite.push(['web/src/routes/login/index.mesa', makeRouteLogin()])
  }
}

// .env (copy of .env.example, gitignored)
filesToWrite.push(['.env', makeEnvExample(useAuth)])

const written = []
for (const [relPath, content] of filesToWrite) {
  const abs = resolve(finalTarget, relPath)
  writeFileSync(abs, content, 'utf8')
  written.push(relPath)
}

log.success(`Wrote ${written.length} base files`)

// ─── 10. Compose subcommands ──────────────────────────────────────────────────
// At this point the directory has a package.json — fli's findProjectRoot will
// resolve the new project as projectRoot from any cwd inside it.

echo('')
log.info('Composing FLI sub-commands…')
echo('')

// fli:init — drops the cli/src/routes scaffold
if (useFli) {
  try {
    log.info('→ fli:init')
    runFli(context, ['init', '--namespace', appName], finalTarget)
  } catch (e) {
    log.warn(`fli:init failed: ${e.message} — continuing`)
  }
}

// auth:install — injects schema models, generates ENCRYPTION_KEY, scaffolds auth.ts
// NOTE: existing auth:install writes to api/src/auth.ts (older path).
//       The api/src/core/auth.ts that project:new writes will be the canonical
//       one until auth:install is migrated.
if (useAuth) {
  try {
    log.info('→ auth:install')
    runFli(context, ['auth:install'], finalTarget)
  } catch (e) {
    log.warn(`auth:install failed: ${e.message} — you may need to run it manually after install`)
  }
}

// User example — scaffold resource + routes around the User model
// Schema already populated by auth:install (or user adds one manually if no-auth)
if (useExample) {
  try {
    log.info('→ make:scaffold User --skip-schema')
    runFli(context, ['scaffold', 'User', '--skip-schema'], finalTarget)
  } catch (e) {
    log.warn(`make:scaffold User failed: ${e.message} — continuing`)
  }
}

// make:deploy — Dockerfile + frontier.config.js deploy block
if (useDeploy) {
  try {
    log.info('→ make:deploy')
    const args = ['make:deploy']
    if (flag.server) args.push('--server', flag.server)
    if (flag.domain) args.push('--domain', flag.domain)
    runFli(context, args, finalTarget)
  } catch (e) {
    log.warn(`make:deploy failed: ${e.message} — you can run it manually later`)
  }
}

// workspace:add — move the project into $WORKSPACE_DIR/packages/
// Only if --workspace was set AND we wrote to a temp path (we didn't — we wrote
// directly to the workspace target). So this is a no-op for now; project lives
// in the workspace by virtue of where we wrote it.

// ─── 11. Git init + initial commit ────────────────────────────────────────────

if (useGit) {
  try {
    log.info('→ git init')
    context.exec({ command: 'git init', cwd: finalTarget, stdio: 'pipe' })
    context.exec({ command: 'git add .', cwd: finalTarget, stdio: 'pipe' })
    context.exec({ command: 'git commit -m "init"', cwd: finalTarget, stdio: 'pipe' })
    log.success('Git repository initialized')
  } catch (e) {
    log.warn(`git init step failed: ${e.message} — skipping`)
  }
}

// ─── 11.5 Link local @frontierjs packages (source=local) ──────────────────────
// Register each needed package as a global bun link (idempotent) so the
// `link:@frontierjs/*` specs in package.json resolve to live symlinks on install.
// Edits to the package sources are then picked up with no reinstall.
if (fjsSource === 'local') {
  echo('')
  log.info(`Linking ${neededPkgs.length} local @frontierjs package(s) from ${packagesDir}…`)
  for (const p of neededPkgs) {
    try {
      context.exec({ command: 'bun link', cwd: pkgDir(p), stdio: 'pipe' })
      log.info(`  → ${p}`)
    } catch (e) {
      log.warn(`  bun link failed for ${p}: ${e.message}`)
    }
  }
}

// ─── 12. bun install ──────────────────────────────────────────────────────────

if (useInstall) {
  try {
    log.info('→ bun install')
    context.exec({ command: 'bun install', cwd: finalTarget, stdio: 'inherit' })
  } catch (e) {
    log.warn(`bun install failed: ${e.message} — run it manually before fli dev`)
  }
}

// ─── 13. Summary ──────────────────────────────────────────────────────────────

echo('')
log.success(`✓ ${appName} created`)
echo('')
echo(`  cd ${useHere ? '.' : (useWorkspace ? finalTarget : name)}`)
if (!useInstall) echo('  bun install')
echo('  cp .env.example .env      # then fill in ENCRYPTION_KEY (openssl rand -hex 32)')
echo('  bun run dev')
echo('')
if (fjsSource === 'local') {
  echo(`  @frontierjs packages are symlinked from ${packagesDir} — edits are live.`)
  echo('  Heads-up: symlinked local packages can diverge from a real npm install —')
  echo('  do a `--source npm` run before publishing to catch packaging issues.')
  echo('')
}
echo('  Then:')
echo('    fli scaffold <Model>    add a new model + service + resource + routes')
echo('    fli admin:generate      generate CRUD admin UI from schema.lite')
echo('    fli deploy:doctor       check deploy readiness')
echo('')
```