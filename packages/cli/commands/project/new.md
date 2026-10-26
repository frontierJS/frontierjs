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
  - fli new my-app --template web-only
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
    description: Scaffold into the current directory instead of creating <name>/ (the app is still named <name>; without one, the folder names it)
    defaultValue: false
  force:
    type: boolean
    description: Allow non-empty target directory
    defaultValue: false
  template:
    type: string
    choices: [full-stack, api-only, web-only, widgets-only, site-only, extension-only]
    description: Which shape of project to scaffold
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
    description: Scaffold the Dockerfile, and the frontier.config.js deploy block when --server or --domain names where (default true; use --no-deploy to skip)
    defaultValue: true
  fli:
    type: boolean
    description: Scaffold cli/src/routes via fli:init (default true; use --no-fli to skip)
    defaultValue: true
  web:
    type: boolean
    description: Scaffold web/ folder with Sierra+Mesa shell (default true; use --no-web for api-only; web-only has no api/ or db/)
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
    choices: [local, npm]
    description: "Where @frontierjs packages install from: npm (published) or local (symlink to <root>/packages, live edits; a build packs them into the image). Default: $FRONTIER_SOURCE, else local from a framework checkout and npm from an install"
    defaultValue: ''
---

<script>
import { mkdirSync } from 'fs'
import { join } from 'path'

// `existsSync, readFileSync, readdirSync, writeFileSync` come from _module.md
// `resolve, basename` come from _module.md
// `execSync` comes from _module.md (used via $.exec which wraps it)

// What the app is given besides its own source — tsconfig, biome.json,
// .editorconfig, the workflow, the agent docs. One module, so the framework's
// opinion about tooling is written down once and can be read.
const { EDITORCONFIG, FJS_PACKAGES, appTsconfig, appBiomeJson, appWorkflow,
        appAgentsMd, appAgentsProjectMd, appClaudeMd } =
  await import(resolve(global.fliRoot, 'core/app-config.js'))

// The widgets/ surface — one owner, shared with `fli make:widget`, so an app
// scaffolded here can be extended by the command that adds the second widget.
const { scaffoldWidgetSurface } =
  await import(resolve(global.fliRoot, 'core/widget-surface.js'))

// The site/ surface, same rule: one owner, shared with `fli make:site`. It is a
// peer of web/ and never a routesDir inside it — sharing a Vite root shares a
// dist/, and `vite build` empties outDir, so building the SPA deletes the site.
const { scaffoldSiteSurface } =
  await import(resolve(global.fliRoot, 'core/site-surface.js'))

// The extension surface, same rule: one owner, shared with `fli make:extension`.
const { scaffoldExtensionSurface } =
  await import(resolve(global.fliRoot, 'core/extension-surface.js'))

// What `fli new` writes, by surface — the root files, api/ and web/. A builder
// is a pure function of the spec; this file decides which are written and where.
const { makePackageJson, makeGitignore, makeEnvExample, makeFliJson, makeReadme,
        makeSchemaLiteEmpty } =
  await import(resolve(global.fliRoot, 'core/scaffold/app.js'))
const { makeApiIndexTs, makeApiAppTs, makeApiCorePrincipalTs, makeApiEnvTs, makeApiCoreGateTs,
        makeApiAccessTest, makeApiCoreDbTs, makeRetentionJobTs, makeApiCoreChannelsTs,
        makeApiCoreAuthTs, makeJunctionConfig } =
  await import(resolve(global.fliRoot, 'core/scaffold/api.js'))
const { makeIndexHtml, makeWebManifest, makeIconSvg, makeViteConfig, makeSierraConfig, makeAppMesa,
        makeMainJs, makeControlsJs, makeDatetimeJs, makeSugarJs, makeNavJs, makeRouteModule, makeRouteNotFound,
        makeRouteIndex, makeRouteLogin, makeRouteReset, makeRouteVerifyEmail, makeRouteAccount,
        makeRouteRegister } =
  await import(resolve(global.fliRoot, 'core/scaffold/web.js'))

// ─── Validators ───────────────────────────────────────────────────────────────

function isValidProjectName(name) {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)
}


// ─── Helper: spawn a subcommand via fli ───────────────────────────────────────
// Runs `fli <args>` in the project root. Throws on non-zero exit.
//
// STDOUT is captured and thrown away; stderr is not. Every command composed
// here is a whole command elsewhere, so each one prints its own banner, its own
// next-steps and its own tutorial — five endings inside a command that has one.
// The scroll that produced was unreadable, and the lines that mattered (a
// warning, the summary) were in it somewhere.
//
// stderr passes straight through because that is where `log.warn` and
// `log.error` already go: the severity split the logger makes is exactly the
// one wanted here, so a child's warning is still live and in order while its
// chatter is not. On a failure the captured stdout is printed before the throw
// — the buffer is worth having only when something went wrong.
//
// `--verbose` inherits stdio instead, and is forwarded to the child so its own
// `log.detail` lines come out too. It is a PARAMETER: the helpers here live in
// the namespace <script> and the command body is a separate function, so a
// const declared in the body is not in scope up here — it reads as `verbose is
// not defined` at the first composed command.
function runFli($, args, cwd, label = args[0], verbose = false) {
  // The RUNNING cli, never whatever `fli` is on PATH. A bare `fli` is a GLOBAL
  // install: it exists on the machine of anyone who has ever run `bun add -g`
  // and on no CI runner, in no container, and for nobody who reached this
  // command through `npm create frontier`. There it is `/bin/sh: 1: fli: not
  // found`, so `fli:init` and `auth:install` did not run and the scaffold came
  // out with no User model — an app that installs, builds, boots, answers health
  // and can register nobody (FJS-252, found on a runner).
  const argv = verbose ? [...args, '--verbose'] : args
  const cmd  = [$.fli, ...argv.map(a => JSON.stringify(a))].join(' ')

  // `$.log`, not the bare `log` the command body gets: this helper is in
  // the namespace <script> and that binding is injected into the body alone.
  $.log.info(`→ ${label}`)

  if (verbose) return $.exec({ command: cmd, cwd, stdio: 'inherit' })

  try {
    return $.exec({ command: cmd, cwd, stdio: ['inherit', 'pipe', 'inherit'] })
  } catch (err) {
    const out = err.stdout?.toString() ?? ''
    if (out.trim()) console.log('\n' + out.trimEnd() + '\n')
    throw err
  }
}
</script>

Creates a brand-new FrontierJS project from scratch — Junction API, optional auth, optional Sierra/Mesa frontend, deploy-ready out of the box. Composes existing FLI commands (`auth:install`, `make:scaffold`, `make:deploy`, `fli:init`, `workspace:add`) so the output stays consistent with what those generators produce when run on existing projects.

The default install set is just `@frontierjs/junction`. Auth is asked about during execution unless `--auth` or `--no-auth` is passed. Use `--minimal` (junction only) or `--full` (all tier-1 packages) to skip prompts entirely. `--yes` accepts every prompt.

Templates: `full-stack` (default — api + web), `api-only` (no web/ folder),
`web-only` (no api/, no db/ — a single-page app that talks to nobody's API),
`widgets-only`, `site-only` and `extension-only` (no api/, no web/ — the product
is that one surface, and what it talks to is somebody else's API). Add
`--widgets`, `--site` or `--extension` to any of them for that surface
alongside.

```js
// ─── 1. Validate inputs ───────────────────────────────────────────────────────

const name = arg.name
const useHere = flag.here === true
// This command composes five others, and each of those is a whole command
// elsewhere with its own banner and its own epilogue. `--verbose` is what puts
// their output back, and it travels to them.
const verbose = flag.verbose === true

// Every refusal here sets `abort` before returning. A bare `return` after a
// `log.error` exits 0, so `fli new` printed *Directory already exists* and
// reported success — and everything that WRAPS this command believed it:
// `npm create frontier`, a CI script, and the tutor, whose next assertion then
// passed against the previous run's files (`FJS-589`'s rule, nine sites).
if (!useHere && !name) {
  log.error('Project name is required. Use `fli new <name>` or `fli new --here`.')
  $.config.abort = true
  return
}

if (name && !isValidProjectName(name)) {
  log.error(`Invalid project name: "${name}". Use lowercase letters, digits, and hyphens.`)
  $.config.abort = true
  return
}

// ─── 2. Resolve target directory ──────────────────────────────────────────────

const targetDir = useHere ? $.paths.root : resolve($.paths.root, name)
// Under --here a stated name still names the app; only its absence falls back to the folder.
const appName   = name ?? basename($.paths.root)

if (!useHere && existsSync(targetDir)) {
  log.error(`Directory ${name}/ already exists. Use --here if you meant to scaffold into it, or pick a different name.`)
  $.config.abort = true
  return
}

if (useHere && !flag.force) {
  const entries = readdirSync(targetDir).filter(f => !f.startsWith('.'))
  if (entries.length > 0) {
    log.error(`Current directory is not empty (${entries.length} entries). Use --force to override.`)
    $.config.abort = true
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
// `web-only` is the same shape with web/ as the surface: a project whose only
// product is the SPA, talking to nobody's API. It also has no db/, since the
// schema is what an API and its clients derive from.
const webOnly      = template === 'web-only'
const useApi       = !surfaceOnly && !webOnly
const useDb        = !webOnly
const useWeb       = webOnly || (!surfaceOnly && (template === 'full-stack' || template === undefined) && flag.web !== false)
const useWidgets   = template === 'widgets-only'   || flag.widgets === true
const useSite      = template === 'site-only'      || flag.site === true
const useExtension = template === 'extension-only' || flag.extension === true
const useDeploy = flag.deploy !== false
const useFli    = flag.fli !== false && !webOnly
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
// Auth is a property of an API, and these templates have none — the widgets talk
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
  const answer = await tty.line(`\n  Install @frontierjs/auth? (sessions, password reset, email verify) [Y/n] › `)
  useAuth = !(answer && answer.toLowerCase().startsWith('n'))
}

// ─── 5. Example decision ──────────────────────────────────────────────────────
// Default: on if auth, off otherwise. Flags override.

let useExample
if (flag.example === true)  useExample = true
else if (flag.example === false) useExample = false
else useExample = useAuth
// An example is a User CRUD slice, which is a model, a service and a gate.
if (!useApi) useExample = false

// ─── 6. Workspace mode — adjust target dir ────────────────────────────────────

let finalTarget = targetDir
if (useWorkspace) {
  const wsRoot = process.env.WORKSPACE_DIR || process.env.OUTLAW_DIR
  if (!wsRoot) {
    log.error('--workspace requires $WORKSPACE_DIR to be set.')
    $.config.abort = true
    return
  }
  const wsResolved = resolve(wsRoot.replace(/^~/, process.env.HOME || ''))
  if (!existsSync(wsResolved)) {
    log.error(`$WORKSPACE_DIR does not exist: ${wsResolved}`)
    $.config.abort = true
    return
  }
  const wsTarget = resolve(wsResolved, 'packages', name)
  if (existsSync(wsTarget)) {
    log.error(`Workspace package already exists: packages/${name}/`)
    $.config.abort = true
    return
  }
  log.info(`Workspace mode — creating at ${wsTarget}`)
  finalTarget = wsTarget
}

// ─── 6.5 FJS package source — npm (published) or local (symlink) ──────────────
// Default resolves from the flag, then $FRONTIER_SOURCE, then the cli's own layout:
// local from a framework checkout, npm from an install. GitHub is not
// supported yet.
//
// A checkout's templates are written against the checkout's packages, and the
// published ones can be behind them: the scaffold's `work()` hook typechecked
// against the tree and failed `bun run check` on day one against npm's junction
// (FJS-1637, FJS-D579). A published cli has no such tree, so it keeps npm.
//
// npm is the default elsewhere because published packages are what a starting point
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
const { isFrameworkCheckout } = await import(resolve(global.fliRoot, 'core/utils.js'))
const fjsSource = (flag.source || process.env.FRONTIER_SOURCE || (isFrameworkCheckout(global.fliRoot) ? 'local' : 'npm')).toLowerCase()

if (fjsSource !== 'local' && fjsSource !== 'npm') {
  const hint = fjsSource === 'github'
    ? '--source github is not supported yet.'
    : `Unknown --source "${fjsSource}".`
  log.error(`${hint} Use local (symlink to your packages) or npm (published).`)
  $.config.abort = true
  return
}

// What this project will be given, decided once. `makePackageJson` is the one
// answer to that question and the manifest is written from it later.
const spec = { name: appName, scope: flag.scope, deployConfig: useDeploy && !!(flag.server || flag.domain), useAuth, useWeb, useApi, useDb, useFli, useWidgets, useSite, useExtension, withPkgs, source: fjsSource }

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
    $.config.abort = true
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
echo(`  Deploy:    ${useDeploy && useApi ? (flag.server || flag.domain ? 'yes (deploy/Dockerfile + frontier.config.js)' : 'yes (deploy/Dockerfile; pass --server to write frontier.config.js)') : 'no'}`)
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

// A queue is what gives the audit trail's declared retention a clock after boot.
const useQueue = useApi && withPkgs.includes('caravan')
const useNotify = useApi && withPkgs.includes('notifications')

const dirs = []
if (useDb) dirs.push('db')
if (useApi) dirs.push('api', 'api/config', 'api/src', 'api/src/core', 'api/src/services')
if (useQueue) dirs.push('api/src/jobs')
if (useNotify) dirs.push('api/src/notifications')
if (useApi && useAuth) dirs.push('api/test')
// cli/src/routes is fli:init's to write, and fli:init refuses a directory that
// already exists. Creating it here left the FLI surface an empty folder and a
// warning nobody reads.
if (useDeploy && useApi) dirs.push('deploy')
if (flag.ci !== false) dirs.push('.github/workflows')
if (useWeb) {
  dirs.push('web', 'web/config', 'web/src', 'web/src/lib', 'web/src/routes', 'web/src/components', 'web/public')
  if (useDb) dirs.push('web/src/resources')
  if (useAuth) dirs.push('web/src/routes/login', 'web/src/routes/register', 'web/src/routes/reset', 'web/src/routes/verify-email', 'web/src/routes/account')
}

for (const d of dirs) {
  mkdirSync(resolve(finalTarget, d), { recursive: true })
}

// ─── 9. Write base files ──────────────────────────────────────────────────────

const filesToWrite = [
  ['package.json',                _manifest],
  ['.gitignore',                  makeGitignore()],
  ['.fli.json',                   makeFliJson(appName)],
  ['tsconfig.json',               appTsconfig({ useWeb, useSite, useWidgets, useExtension, useApi })],
  ['biome.json',                  appBiomeJson()],
  ['.editorconfig',               EDITORCONFIG],
  ['README.md',                   makeReadme(spec)],
  // For the program somebody asks to write code here. Pointed at the packages
  // this manifest names, so an api-only app is not sent to a stylesheet.
  ['AGENTS.md',                   appAgentsMd({ name: appName, packages: neededPkgs })],
  ['AGENTS.project.md',           appAgentsProjectMd({ name: appName })],
  ['CLAUDE.md',                   appClaudeMd({ name: appName })],
]

// What a database needs is the schema and the env that opens it.
if (useDb) filesToWrite.push(
  ['.env.example',                makeEnvExample(useAuth)],
  ['db/schema.lite',              makeSchemaLiteEmpty()],
)

if (useApi) {
  filesToWrite.push(
    ['api/index.ts',                makeApiIndexTs()],
    ['api/src/app.ts',              makeApiAppTs(useAuth, useQueue, useNotify)],
    ['api/src/core/env.ts',         makeApiEnvTs()],
    ['api/src/core/gate.ts',        makeApiCoreGateTs(useQueue)],
    ['api/src/core/db.ts',          makeApiCoreDbTs(useQueue)],
    ['api/src/core/channels.ts',    makeApiCoreChannelsTs(useAuth)],
    ['api/src/core/principal.ts',   makeApiCorePrincipalTs()],
    ['api/config/junction.config.js', makeJunctionConfig(appName, useWeb, useQueue)],
  )
}

// The audit database declares `retention`, and the sweep that runs it again after
// boot is a job. Without the queue there is nowhere to put one.
if (useQueue) filesToWrite.push(['api/src/jobs/retention.job.ts', makeRetentionJobTs()])

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
    ['web/config/vite.config.js',           makeViteConfig(useApi)],
    ['web/config/sierra.config.js',         makeSierraConfig(appName, useApi)],
    ['web/src/App.mesa',                    makeAppMesa()],
    ['web/src/main.js',                     makeMainJs(useApi)],
    ['web/src/lib/datetime.js',             makeDatetimeJs()],
    ['web/src/lib/sugar.js',                makeSugarJs()],
    ...(useApi ? [['web/src/lib/controls.js', makeControlsJs()]] : []),
    ['web/src/lib/nav.js',                  makeNavJs(useAuth)],
    ['web/src/routes/_module.mesa',         makeRouteModule(appName, useAuth, useApi)],
    ['web/src/routes/index.mesa',           makeRouteIndex(appName, useApi)],
    ['web/src/routes/[...404].mesa',        makeRouteNotFound()],
  )
  if (useAuth) {
    filesToWrite.push(
      ['web/src/routes/login/index.mesa',    makeRouteLogin()],
      ['web/src/routes/register/index.mesa', makeRouteRegister()],
      ['web/src/routes/reset/index.mesa',    makeRouteReset()],
      ['web/src/routes/verify-email/index.mesa', makeRouteVerifyEmail()],
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

// .env (copy of .env.example, gitignored) with ENCRYPTION_KEY filled. env.ts
// requires it with or without --auth, and auth:install is the only other writer,
// so a --no-auth app left blank crashes at load on the first `bun run dev`.
// Hex, because litestone parses this variable as hex.
if (useDb) filesToWrite.push(['.env', makeEnvExample(useAuth)
  .replace(/^ENCRYPTION_KEY=$/m, `ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`)])

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
    root: finalTarget, name: 'HelloWidget', appName,
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
      $.exec({ command: 'bun link', cwd: pkgDir(p), stdio: 'pipe' })
      log.detail(`  → ${p}`)
    } catch (e) {
      log.warn(`  bun link failed for ${p}: ${e.message}`)
    }
  }
}

if (useInstall) {
  try {
    log.info('→ bun install')
    // Piped, and the tail is what comes back out: bun prints a line per package
    // and then the one line anybody reads — how many, how long. Its own
    // failures go to stderr, which is inherited, so a broken install still
    // says so here.
    const out = $.exec({
      command: 'bun install', cwd: finalTarget,
      stdio: verbose ? 'inherit' : ['inherit', 'pipe', 'inherit'],
    })
    const tail = out?.toString().trim().split('\n').filter(Boolean).pop()
    if (tail) log.info(`  ${tail.trim()}`)
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
    runFli($, ['init', '--namespace', appName], finalTarget, 'fli:init', verbose)
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
    runFli($, ['auth:install'], finalTarget, 'auth:install', verbose)
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
    runFli($, ['notifications:install'], finalTarget, 'notifications:install', verbose)
  } catch (e) {
    log.warn(`notifications:install failed: ${e.message} — run it yourself before the first app.notify()`)
  }
}

// User example — scaffold resource + routes around the User model
// Schema already populated by auth:install (or user adds one manually if no-auth)
if (useExample) {
  try {
    runFli($, ['scaffold', 'User', '--skip-schema'], finalTarget, 'make:scaffold User', verbose)
  } catch (e) {
    log.warn(`make:scaffold User failed: ${e.message} — continuing`)
  }
}

// make:deploy — Dockerfile + frontier.config.js deploy block. It containerizes
// the API, so a project with none has nothing for it to write: the widget
// surface ships its own static origin from widgets/deploy/.
if (useDeploy && useApi) {
  try {
    const args = ['make:deploy']
    if (flag.server) args.push('--server', flag.server)
    if (flag.domain) args.push('--domain', flag.domain)
    runFli($, args, finalTarget, 'make:deploy', verbose)
  } catch (e) {
    log.warn(`make:deploy failed: ${e.message} — you can run it manually later`)
  }
}

// workspace:add — move the project into $WORKSPACE_DIR/packages/
// Only if --workspace was set AND we wrote to a temp path (we didn't — we wrote
// directly to the workspace target). So this is a no-op for now; project lives
// in the workspace by virtue of where we wrote it.

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

if (useInstall && useDb) {
  try {
    log.info('→ initial migration')
    $.exec({
      command: `${$.bin('litestone', finalTarget)} migrate create initial --schema db/schema.lite`,
      cwd: finalTarget, stdio: 'pipe',
    })
    // A sub-command above opened a client, and a client builds the tables by
    // auto-DDL and records no history. Left alone the first `fli db:migrate`
    // refuses a database its own initial file builds (FJS-1490). `baseline`
    // records the file as applied and refuses if the database lacks anything
    // the file builds, so it cannot record a lie.
    //
    // A schema whose only model sits on the audit database (--no-auth) is the
    // other case: the client builds no table, `baseline` refuses to record
    // what the database lacks, and a migration file on disk stops the client
    // building tables at start. `apply` builds them.
    if (existsSync(join(finalTarget, 'db/app.db'))) {
      const litestone = $.bin('litestone', finalTarget)
      try {
        $.exec({ command: `${litestone} migrate baseline --schema db/schema.lite`, cwd: finalTarget, stdio: 'pipe' })
      } catch {
        $.exec({ command: `${litestone} migrate apply --schema db/schema.lite`, cwd: finalTarget, stdio: 'pipe' })
      }
    }
  } catch (e) {
    // Not fatal: the app runs from `db push` in development either way, and a
    // scaffold that stops here over a deploy-time concern is the worse trade.
    log.warn(`could not write the initial migration: ${e.message}`)
    log.warn('run `fli db:migrate --create-only` before deploying')
  }
}

// ─── 12c. Git init + initial commit ────────────────────────────────────────────

// After the migration, so the first commit holds it — committed before, the
// scaffold's own migration was the one untracked thing in a fresh repo.

if (useGit) {
  try {
    log.info('→ git init')
    $.exec({ command: 'git init', cwd: finalTarget, stdio: 'pipe' })
    $.exec({ command: 'git add .', cwd: finalTarget, stdio: 'pipe' })
    $.exec({ command: 'git commit -m "init"', cwd: finalTarget, stdio: 'pipe' })
    log.success('Git repository initialized')
  } catch (e) {
    log.warn(`git init step failed: ${e.message} — skipping`)
  }
}

// ─── 13. Summary ──────────────────────────────────────────────────────────────
//
// Everything a reader has to ACT on is an `echo`; everything that explains why
// is `log.detail` and comes back with `--verbose`. The split is not cosmetic —
// the full text is forty lines under a scaffold that already printed a hundred,
// and the two lines that matter (`cd`, `fli dev`) were in the middle of it.

echo('')
log.success(`${appName} created`)
echo('')
echo(`  cd ${useHere ? '.' : (useWorkspace ? finalTarget : name)}`)
if (!useInstall) echo('  bun install')
// `.env` is written with its key filled, so `cp .env.example .env` here would
// overwrite a filled file with a blank one and break the app the scaffold just
// built. The question is whether the key has a VALUE, asked of the file rather
// than assumed from the write.
const envFile = resolve(finalTarget, '.env')
const keySet  = existsSync(envFile) &&
  /^[ \t]*ENCRYPTION_KEY[ \t]*=[ \t]*\S/m.test(readFileSync(envFile, 'utf8'))
if (useApi && !keySet) {
  // --format hex, and it is load-bearing: keygen defaults to base64, litestone
  // parses this variable as HEX, and a base64 key therefore decodes to zero
  // bytes and is refused with a sentence about a key length. Advice that fails
  // when taken is worse than none.
  echo('  fli keygen aes --format hex --name ENCRYPTION_KEY --env   # .env needs a key before the API starts')
}
echo('  fli dev')

// A scaffold with --auth has an empty `user` table, so the login page it just
// wrote can sign nobody in and every screen behind a gate answers
// "Authentication required" — which reads as a broken app rather than an empty
// one. It stays an echo for that reason: it is the difference between the app
// working and not.
if (useAuth) {
  echo('')
  echo('  Nobody exists yet:')
  echo('    fli auth:create-user you@example.com --role admin   mints an ADMIN')
  echo('    /register/ in the browser                           role "user" — the link to finish it prints in the API terminal')
}

echo('')
if (fjsSource === 'local') {
  echo(`  @frontierjs is symlinked from ${packagesDir} — edits are live.`)
  log.detail('  A build packs them into the image rather than resolving the symlinks,')
  log.detail('  which a container cannot do — `fli deploy:local` runs the pack step for')
  log.detail('  you, `fli deploy:vendor` does it alone. What ships is that workspace at')
  log.detail('  the moment you built, so local sources can diverge from a real npm')
  log.detail('  install: do an npm run before publishing either way.')
}
// A scaffolded tree is where somebody who has never seen FrontierJS lands, and
// it answers none of what the seed is FOR. The lessons build their own app, so
// this points somewhere rather than back at the directory it just wrote.
echo('  New to FrontierJS? `fli tutor` — thirteen lessons against a running app.')
log.detail('  They run the real commands and then ask the running world whether they')
log.detail('  worked. They build their own app and leave this one alone.')
echo('  Writing it with an AI agent? AGENTS.md is written for it.')
log.detail('  Claude Code reads it through CLAUDE.md, and your own instructions about')
log.detail('  the app go in AGENTS.project.md, which it imports.')
echo('')
echo('  bun run check           the gate CI runs')
if (useDb) {
  echo('  fli scaffold <Model>    model + service + resource + routes')
  echo('  fli admin:generate      CRUD admin UI from schema.lite')
}
if (useApi) echo('  fli deploy:doctor       deploy readiness')
echo('')
```
