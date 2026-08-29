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
  - fli new my-app --widgets
  - fli new my-app --site
  - fli new my-app --template widgets-only
  - fli new my-app --template site-only
  - fli new my-app --extension
  - fli new my-app --template extension-only
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
    description: full-stack (default) | api-only | widgets-only | site-only | extension-only
    defaultValue: full-stack
  with:
    type: string
    description: "Comma-list of additional FJS packages: conduit,caravan,notifications"
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
  widgets:
    type: boolean
    description: Also scaffold the widgets/ surface — embeddable scripts for pages this app does not own
    defaultValue: false
  site:
    type: boolean
    description: Also scaffold the site/ surface — the public, prerendered site
    defaultValue: false
  extension:
    type: boolean
    description: Also scaffold the extension/ surface — a jetty browser extension, MV3
    defaultValue: false
  example:
    type: boolean
    description: Force-include or force-skip the User example (use --example or --no-example); default depends on auth state
  git:
    type: boolean
    description: Run git init and create initial commit (default true; use --no-git to skip)
    defaultValue: true
  ci:
    type: boolean
    description: Write .github/workflows/ci.yml, which runs `bun run check` (default true; use --no-ci to skip)
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
    description: "Where @frontierjs packages install from: npm (published, default) | local (symlink to <root>/packages, live edits; a build packs them into the image). Default: $FJS_SOURCE or npm"
    defaultValue: ''
---

<script>
import { mkdirSync } from 'fs'
import { join } from 'path'

// `existsSync, readFileSync, readdirSync, writeFileSync` come from _module.md
// `resolve, basename` come from _module.md
// `execSync` comes from _module.md (used via context.exec which wraps it)

// What the app is given besides its own source — dev dependencies, the check
// scripts, tsconfig, biome.json, .editorconfig, the workflow. One module, so
// the framework's opinion about tooling is written down once and can be read.
const { EDITORCONFIG, APP_DEV_DEPS, FJS_PACKAGES, appTsconfig, appBiomeJson, appCheckScripts, appWorkflow } =
  await import(resolve(global.fliRoot, 'core/app-config.js'))

// The widgets/ surface — one owner, shared with `fli make:widget`, so an app
// scaffolded here can be extended by the command that adds the second widget.
const { scaffoldWidgetSurface, widgetScripts } =
  await import(resolve(global.fliRoot, 'core/widget-surface.js'))

// The site/ surface, same rule: one owner, shared with `fli make:site`. It is a
// peer of web/ and never a routesDir inside it — sharing a Vite root shares a
// dist/, and `vite build` empties outDir, so building the SPA deletes the site.
const { scaffoldSiteSurface, siteScripts } =
  await import(resolve(global.fliRoot, 'core/site-surface.js'))

// The extension surface, same rule: one owner, shared with `fli make:extension`.
const { scaffoldExtensionSurface, extensionScripts } =
  await import(resolve(global.fliRoot, 'core/extension-surface.js'))

// Split closing-script tags inside template strings — stops the FLI compiler
// from treating them as the outer script block's closing tag.
const sc = '</' + 'script>'

// ─── Validators ───────────────────────────────────────────────────────────────

function isValidProjectName(name) {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)
}


const VITE_VERSION = '^8.0.0'

// ─── Root template builders ───────────────────────────────────────────────────

function makePackageJson(spec) {
  const {
    name, scope, useAuth, useWeb, useApi = true, useWidgets = false, useSite = false,
    useExtension = false, withPkgs, source,
  } = spec
  const pkgName = scope ? `${scope}/${name}` : name
  // Sierra and Mesa are the UI realm, and a widget and a prerendered page are
  // both UI: a widgets-only or site-only project has no SPA and still compiles
  // .mesa with the same compiler.
  const useUI   = useWeb || useWidgets || useSite

  // local source → `link:@frontierjs/x` (resolves to a live symlink via bun link);
  // npm source → the version FJS_PACKAGES pins, which is `latest` while pre-alpha.
  const specFor = (key) => source === 'local' ? `link:${key}` : (FJS_PACKAGES[key] || 'latest')

  const deps = {
    '@frontierjs/litestone': specFor('@frontierjs/litestone'),
  }
  if (useApi)  deps['@frontierjs/junction'] = specFor('@frontierjs/junction')
  if (useAuth) deps['@frontierjs/auth'] = specFor('@frontierjs/auth')
  if (useUI) {
    deps['@frontierjs/sierra'] = specFor('@frontierjs/sierra')
    deps['@frontierjs/mesa']   = specFor('@frontierjs/mesa')
    // web/src/main.js imports it — the styling language, not an optional extra.
    deps['@frontierjs/css']    = specFor('@frontierjs/css')
    // Every Resource and CRUD page `fli scaffold` and `fli admin:generate`
    // write imports the kit — the model's default form is `<Form {resource} />`
    // with no children, in the resource file — so an app without it gets pages
    // that cannot resolve their own imports.
    deps['@frontierjs/ui']     = specFor('@frontierjs/ui')
  }
  if (useExtension) {
    // jetty builds the extension and Mesa renders its surfaces. Both are the
    // APP's dependencies rather than the CLI's: `fli extension:build` runs the
    // installed jetty, and jetty's compiler lookup walks up from the surface to
    // find Mesa in the app's own node_modules.
    deps['@frontierjs/jetty'] = specFor('@frontierjs/jetty')
    deps['@frontierjs/mesa'] ??= specFor('@frontierjs/mesa')
  }
  for (const pkg of withPkgs) {
    const key = `@frontierjs/${pkg}`
    if (FJS_PACKAGES[key]) deps[key] = specFor(key)
  }

  // APP_DEV_DEPS is the tooling opinion — cli, the shared config, biome,
  // typescript. `link:` applies to the @frontierjs half of it for the same
  // reason it applies to the dependencies.
  const devDeps = {}
  for (const [key, spec] of Object.entries(APP_DEV_DEPS)) {
    devDeps[key] = key.startsWith('@frontierjs/') ? specFor(key) : spec
  }
  if (useUI) {
    devDeps['vite'] = VITE_VERSION
  }

  // Scripts. Each surface contributes its own pair and `dev`/`build` run
  // whichever ones exist — a surface an app does not have must not leave a
  // script that fails naming a directory nobody removed.
  const scripts = {}
  const devs   = []
  const builds = []

  if (useApi) {
    scripts['dev:api'] = 'bun --watch run api/index.ts'
    scripts['start']   = 'bun run api/index.ts'
    devs.push('dev:api')
  }
  if (useWeb) {
    scripts['dev:web']   = 'cd web && vite -c config/vite.config.js'
    scripts['build:web'] = 'cd web && vite build -c config/vite.config.js'
    devs.push('dev:web')
    builds.push('build:web')
  }
  if (useExtension) {
    Object.assign(scripts, extensionScripts())
    devs.push('dev:extension')
    builds.push('build:extension')
  }
  if (useWidgets) {
    // A widget is its own library build, one per file in widgets/src/Embeds/,
    // so this is `sierra widgets` and not `vite build`. `serve:widgets` answers
    // with the CORS and cache headers the deployment sends.
    Object.assign(scripts, widgetScripts())
    devs.push('dev:widgets')
    builds.push('build:widgets')
  }
  if (useSite) {
    // An ordinary Vite build that prerenders afterwards, so this IS `vite
    // build` — the difference is what closeBundle does with it.
    Object.assign(scripts, siteScripts())
    devs.push('dev:site')
    builds.push('build:site')
  }

  scripts['dev'] = devs.length > 1 ? `bun run --parallel ${devs.join(' ')}` : (scripts[devs[0]] ?? '')
  if (builds.length) scripts['build'] = builds.map(b => `bun run ${b}`).join(' && ')

  // The deploy container's entrypoint is `bun run db:migrate && bun run start`,
  // so this script is part of the contract with deploy/Dockerfile rather than a
  // convenience — without it the container exits non-zero on every start.
  // `--schema` also fixes the migrations directory: litestone resolves it as a
  // sibling of the schema, so this finds db/migrations without a second flag.
  scripts['db:migrate'] = 'bunx litestone migrate apply --schema db/schema.lite'
  scripts['db:backup']  = 'bunx litestone backup db/backups --schema db/schema.lite'

  // The schema's own TypeScript. Two files because they are two AUDIENCES and
  // the difference is what a caller may read: the API holds a system client and
  // sees `@guarded`/`@secret` columns, the browser never does, and one file for
  // both would tell browser code a column exists that every response strips.
  //
  // `--augment junction` is the half that crosses the wire — it writes the
  // module augmentation that types `client.service('leads')` as the row this
  // schema declares, which is otherwise the one place the seed stops
  // propagating (FJS-018). Only on the web file: the augmentation names
  // @frontierjs/junction/client, which is the browser's module.
  const dbTypes = ['bunx litestone types --schema db/schema.lite --audience system --out db/schema.d.ts']
  if (useWeb) dbTypes.push('bunx litestone types --schema db/schema.lite --audience client --augment junction --out web/src/db.d.ts')
  scripts['db:types'] = dbTypes.join(' && ')

  // lint · typecheck · check — see core/app-config.js for what each is for and
  // why `fli check` leads the third one.
  Object.assign(scripts, appCheckScripts())

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
    // Written by `fli deploy:vendor` before every build — a rewritten manifest
    // and the packed framework tarballs it points at. Regenerated per build, so
    // committing it commits a version of the framework nobody can read off a
    // spec.
    'deploy/generated/',
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
    'PORT=8100',
    'APP_URL=http://localhost:8100',
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

function makeReadme(spec) {
  const { name, useAuth, useWeb, useApi = true, useWidgets = false, useSite = false, useExtension = false, withPkgs } = spec
  const surface = [useApi && 'api/', useWeb && 'web/', useWidgets && 'widgets/', useSite && 'site/', useExtension && 'extension/'].filter(Boolean)
  const features = [
    `- ${useAuth ? 'Auth (sessions, password reset, email verify) via `@frontierjs/auth`' : 'No auth (add later with `fli auth:install`)'}`,
    `- Litestone client with gate plugin for level-based authorization`,
    `- ${useWeb ? 'Sierra + Mesa frontend with Vite' : 'No SPA'}`,
  ]
  if (useWidgets) features.push(
    `- Embeddable widgets in \`widgets/\` — one self-contained script per component, for pages this app does not own`)
  if (useSite) features.push(
    `- A public, prerendered site in \`site/\` — one HTML file per route, islands for what has to be current`)
  if (useExtension) features.push(
    `- A browser extension in \`extension/\` — MV3, Chrome and Firefox, built by \`@frontierjs/jetty\``)
  if (withPkgs.length) features.push(`- Additional packages: ${withPkgs.map(p => `\`@frontierjs/${p}\``).join(', ')}`)

  return `# ${name}

A FrontierJS application — ${surface.join(' + ')} over one \`db/schema.lite\`.

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

${[
  useApi     && 'the api on 8100',
  useWeb     && 'the web app on 8000',
  useWidgets && 'the widget surface on 8200',
  useExtension && 'the extension watcher on 8400',
].filter(Boolean).join(', ')} — ${surface.length > 1 ? 'concurrently' : 'in watch mode'}. The
ports are derived, not chosen: \`env*1000 + category*100 + project*10 + service\`.

Schema DDL runs automatically on first start — no migration step.

## Checking it

\`\`\`bash
bun run check     # fli check, then lint, then typecheck
\`\`\`

That is exactly what \`.github/workflows/ci.yml\` runs, so a green local run is a
green pipeline. The order matters: **\`fli check\` goes first because it is the
half a linter cannot reach** — Biome reads neither \`.mesa\` nor \`.lite\`, and a
model name that is not PascalCase singular or a \`vite.config.js\` without
\`strictPort\` is silent until it is expensive.

\`tsconfig.json\` and \`biome.json\` are each one line of \`extends\` over
\`@frontierjs/config\`, which is a dependency rather than a copy so that a rule
can improve without you re-scaffolding. **There is no formatter**, on purpose —
this house aligns columns and no formatter can express that; see that package's
README.

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
├── tsconfig.json               # one line of extends — @frontierjs/config
├── biome.json                  # ditto; linter only, no formatter
├── .editorconfig
├── README.md
├── .github/workflows/ci.yml    # runs \`bun run check\`
├── db/
│   └── schema.lite             # Single source of truth — data + auth
├── cli/
│   └── src/routes/             # Project-specific FLI commands
${useApi
  ? `├── deploy/
│   └── Dockerfile              # Built on the server
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
`
  : ''}${useWeb
  ? `└── web/
    ├── index.html
    ├── config/
    │   ├── vite.config.js      # Thin wrapper — createSierraViteConfig
    │   └── sierra.config.js    # Routes dir, target, junction url
    └── src/
        ├── main.js             # Entry: boots the router + client, mounts App
        ├── App.mesa            # Root: <RouterView />
        ├── routes/             # Sierra file-based routes (.mesa)
        └── resources/          # One Resource per model — Note.mesa (.mesa)
`
  : ''}${useWidgets
  ? `└── widgets/                    # A surface of its own — its own config,
    ├── config/                 #   host pages and static release
    │   ├── vite.config.js
    │   └── sierra.config.js    # target: 'widget'
    ├── index.html              # the dev harness
    ├── src/Embeds/             # one component per embeddable script
    ├── test/                   # a host page per widget
    ├── deploy/                 # serve.js + Dockerfile — the widget origin
    └── dist/embeds/            # the built scripts
`
  : ''}${useExtension
  ? `└── extension/                  # MV3, Chrome + Firefox — its own manifest,
    ├── config/                 #   permissions and store release
    │   └── jetty.config.js
    ├── src/
    │   ├── harbor/index.js     # the service worker — required
    │   ├── dock/App.mesa       # the popup
    │   └── islands/            # content scripts, flat
    ├── test/                   # what to load unpacked, and what to check by hand
    ├── deploy/                 # packaging for the two stores
    └── dist/chrome|firefox/
`
  : ''}\`\`\`

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

// `apiPrefix` is only set for the full-stack template, and it is the web half
// that needs it: the client talks to the page's own origin and the Vite dev
// proxy carries ONE rule, `/api`. With no prefix the services mount at
// /{service}, the proxy does not match, and the request falls through to Vite's
// SPA handler — 200 with an HTML body, which the client reports as the API
// answering nonsense. An api-only app has no proxy and no such need, so it takes
// Junction's own default: no prefix, routes at /.
function makeApiAppTs(useAuth, useWeb) {
  const prefixLine = useWeb ? `\n    apiPrefix: '/api',` : ''
  if (useAuth) {
    return `// api/src/app.ts
// The construction site — createApp + every plugin registration lives here.
// Read top-to-bottom for "how this app is wired."
//
// The default export is the configured but-not-yet-started app. The actual
// \`app.start()\` call lives in api/index.ts so that test code can import this
// file without binding a port.

import { createApp, requestLogger, correlationId, healthPlugin, manifestPlugin, channels } from '@frontierjs/junction'
import { auth, authPlugin, authCleanup } from './core/auth.ts'
import { withDb }           from './core/hooks.ts'
import { env }              from './core/env.ts'

const app = createApp({
  auth,
  config: {
    port: env.PORT,${prefixLine}
  },
})

// ─── Middleware ───────────────────────────────────────────────────────────
// CORS is declared in config/junction.config.js and installed from there — a
// second app.configure(cors(...)) here registers a SECOND wildcard OPTIONS
// route and patches the router's middleware twice, which is what this file
// used to do. Configure it by hand only when the app also uses csrf(), which
// has to come after it.
app.configure(correlationId())
app.configure(requestLogger())

// ─── Health ───────────────────────────────────────────────────────────────
// Serves {apiPrefix}/health and {apiPrefix}/metrics — app.get applies the
// prefix to every route alike, and Junction's default prefix is none, so this
// is /health unless the config above sets one. frontier.config.js points the
// deploy's health check at the same path and a deploy ROLLS BACK when it does
// not answer, so the two move together.
app.configure(healthPlugin())

// ─── Introspection ────────────────────────────────────────────────────────
// GET {apiPrefix}/manifest — services, hooks, channels, plugins, and every route the
// router will answer, read off live runtime state. fli api:routes reads it:
// the HTTP surface is emergent (services auto-mount, plugins register their
// own), so running the app is the only way to ask what it serves. devOnly by
// default — a production build 404s here.
app.configure(manifestPlugin())

// ─── Real-time ────────────────────────────────────────────────────────────
// Registers the /ws route. Without it the browser client has nothing to
// upgrade to: it falls back to HTTP, which works, and reports itself
// disconnected forever with no error anywhere.
app.configure(channels())

// ─── Auth routes ──────────────────────────────────────────────────────────
// Mounts {apiPrefix}/auth/register, /auth/login, /auth/logout and the
// rest — apiPrefix moves the plugin's routes with everything else.
app.configure(authPlugin)

// ─── Auth cleanup ─────────────────────────────────────────────────────────
// Expired sessions and verification tokens. In boot() rather than register(),
// which junction never awaits — and here rather than in core/auth.ts, because
// a module that starts a timer by being imported starts one in every test that
// imports it too.
app.configure({
  name: 'auth-cleanup',
  register() {},
  async boot() { authCleanup.start() },
  async shutdown() { authCleanup.stop() },
})

// ─── Per-request db scoping ──────────────────────────────────────────────
// withLitestoneDb attaches a request-scoped db client to ctx.locals.db.
// A SERVICE context has no ctx.params at all — that is raw-route only.
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

import { createApp, requestLogger, correlationId, healthPlugin, manifestPlugin, channels } from '@frontierjs/junction'
import { withDb }                                        from './core/hooks.ts'
import { env }                                           from './core/env.ts'

const app = createApp({
  config: {
    port: env.PORT,${prefixLine}
  },
})

// ─── Middleware ───────────────────────────────────────────────────────────
// CORS is declared in config/junction.config.js and installed from there — a
// second app.configure(cors(...)) here registers a SECOND wildcard OPTIONS
// route and patches the router's middleware twice, which is what this file
// used to do. Configure it by hand only when the app also uses csrf(), which
// has to come after it.
app.configure(correlationId())
app.configure(requestLogger())

// ─── Health ───────────────────────────────────────────────────────────────
// Serves {apiPrefix}/health and {apiPrefix}/metrics — Junction's default prefix
// is none, so /health unless the config above sets one. The deploy's health
// check reads the same path and rolls back when it does not answer.
app.configure(healthPlugin())

// ─── Introspection ────────────────────────────────────────────────────────
// GET {apiPrefix}/manifest — services, hooks, channels, plugins, and every route the
// router will answer, read off live runtime state. fli api:routes reads it:
// the HTTP surface is emergent (services auto-mount, plugins register their
// own), so running the app is the only way to ask what it serves. devOnly by
// default — a production build 404s here.
app.configure(manifestPlugin())

// ─── Real-time ────────────────────────────────────────────────────────────
// Registers the /ws route the browser client upgrades to.
app.configure(channels())

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

  // fli auth:install generates this into .env. Declared so defineEnv can see it
  // — the name is one of three it warns about for length and placeholder values
  // — and NOT required, because no code in @frontierjs/auth or junction reads it:
  // auth signs with encryptionKey. A required refusal over a value nothing uses
  // is a container that will not boot for no reason (FJS-360).

  // App
  PORT:     { type: 'port',   default: 8100 },
  APP_URL:  { type: 'url',    default: 'http://localhost:8100' },
  NODE_ENV: { type: 'string', default: 'development' },
})
`
}

function makeApiCoreDbTs() {
  return `// api/src/core/db.ts
// One Litestone client for the whole app. Gate plugin maps the
// SessionContext from auth into Litestone's level system:
//   no user           → STRANGER (0)
//   isAdmin standing  → ADMINISTRATOR (5)
//   anyone else       → USER (4)
//
// STANDING, not a role string: isAdmin / isOwner / isSystemAdmin are what
// Litestone's own resolver reads and what schema.lite's @@allow and field
// policies read, so a level and a policy cannot disagree about who an
// administrator is. What 'admin' MEANS is the app's decision, made once where
// the session is built (auth's sessionFields), not matched as a string here.
//
// Schema is loaded from disk; createClient runs the DDL automatically
// on first run. No separate apply() step needed for fresh DBs.

import { createClient, GatePlugin, LEVELS } from '@frontierjs/litestone'
import { env } from './env.ts'

const gate = new GatePlugin({
  async getLevel(user: unknown) {
    const u = user as { isAdmin?: boolean; isOwner?: boolean; isSystemAdmin?: boolean } | null
    if (!u)               return LEVELS.STRANGER
    if (u.isSystemAdmin)  return LEVELS.SYSADMIN
    if (u.isOwner)        return LEVELS.OWNER
    if (u.isAdmin)        return LEVELS.ADMINISTRATOR
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
// (ctx.locals.db = db.$setAuth(ctx.auth.user)) so policies + plugins see
// who's calling. createService reads ctx.locals.db automatically.
// A SERVICE context has no ctx.params — that is raw-route only, and reaching
// for it here reads undefined rather than failing.

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

import { createLitestoneAuth, createAuthPlugin, createAuthCleanupJobs } from '@frontierjs/auth'
import { db }   from './db.ts'
import { env }  from './env.ts'

export const auth = createLitestoneAuth(db, {
  encryptionKey:        env.ENCRYPTION_KEY,

  // The one place this app says what 'admin' MEANS, and it is load-bearing.
  // db.ts grades the gate on \`isAdmin\`, and schema.lite spends it three times —
  // \`@@gate("4.4.4.5")\` for who may delete a person, \`@@allow('update', … ||
  // auth().isAdmin)\` for whose row, \`@allow('write', auth().isAdmin)\` on role
  // and emailVerified. The User model ships a role STRING, which auth stores
  // and never interprets, so without this line \`isAdmin\` is never on the
  // session and all three are dead: an administrator grades USER(4), a delete
  // is a 403 nobody can clear, editing another person's row is a 404 because a
  // row policy that matches nothing hides it, and a write to role returns 200
  // with the field silently stripped.
  sessionFields: (user) => ({ isAdmin: user.role === 'admin' }),

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

// Expired sessions and verification tokens. app.ts starts these — nothing
// starts a timer by being imported, so a cleanup that is only constructed here
// is a table that grows for ever.
export const authCleanup = createAuthCleanupJobs(db)
`
}

function makeJunctionConfig(appName, useWeb) {
  const prefixLine = useWeb ? `\n    apiPrefix: '/api',` : ''
  return `// api/config/junction.config.js
// Loaded automatically by createApp() when called with no opts, or merged
// with opts.config when both are present. Tells Junction's autoloaders
// where to find services / jobs / conduit targets, and configures the
// built-in middleware.

export default {
  app: {
    name:      '${appName}',${prefixLine}
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

// ─── Databases ────────────────────────────────────────────────────────────
// Both blocks must exist before any model is added: auth's fragments name
// \`main\` and \`audit\` explicitly, and a model referencing an undeclared
// database fails the whole parse — the app dies at createClient, not later.
// Once \`database main\` is declared THIS PATH WINS and createClient's \`db:\`
// option is ignored entirely.

database main  { path env("DATABASE_URL", "./db/app.db") }

database audit { path "./db/audit/" driver logger retention 90d }

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
    <script type="module" src="/src/main.js">${sc}
  </body>
</html>
`
}

function makeViteConfig() {
  return `// web/config/vite.config.js
// Sierra produces the route table and the schema seed from sierra.config.js;
// the dev proxy is this file's job, because only the app knows where its own
// API listens.

import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

// sierra.config.js points the client at the page's own origin, so every one of
// these paths has to reach the API from here. Without the proxy they hit Vite's
// SPA fallback instead: 200, an HTML body, and a client that reports the API
// answered nonsense.
// FLI_PORT_BE is set by the port broker when the app is started through fli,
// which probes before it assigns; the literal is the static slot for project 0.
const API = process.env.API_URL || 'http://localhost:' + (process.env.FLI_PORT_BE ?? 8100)

const base = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...base,
  server: {
    // Spread, never replace: Sierra's own server block carries the HMR overlay
    // and the port. Its port default is 3000, which is nobody's slot in the
    // FJS scheme, so the web port is stated here rather than inherited.
    // 8000 = dev / frontend / project 0; the API is 8100. See ports.js.
    ...base.server,
    port:       parseInt(process.env.WEB_PORT ?? process.env.FLI_PORT_FE ?? '8000', 10),
    strictPort: true,
    proxy: {
      // One entry: apiPrefix moves every route the app registers, raw ones
      // and the auth plugin's included, so they are all under /api. /ws is
      // the socket, which is not a route.
      '/api':     { target: API, changeOrigin: true },
      '/ws':      { target: API, ws: true },
    },
  },
})
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
    // Vite loads this file in NODE to build its own config, where there is no
    // \`location\` — an unguarded reference here takes the dev server down before
    // it serves a byte. Same origin as the page; the client upgrades to ws
    // itself, so this stays http.
    url:      typeof location !== 'undefined' ? location.origin : 'http://localhost:8000',
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

function makeMainJs() {
  return `// web/src/main.js — the entry point index.html loads.
//
// A .mesa module EXPORTS a component; importing one mounts nothing. Without
// this file the page loads, throws no error, logs nothing, and renders an
// empty <div id="app"> — the hardest possible failure to read.

// Boots the router, the Junction client and — because db/schema.lite exists —
// registerSchemas(), all generated from sierra.config.js. Import it first: a
// route module that evaluates before the schemas are registered gets a bare
// make() with no field rules.
import 'virtual:sierra'

// The design system. One import, no build step, no config.
import '@frontierjs/css'

import { mount } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

// mount()'s first argument is an anchor NODE, not an element id — Mesa inserts
// the component immediately after it, so the anchor must already be in the tree.
const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, App, { root })
`
}

function makeRouteModule(appName, useAuth) {
  if (useAuth) {
    return `---
siteName: ${appName}
---
<script>
  import { goto, isActive, page } from '@frontierjs/sierra/router'
  import { status, session, signOut } from '@frontierjs/sierra/junction'

  // Naming a property in a $: line is what SUBSCRIBES this component to it.
  // Without it status.connected renders once, at its initial false, and never
  // updates — the socket connects and the page still says otherwise.
  $: (page.siteName, status.connected, session.user)

  // Awaited: signOut ends the session at the SERVER and then locally, and
  // navigating first would send the guard past a session that is still there.
  async function out() {
    await signOut()
    goto('/login/')
  }
${sc}

<div class="shell">
  <nav class="nav">
    <span class="brand">{page.siteName}</span>

    <div class="links">
      <a href="/" class:active={isActive('/')}>Home</a>
      <a href="/users/" class:active={isActive('/users/')}>Users</a>
    </div>

    <div class="status">
      <span class="dot" class:connected={status.connected}></span>
      <button on:click={out}>Sign out</button>
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
  import { status } from '@frontierjs/sierra/junction'

  // Naming a property in a $: line is what SUBSCRIBES this component to it.
  // Without it status.connected renders once, at its initial false, and never
  // updates — the socket connects and the page still says otherwise.
  $: (page.siteName, status.connected)
${sc}

<div class="shell">
  <nav class="nav">
    <span class="brand">{page.siteName}</span>

    <div class="links">
      <a href="/" class:active={isActive('/')}>Home</a>
    </div>

    <div class="status">
      <span class="dot" class:connected={status.connected}></span>
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
  import { status } from '@frontierjs/sierra/junction'

  // The $: line is the subscription — without it this renders once at the
  // initial false and never changes.
  $: status.connected

  // status.connected is the SOCKET, and the client opens one only once it holds
  // a token — so a signed-out visitor is correctly false and it says nothing
  // about whether the API is up. This page used to print that as
  // "connecting…" forever on a scaffold nobody had signed into yet, which is a
  // working app reporting itself broken on its own front page.
  // Same origin — web/config/vite.config.js proxies /api to the API in dev, and
  // a deployed build serves both from one host. '/api' is this app's apiPrefix,
  // set in web/config/sierra.config.js and api/config/default.ts together.
  const health = () => fetch('/api/health').then(r => {
    if (!r.ok) throw new Error('API answered ' + r.status)
    return r.json()
  })
${sc}

<h1>Welcome to ${appName}</h1>

{#await health()}
  <p>API: checking…</p>
{:then}
  <p>API: reachable ✓</p>
{:catch error}
  <p>API: unreachable — is <code>bun run dev:api</code> running? ({error.message})</p>
{/await}

<p>Socket: {status.connected ? 'open ✓' : 'opens when you sign in'}</p>
<p>Edit <code>web/src/routes/index.mesa</code> to start.</p>
`
}

function makeRouteLogin() {
  return `---
title: Sign in
---
<script>
  import { goto }      from '@frontierjs/sierra/router'
  import { signIn } from '@frontierjs/sierra/junction'

  let email    = ''
  let password = ''
  let error    = ''
  let loading  = false

  async function handleSubmit() {
    loading = true
    error   = ''
    try {
      // signIn does the whole thing: POST to the auth plugin's own login
      // route (the client composes apiPrefix + authPrefix, so no path is
      // written here), store the token, open the socket, and load the session
      // — so \`session.user\` is there on the next line.
      await signIn(email, password)
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
  // The RUNNING cli, never whatever `fli` is on PATH. A bare `fli` is a GLOBAL
  // install: it exists on the machine of anyone who has ever run `bun add -g`
  // and on no CI runner, in no container, and for nobody who reached this
  // command through `npm create frontier`. There it is `/bin/sh: 1: fli: not
  // found`, so `fli:init` and `auth:install` did not run and the scaffold came
  // out with no User model — an app that installs, builds, boots, answers health
  // and can register nobody (FJS-252, found on a runner).
  const cmd = [context.fli, ...args.map(a => JSON.stringify(a))].join(' ')
  context.exec({ command: cmd, cwd, stdio: 'inherit' })
}
</script>

Creates a brand-new FrontierJS project from scratch — Junction API, optional auth, optional Sierra/Mesa frontend, deploy-ready out of the box. Composes existing FLI commands (`auth:install`, `make:scaffold`, `make:deploy`, `fli:init`, `workspace:add`) so the output stays consistent with what those generators produce when run on existing projects.

The default install set is just `@frontierjs/junction`. Auth is asked about during execution unless `--auth` or `--no-auth` is passed. Use `--minimal` (junction only) or `--full` (all tier-1 packages) to skip prompts entirely. `--yes` accepts every prompt.

Templates: `full-stack` (default — api + web), `api-only` (no web/ folder),
`widgets-only`, `site-only` and `extension-only` (no api/, no web/ — the product
is that one surface, and what it talks to is somebody else's API). Add
`--widgets`, `--site` or `--extension` to any of them for that surface
alongside.

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
// `widgets-only` is a whole project: the product is the embeddable scripts, and
// there is no API of its own and no SPA. It is a template rather than a pile of
// --no- flags because that is the shape somebody asks for by name.
// A SURFACE-ONLY template is a project whose whole product is that one surface:
// no API of its own and no SPA, because what it talks to is somebody else's.
const surfaceOnly  = template === 'widgets-only' || template === 'extension-only' || template === 'site-only'
const useApi       = !surfaceOnly
const useWeb       = !surfaceOnly && (template === 'full-stack' || template === undefined) && flag.web !== false
const useWidgets   = template === 'widgets-only'   || flag.widgets === true
const useSite      = template === 'site-only'      || flag.site === true
const useExtension = template === 'extension-only' || flag.extension === true
const useDeploy = flag.deploy !== false
const useFli    = flag.fli !== false
const useGit    = flag.git !== false
const useInstall = flag.install !== false
const useWorkspace = flag.workspace === true
const skipPrompts = flag.yes === true || flag.minimal === true || flag.full === true || flag.dry === true

// Parse --with packages
const withInput = (flag.with || '').split(',').map(p => p.trim()).filter(Boolean)
const validExtras = ['conduit', 'caravan', 'notifications']

// `--with` names @frontierjs packages to add as dependencies, and litestream is
// not one — it is a Go binary that runs beside the app on the server, driven by
// `litestone replicate`. Listing it here put `@frontierjs/litestream` into
// FJS_PACKAGES and therefore into the manifest, so `--full` aborted under
// --source local (no packages/litestream) and 404'd at install under --source
// npm. Recognised by name rather than dropped, so the flag says where it went.
const notAPackage = {
  litestream: 'a server binary, not a dependency — see `litestone replicate` and `fli deploy:setup`',
}

const withPkgs = []
for (const pkg of withInput) {
  if (validExtras.includes(pkg)) withPkgs.push(pkg)
  else if (notAPackage[pkg]) log.warn(`"${pkg}" is ${notAPackage[pkg]} — nothing to add here.`)
  else log.warn(`Unknown package "${pkg}" — skipping. Valid: ${validExtras.join(', ')}`)
}
if (flag.full) {
  for (const p of validExtras) if (!withPkgs.includes(p)) withPkgs.push(p)
}

// ─── 4. Auth decision ─────────────────────────────────────────────────────────
// Three states: --auth (true), --no-auth (false), neither (prompt)

let useAuth
// Auth is a property of an API, and this template has none — the widgets talk
// to somebody else's. Asked first, so the prompt is not offered for a thing the
// scaffold would then have nowhere to install.
if (!useApi)             useAuth = false
else if (flag.auth === true)  useAuth = true
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

// ─── 6.5 FJS package source — npm (published) or local (symlink) ──────────────
// Default resolves from $FJS_SOURCE (set once during buildout), else 'npm'.
// GitHub is not supported yet.
//
// npm is the default because published packages are what a starting point
// should be made of, not because a local scaffold cannot ship. It could not, for
// a while: a `link:` spec resolves to the workspace on the machine that made it
// and to nothing inside a container, so `bun install` failed on every linked
// package and `fli deploy:local` — the command that proves an image before it
// reaches a server — could not be run against the scaffold this repo produced.
// That is how four defects sat undetected on the deploy path (FJS-232, 237, 238,
// 239 — all found by reading, none by anything failing). The deploy path now
// packs those packages into the build context instead (`fli deploy:vendor`,
// FJS-241), so a local scaffold containerises; what it still installs is one
// machine's working tree, which is the right thing while testing a change to a
// package and the wrong thing to hand somebody as a starting point.
const fjsSource = (flag.source || process.env.FJS_SOURCE || 'npm').toLowerCase()

if (fjsSource !== 'local' && fjsSource !== 'npm') {
  const hint = fjsSource === 'github'
    ? '--source github is not supported yet.'
    : `Unknown --source "${fjsSource}".`
  log.error(`${hint} Use local (symlink to your packages) or npm (published).`)
  return
}

// What this project will be given, decided once. `makePackageJson` is the one
// answer to that question and the manifest is written from it later.
const spec = { name: appName, scope: flag.scope, useAuth, useWeb, useApi, useWidgets, useSite, useExtension, withPkgs, source: fjsSource }

// The @frontierjs packages this project will actually depend on — READ OFF the
// manifest rather than listed again beside it. A `link:` spec for a package
// nobody linked fails the install outright, and the two lists had to agree by
// hand: adding `@frontierjs/ui` to the manifest and not here broke every
// `--source local` scaffold, install and all, with the error naming the vendor
// step three commands later. The dev half counts as much as the runtime half —
// `bun run check` is the first thing anyone runs.
const _manifest = makePackageJson(spec)
const _declared = JSON.parse(_manifest)
const neededPkgs = [
  ...Object.keys(_declared.dependencies ?? {}),
  ...Object.keys(_declared.devDependencies ?? {}),
].filter(n => n.startsWith('@frontierjs/'))

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
echo(`  FJS pkgs:  ${fjsSource === 'local' ? `local — symlink to ${packagesDir} (live edits; a build packs them)` : 'npm (published)'}`)
echo(`  Auth:      ${useAuth ? 'yes' : 'no'}`)
echo(`  Web:       ${useWeb ? 'yes (Sierra + Mesa + Vite)' : 'no'}`)
echo(`  Deploy:    ${useDeploy ? 'yes (deploy/Dockerfile + frontier.config.js)' : 'no'}`)
echo(`  FLI:       ${useFli ? 'yes (cli/src/routes/)' : 'no'}`)
echo(`  Example:   ${useExample ? 'yes (User CRUD vertical slice)' : 'no'}`)
echo(`  Git:       ${useGit ? 'yes' : 'no'}`)
echo(`  CI:        ${flag.ci !== false ? 'yes (.github/workflows/ci.yml → bun run check)' : 'no'}`)
echo(`  Tooling:   @frontierjs/config — tsconfig + Biome (linter only, no formatter)`)
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

const dirs = ['db']
if (useApi) dirs.push('api', 'api/config', 'api/src', 'api/src/core', 'api/src/services')
// cli/src/routes is fli:init's to write, and fli:init refuses a directory that
// already exists. Creating it here left the FLI surface an empty folder and a
// warning nobody reads.
if (useDeploy && useApi) dirs.push('deploy')
if (flag.ci !== false) dirs.push('.github/workflows')
if (useWeb) {
  dirs.push('web', 'web/config', 'web/src', 'web/src/routes', 'web/src/resources', 'web/src/components')
  if (useAuth) dirs.push('web/src/routes/login')
}

for (const d of dirs) {
  mkdirSync(resolve(finalTarget, d), { recursive: true })
}

// ─── 9. Write base files ──────────────────────────────────────────────────────

const filesToWrite = [
  ['package.json',                _manifest],
  ['.gitignore',                  makeGitignore()],
  ['.env.example',                makeEnvExample(useAuth)],
  ['.fli.json',                   makeFliJson(appName)],
  ['tsconfig.json',               appTsconfig({ useWeb, useSite, useWidgets, useExtension, useApi })],
  ['biome.json',                  appBiomeJson()],
  ['.editorconfig',               EDITORCONFIG],
  ['README.md',                   makeReadme(spec)],
  ['db/schema.lite',              makeSchemaLiteEmpty()],
]

if (useApi) {
  filesToWrite.push(
    ['api/index.ts',                makeApiIndexTs()],
    ['api/src/app.ts',              makeApiAppTs(useAuth, useWeb)],
    ['api/src/core/env.ts',         makeApiEnvTs()],
    ['api/src/core/db.ts',          makeApiCoreDbTs()],
    ['api/src/core/hooks.ts',       makeApiCoreHooksTs()],
    ['api/config/junction.config.js', makeJunctionConfig(appName, useWeb)],
  )
}

if (useAuth) {
  filesToWrite.push(['api/src/core/auth.ts', makeApiCoreAuthTs()])
}

if (useWeb) {
  filesToWrite.push(
    ['web/index.html',                      makeIndexHtml(appName)],
    ['web/config/vite.config.js',           makeViteConfig()],
    ['web/config/sierra.config.js',         makeSierraConfig(appName)],
    ['web/src/App.mesa',                    makeAppMesa()],
    ['web/src/main.js',                     makeMainJs()],
    ['web/src/routes/_module.mesa',         makeRouteModule(appName, useAuth)],
    ['web/src/routes/index.mesa',           makeRouteIndex(appName)],
  )
  if (useAuth) {
    filesToWrite.push(['web/src/routes/login/index.mesa', makeRouteLogin()])
  }
}

// The app's own gate, calling the script a person runs before pushing. Written
// whether or not --git ran: a repository is created later far more often than a
// workflow is added later.
if (flag.ci !== false) {
  filesToWrite.push(['.github/workflows/ci.yml', appWorkflow({ name: appName })])
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

// ─── 9b. The widgets/ surface ─────────────────────────────────────────────────
//
// Written by the same function `fli make:widget` calls, so the app can be
// extended by the command that adds the second widget. It is a sub-project of
// its own — its own Vite root, its own host pages, its own static release — and
// this project may have it and no web/ at all.

if (useWidgets) {
  const { written: widgetFiles } = scaffoldWidgetSurface({
    root: finalTarget, name: 'Hello', appName,
  })
  log.success(`Wrote ${widgetFiles.length} files in widgets/`)
}

// ─── 9c. The site/ surface ────────────────────────────────────────────────────
//
// Written by the same function `fli make:site` calls. `hasApi` decides whether
// its config declares a `db` to tap: with no API there is nothing to tap, and a
// `db:` pointing at a file that is not there is a build that fails before it
// says anything useful.

if (useSite) {
  const { written: siteFiles } = scaffoldSiteSurface({
    root: finalTarget, appName, hasApi: useApi,
  })
  log.success(`Wrote ${siteFiles.length} files in site/`)
}

if (useExtension) {
  const { written: extFiles } = scaffoldExtensionSurface({ root: finalTarget, appName })
  log.success(`Wrote ${extFiles.length} files in extension/`)
}

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
// It scaffolds `api/src/auth.ts`, which is NOT where this command puts it. The
// files above are written first, so auth:install finds the `api/src/core/auth.ts`
// this wrote and skips its own scaffold rather than laying a second
// createLitestoneAuth over a second client on the same file.
if (useAuth) {
  try {
    log.info('→ auth:install')
    runFli(context, ['auth:install'], finalTarget)
  } catch (e) {
    // Warning and continuing handed back an app that installs, builds, boots and
    // answers health, and then 500s on the first register with `"user" is not a
    // table in this schema` — auth:install is what puts the User model and the
    // three credential models into db/schema.lite, so a failure here means
    // --auth did not happen at all. It scrolled past inside a scaffold that
    // reported success, and the only place it was ever seen was a CI runner
    // (FJS-252). A scaffold that cannot sign anyone in is not a scaffold.
    log.error(`auth:install failed: ${e.message}`)
    log.error('  --auth did not happen — db/schema.lite has no User model and the app can register nobody.')
    throw e
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

// make:deploy — Dockerfile + frontier.config.js deploy block. It containerises
// the API, so a project with none has nothing for it to write: the widget
// surface ships its own static origin from widgets/deploy/.
if (useDeploy && useApi) {
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

// ─── 12b. The initial migration ───────────────────────────────────────────────
//
// The container's entrypoint is `bun run db:migrate && bun run start`, and
// `migrate apply` applies migration FILES. A scaffold that ships none applies
// nothing, exits ZERO, and starts a server over a database holding only
// litestone's own bookkeeping table — so the deploy is declared healthy and the
// first write answers `no such table: user`. Measured on both deploy sources.
//
// So the scaffold writes the first migration itself. `migrate create` needs no
// database (it diffs the schema against the applied set, which is empty here),
// which is why this can run at scaffold time at all.
//
// This does NOT close the gap for the SECOND deploy: every generator here tells
// a developer to run `fli db:push`, which writes tables and no migration file,
// so a model added after this point is missing from the image again. That is a
// framework question rather than a scaffold one — see ISSUES.md.

if (useInstall) {
  try {
    log.info('→ initial migration')
    context.exec({
      command: 'bunx litestone migrate create initial --schema db/schema.lite',
      cwd: finalTarget, stdio: 'pipe',
    })
  } catch (e) {
    // Not fatal: the app runs from `db push` in development either way, and a
    // scaffold that stops here over a deploy-time concern is the worse trade.
    log.warn(`could not write the initial migration: ${e.message}`)
    log.warn('run `bunx litestone migrate create initial --schema db/schema.lite` before deploying')
  }
}

// ─── 13. Summary ──────────────────────────────────────────────────────────────

echo('')
log.success(`✓ ${appName} created`)
echo('')
echo(`  cd ${useHere ? '.' : (useWorkspace ? finalTarget : name)}`)
if (!useInstall) echo('  bun install')
// `.env` is always written, and with --auth it comes back from auth:install with
// both keys generated — so the old unconditional `cp .env.example .env` told
// everyone to overwrite a filled file with a blank one, which breaks the app the
// scaffold just finished building. The question is whether the key has a VALUE,
// which is also the honest answer for --no-auth, where nothing fills it.
const envFile = resolve(finalTarget, '.env')
const keySet  = existsSync(envFile) &&
  /^[ \t]*ENCRYPTION_KEY[ \t]*=[ \t]*\S/m.test(readFileSync(envFile, 'utf8'))
if (!keySet) {
  echo('  fli keygen aes --name ENCRYPTION_KEY --env    # .env needs a key before the API starts')
}
echo('  bun run dev')
echo('')
if (fjsSource === 'local') {
  echo(`  @frontierjs packages are symlinked from ${packagesDir} — edits are live.`)
  echo('  A build packs them into the image rather than resolving the symlinks,')
  echo('  which a container cannot do — `fli deploy:local` runs the pack step for')
  echo('  you, `fli deploy:vendor` does it alone. What ships is that workspace at')
  echo('  the moment you built, so local sources can diverge from a real npm')
  echo('  install: do an npm run before publishing either way.')
  echo('')
}
echo('  Then:')
echo('    bun run check          fli check, then lint, then typecheck — the same gate CI runs')
echo('    fli scaffold <Model>    add a new model + service + resource + routes')
echo('    fli admin:generate      generate CRUD admin UI from schema.lite')
echo('    fli deploy:doctor       check deploy readiness')
echo('')
```