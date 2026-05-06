#!/usr/bin/env bun
// tools/setup.ts
// Junction setup wizard and project audit.
//
// Walks through every prerequisite for running a Junction app,
// checks what's in place, fixes what isn't, and can double as a
// CI audit that exits 1 if anything critical is missing.
//
// ─── Usage ────────────────────────────────────────────────────────────────
//
//   bun run setup                  interactive wizard (new or existing project)
//   bun run setup audit            print audit report, exit 1 on failures
//   bun run setup audit --prod     audit as production (even without NODE_ENV=production)
//   bun run setup audit --json     machine-readable JSON
//
//   From the REPL:
//   setup                          audit inline
//   setup audit                    same

import * as fs      from 'node:fs'
import * as path    from 'node:path'
import * as readline from 'node:readline'

// ─── ANSI ─────────────────────────────────────────────────────────────────

const c = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  gray:     '\x1b[90m',
  bred:     '\x1b[91m',
  bgreen:   '\x1b[92m',
  byellow:  '\x1b[93m',
  bcyan:    '\x1b[96m',
  bwhite:   '\x1b[97m',
}
const paint  = (col: string, t: string) => `${col}${t}${c.reset}`
const ok     = (t: string) => `  ${paint(c.bgreen,  '✓')} ${t}`
const warn   = (t: string) => `  ${paint(c.byellow, '⚠')} ${paint(c.bwhite, t)}`
const fail   = (t: string) => `  ${paint(c.bred,    '✗')} ${paint(c.bwhite, t)}`
const note   = (t: string) => `  ${paint(c.bcyan,   '→')} ${paint(c.gray, t)}`
const dim    = (t: string) => `  ${paint(c.dim + c.gray, t)}`
const header = (t: string) => `\n  ${paint(c.bold + c.bwhite, t)}`
const sep    = () => paint(c.gray, `  ${'─'.repeat(56)}`)

// ─── CLI args ─────────────────────────────────────────────────────────────

const argv    = Bun.argv.slice(2)
const isAudit = argv.includes('audit')
const jsonOut = argv.includes('--json')
const forceProd = argv.includes('--prod')   // treat as production regardless of NODE_ENV
const cwd     = process.cwd()
// isProd: true when NODE_ENV=production OR --prod flag is passed.
// The --prod flag lets you audit any project as if it were production
// without needing to set the environment variable.
const isProd  = forceProd || (process.env.NODE_ENV ?? 'development') === 'production'

// ─── Types ────────────────────────────────────────────────────────────────

type Status = 'ok' | 'warn' | 'fail' | 'skip'

interface CheckResult {
  id:      string
  label:   string
  status:  Status
  detail?: string
  fix?:    string
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const exists    = (p: string) => fs.existsSync(path.join(cwd, p))
const read      = (p: string) => { try { return fs.readFileSync(path.join(cwd, p), 'utf8') } catch { return '' } }
const contains  = (p: string, s: string) => read(p).includes(s)

async function runCmd(cmd: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const proc = Bun.spawn(cmd.split(' '), { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    return { ok: proc.exitCode === 0, out, err }
  } catch {
    return { ok: false, out: '', err: 'command not found' }
  }
}

function findFiles(dir: string, ext: RegExp, exclude = ['node_modules', '.git', 'dist']): string[] {
  const files: string[] = []
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (exclude.some(x => entry === x)) continue
      const full = path.join(dir, entry)
      if (fs.statSync(full).isDirectory()) files.push(...findFiles(full, ext, exclude))
      else if (ext.test(entry)) files.push(full)
    }
  } catch {}
  return files
}

function readJson(p: string): Record<string, unknown> | null {
  try { return JSON.parse(read(p)) } catch { return null }
}

// ─── All checks ───────────────────────────────────────────────────────────

async function runAllChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const add = (r: CheckResult) => { results.push(r); return r }

  // ── 1. Runtime ─────────────────────────────────────────────────────

  const bunResult = await runCmd('bun --version')
  if (!bunResult.ok) {
    add({ id: 'runtime.bun', label: 'Bun runtime', status: 'fail',
      detail: 'bun not found in PATH',
      fix: 'Install from https://bun.sh — curl -fsSL https://bun.sh/install | bash' })
  } else {
    const version = bunResult.out.trim()
    const [major, minor] = version.split('.').map(Number)
    const tooOld = major < 1 || (major === 1 && minor < 0)
    add({ id: 'runtime.bun', label: 'Bun runtime', status: tooOld ? 'warn' : 'ok',
      detail: `v${version}${tooOld ? ' — upgrade recommended (1.0+)' : ''}`,
      fix: tooOld ? 'bun upgrade' : undefined })
  }

  // ── 2. Project structure ────────────────────────────────────────────

  // package.json
  const pkg = readJson('package.json')
  add({ id: 'project.package_json', label: 'package.json', status: pkg ? 'ok' : 'fail',
    detail: pkg ? `name: ${pkg.name ?? '(unnamed)'}` : 'Not found',
    fix: 'run: bun init' })

  // bun run dev script
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>
  const hasDev  = 'dev' in scripts
  add({ id: 'project.dev_script', label: 'bun run dev script',
    status: hasDev ? 'ok' : 'warn',
    detail: hasDev ? scripts.dev : 'No "dev" script in package.json',
    fix: 'Add to package.json scripts: "dev": "bun run --watch src/app.ts"' })

  // config/production.ts
  const hasProdConfig = exists('config/production.ts')
  add({ id: 'project.prod_config', label: 'config/production.ts',
    status: hasProdConfig ? 'ok' : (isProd ? 'warn' : 'skip'),
    detail: hasProdConfig
      ? 'Found — production overrides in place'
      : isProd
        ? 'Missing — CORS, drainTimeout, debug=false not set for production'
        : 'Not created yet (only matters in production)',
    fix: 'Create config/production.ts with CORS origins, debug: false, and drainTimeout' })

  // bun test script
  const hasTest = 'test' in scripts
  add({ id: 'project.test_script', label: 'bun test script',
    status: hasTest ? 'ok' : 'warn',
    detail: hasTest ? scripts.test : 'No "test" script in package.json',
    fix: 'Add: "test": "bun test"' })

  // Config directory
  const hasConfig = exists('config') || exists('config/default.ts')
  add({ id: 'project.config', label: 'config/default.ts',
    status: exists('config/default.ts') ? 'ok' : (exists('config') ? 'warn' : 'fail'),
    detail: exists('config/default.ts') ? 'Found'
          : exists('config') ? 'config/ directory exists but no default.ts'
          : 'config/default.ts not found',
    fix: 'Create config/default.ts (the wizard can scaffold this)' })

  // ── 3. Config correctness ───────────────────────────────────────────

  const configSrc = read('config/default.ts')

  // auth.secret — check it's not the demo value and not hardcoded
  const hasAuthSecret = configSrc.includes('auth') && configSrc.includes('secret')
  if (!hasAuthSecret) {
    add({ id: 'config.auth_secret', label: 'auth.secret configured',
      status: 'fail',
      detail: 'auth.secret not found in config/default.ts',
      fix: 'Add: auth: { secret: process.env.AUTH_SECRET ?? "change-me", sessionExpiry: "7d" }' })
  } else {
    const weakPatterns = ['demo-secret', 'change-in-prod', 'change-me', 'secret123', 'password']
    const isHardcoded  = !configSrc.includes('process.env.AUTH_SECRET')
    const isWeak       = weakPatterns.some(p => configSrc.includes(p))

    if (isProd && (isHardcoded || isWeak)) {
      add({ id: 'config.auth_secret', label: 'auth.secret configured',
        status: 'fail',
        detail: isHardcoded ? 'Secret is hardcoded — use process.env.AUTH_SECRET in production'
                            : 'Weak/demo secret detected in production',
        fix: 'export AUTH_SECRET="$(openssl rand -hex 32)"  and reference it in config' })
    } else if (isWeak) {
      add({ id: 'config.auth_secret', label: 'auth.secret configured',
        status: 'warn',
        detail: 'Default/demo secret detected — fine for dev, must change before production',
        fix: 'Set AUTH_SECRET env var to a random 32+ byte value' })
    } else {
      add({ id: 'config.auth_secret', label: 'auth.secret configured', status: 'ok',
        detail: isHardcoded ? 'Set (hardcoded)' : 'Set via process.env.AUTH_SECRET' })
    }
  }

  // database.url
  const dbInConfig   = configSrc.includes('database') && configSrc.includes('url')
  const dbInEnv      = !!process.env.DATABASE_URL
  add({ id: 'config.database_url', label: 'database.url',
    status: (dbInConfig || dbInEnv) ? 'ok' : 'warn',
    detail: dbInEnv ? `DATABASE_URL set in environment`
          : dbInConfig ? 'Configured in config/default.ts'
          : 'Not found in config or environment — app will run without persistence',
    fix: 'Add database: { url: process.env.DATABASE_URL ?? "file:./app.db" } to config' })

  // port
  const hasPort = configSrc.includes('port')
  add({ id: 'config.port', label: 'port configured',
    status: hasPort ? 'ok' : 'warn',
    detail: hasPort ? `Found in config` : 'No port in config — will default to 3000',
    fix: 'Add port: 3000 to config/default.ts' })

  // ── 4. Environment ──────────────────────────────────────────────────

  // .env file
  const hasEnvFile = exists('.env') || exists('.env.local')
  add({ id: 'env.file', label: '.env file',
    status: hasEnvFile ? 'ok' : 'warn',
    detail: hasEnvFile ? (exists('.env') ? '.env' : '.env.local')
          : 'No .env file — environment variables must be set another way',
    fix: 'Create .env with AUTH_SECRET and DATABASE_URL' })

  // .gitignore covers .env
  if (hasEnvFile) {
    const gitignore    = read('.gitignore')
    const envIgnored   = gitignore.includes('.env') || gitignore.includes('*.env')
    add({ id: 'env.gitignore', label: '.env in .gitignore',
      status: envIgnored ? 'ok' : 'fail',
      detail: envIgnored ? '.env is ignored' : '.env is NOT in .gitignore — risk of committing secrets',
      fix: 'Add .env to .gitignore' })
  }

  // AUTH_SECRET env var
  add({ id: 'env.auth_secret', label: 'AUTH_SECRET env var',
    status: process.env.AUTH_SECRET ? 'ok' : (isProd ? 'fail' : 'warn'),
    detail: process.env.AUTH_SECRET ? 'Set' : `Not set${isProd ? ' — required in production' : ''}`,
    fix: 'export AUTH_SECRET="$(openssl rand -hex 32)"' })

  // NODE_ENV
  add({ id: 'env.node_env', label: 'NODE_ENV',
    status: process.env.NODE_ENV ? 'ok' : 'warn',
    detail: process.env.NODE_ENV ?? 'Not set — defaulting to development',
    fix: 'export NODE_ENV=production  (or development)' })

  // ── 5. App entry point ──────────────────────────────────────────────

  // Find files that call createApp()
  const srcFiles   = findFiles(cwd, /\.(ts|js)$/)
  const appFiles   = srcFiles.filter(f => contains(f, 'createApp('))
  const startFiles = srcFiles.filter(f => contains(f, 'app.start()'))

  add({ id: 'app.create', label: 'createApp() found',
    status: appFiles.length > 0 ? 'ok' : 'fail',
    detail: appFiles.length > 0
      ? appFiles.map(f => path.relative(cwd, f)).join(', ')
      : 'No file calls createApp() — app entry point not found',
    fix: 'Create an app.ts that calls createApp({ config, auth })' })

  add({ id: 'app.start', label: 'app.start() called',
    status: startFiles.length > 0 ? 'ok' : 'fail',
    detail: startFiles.length > 0
      ? startFiles.map(f => path.relative(cwd, f)).join(', ')
      : 'No file calls app.start()',
    fix: 'Add await app.start() at the end of your app entry point' })

  // ── 6. Services ─────────────────────────────────────────────────────

  const serviceFiles    = srcFiles.filter(f => contains(f, 'createService('))
  const registerFiles   = srcFiles.filter(f => contains(f, 'services.register(') || contains(f, 'app.services.register('))

  add({ id: 'services.defined', label: 'Services defined',
    status: serviceFiles.length > 0 ? 'ok' : 'warn',
    detail: serviceFiles.length > 0
      ? `${serviceFiles.length} file${serviceFiles.length > 1 ? 's' : ''} call createService()`
      : 'No services defined yet',
    fix: "import { createService } from '@frontierjs/junction'\nconst app = createService({ name: 'users', ... })" })

  add({ id: 'services.registered', label: 'Services registered',
    status: registerFiles.length > 0 ? 'ok' : (serviceFiles.length > 0 ? 'fail' : 'warn'),
    detail: registerFiles.length > 0
      ? `app.services.register() called in ${registerFiles.map(f => path.relative(cwd, f)).join(', ')}`
      : serviceFiles.length > 0 ? 'Services defined but never registered with app.services.register()'
      : 'No services registered',
    fix: 'app.services.register(createUsersService(app))' })

  // ── 7. Auth ────────────────────────────────────────────────────────

  const authPassedFiles = srcFiles.filter(f => {
    const src = read(f)
    return src.includes('createApp(') && src.includes('auth')
  })
  add({ id: 'auth.configured', label: 'auth passed to createApp()',
    status: authPassedFiles.length > 0 ? 'ok' : 'warn',
    detail: authPassedFiles.length > 0 ? 'Found' : 'No auth implementation found — routes will have no session',
    fix: 'Pass an IAuth implementation: createApp({ config, auth: myAuth })' })

  // Warn if using stub/demo auth in production
  if (isProd) {
    const demoAuthFiles = srcFiles.filter(f => {
      const src = read(f)
      return src.includes('createStubAuth') || src.includes('verifyDemoToken') || src.includes('demo-admin-token')
    })
    if (demoAuthFiles.length > 0) {
      add({ id: 'auth.production', label: 'Auth is production-safe',
        status: 'fail',
        detail: `Demo/stub auth found in: ${demoAuthFiles.map(f => path.relative(cwd, f)).join(', ')}`,
        fix: 'Replace with createBetterAuthAdapter() or a real IAuth implementation' })
    } else {
      add({ id: 'auth.production', label: 'Auth is production-safe', status: 'ok', detail: 'No demo auth detected' })
    }
  }

  // ── 8. Security ────────────────────────────────────────────────────

  // CORS origins — warn if ['*'] in production
  const corsOpen = configSrc.includes("'*'") || configSrc.includes('"*"')
  add({ id: 'security.cors', label: 'CORS origins',
    status: (corsOpen && isProd) ? 'fail' : (corsOpen ? 'warn' : 'ok'),
    detail: corsOpen
      ? `Origins set to ['*']${isProd ? ' — dangerous in production' : ' — fine for development'}`
      : 'Specific origins configured',
    fix: corsOpen ? "Change cors.origins to your actual frontend domain(s)" : undefined })

  // Rate limiting
  const rateLimitFiles = srcFiles.filter(f => contains(f, 'rateLimit('))
  add({ id: 'security.rate_limit', label: 'Rate limiting',
    status: rateLimitFiles.length > 0 ? 'ok' : (isProd ? 'warn' : 'skip'),
    detail: rateLimitFiles.length > 0 ? 'rateLimit() configured'
          : isProd ? 'Not configured — recommended for production' : 'Not configured',
    fix: "app.configure(rateLimit({ limit: 100, window: 60_000 }))" })

  // Auth secret strength (only if AUTH_SECRET is set)
  if (process.env.AUTH_SECRET) {
    const secret = process.env.AUTH_SECRET
    const isStrong = secret.length >= 32
    add({ id: 'security.secret_strength', label: 'AUTH_SECRET strength',
      status: isStrong ? 'ok' : 'fail',
      detail: isStrong ? `${secret.length} characters (good)` : `Only ${secret.length} characters — use at least 32`,
      fix: 'export AUTH_SECRET="$(openssl rand -hex 32)"' })
  }

  // ── 9. Production readiness ─────────────────────────────────────────
  // Only surface these as warnings/fails when NODE_ENV=production.
  // In development they're informational.

  const prodStatus = (found: boolean): Status =>
    found ? 'ok' : (isProd ? 'warn' : 'skip')

  const healthFiles  = srcFiles.filter(f => contains(f, 'healthPlugin'))
  // Only flag healthPlugin missing if it's not in *any* source file —
  // it might be imported in a separate plugin file, not the app entry point.
  const healthConfigured = healthFiles.length > 0
  const healthInEntry    = appFiles.some(f => contains(f, 'healthPlugin'))
  add({ id: 'prod.health', label: 'healthPlugin configured',
    status: healthConfigured ? 'ok' : prodStatus(false),
    detail: healthConfigured
      ? healthInEntry
        ? 'Configured in app entry point'
        : `Configured (in ${healthFiles.map(f => path.relative(cwd, f)).join(', ')})`
      : isProd
        ? 'Not configured — load balancers and k8s need /health and /metrics'
        : 'Not configured (optional in dev)',
    fix: "app.configure(healthPlugin())" })

  const corrFiles = srcFiles.filter(f => contains(f, 'correlationId'))
  add({ id: 'prod.correlation', label: 'correlationId middleware',
    status: prodStatus(corrFiles.length > 0),
    detail: corrFiles.length > 0 ? 'Found' : isProd ? 'Not configured — X-Request-ID helps trace errors' : 'Not configured (optional in dev)',
    fix: "app.configure(correlationId())" })

  const logFiles = srcFiles.filter(f => contains(f, 'requestLogger'))
  add({ id: 'prod.request_logger', label: 'requestLogger middleware',
    status: prodStatus(logFiles.length > 0),
    detail: logFiles.length > 0 ? 'Found' : isProd ? 'Not configured — no access log in production' : 'Not configured (optional in dev)',
    fix: "app.configure(requestLogger())" })

  const drainFiles = srcFiles.filter(f => contains(f, 'drainTimeout'))
  add({ id: 'prod.drain_timeout', label: 'drainTimeout configured',
    status: prodStatus(drainFiles.length > 0),
    detail: drainFiles.length > 0 ? 'Found' : isProd ? 'Not set — app will cut off in-flight requests on shutdown' : 'Not set (optional in dev)',
    fix: "Add http: { drainTimeout: 5000 } to config" })

  // ── 10. Tests ──────────────────────────────────────────────────────

  const testFiles = findFiles(cwd, /\.(test|spec)\.(ts|js)$/)
  add({ id: 'tests.exists', label: 'Test files',
    status: testFiles.length > 0 ? 'ok' : 'warn',
    detail: testFiles.length > 0
      ? `${testFiles.length} test file${testFiles.length > 1 ? 's' : ''}`
      : 'No test files found',
    fix: 'Create tests/ directory and add *.test.ts files' })

  return results
}

// ─── Audit mode ───────────────────────────────────────────────────────────

async function runAudit(compact = false): Promise<void> {
  const results  = await runAllChecks()

  if (jsonOut) {
    console.log(JSON.stringify(results, null, 2))
    process.exit(results.filter(r => r.status === 'fail').length > 0 ? 1 : 0)
  }

  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const r of results) counts[r.status]++

  const groups: Record<string, CheckResult[]> = {}
  for (const r of results) {
    const g = r.id.split('.')[0]
    if (!groups[g]) groups[g] = []
    groups[g].push(r)
  }

  const groupNames: Record<string, string> = {
    runtime:  'Runtime',
    project:  'Project structure',
    config:   'Config',
    env:      'Environment',
    app:      'App entry point',
    services: 'Services',
    auth:     'Auth',
    security: 'Security',
    prod:     isProd ? 'Production readiness' : 'Production readiness (skipped in dev)',
    tests:    'Tests',
  }

  if (!compact) {
    console.log()
    console.log(`  ${paint(c.bold + c.bwhite, 'Junction project audit')}  ${paint(c.gray, cwd)}`)
    const envLabel = forceProd && !process.env.NODE_ENV
    ? 'NODE_ENV=production (--prod)'
    : isProd ? 'NODE_ENV=production' : 'NODE_ENV=development'
  console.log(`  ${paint(c.gray, envLabel)}`)
    console.log(sep())
  }

  for (const [group, checks] of Object.entries(groups)) {
    if (!compact) console.log(header(groupNames[group] ?? group))
    for (const r of checks) {
      if (compact && r.status === 'ok') continue  // only show problems in compact mode
      const line =
        r.status === 'ok'   ? ok(paint(c.gray, r.label))
      : r.status === 'warn' ? warn(r.label)
      : r.status === 'fail' ? fail(r.label)
      :                       dim(`${r.label}  (skipped)`)
      console.log(line)
      if (r.detail && r.status !== 'ok')  console.log(dim(`    ${r.detail}`))
      if (r.fix    && r.status === 'fail') console.log(note(`    Fix: ${r.fix}`))
    }
  }

  console.log()
  console.log(sep())
  const parts = [
    counts.ok   ? paint(c.bgreen,  `${counts.ok} passed`)    : '',
    counts.warn ? paint(c.byellow, `${counts.warn} warnings`) : '',
    counts.fail ? paint(c.bred,    `${counts.fail} failed`)   : '',
    counts.skip ? paint(c.gray,    `${counts.skip} skipped`)  : '',
  ].filter(Boolean)
  console.log(`  ${parts.join('   ')}`)

  if (counts.fail === 0 && counts.warn === 0) {
    console.log()
    console.log(`  ${paint(c.bgreen, '★')} ${paint(c.bwhite, 'Project is fully configured!')}`)
  }
  console.log()

  if (!compact) process.exit(counts.fail > 0 ? 1 : 0)
}

// ─── Wizard ───────────────────────────────────────────────────────────────

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
const ask = (q: string): Promise<string> =>
  new Promise(res => rl.question(`  ${paint(c.bcyan, '?')} ${q} `, res))
const confirm = async (q: string, def = false): Promise<boolean> => {
  const label = def ? '[Y/n]' : '[y/N]'
  const ans   = await ask(`${q} ${paint(c.gray, label)}`)
  const t = ans.trim().toLowerCase()
  return t === '' ? def : t === 'y'
}

async function runWizard(): Promise<void> {
  console.log()
  console.log(sep())
  console.log(`  ${paint(c.bold + c.bwhite, 'Junction setup wizard')}`)
  console.log(sep())
  console.log(paint(c.gray, `
  Checks every prerequisite for running a Junction app.
  For each issue: explains what's needed and helps you fix it.
`))

  // ── Detect new vs existing project ────────────────────────────────

  const isNewProject = !exists('package.json')

  if (isNewProject) {
    console.log(`  ${paint(c.byellow, '⚠')} ${paint(c.bwhite, 'No package.json found — looks like a new project.')}`)
    console.log()
    const scaffold = await confirm('Scaffold a new Junction project here?', true)
    if (scaffold) {
      await scaffoldNewProject()
      console.log()
      console.log(`  ${paint(c.bgreen, '✓')} ${paint(c.bwhite, 'Project scaffolded! Re-running checks...')}`)
      console.log()
    }
  }

  // ── Run full audit first ───────────────────────────────────────────

  console.log(header('Running checks...'))
  console.log()

  const results  = await runAllChecks()
  const failures = results.filter(r => r.status === 'fail')
  const warnings = results.filter(r => r.status === 'warn')

  // Print summary inline
  for (const r of results) {
    if (r.status === 'skip') continue
    const line =
      r.status === 'ok'   ? ok(paint(c.gray, r.label))
    : r.status === 'warn' ? warn(r.label)
    :                       fail(r.label)
    console.log(line)
    if (r.detail && r.status !== 'ok') console.log(dim(`    ${r.detail}`))
  }

  console.log()
  console.log(sep())
  const counts = { ok: 0, warn: 0, fail: 0 }
  for (const r of results) if (r.status in counts) counts[r.status as keyof typeof counts]++
  console.log(`  ${[
    counts.ok   ? paint(c.bgreen,  `${counts.ok} passing`)   : '',
    counts.warn ? paint(c.byellow, `${counts.warn} warnings`) : '',
    counts.fail ? paint(c.bred,    `${counts.fail} failing`)  : '',
  ].filter(Boolean).join('   ')}`)
  console.log()

  if (failures.length === 0 && warnings.length === 0) {
    console.log(`  ${paint(c.bgreen, '★')} ${paint(c.bwhite, 'Everything is set up correctly!')}`)
    console.log()
    printNextSteps()
    rl.close()
    return
  }

  // ── Walk through fixes ─────────────────────────────────────────────

  const toFix = [...failures, ...warnings].filter(r => r.fix)
  if (!toFix.length) { rl.close(); return }

  console.log()
  console.log(paint(c.gray, `  Let's fix ${toFix.length} issue${toFix.length > 1 ? 's' : ''}.`))
  console.log()

  for (const result of toFix) {
    console.log()
    console.log(`  ${result.status === 'fail' ? paint(c.bred, '✗') : paint(c.byellow, '⚠')} ${paint(c.bwhite, result.label)}`)
    if (result.detail) console.log(dim(`    ${result.detail}`))
    console.log()

    switch (result.id) {

      case 'runtime.bun': {
        console.log(note('Run to upgrade:'))
        console.log(dim('    bun upgrade'))
        await ask('Press enter when done')
        break
      }

      case 'project.package_json': {
        const init = await confirm('Run bun init to create package.json?', true)
        if (init) {
          const name = await ask('Project name (e.g. my-api) [my-api]')
          const r    = await runCmd(`bun init -y`)
          if (!r.ok) await runCmd('bun init -y')
          if (name.trim()) {
            const pkg = readJson('package.json') ?? {}
            pkg.name  = name.trim() || 'my-api'
            fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(pkg, null, 2))
          }
          console.log(ok('package.json created'))
        }
        break
      }

      case 'project.config': {
        const create = await confirm('Create config/default.ts with sensible defaults?', true)
        if (create) {
          const appName  = await ask('App name [my-api]')
          const port     = await ask('Port [3000]')
          const frontendUrl = await ask('Production frontend URL (for CORS) [https://yourapp.com]')
          writeConfigFile(appName.trim() || 'my-api', parseInt(port.trim() || '3000', 10))
          writeProductionConfig([(frontendUrl.trim() || 'https://yourapp.com')])
          console.log(ok('config/default.ts created'))
          console.log(ok('config/production.ts created'))
        }
        break
      }

      case 'config.auth_secret': {
        console.log(note('Generate a strong secret and add to your environment:'))
        console.log(dim('    export AUTH_SECRET="$(openssl rand -hex 32)"'))
        console.log()
        console.log(note('Then reference it in config/default.ts:'))
        console.log(dim('    auth: { secret: process.env.AUTH_SECRET ?? "fallback-dev-only" }'))
        console.log()
        const addEnv = await confirm('Append AUTH_SECRET placeholder to .env?')
        if (addEnv) {
          const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join('')
          appendEnv('AUTH_SECRET', secret)
          console.log(ok('.env updated with generated AUTH_SECRET'))
          console.log(paint(c.byellow, `  ⚠ Treat this as a secret — keep it out of source control`))
        }
        break
      }

      case 'config.database_url': {
        const dbType = await ask('Database type? (sqlite / postgres / mysql) [sqlite]')
        const db     = dbType.trim().toLowerCase() || 'sqlite'
        const url    = db === 'postgres' ? 'postgresql://user:pass@localhost:5432/mydb'
                     : db === 'mysql'    ? 'mysql://user:pass@localhost:3306/mydb'
                     : 'file:./app.db'
        const addEnv = await confirm(`Add DATABASE_URL="${url}" to .env?`, true)
        if (addEnv) {
          appendEnv('DATABASE_URL', url)
          console.log(ok('.env updated'))
          if (db !== 'sqlite') console.log(note('Update the credentials before using'))
        }
        break
      }

      case 'env.file': {
        const create = await confirm('Create .env file?', true)
        if (create) {
          if (!exists('.env')) {
            fs.writeFileSync(path.join(cwd, '.env'), '# Junction environment variables\n')
            console.log(ok('.env created'))
          } else {
            console.log(ok('.env already exists'))
          }
        }
        break
      }

      case 'env.gitignore': {
        const add = await confirm('Add .env to .gitignore?', true)
        if (add) {
          const gitignorePath = path.join(cwd, '.gitignore')
          const existing      = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : ''
          fs.writeFileSync(gitignorePath, existing + '\n.env\n.env.local\n')
          console.log(ok('.gitignore updated'))
        }
        break
      }

      case 'env.auth_secret': {
        const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map(b => b.toString(16).padStart(2, '0')).join('')
        const addEnv = await confirm('Generate AUTH_SECRET and add to .env?', true)
        if (addEnv) {
          appendEnv('AUTH_SECRET', secret)
          console.log(ok('.env updated'))
        } else {
          console.log(note(`Run: export AUTH_SECRET="${secret}"`))
        }
        break
      }

      case 'app.create': {
        const create = await confirm('Create a starter app.ts entry point?', true)
        if (create) {
          writeAppEntryPoint()
          console.log(ok('app.ts created'))
          console.log(note('Edit it to add your services and configuration'))
        }
        break
      }

      case 'services.defined':
      case 'services.registered': {
        const create = await confirm('Create a starter service (e.g. users)?')
        if (create) {
          const name = await ask('Service name [users]')
          writeStarterService(name.trim() || 'users')
          console.log(ok(`${name.trim() || 'users'} service created`))
          console.log(note("Register it in app.ts: app.services.register(createUsersService(app))"))
        }
        break
      }

      case 'auth.configured': {
        console.log(note('Add auth to createApp():'))
        console.log(dim(`
    import type { IAuth } from '@frontierjs/junction'

    const auth: IAuth = {
      async verifySession(token) {
        // look up the token and return a SessionContext (or null)
        return { userId: '...', role: 'user', userType: 'user',
                 authMethod: 'session', scopes: [] }
      },
      // implement other methods or use createBetterAuthAdapter()
    }

    const app = createApp({ config, auth })`))
        console.log()
        await ask('Press enter when done')
        break
      }

      case 'security.cors': {
        console.log(note('In config/production.ts, restrict CORS to your domain:'))
        console.log(dim(`
    export default {
      http: {
        cors: {
          origins: ['https://yourapp.com'],
        },
      },
    }`))
        console.log()
        await ask('Press enter when done')
        break
      }

      case 'security.rate_limit': {
        console.log(note('Add to your app setup:'))
        console.log(dim("    import { rateLimit } from '@frontierjs/junction'"))
        console.log(dim("    app.configure(rateLimit({ limit: 100, window: 60_000 }))"))
        console.log()
        await ask('Press enter when done')
        break
      }

      case 'security.secret_strength': {
        console.log(note('Generate a stronger secret:'))
        console.log(dim('    export AUTH_SECRET="$(openssl rand -hex 32)"'))
        await ask('Press enter when done')
        break
      }

      case 'prod.health': {
        console.log(note('Add to your app setup:'))
        console.log(dim("    import { healthPlugin } from '@frontierjs/junction'"))
        console.log(dim("    app.configure(healthPlugin())"))
        await ask('Press enter when done')
        break
      }

      case 'prod.correlation': {
        console.log(note('Add to your app setup:'))
        console.log(dim("    import { correlationId } from '@frontierjs/junction'"))
        console.log(dim("    app.configure(correlationId())"))
        await ask('Press enter when done')
        break
      }

      case 'prod.request_logger': {
        console.log(note('Add to your app setup:'))
        console.log(dim("    import { requestLogger } from '@frontierjs/junction'"))
        console.log(dim("    app.configure(requestLogger())"))
        await ask('Press enter when done')
        break
      }

      case 'prod.drain_timeout': {
        console.log(note('Add to config/default.ts:'))
        console.log(dim("    http: { drainTimeout: 5000, ... }"))
        await ask('Press enter when done')
        break
      }

      case 'project.prod_config': {
        const domain = await ask('Production frontend URL (for CORS) [https://yourapp.com]')
        writeProductionConfig([(domain.trim() || 'https://yourapp.com')])
        console.log(ok('config/production.ts created'))
        console.log(note('Edit it to set your actual domain and any other production overrides'))
        break
      }

      case 'tests.exists': {
        const create = await confirm('Create a starter test file?')
        if (create) {
          if (!exists('tests')) fs.mkdirSync(path.join(cwd, 'tests'))
          writeStarterTest()
          console.log(ok('tests/app.test.ts created'))
          console.log(note('Run: bun test'))
        }
        break
      }

      default:
        if (result.fix) {
          console.log(note(result.fix))
          await ask('Press enter when done')
        }
    }
  }

  // ── Re-check and show final state ─────────────────────────────────

  console.log()
  console.log(header('Re-checking...'))
  console.log()

  const final    = await runAllChecks()
  const stillBad = final.filter(r => r.status === 'fail' || r.status === 'warn')

  for (const r of final) {
    if (r.status === 'skip') continue
    const line = r.status === 'ok' ? ok(paint(c.gray, r.label))
               : r.status === 'warn' ? warn(r.label)
               : fail(r.label)
    console.log(line)
  }

  console.log()
  console.log(sep())

  if (stillBad.length === 0) {
    console.log()
    console.log(`  ${paint(c.bgreen, '★')} ${paint(c.bwhite, 'Everything is set up!')}`)
    console.log()
    printNextSteps()
  } else {
    console.log()
    console.log(`  ${paint(c.byellow, `${stillBad.length} item${stillBad.length > 1 ? 's' : ''} still need attention`)}`)
    console.log()
    console.log(note('Re-run any time: bun run setup'))
  }
  console.log()
  rl.close()
}

// ─── File scaffolding helpers ─────────────────────────────────────────────

function writeConfigFile(name: string, port: number): void {
  if (!exists('config')) fs.mkdirSync(path.join(cwd, 'config'))
  fs.writeFileSync(path.join(cwd, 'config/default.ts'), `// config/default.ts
export default {
  name:     '${name}',
  version:  '1.0.0',
  port:     ${port},
  debug:    true,

  auth: {
    secret:        process.env.AUTH_SECRET ?? 'change-me-in-production',
    sessionExpiry: '7d',
  },

  database: {
    url: process.env.DATABASE_URL ?? 'file:./app.db',
    log: false,
  },

  http: {
    maxBodySize: 256 * 1024,
    compress:    true,
    cors: {
      origins: ['*'],  // TODO: restrict in production
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      headers: ['Content-Type', 'Authorization', 'X-API-Key'],
    },
    ddos: { enabled: false, limit: 100, window: 60_000 },
    powered: '${name}',
  },

  cache: {
    defaultTtl: '5 minutes',
    maxSize:    10_000,
  },
}
`)
}

function writeProductionConfig(origins: string[]): void {
  if (!exists('config')) fs.mkdirSync(path.join(cwd, 'config'))
  if (exists('config/production.ts')) return  // don't overwrite

  const originList = origins.length
    ? origins.map(o => `'${o}'`).join(', ')
    : "'https://yourapp.com'"

  fs.writeFileSync(path.join(cwd, 'config/production.ts'), `// config/production.ts
// Overrides applied only when NODE_ENV=production.
// Keep secrets in environment variables — never hardcode them here.
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
    drainTimeout: 5_000,  // ms to drain in-flight requests on shutdown
  },
}
`)
}

function writeAppEntryPoint(): void {
  fs.writeFileSync(path.join(cwd, 'app.ts'), `import {
  createApp, loadConfig,
  healthPlugin, correlationId, requestLogger,
} from '@frontierjs/junction'

// Load config from ./config/default.ts
const config = await loadConfig('./config')

// TODO: Replace with your auth implementation
// import { createBetterAuthAdapter } from '@frontierjs/junction'
const auth = undefined

const app = createApp({ config, auth })

// ── Plugins ────────────────────────────────────────────────────────
app.configure(correlationId())
app.configure(requestLogger())
app.configure(healthPlugin())

// ── Services ───────────────────────────────────────────────────────
// app.services.register(createUsersService(app))

// ── Routes ─────────────────────────────────────────────────────────
app.get('/', ctx => ctx.json({
  name:    config.name,
  version: config.version,
  health:  '/health',
  docs:    '/api/docs',
}))

await app.start()
`)
}

function writeStarterService(name: string): void {
  const pascal = name.charAt(0).toUpperCase() + name.slice(1)
  if (!exists('services')) fs.mkdirSync(path.join(cwd, 'services'))
  fs.writeFileSync(path.join(cwd, `services/${name}.service.ts`), `import {
  createService, createSchema, v,
  NotFound, authenticate,
} from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'

interface ${pascal} {
  id:         string
  name:       string
  createdAt:  string
}

const store = new Map<string, ${pascal}>()

const Create${pascal}Schema = createSchema({
  name: v.required.string({ minLength: 1, maxLength: 100, trim: true }),
})

export function create${pascal}Service(_app: App) {
  return createService({
    name: '${name}',

    async find() {
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
      const updated = { ...item, ...ctx.data, id: item.id }
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
`)
}

function writeStarterTest(): void {
  fs.writeFileSync(path.join(cwd, 'tests/app.test.ts'), `import { describe, it, expect } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'

describe('App', () => {

  it('responds to health check', async () => {
    const { healthPlugin } = await import('@frontierjs/junction')
    const { createService } = await import('@frontierjs/junction')
    const app = await createTestApp({
      services: [() => createService({ name: 'items', find: async () => [] })],
    })
    app.configure(healthPlugin())
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).status).toBe('ok')
  })

  it('returns 404 for unknown routes', async () => {
    const { createService } = await import('@frontierjs/junction')
    const app = await createTestApp({
      services: [() => createService({ name: 'items', find: async () => [] })],
    })
    const res = await request(app).get('/does-not-exist')
    expect(res.status).toBe(404)
  })
})
`)
}

async function scaffoldNewProject(): Promise<void> {
  const name   = await ask('Project name [my-api]')
  const port   = await ask('Port [3000]')
  const n      = name.trim() || 'my-api'
  const p      = parseInt(port.trim() || '3000', 10)

  // package.json
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name:    n,
    version: '0.1.0',
    type:    'module',
    scripts: {
      dev:   'bun run --watch app.ts',
      start: 'NODE_ENV=production bun run app.ts',
      test:  'bun test',
      repl:  'bun run node_modules/@frontierjs/junction/tools/repl.ts',
      setup: 'bun run node_modules/@frontierjs/junction/tools/setup.ts',
    },
    dependencies: {},
    devDependencies: {},
  }, null, 2))

  // .env
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  fs.writeFileSync(path.join(cwd, '.env'),
    `AUTH_SECRET="${secret}"\nDATABASE_URL="file:./app.db"\nNODE_ENV=development\n`)

  // .gitignore
  fs.writeFileSync(path.join(cwd, '.gitignore'),
    `.env\n.env.local\nnode_modules/\ndist/\n*.db\n`)

  writeConfigFile(n, p)
  writeProductionConfig(['https://yourapp.com'])
  writeAppEntryPoint()
  if (!exists('tests')) fs.mkdirSync(path.join(cwd, 'tests'))
  writeStarterTest()

  console.log()
  console.log(ok('package.json'))
  console.log(ok('config/default.ts'))
  console.log(ok('config/production.ts'))
  console.log(ok('app.ts'))
  console.log(ok('tests/app.test.ts'))
  console.log(ok('.env (with generated AUTH_SECRET)'))
  console.log(ok('.gitignore'))
}

function appendEnv(key: string, value: string): void {
  const envPath = path.join(cwd, '.env')
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  if (existing.includes(`${key}=`)) return  // don't duplicate
  fs.appendFileSync(envPath, `${key}="${value}"\n`)
}

function printNextSteps(): void {
  console.log(note('Next steps:'))
  console.log(dim('  bun run dev              start the app with --watch'))
  console.log(dim('  bun test                 run the test suite'))
  console.log(dim('  bun run repl             open the interactive REPL'))
  console.log(dim('  bun run setup audit      re-audit any time'))
  console.log()
}

// ─── Entry point ──────────────────────────────────────────────────────────

if (isAudit) {
  await runAudit(false)
} else {
  await runWizard()
}
