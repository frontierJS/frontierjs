// env-push.test.js — `fli env:push` puts a local key in the file the deploy's
// env check reads, and says which keys, never their values.
//
// The end-to-end cases deploy to `localhost`, which `machine.js` runs as a local
// `sh -s`: the same script an ssh target is handed, with no network.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { pushEnvLines } from '../core/global-env.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('pushEnvLines', () => {
  test('appends a key the server lacks and keeps every other line', () => {
    const r = pushEnvLines('# keep\nA=1\n', 'B=2\n')
    expect(r.text).toBe('# keep\nA=1\nB=2\n')
    expect(r.added).toEqual(['B'])
  })

  test('a key with another value is left alone and named, unless overwrite', () => {
    const kept = pushEnvLines('A=server\n', 'A=local\n')
    expect(kept.text).toBe('A=server\n')
    expect(kept.differs).toEqual(['A'])
    const over = pushEnvLines('A=server\nB=1\n', 'A=local\n', { overwrite: true })
    expect(over.text).toBe('A=local\nB=1\n')
    expect(over.replaced).toEqual(['A'])
  })

  test('the same line is neither added nor replaced', () => {
    const r = pushEnvLines('A=1\n', 'A=1\n', { overwrite: true })
    expect(r).toMatchObject({ text: 'A=1\n', added: [], replaced: [], same: ['A'] })
  })

  test('an empty server file becomes the pushed lines', () => {
    expect(pushEnvLines('', 'A=1\nB=2').text).toBe('A=1\nB=2\n')
  })

  test('a server file with no final newline is not run into', () => {
    expect(pushEnvLines('A=1', 'B=2\n').text).toBe('A=1\nB=2\n')
  })
})

describe('fli env:push', () => {
  let app, server

  const push = (...args) => spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), 'env:push', ...args], {
    encoding: 'utf8', cwd: app, env: { ...process.env, NO_COLOR: '1' },
  })

  beforeEach(() => {
    app    = mkdtempSync(join(tmpdir(), 'fli-push-app-'))
    server = mkdtempSync(join(tmpdir(), 'fli-push-box-'))
    writeFileSync(join(app, 'package.json'), '{"name":"t","scripts":{}}')
    writeFileSync(join(app, 'frontier.config.js'),
      `export default { deploy: { server: 'localhost', path: ${JSON.stringify(server)}, app_id: 't' } }\n`)
    writeFileSync(join(app, '.env.production'), 'VAPID_SUBJECT=mailto:a@b.test\nVAPID_PRIVATE_KEY=s3cret\nOTHER=x\n')
  })

  afterEach(() => {
    rmSync(app, { recursive: true, force: true })
    rmSync(server, { recursive: true, force: true })
  })

  test('adds the named keys to <deploy.path>/.env.production and prints no value', () => {
    writeFileSync(join(server, '.env.production'), 'ENCRYPTION_KEY=k\n')
    const r = push('VAPID_*')
    expect(r.status).toBe(0)
    expect(readFileSync(join(server, '.env.production'), 'utf8'))
      .toBe('ENCRYPTION_KEY=k\nVAPID_SUBJECT=mailto:a@b.test\nVAPID_PRIVATE_KEY=s3cret\n')
    expect(r.stdout + r.stderr).toContain('VAPID_SUBJECT')
    expect(r.stdout + r.stderr).not.toContain('s3cret')
  })

  test('--dry reads the server and writes nothing', () => {
    writeFileSync(join(server, '.env.production'), 'OTHER=x\n')
    const r = push('--dry')
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).toContain('VAPID_PRIVATE_KEY')
    expect(r.stdout + r.stderr).not.toContain('s3cret')
    expect(readFileSync(join(server, '.env.production'), 'utf8')).toBe('OTHER=x\n')
  })

  test('a file the server lacks is created, readable by its owner only', () => {
    const r = push('OTHER')
    expect(r.status).toBe(0)
    const file = join(server, '.env.production')
    expect(readFileSync(file, 'utf8')).toBe('OTHER=x\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('a key named that the local file lacks refuses the push', () => {
    const r = push('NOPE')
    expect(r.status).not.toBe(0)
    expect(existsSync(join(server, '.env.production'))).toBe(false)
  })

  test('the scaffold placeholder server is refused before any connection', () => {
    writeFileSync(join(app, 'frontier.config.js'),
      "export default { deploy: { server: 'your-server.com', path: '/srv/t', app_id: 't' } }\n")
    const r = push()
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('placeholder')
  })
})
