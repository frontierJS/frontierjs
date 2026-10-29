// deploy-doctor.test.js — `fli deploy:doctor` answers a program, not only a person.
//
// FJS-2553: the summary counted failures and the command ended 0 anyway, and
// the only way to learn whether an app was ready was to scrape the coloured
// ✓/✗ lines. Each case runs the real command over a real app directory.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const doctor = (cwd, ...args) =>
  spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), 'deploy:doctor', ...args], {
    encoding: 'utf8', cwd, env: { ...process.env, NO_COLOR: '1' },
  })

let withConfig, noConfig

beforeAll(() => {
  // A deploy block that resolves and no Dockerfile: a failing check that needs no network.
  withConfig = mkdtempSync(join(tmpdir(), 'fli-doctor-app-'))
  writeFileSync(join(withConfig, 'package.json'), '{"name":"t","scripts":{}}')
  writeFileSync(join(withConfig, 'frontier.config.js'),
    "export default { deploy: { server: 'example.test', path: '/srv/t', app_id: 't' } }\n")
  noConfig = mkdtempSync(join(tmpdir(), 'fli-doctor-bare-'))
  writeFileSync(join(noConfig, 'package.json'), '{"name":"t"}')
  mkdirSync(join(noConfig, 'db'))
})

afterAll(() => {
  rmSync(withConfig, { recursive: true, force: true })
  rmSync(noConfig, { recursive: true, force: true })
})

describe('deploy:doctor as a program reads it', () => {

  test('a failed check exits non-zero', () => {
    const r = doctor(withConfig)
    expect(r.stdout + r.stderr).toContain('failure(s)')
    expect(r.status).not.toBe(0)
  })

  test('--json prints the rows renderCheck draws and nothing else', () => {
    const r = doctor(withConfig, '--json')
    const out = JSON.parse(r.stdout)
    expect(out.ok).toBe(false)
    expect(out.failed).toBeGreaterThan(0)
    const dockerfile = out.checks.find(c => c.name.startsWith('Dockerfile at'))
    expect(dockerfile.status).toBe('fail')
    expect(dockerfile.hint).toContain('fli make:deploy')
    expect(dockerfile.section).toBe('API container')
    expect(out.checks.find(c => c.name === 'deploy block defined').status).toBe('pass')
    expect(r.status).not.toBe(0)
  })

  test('--json with no config still prints the one failed row', () => {
    const r = doctor(noConfig, '--json')
    const out = JSON.parse(r.stdout)
    expect(out.ok).toBe(false)
    expect(out.checks[0]).toMatchObject({ name: 'frontier.config.js', status: 'fail' })
    expect(r.status).not.toBe(0)
  })

})

// FJS-2433: the image make:deploy writes ran as root. The runtime stage names a
// non-root user and hands it /db, the one directory the container writes.
describe('the Dockerfile make:deploy writes', () => {
  test('the runtime stage runs as a non-root user that owns /db', () => {
    const app = mkdtempSync(join(tmpdir(), 'fli-mkdeploy-'))
    try {
      writeFileSync(join(app, 'package.json'), '{"name":"t","scripts":{}}')
      const r = spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), 'make:deploy'], {
        encoding: 'utf8', cwd: app, env: { ...process.env, NO_COLOR: '1' },
      })
      expect(r.status).toBe(0)
      const runtime = readFileSync(join(app, 'deploy', 'Dockerfile'), 'utf8').split(`FROM oven/bun:${Bun.version}-slim`)[1]
      expect(runtime).toMatch(/^USER bun$/m)
      expect(runtime).toMatch(/chown bun:bun \/db/)
      // the user line comes after every RUN, which needs root, and before CMD
      expect(runtime.indexOf('USER bun')).toBeGreaterThan(runtime.lastIndexOf('\nRUN '))
      expect(runtime.indexOf('USER bun')).toBeLessThan(runtime.indexOf('CMD '))
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })
})

// FJS-3212: `*.test.ts` matches at the context root only, so api/test/ shipped
// in every production image. Read through the same matcher `02b-build-check` uses.
describe('the .dockerignore make:deploy writes', () => {
  test('a test file or test directory under a surface is excluded', async () => {
    const { parseDockerignore, ignoreDecision } = await import('../core/build-check.js')
    const app = mkdtempSync(join(tmpdir(), 'fli-mkdeploy-ignore-'))
    try {
      writeFileSync(join(app, 'package.json'), '{"name":"t","scripts":{}}')
      const r = spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), 'make:deploy'], {
        encoding: 'utf8', cwd: app, env: { ...process.env, NO_COLOR: '1' },
      })
      expect(r.status).toBe(0)
      const pats = parseDockerignore(readFileSync(join(app, '.dockerignore'), 'utf8'))
      for (const p of ['api/test/app.test.ts', 'api/test/fixtures/seed.json', 'api/src/x.test.js', 'x.test.ts']) {
        expect([p, ignoreDecision(p, pats)]).toEqual([p, 'ignored'])
      }
      expect(ignoreDecision('api/src/app.ts', pats)).toBe('included')
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })

  // FJS-3524: a denylist let in every surface and every kind of file it did not
  // name. An allowlist is checked against the Dockerfile written beside it, so a
  // path one COPYs is never one the other drops.
  test('lets in what the Dockerfile copies and nothing else', async () => {
    const { parseDockerignore, ignoreDecision } = await import('../core/build-check.js')
    const app = mkdtempSync(join(tmpdir(), 'fli-mkdeploy-allow-'))
    try {
      writeFileSync(join(app, 'package.json'), '{"name":"t","scripts":{}}')
      const r = spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), 'make:deploy'], {
        encoding: 'utf8', cwd: app, env: { ...process.env, NO_COLOR: '1' },
      })
      expect(r.status).toBe(0)
      const ignore = readFileSync(join(app, '.dockerignore'), 'utf8')
      const pats = parseDockerignore(ignore)
      for (const p of ['api/src/app.ts', 'db/schema.lite', 'db/migrations/main/1_x.sql',
        'deploy/generated/app-manifest.json', 'tsconfig.json']) {
        expect([p, ignoreDecision(p, pats)]).toEqual([p, 'included'])
      }
      for (const p of ['desktop/shell/target/x', 'widgets/a.mesa', 'cli/x.js', 'web/src/x.mesa',
        '.env.production', '.git/HEAD', 'api/node_modules/x/index.js', 'db/audit/auditTrail.jsonl',
        'db/app.db-wal', 'db/backups/x.db', 'move-report.json']) {
        expect([p, ignoreDecision(p, pats)]).toEqual([p, 'ignored'])
      }
      const dockerfile = readFileSync(join(app, 'deploy', 'Dockerfile'), 'utf8')
      for (const [, from] of dockerfile.matchAll(/^COPY (?!--from)(\S+)/gm)) {
        expect(ignore).toContain(`!${from}`)
      }
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })
})
