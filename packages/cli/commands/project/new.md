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
const { EDITORCONFIG, APP_DEV_DEPS, FJS_PACKAGES, appTsconfig, appBiomeJson, appCheckScripts, appWorkflow,
        appAgentsMd, appClaudeMd } =
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
    // The generated list page imports `encodeQueryString` and `directiveParams`
    // — the `$`-directive table and what a query string MEANS, which Invariant
    // 10 gives one owner. Declared here rather than leaned on transitively:
    // sierra and junction both depend on it, but bun installs into `.bun/` with
    // symlinks, so a package an app does not name is not resolvable BY NAME
    // from the app's own source. That is why the `scaffold` CI phase built
    // fine — it packs the tree — and a real `fli new` did not (`FJS-1045`).
    deps['@frontierjs/toolbelt'] = specFor('@frontierjs/toolbelt')
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

  // lint · typecheck · test · check — see core/app-config.js for what each is
  // for and why `fli check` leads. Tests only with auth, the one case that
  // writes api/test/access.test.ts.
  Object.assign(scripts, appCheckScripts({ tests: useApi && useAuth }))

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
    '# Where the audit trail is written. A logger-driver database is a',
    '# DIRECTORY of JSONL, and it is a variable for the same reason DATABASE_URL',
    '# is: a deploy mounts a volume, and a literal path here writes the trail',
    '# inside the container, where the next swap takes it.',
    'AUDIT_PATH=./db/audit/',
    '',
    '# App. PORT and APP_URL default to FLI_PORT_BE (the port the broker hands a',
    '# session, and the one web/ proxies /api to) and then to 8100. Set here, they',
    '# win over the broker, and the proxy forwards to a port the API is not on.',
    '# PORT=8100',
    '# APP_URL=http://localhost:8100',
    '# WEB_URL=http://localhost:8000   # the page a password-reset link opens',
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
    `- ${useAuth ? 'Auth via `@frontierjs/auth` — sign in, register, `/account/` (name, password, sessions) and `/reset/`. Reset and verification links print to the API terminal until a mailer is wired' : 'No auth (add later with `fli auth:install`)'}`,
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

# 2. Start
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

\`.env\` is already written and \`ENCRYPTION_KEY\` already has a value${useAuth ? '' : " — if it is\nblank, `fli keygen aes --format hex --name ENCRYPTION_KEY --env` fills it"}. Copying
\`.env.example\` over it blanks the key, and Litestone refuses to open with one.

${useAuth ? `
### The first account

Nobody exists yet, and the login page cannot sign in an empty \`user\` table.
Two doors:

\`\`\`bash
fli auth:create-user you@example.com --role admin
\`\`\`

or \`/register/\` in the browser, which signs the new account straight in.
Registration gives everybody role \`user\`; \`--role admin\` is the only way to
mint an ADMINISTRATOR, and \`db/schema.lite\` marks \`role\` \`@allow('write',
auth().isAdmin)\` so nobody promotes themselves on the way in.

### Email

There is no mailer yet, so nothing is sent. A password reset requested at
\`/reset/\` prints its link in the terminal running the API, and the link opens
\`/reset/?token=…\` on \`WEB_URL\`. Wire \`app.mail.send()\` into the two
callbacks in \`api/src/core/auth.ts\` to send them for real; set \`WEB_URL\` in
production so the link names the deployed site.
` : ''}

## Checking it

\`\`\`bash
bun run check     # fli check, then lint, then typecheck${useApi && useAuth ? ', then bun run test' : ''}
\`\`\`
${useApi && useAuth ? `
\`api/test/access.test.ts\` is the first test: who may read, edit, promote and
delete a \`User\`, asked of the real schema with the app's own resolver
(\`api/src/core/gate.ts\`). Every rule it grades lives in \`db/schema.lite\`, so
loosening one there is a red test rather than a quiet change.
` : ''}
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
├── AGENTS.md                   # for an AI agent writing code here — written by fli new
├── CLAUDE.md                   # this app's own agent notes; imports AGENTS.md
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
│   ├── src/
│   │   ├── app.ts              # createApp + plugin wiring
│   │   ├── core/
│   │   │   ├── env.ts          # Typed, validated env
│   │   │   ├── gate.ts         # Who a caller is, as a gate level
│   │   │   ├── db.ts           # Litestone client, graded by gate.ts
│   │   │   ├── channels.ts     # Who receives a broadcast
│   │   │   └── auth.ts         # createLitestoneAuth + plugin (if auth)
│   │   └── services/           # Service files autoloaded at boot
│   └── test/                   # access.test.ts (if auth)
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
- **Real-time:** already wired — \`api/src/core/channels.ts\` decides who listens, and joins every channel a service declares
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

import { createApp, channels } from '@frontierjs/junction'
import { auth, authPlugin, authCleanup } from './core/auth.ts'
import { joinChannels }     from './core/channels.ts'
import { db }               from './core/db.ts'
import { env }              from './core/env.ts'

// ─── The app ──────────────────────────────────────────────────────────────
// The db client is passed rather than wired, and it is not a convenience:
// handing it here installs the per-request scoping AND four things that have
// no other install site — the write announcement that reaches open tabs, the
// request context on every audit row, the audit metrics, and the query
// telemetry the devtools console reads. Scoping the client by hand instead
// gets the first of those and none of the rest, silently.
const app = createApp({
  auth,
  db,
  config: {
    port: env.PORT,${prefixLine}
  },
})

// ─── Real-time ────────────────────────────────────────────────────────────
// Registers the /ws route. Without it the browser client has nothing to
// upgrade to: it falls back to HTTP, which works, and reports itself
// disconnected forever with no error anywhere.
//
// The callback is the other half and is just as silent when it is missing: a
// service's \`channel:\` says where a write is announced, and until a
// connection JOINS that channel the announcement reaches nobody. core/channels.ts
// is where an app decides who listens to what.
app.configure(channels((a) => {
  a.channels!.on('connection', (session, conn) => joinChannels(a, session, conn))
}))

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

// Services in api/src/services/*.service.ts are autoloaded at boot
// (configured in api/config/junction.config.js).

export default app
`
  }

  return `// api/src/app.ts
// The construction site — createApp + every plugin registration lives here.

import { createApp, channels } from '@frontierjs/junction'
import { joinChannels }                                  from './core/channels.ts'
import { db }                                            from './core/db.ts'
import { env }                                           from './core/env.ts'

// ─── The app ──────────────────────────────────────────────────────────────
// The db client is passed rather than wired: handing it here installs the
// per-request scoping AND the write announcement, the audit request context,
// the audit metrics and the query telemetry, none of which has another install
// site. Scoping by hand gets the scoping alone, and says nothing.
const app = createApp({
  db,
  config: {
    port: env.PORT,${prefixLine}
  },
})

// ─── Real-time ────────────────────────────────────────────────────────────
// Registers the /ws route the browser client upgrades to. The callback is the
// half that is silent without it: a write is announced on the channel its
// service declares, and reaches nobody until a connection has joined one.
app.configure(channels((a) => {
  a.channels!.on('connection', (session, conn) => joinChannels(a, session, conn))
}))

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

  // The audit trail's directory. Declared for the same reason DATABASE_URL is:
  // a logger-driver database is a directory of JSONL on disk, and a deploy has
  // to be able to put it on the mounted volume without editing the schema.
  AUDIT_PATH: { type: 'string', default: './db/audit/' },

  // fli auth:install generates this into .env. Declared so defineEnv can see it
  // — the name is one of three it warns about for length and placeholder values
  // — and NOT required, because no code in @frontierjs/auth or junction reads it:
  // auth signs with encryptionKey. A required refusal over a value nothing uses
  // is a container that will not boot for no reason (FJS-360).

  // App. FLI_PORT_BE is the port the broker hands a session, and
  // web/config/vite.config.js proxies /api to it — a PORT that ignored it left
  // the proxy forwarding to a port nothing was listening on.
  PORT:     { type: 'port',   default: Number(process.env.FLI_PORT_BE ?? 8100) },
  APP_URL:  { type: 'url',    default: 'http://localhost:' + (process.env.FLI_PORT_BE ?? 8100) },
  // Where the web app is, for a link somebody is sent — a password reset lands
  // on a page, and the API's origin serves none. FLI_PORT_FE for the reason PORT
  // reads FLI_PORT_BE.
  WEB_URL:  { type: 'url',    default: 'http://localhost:' + (process.env.FLI_PORT_FE ?? 8000) },
  NODE_ENV: { type: 'string', default: 'development' },
})
`
}

function makeApiCoreGateTs() {
  return `// api/src/core/gate.ts
// Who a caller IS, as a level on Litestone's ladder — what every @@gate in
// db/schema.lite is compared against:
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
// Its own file so a test can install it without opening the app's database
// (api/test/access.test.ts), and so \`fli tinker --gate api/src/core/gate.ts\`
// can grade a console the way the API grades a request. Anything graded by a
// different resolver passes against a ladder the API does not run.

import { GatePlugin, LEVELS } from '@frontierjs/litestone'

export async function getLevel(user: unknown) {
  const u = user as { isAdmin?: boolean; isOwner?: boolean; isSystemAdmin?: boolean } | null
  if (!u)               return LEVELS.STRANGER
  if (u.isSystemAdmin)  return LEVELS.SYSADMIN
  if (u.isOwner)        return LEVELS.OWNER
  if (u.isAdmin)        return LEVELS.ADMINISTRATOR
  return LEVELS.USER
}

export const gate = new GatePlugin({ getLevel })
`
}

// Written only with auth: every assertion is about the User model auth:install
// appends, and the principals are the sessions auth's sessionFields builds.
function makeApiAccessTest() {
  return `// api/test/access.test.ts — who may do what to a User, asked of the real schema.
//
// Every rule under test is declared in db/schema.lite, not in a service: @@gate
// sets the level each operation needs, @@allow narrows an update to your own
// row, and @allow('write', auth().isAdmin) guards the role column. The resolver
// is the app's own (api/src/core/gate.ts), so this grades the ladder the API
// runs rather than a copy of it.
//
// Each refusal sits beside a caller who IS allowed the same thing. A schema that
// refused everybody would pass every refusal on its own.

import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createTestEnv } from '@frontierjs/litestone/testing'
import { gate } from '../src/core/gate.ts'

const schema = fileURLToPath(new URL('../../db/schema.lite', import.meta.url))

// A fresh database built from the schema — never db/app.db. It is thrown away
// with the run, so it takes a throwaway key rather than .env's, which CI does
// not have: the file is gitignored.
const env = await createTestEnv({
  schema,
  plugins:       [gate],
  encryptionKey: randomBytes(32).toString('hex'),
  autoFactories: true,
})
afterAll(() => env.close())

// Fixtures are written below the boundary, so a gate refusing the caller under
// test cannot refuse the setup. ONE factory for the file: asSystem() returns a
// copy, and each fresh copy restarts the sequence that keeps emails unique.
const users = env.factories.user.asSystem()

// TestEnv is not generic over the schema, so its tables are typed unknown.
const system   = env.system as any
const actingAs = (principal: unknown) => env.actingAs(principal) as any

// A principal is the SESSION the API builds, not a row: auth's sessionFields
// turns role "admin" into isAdmin at sign-in, and gate.ts reads isAdmin.
const admin = { id: 'admin', isAdmin: true }

test('every @@gate answers the way the schema declares it', async () => {
  expect(await env.verifyGateLadder()).toEqual([])
})

describe('User', () => {
  test('a stranger cannot list users, and a signed-in user can', async () => {
    const me = await users.createOne()

    await expect(actingAs(null).user.findMany()).rejects.toThrow('requires level 4')
    expect(await actingAs({ id: me.id }).user.findMany()).not.toHaveLength(0)
  })

  test('a user can rename themselves, and cannot promote themselves', async () => {
    const me = await users.createOne({ role: 'user' })

    await actingAs({ id: me.id }).user.update({
      where: { id: me.id },
      data:  { name: 'Renamed', role: 'admin' },
    })

    // The field policy declines in silence: no error, the column unchanged.
    const row = await system.user.findFirst({ where: { id: me.id } })
    expect(row?.name).toBe('Renamed')
    expect(row?.role).toBe('user')
  })

  test('an admin can promote somebody', async () => {
    const person = await users.createOne({ role: 'user' })

    await actingAs(admin).user.update({ where: { id: person.id }, data: { role: 'admin' } })

    const row = await system.user.findFirst({ where: { id: person.id } })
    expect(row?.role).toBe('admin')
  })

  test("a user cannot edit somebody else's row, and an admin can", async () => {
    const me    = await users.createOne()
    const other = await users.createOne({ name: 'Other' })

    // The row policy filters the row out before the write, so the answer is
    // null rather than an error.
    const refused = await actingAs({ id: me.id }).user.update({
      where: { id: other.id },
      data:  { name: 'Hijacked' },
    })
    expect(refused).toBeNull()
    expect((await system.user.findFirst({ where: { id: other.id } }))?.name).toBe('Other')

    await actingAs(admin).user.update({ where: { id: other.id }, data: { name: 'Edited' } })
    expect((await system.user.findFirst({ where: { id: other.id } }))?.name).toBe('Edited')
  })

  test('deleting a user takes an administrator', async () => {
    const me    = await users.createOne()
    const other = await users.createOne()

    await expect(
      actingAs({ id: me.id }).user.delete({ where: { id: other.id } }),
    ).rejects.toThrow('requires level 5')

    await actingAs(admin).user.delete({ where: { id: other.id } })
    expect(await system.user.findFirst({ where: { id: other.id } })).toBeNull()
  })
})
`
}

function makeApiCoreDbTs() {
  return `// api/src/core/db.ts
// One Litestone client for the whole app, graded by the resolver in gate.ts.
//
// Schema is loaded from disk; createClient runs the DDL automatically
// on first run. No separate apply() step needed for fresh DBs.

import { fileURLToPath } from 'node:url'

import { createClient } from '@frontierjs/litestone'
import { env }  from './env.ts'
import { gate } from './gate.ts'

// Anchored to THIS FILE, never to the working directory. Not every command that
// imports this module runs from the app root — a \`site/\` build runs from its own
// surface — and both halves of getting that wrong are quiet: a schema path that
// resolves nowhere is a client that cannot open, and a DATABASE path that
// resolves nowhere is a NEW, EMPTY database, which prerenders a page with no
// rows in it and exits 0.
//
// \`resolveFrom: 'schema'\` then anchors env.DATABASE_URL to the app root as well,
// since that is the directory above the schema's own.
const schemaPath = fileURLToPath(new URL('../../../db/schema.lite', import.meta.url))

// No \`db:\` here on purpose. That option is an OVERRIDE and is resolved against
// the process — \`database main\` in the seed already declares
// \`env("DATABASE_URL", "./db/app.db")\`, which is the same variable, anchored to
// the app root by \`resolveFrom\` above. Passing it here would put the database
// wherever the command was typed from.
export const db = await createClient({
  // \`path:\`, not \`schema:\`. A path under \`schema:\` is read as one, but the two
  // keys mean different things — a schema STRING has no directory, so a relative
  // \`import\` in it resolves against nothing and is dropped — and no tool can tell
  // which was meant from the outside: \`fli check\`'s \`schema-in-memory\` fires on
  // the key, because that is all a source reader can see.
  path:          schemaPath,
  resolveFrom:   'schema',
  encryptionKey: env.ENCRYPTION_KEY,
  plugins:       [gate],
})
`
}

function makeApiCoreChannelsTs(useAuth) {
  const notify = useAuth
    ? `
  // The in-app notification channel for one person. \`@frontierjs/notifications\`
  // owns this spelling; an anonymous connection has none to join, which is the
  // only reason this is not "join everything".
  const who    = (session ?? {}) as Session
  const userId = who.userId ?? who.id
  if (userId) app.channel!(\`notifications:user:\${userId}\`).join(conn as never)
`
    : ''

  // A parameter nothing reads is a type error under the tsconfig this scaffold
  // ships, so the no-auth variant takes `_session` and declares no shape for it.
  const sessionArg  = useAuth ? 'session' : '_session'
  const sessionType = useAuth
    ? `/** A session as this app can read one. Junction hands the handler \`unknown\`,
 *  because what a session IS belongs to whichever auth provider issued it —
 *  auth's own shape puts the id at \`userId\`, a hand-built principal puts it at
 *  \`id\`, so both are read here and the wrong one is undefined, which joins
 *  nothing and says nothing. */
type Session = { userId?: string; id?: string }
`
    : ''

  return `// api/src/core/channels.ts — who receives a broadcast.
//
// A service declares \`channel: 'notes'\` and Junction publishes every write on
// it. Nothing is delivered until a CONNECTION has joined that channel, and
// joining is this file's decision — the one an app makes and the framework
// cannot.
//
// It exists because a channel nobody joined broadcasts into NOTHING. No error,
// no log, no dropped frame: the publish succeeds, reaches an empty set, and the
// symptom is a screen that never updates.
//
// Joining is a subscription and not a permission. A broadcast is not a SELECT,
// so an \`@@allow\` — which compiles into a WHERE — could not reach one; junction
// grades every frame per recipient at the Data boundary now, and shapes it. So
// what is below is a list of what each connection LISTENS to, never of what it
// may read, and a channel joined by somebody entitled to nothing delivers
// nothing to them.
//
// Which is why the default is every channel a service declares: \`fli scaffold\`
// writes \`channel:\` into each service it generates, and a list repeated here
// by hand goes stale the first time you add a model. Narrow it when a channel
// is genuinely nobody's business until they ask for it.

import type { App } from '@frontierjs/junction'

${sessionType}
/** Everything one connection listens to. Called once, on connection. */
export function joinChannels(app: App, ${sessionArg}: unknown, conn: unknown): void {
  for (const service of app.services.values()) {
    // Only the string form. A function \`channel:\` computes its target per
    // publish, so there is no name here to join ahead of time — an app using
    // one names the channels it wants below, by hand.
    const declared = (service as { channel?: unknown }).channel
    if (typeof declared === 'string') app.channel!(declared).join(conn as never)
  }
${notify}}
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
  // gate.ts grades the gate on \`isAdmin\`, and schema.lite spends it three times —
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

  // Neither sends anything yet: there is no mailer, so the link is printed to
  // this terminal instead, where you can click it. Both routes answer the same
  // whether or not the address has an account — they must never reveal who is
  // registered — so this log is the only place a reset is visible at all.
  // Wire app.mail.send() in here once the app has a mailer.
  onPasswordResetRequested: async (email, token) => {
    // WEB_URL, not APP_URL: the link lands on web/src/routes/reset/, and the
    // API's own origin has no page to answer it.
    const link = \`\${env.WEB_URL}/reset/?token=\${encodeURIComponent(token)}\`
    console.log(\`[auth] password reset for \${email} — no mailer, so here is the link:\\n  \${link}\`)
  },
  onEmailVerificationRequested: async (email, token) => {
    const link = \`\${env.APP_URL}/api/auth/email/verify?token=\${encodeURIComponent(token)}\`
    console.log(\`[auth] verify \${email} — no mailer, so here is the link:\\n  \${link}\`)
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
    // A scaffolded app authenticates with a BEARER token, so it never needs a
    // credentialed request and \`*\` is an ordinary local-development
    // convenience. Turning on \`cookieAuth\` means a cookie, and a cookie means
    // naming the origins that may hold a session: junction refuses \`*\` beside
    // \`credentials: true\` at construction, because the browser refuses the
    // literal \`*\` next to Access-Control-Allow-Credentials and the middleware
    // would otherwise reflect whatever Origin arrived.
    cors:          { origins: ['*'], credentials: false },
    helmet:        true,
    requestLogger: true,
    correlationId: true,
  },

  // Junction's own plugins, and the middleware above: DECLARED here, installed
  // by Junction at start(). Nothing about either is written in api/src/app.ts.
  //
  // What decides the section is what the option takes — data is declared, code
  // is constructed. A plugin needing a function (health's own readiness checks,
  // a custom auth guard) is configured by hand in app.ts instead and is then
  // left OUT of this file, because declaring it in both places is two owners
  // for one route and start() refuses it by name.
  //
  // health serves /health and /metrics; frontier.config.js points the deploy's
  // health check at the same path and a deploy ROLLS BACK when it does not
  // answer, so the two move together. manifest serves /manifest, which
  // fli api:routes reads: the HTTP surface is emergent, so running the app is
  // the only way to ask what it serves. It is devOnly, so a production build
  // 404s there.
  plugins: {
    health:   true,
    manifest: true,
  },

  // Third-party services this app needs and does not own — an n8n, a mail
  // server, a search cluster. Declared here, BOUND per environment as ordinary
  // variables, and the app refuses to start if one is missing or bound halfway.
  // Setting optional: true forgives a service nobody bound; it never forgives
  // one bound halfway, because that is the shape that reaches production.
  //
  // attachments: {
  //   n8n: {
  //     describe: 'workflow automation',
  //     env: {
  //       N8N_URL:     { required: true, type: 'url' },
  //       N8N_API_KEY: { required: true },
  //     },
  //   },
  // },
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
// This path is the app's. createClient's \`db:\` option OVERRIDES it and is
// resolved against the working directory, so api/src/core/db.ts passes none.

database main  { path env("DATABASE_URL", "./db/app.db") }

database audit { path env("AUDIT_PATH", "./db/audit/") driver logger retention 90d }

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
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
  </head>
  <!-- class="app" is what gives the page @frontierjs/css's font and ground; the
       package has no bare body rule, so without it text outside a component
       falls back to the browser's serif. -->
  <body class="app">
    <div id="app"></div>
    <script type="module" src="/src/main.js">${sc}
  </body>
</html>
`
}

// What makes the built app one a browser offers to install, and the build
// grades it: `sierra` prints `manifest.webmanifest — installable` or names
// the rule a change broke, since an install button that stops appearing says
// so nowhere else. An SVG counts as an icon of any size.
function makeWebManifest(appName) {
  return `${JSON.stringify({
    name:             appName,
    short_name:       appName,
    start_url:        '/',
    display:          'standalone',
    background_color: '#ffffff',
    icons:            [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  }, null, 2)}
`
}

function makeIconSvg(appName) {
  const letter = (appName.replace(/[^a-z0-9]/gi, '')[0] ?? 'a').toUpperCase()
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#2b4c7e"/>
  <text x="32" y="44" font-family="system-ui, sans-serif" font-size="34" font-weight="700" fill="#ffffff" text-anchor="middle">${letter}</text>
</svg>
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

  // Two of @frontierjs/css's themes, following the OS until somebody presses the
  // switch in the topbar. Sierra writes the class on <html> from a <head> script,
  // before first paint — anything the app ran itself would flash the default
  // first. Add any other theme-* class the package ships to the list and the
  // switch cycles through it. The key is per app because every scaffold serves
  // on localhost:8000, and one origin is one localStorage.
  theme: {
    themes:  ['theme-default', 'theme-dark'],
    default: 'system',
    key:     '${appName}_theme',
  },

  junction: {
    // Where the API is. Unset, it is the page's own origin, which is right while
    // Vite or nginx proxies /api to it. An API on its own origin
    // (api.example.com beside app.example.com) or a build a native shell bundles
    // has no proxy in front of it, so the build names it:
    //   VITE_API_URL=https://api.example.com bun run build
    // Vite inlines the value at build time and loads this file in NODE too,
    // where there is neither \`import.meta.env\` nor \`location\` — an unguarded
    // reference to either takes the dev server down before it serves a byte.
    // The client upgrades to ws itself, so this stays http.
    url:      import.meta.env?.VITE_API_URL ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost:8000'),
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
  import { theme, toggleTheme } from '@frontierjs/sierra/theme'

  // Naming a property in a $: line is what SUBSCRIBES this component to it.
  // Without it status.connected renders once, at its initial false, and never
  // updates — the socket connects and the page still says otherwise.
  //
  // session.checked is here for the same reason and answers a different
  // question: the boot restore is asynchronous, so on a cold load session.user
  // is null for a caller who IS signed in. Rendering the signed-out nav until
  // it settles is the redirect flash one layer up.
  $: (page.siteName, page.route, status.connected, session.user, session.checked, theme.value)

  // Awaited: signOut ends the session at the SERVER and then locally, and
  // navigating first would send the guard past a session that is still there.
  async function out() {
    await signOut()
    goto('/login/')
  }
${sc}

<!--
  Every class here is @frontierjs/css, imported once in main.js, so there is no
  <style> block: a color written here is one a theme cannot reach.

  The current page is aria-current="page" rather than a class — the stylesheet
  keys off the attribute, and Mesa drops one whose value is null. The leading
  page.route read in each expression is what makes it move: Mesa takes an
  expression's dependencies from its own text, and isActive() reads the route
  where this file cannot see it.
-->
<div class="shell">
  <header class="topbar">
    <nav class="group" aria-label="Main">
      <strong>{page.siteName}</strong>
      <a class="navlink" href="/" aria-current={(page.route, isActive('/', { exact: true })) ? 'page' : null}>Home</a>
      <!-- User reads at gate level 4 in db/schema.lite, so this link cannot
           work for a stranger. A nav that offers one that always answers
           "Authentication required" is a working app reporting itself broken. -->
      {#if session.user}
        <a class="navlink" href="/users/" aria-current={(page.route, isActive('/users/')) ? 'page' : null}>Users</a>
      {/if}
    </nav>

    <div class="group">
      <span class="badge" class:success={status.connected} class:muted={!status.connected}>
        {status.connected ? 'live' : 'offline'}
      </span>
      <button class="btn ghost square" on:click={toggleTheme}
              aria-label={theme.value === 'theme-dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
        {theme.value === 'theme-dark' ? '☀' : '☾'}
      </button>
      {#if !session.checked}
        <span class="text-muted">…</span>
      {:else if session.user}
        <a class="navlink" href="/account/" aria-current={(page.route, isActive('/account/')) ? 'page' : null}>{session.user.email}</a>
        <button class="btn ghost" on:click={out}>Sign out</button>
      {:else}
        <a class="btn primary" href="/login/">Sign in</a>
      {/if}
    </div>
  </header>

  <main class="screen">
    <div class="container">
      <slot />
    </div>
  </main>
</div>
`
  }

  return `---
siteName: ${appName}
---
<script>
  import { isActive, page } from '@frontierjs/sierra/router'
  import { status } from '@frontierjs/sierra/junction'
  import { theme, toggleTheme } from '@frontierjs/sierra/theme'

  // Naming a property in a $: line is what SUBSCRIBES this component to it.
  // Without it status.connected renders once, at its initial false, and never
  // updates — the socket connects and the page still says otherwise.
  $: (page.siteName, page.route, status.connected, theme.value)
${sc}

<!--
  Every class here is @frontierjs/css, imported once in main.js, so there is no
  <style> block: a color written here is one a theme cannot reach. The leading
  page.route read is what makes aria-current move — Mesa takes an expression's
  dependencies from its own text, and isActive() reads the route out of sight.
-->
<div class="shell">
  <header class="topbar">
    <nav class="group" aria-label="Main">
      <strong>{page.siteName}</strong>
      <a class="navlink" href="/" aria-current={(page.route, isActive('/', { exact: true })) ? 'page' : null}>Home</a>
    </nav>

    <div class="group">
      <span class="badge" class:success={status.connected} class:muted={!status.connected}>
        {status.connected ? 'live' : 'offline'}
      </span>
      <button class="btn ghost square" on:click={toggleTheme}
              aria-label={theme.value === 'theme-dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
        {theme.value === 'theme-dark' ? '☀' : '☾'}
      </button>
    </div>
  </header>

  <main class="screen">
    <div class="container">
      <slot />
    </div>
  </main>
</div>
`
}

// The catch-all. Without it an unknown URL renders the layout around nothing,
// which reads as a page that failed to load rather than one that does not exist.
function makeRouteNotFound() {
  return `---
title: Not found
---
<script>
  import { page } from '@frontierjs/sierra/router'

  // [...404] is the catch-all: Sierra matches it only after every other route
  // has declined, and puts the unmatched path under params['404'].
  $: page.params
${sc}

<div class="empty">
  <div class="empty-icon" aria-hidden="true">🧭</div>
  <div class="empty-title">Nothing lives at <code>/{page.params['404']}</code></div>
  <div class="empty-text">The link may be old, or the address mistyped.</div>
  <div class="empty-actions">
    <a class="btn primary" href="/">Go home</a>
  </div>
</div>
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
  // One request read by two blocks: the badge, and the sentence under it that
  // only a failure needs.
  const health = fetch('/api/health').then(r => {
    if (!r.ok) throw new Error('API answered ' + r.status)
    return r.json()
  })

  // ─── the tour ──────────────────────────────────────────────────────
  // Everything from here down is a worked example of the language this file
  // is written in, placed so it can be read beside what it renders. Delete it
  // when you write your own home page; nothing else imports any of it.

  let count = 0
  let name  = ''

  // A $: line re-runs when anything it READ changes. Nothing is declared as a
  // dependency, and nothing has to be.
  $: greeting = name ? 'Hello, ' + name : 'Hello'

  const realms = [
    { noun: 'Model',    realm: 'Data', where: 'db/schema.lite' },
    { noun: 'Service',  realm: 'API',  where: 'api/src/services/' },
    { noun: 'Resource', realm: 'UI',   where: 'web/src/resources/' },
  ]
${sc}

<!--
  Every class on this page is a word from @frontierjs/css — what a thing IS
  (card, badge, btn) and what is true about it (primary, success, muted). The
  <style> block at the bottom holds one grid and no color, because a color
  written here is one no theme can reach.
-->
<header class="stack gap-sm">
  <h1>Welcome to ${appName}</h1>
  <p class="text-lg text-muted">
    This page is <code>web/src/routes/index.mesa</code>, and the tour below is
    running rather than quoted — every point does the thing it describes.
  </p>

  <div class="cluster">
    {#await health}
      <span class="badge muted">API · checking</span>
    {:then}
      <span class="badge success">API · reachable</span>
    {:catch}
      <span class="badge danger">API · unreachable</span>
    {/await}
    <span class="badge" class:success={status.connected} class:muted={!status.connected}>
      Socket · {status.connected ? 'open' : 'opens when you sign in'}
    </span>
  </div>

  {#await health}{:then}{:catch error}
    <div class="alert danger" role="alert">
      <div class="alert-content">
        Is <code>bun run dev:api</code> running? ({error.message})
      </div>
    </div>
  {/await}
</header>

<section class="tour stack gap-md">
  <h2>Mesa in a minute</h2>

  <div class="grid">
    <article class="card stack gap-sm">
      <h3>1 · State is a variable</h3>
      <p>No store, no hook, no setter. Assign to it, and the markup that read it
         is what updates.</p>
      <div class="cluster">
        <button class="btn primary" on:click={() => count++}>Press me</button>
        <span class="pill" class:muted={count === 0} class:success={count > 0}>pressed {count} times</span>
      </div>
    </article>

    <article class="card stack gap-sm">
      <h3>2 · A <code>$:</code> line re-runs when what it read changes</h3>
      <p>The subscription is the line itself — there is no dependency array to
         keep in step with the body.</p>
      <input class="field" bind:value={name} placeholder="your name" aria-label="your name" />
      <p class="text-lg">{greeting}</p>
    </article>

    <article class="card stack gap-sm">
      <h3>3 · Blocks are markup</h3>
      <p><code>&#123;#each&#125;</code> and <code>&#123;#if&#125;</code> are
         compiled to DOM operations rather than re-run as functions. Both are
         below, over the three nouns this framework has.</p>
      <dl class="facts divided">
        {#each realms as r}
          <dt>{r.noun}</dt>
          <dd>the {r.realm} realm, in <code>{r.where}</code></dd>
        {/each}
      </dl>
      {#if count > 2}
        <p class="text-sm text-muted">…and the button in card 1 has been pressed {count} times.</p>
      {/if}
    </article>

    <article class="card stack gap-sm">
      <h3>4 · Styles are scoped to the file</h3>
      <p>The <code>&lt;style&gt;</code> block at the bottom cannot leak out of
         this component, and cannot reach into a child one. To cross that line
         you write <code>:global(…)</code>, which is a thing you can grep for.</p>
    </article>

    <article class="card stack gap-sm">
      <h3>5 · Everything the runtime offers is on <code>$</code></h3>
      <p><code>$.onMount</code>, <code>$.emit</code>, <code>$.tick</code>. Five
         members keep a bare spelling because they are read as a bag in the
         middle of markup: <code>$props</code>, <code>$attributes</code>,
         <code>$slots</code>, <code>$context</code>, <code>$async</code>.</p>
    </article>
  </div>
</section>

<section class="next stack gap-md">
  <h2>Where to go next</h2>
  <ol class="steps vertical">
    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><code>db/schema.lite</code></span>
      <span class="step-hint">The seed. Models, gates and policies; the API and
        these screens are derived from it.</span>
    </li>
    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><code>fli scaffold Note --fields "title:string body:text"</code></span>
      <span class="step-hint">One command, a stanza in the seed and a working screen.</span>
    </li>
    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><code>fli tutor:access</code></span>
      <span class="step-hint">The next lesson: a gate and a row policy, watched
        refusing somebody.</span>
    </li>
    <li class="step">
      <span class="step-marker"></span>
      <span class="step-label"><a class="link" href="https://github.com/frontierjs/frontierjs">github.com/frontierjs/frontierjs</a></span>
      <span class="step-hint">Mesa's reference is <code>packages/mesa/docs/</code>,
        the schema language is <code>packages/litestone/docs/</code>.</span>
    </li>
  </ol>
</section>

<style>
  .tour, .next { margin-top: var(--space-3xl) }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    gap: var(--space-lg);
  }
  h3 { margin: 0 }
  p  { margin: 0 }
</style>
`
}

function makeRouteLogin() {
  return `---
title: Sign in
---
<script>
  import { goto }                                    from '@frontierjs/sierra/router'
  import { session, signIn, submitCode, signOut }    from '@frontierjs/sierra/junction'

  let email    = ''
  let password = ''
  let code     = ''
  let error    = ''
  let loading  = false

  // A password is not always the whole answer. An account with two-step
  // sign-in turned on answers a CHALLENGE: nothing is stored, nobody is signed
  // in, and \`session.awaitingCode\` holds when the attempt lapses. The code box
  // below renders from it — without that branch this page sent a person with a
  // second factor to / signed out, with nothing on screen saying why.
  $: session.awaitingCode

  async function handleSubmit() {
    loading = true
    error   = ''
    try {
      // signIn does the whole thing: POST to the auth plugin's own login
      // route (the client composes apiPrefix + authPrefix, so no path is
      // written here), store the token, open the socket, and load the session
      // — so \`session.user\` is there on the next line, unless a code is owed.
      await signIn(email, password)
      password = ''
      if (session.user) goto('/')
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function handleCode() {
    loading = true
    error   = ''
    try {
      // The ticket is the client's; this sends the code. A refusal that ends
      // the attempt clears \`session.awaitingCode\`, which puts the password
      // form back.
      await submitCode(code.trim())
      code = ''
      goto('/')
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function startOver() {
    await signOut()
    code = ''; error = ''
  }
${sc}

<div class="auth-card card stack gap-md">
  <h1 class="text-xl">Sign in</h1>

  {#if error}
    <div class="alert danger" role="alert"><div class="alert-content">{error}</div></div>
  {/if}

  {#if session.awaitingCode}
    <p class="text-sm text-muted">Enter the code from your authenticator app, or one of your recovery codes.</p>
    <input class="field" bind:value={code} autocomplete="one-time-code" inputmode="numeric" placeholder="123456" aria-label="Code" />
    <button class="btn primary" on:click={handleCode} disabled={loading}>
      {loading ? 'Checking…' : 'Verify'}
    </button>
    <button class="btn ghost" on:click={startOver} disabled={loading}>Start over</button>
  {:else}
    <input class="field" bind:value={email}    type="email"    placeholder="Email"    aria-label="Email" />
    <input class="field" bind:value={password} type="password" placeholder="Password" aria-label="Password" />
    <button class="btn primary" on:click={handleSubmit} disabled={loading}>
      {loading ? 'Signing in…' : 'Sign in'}
    </button>

    <p class="text-sm text-muted">
      <a class="link" href="/reset/">Forgot your password?</a> · No account? <a class="link" href="/register/">Create one</a>
    </p>
  {/if}

  <!-- A fresh app has no rows in \`user\`, so the first person to open this
       page cannot sign in and there is nothing on screen saying why. The other
       door is the CLI, which is also the only way to mint an ADMIN — register
       gives everybody role "user", and db/schema.lite gates delete at 5. -->
  {#if import.meta.env.DEV}
    <div class="alert info">
      <div class="alert-content text-sm">
        First run? No user exists yet. Either register above, or from the app root:
        <code>fli auth:create-user you@example.com --role admin</code>
      </div>
    </div>
  {/if}
</div>

<style>
  .auth-card { max-width: 24rem; margin: var(--space-3xl) auto }
  h1, p { margin: 0 }
</style>
`
}

// The page a password-reset link opens, and the page that asks for one. Written
// with auth, since both halves are routes @frontierjs/auth mounts.
function makeRouteReset() {
  return `---
title: Reset your password
---
<script>
  // Both halves of a reset, told apart by the URL. Without a token this asks for
  // an address; the link that request produces lands back here WITH one, and
  // then this sets the new password.
  //
  // The token is String()ed because the query reader turns a value that round-
  // trips as a number into one, and a token of digits would otherwise reach the
  // route as a number it refuses.
  //
  // Nothing here signs anybody in. Confirming a reset ends every session the
  // account holds, so the next stop is the sign-in page.
  import { page }      from '@frontierjs/sierra/router'
  import { getClient } from '@frontierjs/sierra/junction'

  $: page.query

  let email    = ''
  let password = ''
  let again    = ''
  let busy     = false
  let error    = ''
  let sent     = false
  let done     = false

  const token = () => String(page.query?.token ?? '')

  async function run(fn) {
    busy  = true
    error = ''
    try { await fn() } catch (e) { error = e.message } finally { busy = false }
  }

  // The route answers the same whether or not the address has an account, so
  // "sent" is all this page can honestly say.
  const request = () => run(async () => {
    await getClient().auth.requestPasswordReset(email.trim())
    sent = true
  })

  const confirm = () => run(async () => {
    // The server sees one box. A typo in a password nobody can see is a
    // password nobody can use, so the second box is checked here.
    if (password !== again) throw new Error('The two passwords are not the same.')
    await getClient().auth.confirmPasswordReset(token(), password)
    password = ''; again = ''
    done = true
  })
${sc}

<div class="auth-card card stack gap-md">
  <h1 class="text-xl">Reset your password</h1>

  {#if error}
    <div class="alert danger" role="alert"><div class="alert-content">{error}</div></div>
  {/if}

  {#if done}
    <div class="alert success" role="status">
      <div class="alert-content">Your password is set, and every other place you were signed in has been signed out.</div>
    </div>
    <a class="btn primary" href="/login/">Sign in</a>
  {:else if token()}
    <input class="field" bind:value={password} type="password" placeholder="New password"     aria-label="New password"     autocomplete="new-password" />
    <input class="field" bind:value={again}    type="password" placeholder="The same again"   aria-label="The same again"   autocomplete="new-password" />
    <button class="btn primary" on:click={confirm} disabled={busy}>
      {busy ? 'Saving…' : 'Set password'}
    </button>
  {:else if sent}
    <div class="alert success" role="status">
      <div class="alert-content">If <strong>{email}</strong> has an account, a reset link is on its way.</div>
    </div>
    <!-- auth.ts prints the link instead of mailing it until the app has a
         mailer, and nothing on this page could say so otherwise. -->
    {#if import.meta.env.DEV}
      <div class="alert info">
        <div class="alert-content text-sm">No mailer is wired yet, so the link is printed in the terminal running the API.</div>
      </div>
    {/if}
    <a class="link text-sm" href="/login/">Back to sign in</a>
  {:else}
    <p class="text-sm text-muted">Enter the address you sign in with and we will send a link to set a new password.</p>
    <input class="field" bind:value={email} type="email" placeholder="Email" aria-label="Email" autocomplete="email" />
    <button class="btn primary" on:click={request} disabled={busy || !email.trim()}>
      {busy ? 'Sending…' : 'Send reset link'}
    </button>
    <a class="link text-sm" href="/login/">Back to sign in</a>
  {/if}
</div>

<style>
  .auth-card { max-width: 24rem; margin: var(--space-3xl) auto }
  h1, p { margin: 0 }
</style>
`
}

// The signed-in person's own account. \`withName\` is whether the example users
// service exists, which is the only way this app can write a User row.
function makeRouteAccount(withName) {
  return `---
title: Account
---
<script>
  // The signed-in person's own account: their name, their password, and every
  // place they are signed in.
  //
${withName ? `  // The password and the sessions go through client.auth, which is the account
  // and sessions services scoped to the CALLER — nothing here names a user id
  // for them, because nothing there will take one. The name is the User row,
  // written through the users service; db/schema.lite's @@allow('update',
  // id == auth().id || …) is what lets a person write their own.
  import { getClient, session, refresh } from '@frontierjs/sierra/junction'` : `  // The password and the sessions go through client.auth, which is the account
  // and sessions services scoped to the CALLER — nothing here names a user id,
  // because nothing there will take one. The name is not editable here: that
  // is a write to the User row, and this app has no users service to make it.
  import { getClient, session } from '@frontierjs/sierra/junction'`}

  $: (session.user, session.checked)

  let name     = ''
  let current  = ''
  let next     = ''
  let sessions = []
  let notice   = ''
  let error    = ''
  let busy     = false

  const auth = () => getClient().auth

  // Asked whenever the person changes, not once at mount: the session restore
  // may still be in flight when this page mounts, and signing out in another
  // tab makes the last answer somebody else's.
  $: {
    if (session.user) { name = session.user.name ?? ''; loadSessions() }
    else sessions = []
  }

  async function loadSessions() {
    try { sessions = await auth().sessions() } catch (e) { error = e.message }
  }

  // Each action answers the sentence to show when it worked.
  async function run(fn) {
    busy   = true
    error  = ''
    notice = ''
    try { notice = await fn() } catch (e) { error = e.message } finally { busy = false }
  }

${withName ? `  const saveName = () => run(async () => {
    await getClient().service('users').patch(session.user.userId, { name: name.trim() })
    // The session is what the topbar reads, and it was built before the write.
    await refresh()
    return 'Name saved.'
  })

` : ``}  const changePassword = () => run(async () => {
    await auth().changePassword(current, next)
    current = ''; next = ''
    return 'Password changed.'
  })

  const signOutOthers = () => run(async () => {
    const { revoked } = await auth().revokeOtherSessions()
    await loadSessions()
    return revoked === 1 ? 'Signed out of 1 other session.' : \`Signed out of \${revoked} other sessions.\`
  })

  const signOutOne = (id) => run(async () => {
    await auth().revokeSession(id)
    await loadSessions()
    return 'Signed out.'
  })

  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—')
${sc}

<header class="stack gap-sm">
  <h1>Account</h1>
  <p class="text-muted">Your name, your password, and where you are signed in.</p>
</header>

{#if !session.checked}
  <p class="text-muted">…</p>
{:else if !session.user}
  <div class="alert info"><div class="alert-content"><a class="link" href="/login/">Sign in</a> to manage your account.</div></div>
{:else}
  {#if error}<div class="alert danger" role="alert"><div class="alert-content">{error}</div></div>{/if}
  {#if notice}<div class="alert success" role="status"><div class="alert-content">{notice}</div></div>{/if}

  <div class="grid">
    <section class="card stack gap-sm">
      <h2 class="text-lg">Profile</h2>
      <dl class="facts">
        <dt>Email</dt>
        <dd>{session.user.email}</dd>
      </dl>
${withName ? `      <input class="field" bind:value={name} placeholder="Your name" aria-label="Name" autocomplete="name" />
      <button class="btn primary" on:click={saveName} disabled={busy}>Save name</button>
` : ``}    </section>

    <section class="card stack gap-sm">
      <h2 class="text-lg">Password</h2>
      <input class="field" bind:value={current} type="password" placeholder="Current password" aria-label="Current password" autocomplete="current-password" />
      <input class="field" bind:value={next}    type="password" placeholder="New password"     aria-label="New password"     autocomplete="new-password" />
      <button class="btn primary" on:click={changePassword} disabled={busy || !current || !next}>Change password</button>
    </section>
  </div>

  <section class="card stack gap-sm sessions">
    <div class="split">
      <h2 class="text-lg">Where you are signed in</h2>
      <button class="btn outlined" on:click={signOutOthers} disabled={busy || sessions.length < 2}>Sign out everywhere else</button>
    </div>
    <dl class="facts divided">
      {#each sessions as s}
        <dt>{when(s.createdAt)}</dt>
        <dd class="split">
          {#if s.current}
            <span class="badge success">this browser</span>
          {:else}
            <span class="text-sm text-muted">expires {when(s.expiresAt)}</span>
            <button class="btn ghost" on:click={() => signOutOne(s.id)} disabled={busy}>Sign out</button>
          {/if}
        </dd>
      {/each}
    </dl>
  </section>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    gap: var(--space-lg);
    margin-top: var(--space-2xl);
  }
  .sessions { margin-top: var(--space-lg) }
  h1, h2, p { margin: 0 }
</style>
`
}

function makeRouteRegister() {
  return `---
title: Create an account
---
<script>
  import { goto }   from '@frontierjs/sierra/router'
  import { signUp } from '@frontierjs/sierra/junction'

  let email    = ''
  let password = ''
  let name     = ''
  let error    = ''
  let loading  = false

  // The API mounts {apiPrefix}/auth/register whether or not a page like this
  // exists, so this screen adds no surface — it is the one that was missing.
  // Delete the file and the route is still open; close it in api/src/app.ts.
  //
  // Everyone who arrives this way gets role "user", which db/schema.lite grades
  // as USER(4). ADMINISTRATOR(5) comes from \`fli auth:create-user --role admin\`
  // or from an admin editing the row: role carries @allow('write', auth().isAdmin),
  // so a caller cannot promote themselves on the way in.
  async function handleSubmit() {
    loading = true
    error   = ''
    try {
      // signUp signs the new account IN — the server answers with a token and
      // the client stores it — so there is no second trip through /login/.
      await signUp({ email, password, name })
      goto('/')
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }
${sc}

<div class="auth-card card stack gap-md">
  <h1 class="text-xl">Create an account</h1>

  {#if error}
    <div class="alert danger" role="alert"><div class="alert-content">{error}</div></div>
  {/if}

  <input class="field" bind:value={name}     type="text"     placeholder="Name"     aria-label="Name" />
  <input class="field" bind:value={email}    type="email"    placeholder="Email"    aria-label="Email" />
  <input class="field" bind:value={password} type="password" placeholder="Password" aria-label="Password" />
  <button class="btn primary" on:click={handleSubmit} disabled={loading}>
    {loading ? 'Creating…' : 'Create account'}
  </button>

  <p class="text-sm text-muted">Already have one? <a class="link" href="/login/">Sign in</a></p>
</div>

<style>
  .auth-card { max-width: 24rem; margin: var(--space-3xl) auto }
  h1, p { margin: 0 }
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

// Every refusal here sets `abort` before returning. A bare `return` after a
// `log.error` exits 0, so `fli new` printed *Directory already exists* and
// reported success — and everything that WRAPS this command believed it:
// `npm create frontier`, a CI script, and the tutor, whose next assertion then
// passed against the previous run's files (`FJS-589`'s rule, nine sites).
if (!useHere && !name) {
  log.error('Project name is required. Use `fli new <name>` or `fli new --here`.')
  context.config.abort = true
  return
}

if (name && !isValidProjectName(name)) {
  log.error(`Invalid project name: "${name}". Use lowercase letters, digits, and hyphens.`)
  context.config.abort = true
  return
}

// ─── 2. Resolve target directory ──────────────────────────────────────────────

const targetDir = useHere ? context.paths.root : resolve(context.paths.root, name)
const appName   = useHere ? basename(context.paths.root) : name

if (!useHere && existsSync(targetDir)) {
  log.error(`Directory ${name}/ already exists. Use --here if you meant to scaffold into it, or pick a different name.`)
  context.config.abort = true
  return
}

if (useHere && !flag.force) {
  const entries = readdirSync(targetDir).filter(f => !f.startsWith('.'))
  if (entries.length > 0) {
    log.error(`Current directory is not empty (${entries.length} entries). Use --force to override.`)
    context.config.abort = true
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
// npm. Recognized by name rather than dropped, so the flag says where it went.
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
    context.config.abort = true
    return
  }
  const wsResolved = resolve(wsRoot.replace(/^~/, process.env.HOME || ''))
  if (!existsSync(wsResolved)) {
    log.error(`$WORKSPACE_DIR does not exist: ${wsResolved}`)
    context.config.abort = true
    return
  }
  const wsTarget = resolve(wsResolved, 'packages', name)
  if (existsSync(wsTarget)) {
    log.error(`Workspace package already exists: packages/${name}/`)
    context.config.abort = true
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
// FJS-241), so a local scaffold containerizes; what it still installs is one
// machine's working tree, which is the right thing while testing a change to a
// package and the wrong thing to hand somebody as a starting point.
const fjsSource = (flag.source || process.env.FJS_SOURCE || 'npm').toLowerCase()

if (fjsSource !== 'local' && fjsSource !== 'npm') {
  const hint = fjsSource === 'github'
    ? '--source github is not supported yet.'
    : `Unknown --source "${fjsSource}".`
  log.error(`${hint} Use local (symlink to your packages) or npm (published).`)
  context.config.abort = true
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
    context.config.abort = true
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
if (useApi && useAuth) dirs.push('api/test')
// cli/src/routes is fli:init's to write, and fli:init refuses a directory that
// already exists. Creating it here left the FLI surface an empty folder and a
// warning nobody reads.
if (useDeploy && useApi) dirs.push('deploy')
if (flag.ci !== false) dirs.push('.github/workflows')
if (useWeb) {
  dirs.push('web', 'web/config', 'web/src', 'web/src/routes', 'web/src/resources', 'web/src/components', 'web/public')
  if (useAuth) dirs.push('web/src/routes/login', 'web/src/routes/register', 'web/src/routes/reset', 'web/src/routes/account')
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
  // For the program somebody asks to write code here. Pointed at the packages
  // this manifest names, so an api-only app is not sent to a stylesheet.
  ['AGENTS.md',                   appAgentsMd({ name: appName, packages: neededPkgs })],
  ['CLAUDE.md',                   appClaudeMd({ name: appName })],
  ['db/schema.lite',              makeSchemaLiteEmpty()],
]

if (useApi) {
  filesToWrite.push(
    ['api/index.ts',                makeApiIndexTs()],
    ['api/src/app.ts',              makeApiAppTs(useAuth, useWeb)],
    ['api/src/core/env.ts',         makeApiEnvTs()],
    ['api/src/core/gate.ts',        makeApiCoreGateTs()],
    ['api/src/core/db.ts',          makeApiCoreDbTs()],
    ['api/src/core/channels.ts',    makeApiCoreChannelsTs(useAuth)],
    ['api/config/junction.config.js', makeJunctionConfig(appName, useWeb)],
  )
}

if (useAuth) {
  filesToWrite.push(
    ['api/src/core/auth.ts',     makeApiCoreAuthTs()],
    ['api/test/access.test.ts',  makeApiAccessTest()],
  )
}

if (useWeb) {
  filesToWrite.push(
    ['web/index.html',                      makeIndexHtml(appName)],
    ['web/public/manifest.webmanifest',     makeWebManifest(appName)],
    ['web/public/icon.svg',                 makeIconSvg(appName)],
    ['web/config/vite.config.js',           makeViteConfig()],
    ['web/config/sierra.config.js',         makeSierraConfig(appName)],
    ['web/src/App.mesa',                    makeAppMesa()],
    ['web/src/main.js',                     makeMainJs()],
    ['web/src/routes/_module.mesa',         makeRouteModule(appName, useAuth)],
    ['web/src/routes/index.mesa',           makeRouteIndex(appName)],
    ['web/src/routes/[...404].mesa',        makeRouteNotFound()],
  )
  if (useAuth) {
    filesToWrite.push(
      ['web/src/routes/login/index.mesa',    makeRouteLogin()],
      ['web/src/routes/register/index.mesa', makeRouteRegister()],
      ['web/src/routes/reset/index.mesa',    makeRouteReset()],
      ['web/src/routes/account/index.mesa',  makeRouteAccount(useExample)],
    )
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

// ─── 9d. Link local packages, then install ────────────────────────────────────
//
// BEFORE the sub-commands, not after them, and the reason is `auth:install`:
// it reads `user.lite` out of @frontierjs/auth by RESOLVING it, and with no
// node_modules the resolve fails and it falls back to `bun add`, which is
// always the REGISTRY's copy. So an app scaffolded `--source local` had the
// published User model appended — measured on a fresh scaffold as an
// `accountId Int?` where the tree says `String?` and, worse, no `@@auth`, which
// leaves every claim in every policy ungraded (`FJS-666`, `FJS-737`). That is
// `FJS-741` one step earlier in the same command: WHICH auth this app is
// developed against has to be settled before anything reads out of it.
//
// `bun link` registers each package globally (idempotent) so the
// `link:@frontierjs/*` specs resolve to live symlinks — edits to the tree are
// then picked up with no reinstall.

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

if (useInstall) {
  try {
    log.info('→ bun install')
    context.exec({ command: 'bun install', cwd: finalTarget, stdio: 'inherit' })
  } catch (e) {
    log.warn(`bun install failed: ${e.message} — run it manually before fli dev`)
  }
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

// notifications:install — appends the Notification model the package requires.
// `--with notifications` used to add the dependency and stop, so every app
// copied the model out of node_modules by hand or found out at the first send
// that `notification` is not a table in this schema. Warn and continue rather
// than throw: unlike auth, nothing else in the scaffold depends on it, and an
// app can run the command itself.
if (withPkgs.includes('notifications')) {
  try {
    log.info('→ notifications:install')
    runFli(context, ['notifications:install'], finalTarget)
  } catch (e) {
    log.warn(`notifications:install failed: ${e.message} — run it yourself before the first app.notify()`)
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

// make:deploy — Dockerfile + frontier.config.js deploy block. It containerizes
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
  // --format hex, and it is load-bearing: keygen defaults to base64, litestone
  // parses this variable as HEX, and a base64 key therefore decodes to zero
  // bytes and is refused with a sentence about a key length. Advice that fails
  // when taken is worse than none.
  echo('  fli keygen aes --format hex --name ENCRYPTION_KEY --env   # .env needs a key before the API starts')
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
// A scaffolded tree is where somebody who has never seen FrontierJS lands, and
// it answers none of what the seed is FOR. The lessons build their own app, so
// this points somewhere rather than back at the directory it just wrote.
echo('  New to FrontierJS? `fli tutor` — thirteen lessons that run the real')
echo('  commands and then ask the running world whether they worked. They build')
echo('  their own app and leave this one alone.')
echo('')
echo('  Writing it with an AI agent? AGENTS.md is written for it — Claude Code')
echo('  reads it through CLAUDE.md, and your own notes about the app go there.')
echo('')
// A scaffold with --auth has an empty `user` table, so the login page it just
// wrote can sign nobody in and every screen behind a gate answers
// "Authentication required" — which reads as a broken app rather than an empty
// one. auth:install prints this too, hundreds of lines up the scroll.
if (useAuth) {
  echo('  Nobody exists yet — the first account is either door:')
  echo('    fli auth:create-user you@example.com --role admin   the only way to mint an ADMIN')
  echo('    /register/ in the browser                           role "user", and it signs you in')
  echo('  Then /login/. The nav says which of the two you are.')
  echo('')
}
echo('  Then:')
echo(`    bun run check          fli check, then lint, then typecheck${useApi && useAuth ? ', then tests' : ''} — the same gate CI runs`)
echo('    fli scaffold <Model>    add a new model + service + resource + routes')
echo('    fli admin:generate      generate CRUD admin UI from schema.lite')
echo('    fli deploy:doctor       check deploy readiness')
echo('')
```