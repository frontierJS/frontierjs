/*
 * test/new-scaffold.test.js
 *
 * Two ways `fli new` failed its own output, both found by the ELA stressor's
 * first command. `--widgets` handed `scaffoldWidgetSurface` a one-word name
 * under an empty prefix, which its tag guard refuses, so the scaffold stopped
 * half-written. And the first commit ran before the initial migration was
 * written, so a fresh repo opened with `db/migrations/` untracked.
 */

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs'
import { Database } from 'bun:sqlite'
import { join }   from 'path'
import { tmpdir } from 'os'

import { scaffoldWidgetSurface, widgetTag, isLegalWidgetTag } from '../core/widget-surface.js'

const NEW_MD = readFileSync(join(import.meta.dir, '../commands/project/new.md'), 'utf8')
const roots = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

test('the widget `fli new --widgets` names is a tag a browser will register', () => {
  const call = NEW_MD.match(/scaffoldWidgetSurface\(\{[^}]*name:\s*'([^']+)'/)
  expect(call).not.toBeNull()
  expect(isLegalWidgetTag(widgetTag(call[1], ''))).toBe(true)
})

test('scaffoldWidgetSurface with no name scaffolds rather than refusing', () => {
  const root = mkdtempSync(join(tmpdir(), 'fjs-new-widget-'))
  roots.push(root)
  const { written } = scaffoldWidgetSurface({ root })
  expect(written.length).toBeGreaterThan(0)
  expect(existsSync(join(root, 'widgets/src/Embeds/HelloWidget.mesa'))).toBe(true)
})

// FJS-1990: importing a .mesa mounts nothing, so a dev.js that only imported
// the starter widget showed an empty tag and no error.
test('the dev harness entry loads the module that embeds every widget', () => {
  const root = mkdtempSync(join(tmpdir(), 'fjs-new-widget-dev-'))
  roots.push(root)
  scaffoldWidgetSurface({ root })
  const dev = readFileSync(join(root, 'widgets/src/dev.js'), 'utf8')
  expect(dev).toContain("import 'virtual:sierra-widgets'")
})

test('the first commit comes after the initial migration is written', () => {
  const migration = NEW_MD.indexOf("migrate create initial")
  const commit    = NEW_MD.indexOf("git commit -m")
  expect(migration).toBeGreaterThan(-1)
  expect(commit).toBeGreaterThan(migration)
})

// FJS-1480 — the scaffold declares `retention 90d` on the audit database, and
// litestone sweeps once inside createClient. A server that stays up needs the
// queue to run it again, so a caravan app is given the job that does.
import { spawnSync } from 'child_process'

const scaffold = (name, ...flags) => {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-new-retention-'))
  roots.push(dir)
  const r = spawnSync(process.execPath, [join(import.meta.dir, '../bin/fli.js'), 'new', name, ...flags,
    '--yes', '--no-install', '--no-git', '--source', 'local'], { cwd: dir, encoding: 'utf8' })
  expect(r.status).toBe(0)
  return join(dir, name)
}

test('a caravan app is scaffolded with the job that runs its declared retention', () => {
  const app = scaffold('with-queue', '--full')
  const job = join(app, 'api/src/jobs/retention.job.ts')
  expect(existsSync(job)).toBe(true)
  expect(readFileSync(job, 'utf8')).toContain('$retain()')
  expect(readFileSync(join(app, 'api/src/core/db.ts'), 'utf8')).toMatch(/export const sys\s*=\s*db\.asSystem\(\)/)
  expect(readFileSync(join(app, 'api/src/app.ts'), 'utf8')).toContain('createCaravan')
  expect(readFileSync(join(app, 'api/config/junction.config.js'), 'utf8')).toMatch(/jobsDir:\s*here\('\.\.\/src\/jobs'\)/)
}, 60_000)

test('an app with no queue gets no job it could not run', () => {
  const app = scaffold('no-queue', '--minimal')
  expect(existsSync(join(app, 'api/src/jobs'))).toBe(false)
  expect(readFileSync(join(app, 'api/src/core/db.ts'), 'utf8')).not.toContain('asSystem')
}, 60_000)

// FJS-2644 — a deploy mounts only the directory DATABASE_URL points at, so a
// queue written as a literal beside the code stays inside the container and
// every release starts with an empty one.
test('the scaffolded queue sits beside DATABASE_URL, not beside the code', () => {
  const app = scaffold('queue-volume', '--full')
  const config = join(app, 'api/config/junction.config.js')
  const probe = (url) => {
    const r = spawnSync(process.execPath, ['-e', `const c = (await import(${JSON.stringify(config)})).default; console.log(c.caravan.db)`],
      { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } })
    expect(r.stderr).toBe('')
    return r.stdout.trim()
  }
  expect(probe('/data/app.db')).toBe('/data/jobs.db')
  expect(probe('./db/app.db')).toBe(join(app, 'db/jobs.db'))
  expect(probe(':memory:')).toBe(join(app, 'db/jobs.db'))
}, 60_000)

// FJS-1792 — --full installed caravan and notifications and wired neither past
// createCaravan(), so a schema declaring @@commitment was refused at start and
// the first app.notify() was hand-written plumbing.
test('--full wires the commitments plugin, the system principal and the notifications plugin', () => {
  const app = scaffold('wired', '--full')
  const appTs = readFileSync(join(app, 'api/src/app.ts'), 'utf8')
  expect(appTs).toContain("import { commitments } from '@frontierjs/junction/commitments'")
  expect(appTs).toMatch(/^\s*system: SYSTEM,$/m)
  expect(appTs).toMatch(/^app\.configure\(notificationsPlugin\(\{ db \}\)\)$/m)
  // After caravan, which commitments() requires.
  expect(appTs.indexOf('app.configure(createCaravan())')).toBeLessThan(appTs.indexOf('app.configure(commitments())'))
  expect(readFileSync(join(app, 'api/src/core/gate.ts'), 'utf8')).toMatch(/export const SYSTEM\s*=/)
  expect(existsSync(join(app, 'api/src/notifications'))).toBe(true)
}, 60_000)

test('an app with neither package wires neither plugin', () => {
  const app = scaffold('unwired', '--minimal')
  const appTs = readFileSync(join(app, 'api/src/app.ts'), 'utf8')
  expect(appTs).not.toContain('commitments')
  expect(appTs).not.toContain('notificationsPlugin')
  expect(appTs).not.toContain('SYSTEM')
  expect(readFileSync(join(app, 'api/src/core/gate.ts'), 'utf8')).not.toContain('SYSTEM')
  expect(existsSync(join(app, 'api/src/notifications'))).toBe(false)
}, 60_000)

// FJS-1618 — an app whose only surface is web/ was a full-stack scaffold taken
// apart by hand: nine files rewritten and four deleted. The template writes it
// the way it is.
test('--template web-only writes web/ and nothing that needs an API or a database', () => {
  const app = scaffold('web-only', '--template', 'web-only')
  for (const gone of ['api', 'db', 'cli', 'deploy', '.env', '.env.example', 'frontier.config.js'])
    expect(existsSync(join(app, gone))).toBe(false)
  expect(existsSync(join(app, 'web/src/routes/index.mesa'))).toBe(true)

  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
  const deps = { ...manifest.dependencies, ...manifest.devDependencies }
  expect(deps['@frontierjs/litestone']).toBeUndefined()
  expect(deps['@frontierjs/junction']).toBeUndefined()
  for (const s of ['dev:api', 'start', 'db:migrate', 'db:backup', 'db:types'])
    expect(manifest.scripts[s]).toBeUndefined()
  expect(manifest.scripts.dev).toBe(manifest.scripts['dev:web'])

  expect(readFileSync(join(app, 'tsconfig.json'), 'utf8')).not.toContain('api/')
  expect(readFileSync(join(app, 'web/config/sierra.config.js'), 'utf8')).not.toContain('junction')
  const vite = readFileSync(join(app, 'web/config/vite.config.js'), 'utf8')
  expect(vite).not.toContain('/api')
  expect(vite).toContain('strictPort: true')
  expect(readFileSync(join(app, 'web/src/routes/_module.mesa'), 'utf8')).not.toContain('sierra/resource')
  expect(readFileSync(join(app, 'web/src/routes/index.mesa'), 'utf8')).not.toContain('/api/health')
  expect(readFileSync(join(app, 'web/src/main.js'), 'utf8')).not.toContain('db/schema.lite')
  expect(readFileSync(join(app, 'AGENTS.md'), 'utf8')).not.toContain('schema.lite\`: **Data')
  expect(readFileSync(join(app, 'README.md'), 'utf8')).not.toMatch(/api\/|schema\.lite/)
}, 60_000)

// FJS-1490 — a sub-command `fli new` composes opens a client before the initial
// migration is written, so auto-DDL builds app.db and records no history; the
// first `fli db:migrate` then refuses a database its own migration file builds.
test('the database the scaffold leaves already has its initial migration recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-new-history-'))
  roots.push(dir)
  const r = spawnSync(process.execPath, [join(import.meta.dir, '../bin/fli.js'), 'new', 'history', '--full',
    '--yes', '--no-git', '--no-ci', '--no-deploy', '--source', 'local'], { cwd: dir, encoding: 'utf8' })
  expect(r.status).toBe(0)
  const app = join(dir, 'history')
  const files = readdirSync(join(app, 'db/migrations/main'))
  expect(files.length).toBe(1)
  const dbFile = join(app, 'db/app.db')
  if (!existsSync(dbFile)) return // no database built, so no history owed
  const db = new Database(dbFile, { readonly: true })
  const recorded = db.query('select * from _litestone_migrations').all()
  db.close()
  expect(JSON.stringify(recorded)).toContain(files[0])
}, 120_000)

// FJS-1845 — db/schema.d.ts does not exist until `db:types` has run, and until
// then every table a job or a test reads off the client is `unknown`. The
// script was in package.json and in no README.
test('a database app\'s README names the script that writes db/schema.d.ts', () => {
  const app = scaffold('readme-types', '--full')
  expect(readFileSync(join(app, 'README.md'), 'utf8')).toContain('bun run db:types')
}, 60_000)
