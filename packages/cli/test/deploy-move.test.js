// deploy-move.test.js — `fli deploy:move`'s pure half and its shell, run
// against temp directories on this machine: the scripts are the ones a box is
// handed, so the quoting and the file modes are exercised, not described.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

import {
  serverDestination, rootPipe, readSourceScript, parseSourceRead, sourceVariables, planVariables, planEnvWrite, frontingApps,
  writeFilesScript, treeStatScript, parseTreeStat, tarOutScript, tarInScript, archiveName, streamTar,
  nextSteps, deployCommand, failureNote, bytesOf,
} from '../core/deploy-move.js'

const tmp  = () => mkdtempSync(join(tmpdir(), 'fli-move-'))
const sh   = (script, input) => spawnSync('sh', ['-s'], { input, encoding: 'utf8' }).stdout ?? ''
const run  = (script) => spawnSync('sh', ['-c', script], { encoding: 'utf8' })
const me   = `${process.getuid()}:${process.getgid()}`

describe('serverDestination', () => {
  test('a default port is user@ip, another is the URI form', () => {
    expect(serverDestination({ ipAddress: '1.2.3.4', sshUser: 'deploy' })).toBe('deploy@1.2.3.4')
    expect(serverDestination({ ipAddress: '1.2.3.4' })).toBe('root@1.2.3.4')
    expect(serverDestination({ ipAddress: '1.2.3.4', sshPort: 2222 })).toBe('ssh://root@1.2.3.4:2222')
  })
  test('a server with no address is refused by name', () => {
    expect(() => serverDestination({ name: 'yuma' })).toThrow(/yuma/)
  })
})

describe('rootPipe', () => {
  test('a local host runs the script directly, with the script quoted', () => {
    const cmd = rootPipe('localhost', `echo 'it'"s"`)
    expect(cmd).not.toContain('ssh ')
    expect(cmd).toContain('sudo -n sh -c')
  })
  test('a remote host goes through ssh as one quoted argument', () => {
    const cmd = rootPipe('deploy@box', 'cat > /x')
    expect(cmd).toContain('ssh ')
    expect(cmd).toContain('deploy@box')
  })
})

describe('the SSH install read', () => {
  test('the env file and each secrets file come back apart, newlines dropped', () => {
    const dir = tmp()
    const secrets = join(dir, 'secrets'); mkdirSync(secrets)
    writeFileSync(join(dir, '.env.production'), 'A=1\n# c\nexport B="two words"\n')
    writeFileSync(join(secrets, 'ENCRYPTION_KEY'), 'k3y==\n')
    writeFileSync(join(secrets, 'STRIPE_KEY'), 'sk\n')
    const out = sh(null, readSourceScript({ envFile: join(dir, '.env.production'), secretsDir: secrets, token: 'tok' }))
    const read = parseSourceRead(out, 'tok')
    expect(read.secrets).toEqual({ ENCRYPTION_KEY: 'k3y==', STRIPE_KEY: 'sk' })
    const { values, secretKeys } = sourceVariables(read)
    expect(values).toEqual({ A: '1', B: 'two words', ENCRYPTION_KEY: 'k3y==', STRIPE_KEY: 'sk' })
    expect([...secretKeys].sort()).toEqual(['ENCRYPTION_KEY', 'STRIPE_KEY'])
    rmSync(dir, { recursive: true })
  })
  test('a missing env file and secrets directory read as empty', () => {
    const dir = tmp()
    const read = parseSourceRead(sh(null, readSourceScript({ envFile: join(dir, 'none'), secretsDir: join(dir, 'nodir'), token: 't' })), 't')
    expect(read).toEqual({ env: '', secrets: {} })
  })
  test('a read that did not finish is refused', () => {
    expect(() => parseSourceRead('@@t env\nA=1\n', 't')).toThrow(/did not finish/)
  })
})

describe('planVariables', () => {
  const source = { values: { ENCRYPTION_KEY: 'new', A: '1', B: '2', API_TOKEN: 't', C: 'c' }, secretKeys: new Set(['ENCRYPTION_KEY']) }
  const rows = [
    { id: 'k', appId: 'app', key: 'ENCRYPTION_KEY', isSecret: true, version: 3 },
    { id: 'a', appId: 'app', key: 'A', value: '1', isSecret: false, version: 1 },
    { id: 'b', appId: 'app', key: 'B', value: 'old', isSecret: false, version: 2 },
    { id: 'e', appId: null, key: 'C', value: 'envwide', isSecret: false, version: 1 },
    { id: 'x', appId: 'app', key: 'BASECAMP_ONLY', value: 'v', isSecret: false, version: 1 },
  ]
  const plan = planVariables({ ...source, rows, appId: 'app' })

  test('the App\'s own minted key is overwritten, as a secret, in place', () => {
    expect(plan.patch.find(p => p.key === 'ENCRYPTION_KEY')).toEqual({ id: 'k', version: 3, key: 'ENCRYPTION_KEY', value: 'new' })
    expect(plan.secret).toContain('ENCRYPTION_KEY')
  })
  test('an equal plain value is left, a differing one is patched', () => {
    expect(plan.same).toEqual(['A'])
    expect(plan.patch.find(p => p.key === 'B').value).toBe('2')
  })
  test('an environment-wide row is shadowed by a new App row, not edited', () => {
    expect(plan.create.find(c => c.key === 'C')).toEqual({ appId: 'app', key: 'C', value: 'c', isSecret: false })
    expect(plan.replaced).toContain('C')
  })
  test('a credential-looking name is a secret on a new row', () => {
    expect(plan.create.find(c => c.key === 'API_TOKEN').isSecret).toBe(true)
    expect(plan.added).toContain('API_TOKEN')
  })
  test('keys only Basecamp holds are named and left alone', () => {
    expect(plan.kept).toEqual(['BASECAMP_ONLY'])
  })
  test('a plain row of a key that is now a secret is deleted and made again', () => {
    const p = planVariables({ values: { PW: 'x' }, secretKeys: new Set(['PW']), rows: [{ id: 'p', appId: 'app', key: 'PW', value: 'old', isSecret: false, version: 1 }], appId: 'app' })
    expect(p.recreate).toEqual([{ id: 'p', appId: 'app', key: 'PW', value: 'x', isSecret: true }])
    expect(p.patch).toEqual([])
  })
})

describe('frontingApps', () => {
  // kapp on yuma as Basecamp set it up: the API App with no Domain, and the
  // static App 'app' holding kobami.app with /api and /ws routed back.
  const siblings = [
    { id: 'web', name: 'app', source: { kind: 'inline' }, domains: [{ hostname: 'Kobami.app' }] },
    { id: 'api', name: 'api', source: { kind: 'image' }, domains: [] },
    { id: 'blog', name: 'blog', source: { kind: 'inline' }, domains: [{ hostname: 'blog.kobami.app' }] },
  ]

  test('the static App holding the hostname lets go with the API App', () => {
    expect(frontingApps({ siblings, appId: 'api', hosts: ['kobami.app'] }))
      .toEqual({ fronts: [{ id: 'web', name: 'app', hosts: ['kobami.app'] }], foreign: [] })
  })

  test('a container App holding the hostname is another app, never deleted', () => {
    const other = [...siblings, { id: 'x', name: 'shop', source: { kind: 'git' }, domains: [{ hostname: 'kobami.app' }] }]
    expect(frontingApps({ siblings: other, appId: 'api', hosts: ['kobami.app'] }).foreign)
      .toEqual([{ id: 'x', name: 'shop', hosts: ['kobami.app'] }])
  })
})

describe('the keys a door keeps', () => {
  // kos listens on PORT; over SSH that is 3000, under its Basecamp App 8100.
  test('PORT stays with the door that set it, both ways', () => {
    const src = sourceVariables({ env: 'PORT=3000\nAPP_URL=https://kobami.app\n', secrets: {} })
    expect(src.values).toEqual({ APP_URL: 'https://kobami.app' })
    const out = planEnvWrite({ variables: [{ key: 'PORT', value: '8100' }, { key: 'A', value: '1' }], current: 'PORT=3000\n' })
    expect(out.text).toMatch(/^PORT=3000$/m)
    expect(out.text).not.toMatch(/8100/)
  })
})

describe('planEnvWrite', () => {
  test('ENCRYPTION_KEY is carried alone, the rest merged over the current file', () => {
    const w = planEnvWrite({
      variables: [{ key: 'ENCRYPTION_KEY', value: 'k' }, { key: 'A', value: '2' }, { key: 'B', value: 'b' }],
      current: '# keep\nA=1\nOTHER=o\n',
    })
    expect(w.encryptionKey).toBe('k')
    expect(w.text).toBe('# keep\nA=2\nOTHER=o\nB=b\n')
    expect(w.added).toEqual(['B'])
    expect(w.replaced).toEqual(['A'])
  })
  test('a value with a line break is refused by its key', () => {
    const w = planEnvWrite({ variables: [{ key: 'PEM', value: 'a\nb' }, { key: 'OK', value: '1' }] })
    expect(w.unwritable).toEqual(['PEM'])
    expect(w.text).toBe('OK=1\n')
  })
  test('the written files carry the key at mode 400 and keep the env file\'s mode', () => {
    const dir = tmp()
    const env = join(dir, '.env.production'), secrets = join(dir, 'secrets')
    writeFileSync(env, 'OLD=1\n', { mode: 0o640 })
    const script = writeFilesScript({ envFile: env, secretsDir: secrets, text: "A=it's $HOME\nB=2\n", encryptionKey: "k'e\"y$1", owner: me, token: 'EOFX' })
    expect(run(script).status).toBe(0)
    expect(readFileSync(env, 'utf8')).toBe("A=it's $HOME\nB=2\n")
    expect(statSync(env).mode & 0o777).toBe(0o640)
    expect(readFileSync(join(secrets, 'ENCRYPTION_KEY'), 'utf8')).toBe("k'e\"y$1\n")
    expect(statSync(join(secrets, 'ENCRYPTION_KEY')).mode & 0o777).toBe(0o400)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('the data directory', () => {
  const seed = (dir) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'app.db'), 'x'.repeat(100))
    writeFileSync(join(dir, 'app.db-wal'), 'y'.repeat(20))
  }
  test('treeStat counts files, bytes and entries; a missing directory is zero', () => {
    const dir = tmp(); seed(join(dir, 'db'))
    expect(parseTreeStat(sh(null, treeStatScript(join(dir, 'db'))))).toEqual({ files: 2, bytes: 120, entries: 2 })
    expect(parseTreeStat(sh(null, treeStatScript(join(dir, 'none'))))).toEqual({ files: 0, bytes: 0, entries: 0 })
  })
  test('a tar streams from one directory into another through streamTar', async () => {
    const dir = tmp(); seed(join(dir, 'from'))
    await streamTar({ from: tarOutScript(join(dir, 'from')), to: tarInScript({ dir: join(dir, 'to'), overwrite: false, owner: me }) })
    expect(readdirSync(join(dir, 'to')).sort()).toEqual(['app.db', 'app.db-wal'])
    expect(statSync(join(dir, 'to')).mode & 0o777).toBe(0o750)
  })
  test('a destination with files is refused without overwrite and emptied with it', async () => {
    const dir = tmp(); seed(join(dir, 'from')); mkdirSync(join(dir, 'to')); writeFileSync(join(dir, 'to', 'stale.db-wal'), 'z')
    await expect(streamTar({ from: tarOutScript(join(dir, 'from')), to: tarInScript({ dir: join(dir, 'to'), overwrite: false, owner: me }) }))
      .rejects.toThrow(/write side failed \(exit 3\).*already holds files/)
    expect(readdirSync(join(dir, 'to'))).toEqual(['stale.db-wal'])
    await streamTar({ from: tarOutScript(join(dir, 'from')), to: tarInScript({ dir: join(dir, 'to'), overwrite: true, owner: me }) })
    expect(readdirSync(join(dir, 'to')).sort()).toEqual(['app.db', 'app.db-wal'])
  })
  test('a failing read side is named first', async () => {
    await expect(streamTar({ from: 'echo nope >&2; exit 4', to: 'cat >/dev/null' })).rejects.toThrow(/read side failed \(exit 4\): nope/)
  })
  test('a path with a quote in it is one word', () => {
    const dir = tmp(); const odd = join(dir, "it's here"); seed(odd)
    expect(parseTreeStat(sh(null, treeStatScript(odd))).files).toBe(2)
  })
})

describe('what is printed', () => {
  test('an archive name is one Outpost accepts', () => {
    expect(archiveName('01HX/ab c', 'ff00')).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  })
  test('the next command follows the tier', () => {
    expect(deployCommand({ production: true })).toBe('fli deploy --production')
    expect(deployCommand({ stage: true })).toBe('fli deploy --stage')
    expect(deployCommand({})).toBe('fli deploy')
  })
  test('moving to ssh says to remove BASECAMP_APP_ID, to basecamp to set it', () => {
    expect(nextSteps({ to: 'ssh', flag: { production: true } })).toEqual([
      'Remove BASECAMP_APP_ID from .env, so fli deploy takes the SSH door',
      'Then fli deploy:setup --production to write the routes, and fli deploy --production'])
    expect(nextSteps({ to: 'basecamp' })[0]).toMatch(/Set BASECAMP_APP_ID/)
  })
  test('a failure after the source stopped says how it comes back', () => {
    expect(failureNote({ to: 'basecamp', stopped: true, dbDir: '/a/db', host: 'h' })).toMatch(/stopped and unrouted.*\/a\/db/)
    expect(failureNote({ to: 'ssh', stopped: true })).toMatch(/Trash/)
    expect(failureNote({ to: 'ssh', stopped: false })).toBeNull()
  })
  test('bytes', () => {
    expect(bytesOf(512)).toBe('512 B')
    expect(bytesOf(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
