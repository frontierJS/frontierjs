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
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
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
