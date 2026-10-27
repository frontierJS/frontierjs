// ─── scaffold/app.js — what a new app is given at its root ─────────────────
//
// The files every shape of `fli new` writes whatever its surfaces: package.json,
// .gitignore, .env.example, .fli.json, README.md and the empty db/schema.lite.
// `api.js` and `web.js` beside this are the two surfaces `fli new` owns
// outright; widgets, site and extension have a module each under core/, shared
// with the `make:*` command that adds the surface to an app that exists.
// Every builder is a pure function of the spec: nothing here reads the disk.
// ─────────────────────────────────────────────────────────────────────────────

import { APP_DEV_DEPS, FJS_PACKAGES, appCheckScripts, appSurfaceScripts } from '../app-config.js'
import { widgetScripts }                      from '../widget-surface.js'
import { siteScripts, siteDevDeps }           from '../site-surface.js'
import { extensionScripts, extensionDevDeps } from '../extension-surface.js'

const VITE_VERSION = '^8.0.0'

// ─── Root template builders ───────────────────────────────────────────────────

export function makePackageJson(spec) {
  const {
    name, scope, useAuth, useWeb, useApi = true, useDb = true, useWidgets = false, useSite = false,
    useExtension = false, withPkgs, source,
  } = spec
  const pkgName = scope ? `${scope}/${name}` : name
  // Sierra and Mesa are the UI realm, and a widget and a prerendered page are
  // both UI: a widgets-only or site-only project has no SPA and still compiles
  // .mesa with the same compiler.
  const useUI   = useWeb || useWidgets || useSite

  // local source → `link:@frontierjs/x` (resolves to a live symlink via bun link);
  // npm source → the exact version FJS_PACKAGES or APP_DEV_DEPS pins.
  const specFor = (key) => source === 'local'
    ? `link:${key}`
    : (FJS_PACKAGES[key] ?? APP_DEV_DEPS[key])

  const deps = {}
  if (useDb)   deps['@frontierjs/litestone'] = specFor('@frontierjs/litestone')
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
  if (useExtension) {
    // After the UI's vite on purpose: jetty's peer range is the narrower one.
    Object.assign(devDeps, extensionDevDeps())
  }
  if (useSite) {
    Object.assign(devDeps, siteDevDeps())
  }

  // Scripts — the surface table is core/app-config.js's (FJS-D1083).
  const surfaces = []
  if (useExtension) surfaces.push({ scripts: extensionScripts(), dev: 'dev:extension', build: 'build:extension' })
  // A widget is its own library build, one per file in widgets/src/Embeds/,
  // so this is `sierra widgets` and not `vite build`. `serve:widgets` answers
  // with the CORS and cache headers the deployment sends.
  if (useWidgets)   surfaces.push({ scripts: widgetScripts(),    dev: 'dev:widgets',   build: 'build:widgets' })
  // An ordinary Vite build that prerenders afterwards, so this IS `vite
  // build` — the difference is what closeBundle does with it.
  if (useSite)      surfaces.push({ scripts: siteScripts(),      dev: 'dev:site',      build: 'build:site' })
  const scripts = appSurfaceScripts({ api: useApi, web: useWeb, surfaces })

  // The deploy container's entrypoint is `bun run db:migrate && bun run start`,
  // so this script is part of the contract with deploy/Dockerfile rather than a
  // convenience — without it the container exits non-zero on every start.
  // `--schema` also fixes the migrations directory: litestone resolves it as a
  // sibling of the schema, so this finds db/migrations without a second flag.
  //
  // A web-only app has no db/ and installs no litestone, so none of these
  // scripts has a binary to run.
  if (useDb) {
    scripts['db:migrate'] = 'litestone migrate apply --schema db/schema.lite'
    // No destination: litestone writes a new db/backups/<stamp>/ each run, where a
    // fixed one made every backup overwrite the last (FJS-1786).
    scripts['db:backup']  = 'litestone backup --schema db/schema.lite'

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
    const dbTypes = ['litestone types --schema db/schema.lite --audience system --out db/schema.d.ts']
    if (useWeb) dbTypes.push('litestone types --schema db/schema.lite --audience client --augment junction --out web/src/lib/db.d.ts')
    scripts['db:types'] = dbTypes.join(' && ')
  }

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

export function makeGitignore() {
  return [
    'node_modules/',
    '.env',
    '.env.local',
    'db/*.db',
    'db/*.db-shm',
    'db/*.db-wal',
    'db/backups/',
    // The JSON Schema `db:push`, `db:migrate` and `db:jsonschema` derive.
    'db/.json/',
    '.DS_Store',
    'dist/',
    // `jetty dev`'s launched browsers keep their profiles here — sign-ins,
    // cookies and the extension's storage.
    '.browser-profiles/',
    '.fli-tmp/',
    '.deploy.lock',
    // Written by `fli deploy:vendor` before every build — a rewritten manifest
    // and the packed framework tarballs it points at. Regenerated per build, so
    // committing it commits a version of the framework nobody can read off a
    // spec.
    'deploy/generated/',
    // Sierra's route tables — the scanner writes routes.js on every dev run and
    // a build writes routes.build.js beside it. Derived from web/src/routes/, so
    // a committed copy churns with every route edit.
    'routes.build.js',
    'web/config/routes.js',
    '',
  ].join('\n')
}

export function makeEnvExample(useAuth) {
  const lines = [
    '# Required — generate with: openssl rand -hex 32',
    'ENCRYPTION_KEY=',
    '',
    '# Database file. Use :memory: for tests.',
    'DATABASE_URL=./db/app.db',
    '',
    '# Where the audit trail is written. It is a SQLite file, and a variable for',
    '# the same reason DATABASE_URL is: a deploy mounts a volume, and a literal',
    '# path here writes the trail inside the container, where the next swap',
    '# takes it.',
    'AUDIT_PATH=./db/audit.db',
    '',
    '# App. The API binds FRONTIER_PORT_BE, the port fli dev hands it and web/',
    '# proxies /api to; a bare PORT (a PaaS sets one) is read only when that is',
    '# absent, and api/config/junction.config.js says 8100 when neither is.',
    '# FRONTIER_API_URL is where a client reaches the API; FRONTIER_APP_URL is',
    '# where a person reaches web/ -- the page a password-reset link opens.',
    '# FRONTIER_API_URL=http://localhost:8100',
    '# FRONTIER_APP_URL=http://localhost:8000',
    '',
    '# Read by web/ and site/ at BUILD time (their envDir is this folder), and the',
    '# one FRONTIER_ name a bundle can see: FRONTIER_PUBLIC_ is the browser door. The',
    '# API origin when it is not the page\'s own; empty means same origin behind one proxy.',
    '# A site/ island never reaches /api by a relative path -- it is its own origin.',
    '# FRONTIER_PUBLIC_API_URL=https://api.example.com',
    '',
    '# No NODE_ENV here: build scripts load this file, and a vite build that sees',
    '# development ships every import.meta.env.DEV branch. The API defaults to it.',
    '',
  ]
  return lines.join('\n')
}

export function makeFliJson(name) {
  return JSON.stringify({
    routesDir:        'cli/src/routes',
    defaultNamespace: name,
    editor:           'code',
  }, null, 2) + '\n'
}

export function makeReadme(spec) {
  const { name, useAuth, useWeb, useApi = true, useDb = true, useFli = true, useWidgets = false, useSite = false, useExtension = false, deployConfig = false, withPkgs } = spec
  const surface = [useApi && 'api/', useWeb && 'web/', useWidgets && 'widgets/', useSite && 'site/', useExtension && 'extension/'].filter(Boolean)
  const features = [
    `- ${useAuth ? 'Auth via `@frontierjs/auth` — sign in, register, `/account/` (name, password, sessions) and `/reset/`. Reset and verification links print to the API terminal until a mailer is wired' : 'No auth (add later with `fli auth:install`)'}`,
    ...(useDb ? ['- Litestone client with gate plugin for level-based authorization'] : []),
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

A FrontierJS application — ${surface.join(' + ')}${useDb ? ' over one \`db/schema.lite\`' : ''}.

## What's included

${features.join('\n')}

## Run

\`\`\`bash
# 1. Install deps
bun install

# 2. Start
fli dev
\`\`\`

${surface.length > 1 ? 'Every surface runs concurrently' : 'The surface runs in watch mode'}, and \`fli dev\` prints the
address each one answers on. The ports belong to this app's root, not to the
framework: \`fli dev\` gives each app on the machine its own slot, so a second
app does not collide with the first. \`fli ps\` shows which port each running
app holds, and \`fli dev --dry\` shows this one's before it starts.

${useDb ? `Schema DDL runs automatically on first start — no migration step.

\`.env\` is already written and \`ENCRYPTION_KEY\` already has a value. Copying
\`.env.example\` over it blanks the key, and Litestone refuses to open with one;
\`fli keygen aes --format hex --name ENCRYPTION_KEY --env\` fills it again.
` : 'This app has no API and no database -- web/ is the whole project.\n'}
${useAuth ? `
### The first account

Nobody exists yet, and the login page cannot sign in an empty \`user\` table.
Two doors:

\`\`\`bash
fli auth:create-user you@example.com --role admin
\`\`\`

or \`/register/\` in the browser. That makes no account yet: the verification
link prints in the API's terminal, and the account is made when it is followed.
Registration gives everybody role \`user\`; \`--role admin\` is the only way to
mint an ADMINISTRATOR, and \`db/schema.lite\` marks \`role\` \`@allow(write,
auth().isAdmin)\` so nobody promotes themselves on the way in.

### Email

There is no mailer yet, so nothing is sent. A password reset requested at
\`/reset/\` prints its link in the terminal running the API, and the link opens
\`/reset/#token=…\` on \`FRONTIER_APP_URL\` (the fragment keeps the token out of requests and logs). Wire \`app.mail.send()\` into the three
callbacks in \`api/src/core/auth.ts\` to send them for real; set \`FRONTIER_APP_URL\` in
production so the link names the deployed site. The third,
\`onCredentialChanged\`, is the notice that a password, email address or
two-step sign-in changed: it only logs until there is a mailer, and a person who
did not make the change hears of it nowhere else.
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
${useDb ? `\`db/schema.d.ts\` is the schema's own TypeScript and does not exist until
\`bun run db:types\` has written it; until then every table on the client — in a
job, a test or a service — is \`unknown\`. \`bun run typecheck\` runs it first, so
run it by hand after editing \`db/schema.lite\` to refresh the types in your editor.

` : ''}That is exactly what \`.github/workflows/ci.yml\` runs, so a green local run is a
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
${useDb ? `# Add a new model with full vertical slice (schema → service → resource → routes)
fli scaffold ModelName --fields "name:string email:email"

# Generate a CRUD admin UI from schema.lite
fli admin:generate

# Check services, resources and the schema against each other
fli check

# Pre-flight checks before deploying
fli deploy:doctor

# Deploy via SSH + Docker (after fli deploy:setup)
fli deploy
` : `# Add a component
fli make:component Card

# The static build
bun run build
`}\`\`\`

## Layout

\`\`\`
${name}/
├── package.json
${useApi ? (deployConfig ? '├── frontier.config.js          # FLI deploy config\n' : '') + '├── .env.example\n' : ''}├── tsconfig.json               # one line of extends — @frontierjs/config
├── biome.json                  # ditto; linter only, no formatter
├── .editorconfig
├── README.md
├── AGENTS.md                   # for an AI agent writing code here — written by fli new
├── AGENTS.project.md           # this app's own agent instructions; imported by AGENTS.md
├── CLAUDE.md                   # Claude Code's entry; imports AGENTS.md
├── .github/workflows/ci.yml    # runs \`bun run check\`
${useDb ? '├── db/\n│   └── schema.lite             # Single source of truth — data + auth\n' : ''}${useFli ? '├── cli/\n│   └── src/routes/             # Project-specific FLI commands\n' : ''}${useApi
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
│   │   │   ├── principal.ts    # Per-request claims -- createApp({ principal })
│   │   │   └── auth.ts         # createLitestoneAuth + plugin (if auth)
│   │   └── services/           # Service files autoloaded at boot
│   └── test/                   # access.test.ts (if auth)
`
  : ''}${useWeb
  ? `└── web/
    ├── index.html
    ├── config/
    │   ├── vite.config.js      # Thin wrapper — createSierraViteConfig
    │   └── sierra.config.js    # Routes dir, target${useApi ? ', junction url' : ''}
    └── src/
        ├── main.js             # Side-effect imports; virtual:sierra mounts App
${useApi ? '        ├── controls.js         # Form controls the app contributes (registerControl)\n' : ''}        ├── App.mesa            # Root: <RouterView />
        ├── lib/nav.js          # The nav table — the Shell draws it, make:scaffold adds to it
        ├── routes/             # Sierra file-based routes (.mesa)
${useDb ? '        └── resources/          # One Resource per model — Note.mesa (.mesa)\n' : ''}`
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

${useDb ? `## Where to grow

- **Add a model:** \`fli scaffold Lead --fields "name:string email:email status:string"\`
- **Background jobs:** add \`@frontierjs/caravan\` and configure under the \`caravan\` block in \`junction.config.js\`
- **Third-party integrations:** add \`@frontierjs/conduit\` and place targets in \`api/src/conduit/\`
- **Real-time:** already wired — \`api/src/core/channels.ts\` decides who listens, and joins every channel a service declares
` : ''}`
}

// ─── Schema starter (no auth path) ────────────────────────────────────────────

export function makeSchemaLiteEmpty() {
  return `// db/schema.lite
// Single source of truth for data shape + authorization.
// Add models here; Litestone generates DDL automatically on first start.

// ─── Databases ────────────────────────────────────────────────────────────
// Both blocks must exist before any model is added: auth's fragments name
// \`main\` and \`audit\` explicitly, and a model referencing an undeclared
// database fails the whole parse — the app dies at createClient, not later.
// This path is the app's. createClient's \`db:\` option OVERRIDES it and is
// resolved against the working directory, so api/src/core/db.ts passes none.

database main  { path env("DATABASE_URL", "./db/app.db") announce inProcess }

import "@frontierjs/litestone/references/AuditTrail.lite"

database audit { path env("AUDIT_PATH", "./db/audit.db") retention 90d model AuditTrail announce inProcess }

model AuditTrail { id Int @id @default(autoincrement())  @@trait(AuditTrail) @@db(audit) @@gate(8) }

`
}
