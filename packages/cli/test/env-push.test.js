// env-push.test.js — `fli env:push` puts a local key in the file the deploy's
// env check reads, and says which keys, never their values.
//
// The end-to-end cases deploy to `localhost`, which `machine.js` runs as a local
// `sh -s`: the same script an ssh target is handed, with no network. The
// Basecamp case answers from a Bun.serve in this process, so the child is
// spawned async — a spawnSync would hold the loop the server answers on.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { pushEnvLines } from '../core/global-env.js'
import { releaseOwnedKeys, variablePush } from '../core/release-preflight.js'

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

describe('releaseOwnedKeys', () => {
  test('the port, NODE_ENV, the key, each database path and each localhost URL', () => {
    const owned = releaseOwnedKeys({
      databases: [{ name: 'main', envVar: 'DATABASE_URL' }, { name: 'logs', envVar: null }],
      envSpec: {
        AUDIT_PATH:       { type: 'string' },
        FRONTIER_API_URL: { type: 'url', default: 'http://localhost:8100' },
        PLAUSIBLE_URL:    { type: 'url', default: 'https://plausible.io' },
        MT_TOKEN:         { type: 'string', required: true },
      },
    })
    expect([...owned].sort()).toEqual(['AUDIT_PATH', 'DATABASE_URL', 'ENCRYPTION_KEY', 'FRONTIER_API_URL', 'NODE_ENV', 'PORT'])
  })
})

describe('variablePush', () => {
  const APP = 'app1'
  const rows = [
    { id: 'v1', appId: APP,  key: 'PLAIN',  value: 'old', isSecret: false, version: 3 },
    { id: 'v2', appId: APP,  key: 'API_KEY', value: null, isSecret: true,  version: 1 },
    { id: 'v3', appId: null, key: 'SHARED', value: 'env', isSecret: false, version: 1 },
    { id: 'v4', appId: APP,  key: 'SAME',   value: 'x',   isSecret: false, version: 1 },
  ]
  const body = 'export NEW_TOKEN="t0k"\nPLAIN=new\nAPI_KEY=k\nSHARED=mine\nSAME=x\nDATABASE_URL=./db/app.db\n'

  test('a missing key is a new row on the App, a secret by its name; a held one is left alone', () => {
    const r = variablePush({ rows, appId: APP, body, owned: new Set(['DATABASE_URL']) })
    expect(r.create).toEqual([{ appId: APP, key: 'NEW_TOKEN', value: 't0k', isSecret: true }])
    expect(r.patch).toEqual([])
    expect(r).toMatchObject({ added: ['NEW_TOKEN'], same: ['SAME'], differs: ['PLAIN', 'API_KEY', 'SHARED'], skipped: ['DATABASE_URL'] })
  })

  test('overwrite patches the App\'s own row with its version, and shadows an environment-wide one', () => {
    const r = variablePush({ rows, appId: APP, body, owned: new Set(['DATABASE_URL']), overwrite: true })
    expect(r.patch).toEqual([
      { id: 'v1', version: 3, key: 'PLAIN', value: 'new' },
      { id: 'v2', version: 1, key: 'API_KEY', value: 'k' },
    ])
    expect(r.create.map(v => v.key)).toEqual(['NEW_TOKEN', 'SHARED'])
    expect(r.replaced).toEqual(['PLAIN', 'API_KEY', 'SHARED'])
    expect(r.secret).toEqual(['NEW_TOKEN', 'API_KEY'])
  })

  test('an owned key named exactly is pushed', () => {
    const r = variablePush({ rows: [], appId: APP, body: 'ENCRYPTION_KEY=abc\n', owned: new Set(['ENCRYPTION_KEY']), named: ['ENCRYPTION_KEY'] })
    expect(r.create).toEqual([{ appId: APP, key: 'ENCRYPTION_KEY', value: 'abc', isSecret: true }])
    expect(variablePush({ rows: [], appId: APP, body: 'ENCRYPTION_KEY=abc\n', owned: new Set(['ENCRYPTION_KEY']), named: ['ENCRYPTION_*'] }).skipped)
      .toEqual(['ENCRYPTION_KEY'])
  })
})

describe('fli env:push', () => {
  let app, server

  const push = (...args) => spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), 'env:push', ...args], {
    encoding: 'utf8', cwd: app, env: { ...process.env, NO_COLOR: '1', BASECAMP_APP_ID: '' },
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

describe('fli env:push to an App in Basecamp', () => {
  let app, home, bc, writes

  // `id` empty leaves BASECAMP_APP_ID to the app's .env, as a real run reads it.
  const run = async (id, args) => {
    const env = { ...process.env, NO_COLOR: '1', HOME: home, BASECAMP_APP_ID: id }
    if (!id) delete env.BASECAMP_APP_ID
    const child = Bun.spawn([process.execPath, resolve(ROOT, 'bin/fli.js'), 'env:push', ...args], { cwd: app, stdout: 'pipe', stderr: 'pipe', env })
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { status: await child.exited, output: out + err }
  }
  const push = (...args) => run('app1', args)
  push.withId = (id, ...args) => run(id, args)

  beforeEach(() => {
    writes = []
    bc = Bun.serve({ port: 0, async fetch(req) {
      const url = new URL(req.url)
      const json = (data, status = 200) => Response.json({ data }, { status })
      if (req.method === 'GET' && url.pathname === '/apps/app1') return json({ id: 'app1', name: 'kapp', environmentId: 'env1' })
      if (req.method === 'GET' && url.pathname.startsWith('/apps/')) return Response.json({ message: 'not found' }, { status: 404 })
      if (req.method === 'GET' && url.pathname === '/variables')
        return json(url.searchParams.get('$offset') === '0'
          ? [{ id: 'v1', appId: 'app1', key: 'MT_TOKEN', value: null, isSecret: true, version: 2 }] : [])
      writes.push({ method: req.method, path: url.pathname, body: await req.json() })
      return json({ id: 'new' })
    } })
    app  = mkdtempSync(join(tmpdir(), 'fli-push-bc-app-'))
    home = mkdtempSync(join(tmpdir(), 'fli-push-bc-home-'))
    mkdirSync(join(home, '.config', 'fli'), { recursive: true })
    writeFileSync(join(home, '.config', 'fli', 'basecamps.json'), JSON.stringify({ yuma: { url: `http://localhost:${bc.port}`, apiKey: 'k' } }))
    writeFileSync(join(app, 'package.json'), '{"name":"t","scripts":{}}')
    writeFileSync(join(app, '.env.production'), 'LINK_KEY=s3cret\nMT_TOKEN=t0k\nDATABASE_URL=./db/app.db\nPORT=3000\n')
  })

  afterEach(() => {
    bc.stop(true)
    rmSync(app, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  test('writes the missing keys as Variables, skips what the release sets, and prints no value', async () => {
    const r = await push()
    expect(r.status).toBe(0)
    expect(writes).toEqual([{ method: 'POST', path: '/variables', body: { environmentId: 'env1', appId: 'app1', key: 'LINK_KEY', value: 's3cret', isSecret: true } }])
    expect(r.output).toContain('MT_TOKEN')
    expect(r.output).toContain('PORT')
    expect(r.output).not.toContain('s3cret')
  })

  test('--overwrite patches the held row with its version', async () => {
    const r = await push('MT_TOKEN', '--overwrite')
    expect(r.status).toBe(0)
    expect(writes).toEqual([{ method: 'PATCH', path: '/variables/v1', body: { value: 't0k', version: 2 } }])
  })

  test('--dry writes nothing', async () => {
    const r = await push('--dry')
    expect(r.status).toBe(0)
    expect(writes).toEqual([])
    expect(r.output).toMatch(/LINK_KEY\s+would be added as a secret/)
  })

  test('a flag for a server\'s env file is refused', async () => {
    const r = await push('--server', 'x')
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('--server is for a server')
    expect(writes).toEqual([])
  })

  test('an App the Basecamp does not hold is refused with the way out', async () => {
    writeFileSync(join(app, '.env'), 'BASECAMP_APP_ID=gone\n')
    const r = await push.withId('')
    expect(r.status).not.toBe(0)
    expect(r.output).toContain('BASECAMP_APP_ID gone is no App on yuma')
    expect(writes).toEqual([])
  })
})
