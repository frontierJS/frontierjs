/*
 * test/services.test.js
 *
 * `core/services.js` is the catalog of the accounts fli signs in to. Its key
 * lists come off `requires:` and `CLOUDS`, so these tests are what stop a key
 * added to a command from being a key no screen can say anything about, and
 * what stop a catalog key no command reads. Nothing here may print a value.
 */

import { describe, expect, test, beforeAll, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { services, keysOf, knownKeys, commandsUsing, servicesReport, probeService, scrub } from '../core/services.js'
import { CLOUDS } from '../core/cloud.js'
import { requiresOf } from '../core/requires.js'
import { extractFrontmatter } from '../core/compiler.js'

const CLI  = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(CLI, '..', '..')

const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap(d => d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.md') ? [join(dir, d.name)] : [])

let registry
beforeAll(async () => {
  global.fliRoot     = CLI
  global.projectRoot = REPO
  const { buildRegistry } = await import('../core/registry.js')
  registry = buildRegistry()
})

let tmp
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fli-services-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// A PATH of one directory holding stub binaries, so the probe reads the stub and never the machine's login.
const stub = (name, body) => {
  const dir = join(tmp, 'bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
  return dir
}

describe('the catalog against its sources', () => {
  test('every requires: key under commands/ and every CLOUDS key is in some service', () => {
    const named = knownKeys()
    const required = walk(join(CLI, 'commands'))
      .filter(f => !/[\/\\]_steps[^\/\\]*[\/\\]/.test(f))
      .flatMap(f => {
        let meta
        try { meta = extractFrontmatter(readFileSync(f, 'utf8'), f) } catch { return [] }
        return requiresOf(meta).map(r => r.key)
      })
    expect(required.length).toBeGreaterThan(0)
    for (const key of [...required, ...Object.values(CLOUDS).map(c => c.key)]) expect([key, named.has(key)]).toEqual([key, true])
  })

  test('every service has a command that uses it, and every env key is read by commands or code', () => {
    for (const s of services) expect([s.id, commandsUsing(s, registry).length > 0]).toEqual([s.id, true])
    const source = walk(join(CLI, 'commands')).map(f => readFileSync(f, 'utf8')).join('\n')
    for (const s of services) for (const key of keysOf(s)) expect([key, source.includes(key)]).toEqual([key, true])
  })

  test('a setup pointer names a file and a heading that exist', () => {
    for (const s of services.filter(x => x.setup)) {
      const [path, heading] = s.setup.split('#')
      const text = readFileSync(join(CLI, path), 'utf8')
      expect([s.id, new RegExp(`^#{1,4} ${heading}\\b`, 'm').test(text)]).toEqual([s.id, true])
    }
  })

  test('commandsUsing derives github:create for GitHub and a key-only user for the Basecamp DNS token', () => {
    expect(commandsUsing('github', registry).map(c => c.title)).toContain('github:create')
    expect(commandsUsing('cloudflare-dns', registry).map(c => c.title)).toContain('basecamp:dns')
    expect(commandsUsing('nope', registry)).toEqual([])
  })
})

describe('servicesReport', () => {
  const SECRET = 'ghp_SEEDEDsecretVALUE1234567890abcdef'
  const byId = (rows, id) => rows.find(r => r.id === id)

  test('an env service is present when its keys are set and absent otherwise; no value leaves', () => {
    mkdirSync(join(tmp, '.config', 'fli'), { recursive: true })
    writeFileSync(join(tmp, '.config', 'fli', '.env'), `GITHUB_TOKEN=${SECRET}\nHETZNER_TOKEN=\n`)
    const rows = servicesReport({ home: tmp, env: { PATH: '' } })
    expect(byId(rows, 'github').present).toBe(true)
    expect(byId(rows, 'hetzner').present).toBe(false)
    expect(byId(rows, 'digitalocean').present).toBe(false)
    expect(JSON.stringify(rows)).not.toContain(SECRET)
  })

  test('env keys also count when only the process env holds them', () => {
    const rows = servicesReport({ home: tmp, env: { PATH: '', DIGITALOCEAN_TOKEN: SECRET } })
    expect(byId(rows, 'digitalocean').present).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(SECRET)
  })

  test('a file service is present when its home.js entry or path exists', () => {
    expect(byId(servicesReport({ home: tmp, env: { PATH: '' } }), 'basecamp').present).toBe(false)
    mkdirSync(join(tmp, '.config', 'fli'), { recursive: true })
    writeFileSync(join(tmp, '.config', 'fli', 'basecamps.json'), '{}')
    mkdirSync(join(tmp, '.ssh'), { recursive: true })
    writeFileSync(join(tmp, '.ssh', 'config'), 'Host x\n')
    const rows = servicesReport({ home: tmp, env: { PATH: '' } })
    expect(byId(rows, 'basecamp').present).toBe(true)
    expect(byId(rows, 'ssh').present).toBe(true)
  })

  test('a cli probe runs only when asked, and reads who from a stub binary on PATH', () => {
    const PATH = stub('gh', 'echo "github.com"; echo "  ✓ Logged in to github.com account alice (keyring)"; echo "  - Token: ghp_************************************"')
    const quiet = servicesReport({ home: tmp, env: { PATH } })
    expect(byId(quiet, 'github-cli').present).toBe(true)
    expect(byId(quiet, 'github-cli').probe).toBeUndefined()

    const asked = servicesReport({ home: tmp, env: { PATH }, probe: ['github-cli'] })
    expect(byId(asked, 'github-cli').probe).toMatchObject({ ok: true, who: 'alice' })
    expect(byId(asked, 'npm').probe).toBeUndefined()
    expect(JSON.stringify(asked)).not.toContain('ghp_')
  })

  test('a failing or missing binary is ok:false with no name', () => {
    const PATH = stub('npm', 'echo "npm error code E401" >&2; exit 1')
    const gh = services.find(s => s.id === 'github-cli')
    expect(probeService(services.find(s => s.id === 'npm'), { env: { PATH } })).toMatchObject({ ok: false, who: null })
    expect(probeService(gh, { env: { PATH } })).toMatchObject({ ok: false, who: null })
  })

  test('claude signed out exits 0 and is still not ok', () => {
    const PATH = stub('claude', 'echo \'{"loggedIn": false}\'')
    expect(probeService(services.find(s => s.id === 'anthropic'), { env: { PATH } }).ok).toBe(false)
  })

  test('the scrubber drops anything token-shaped', () => {
    expect(scrub(`Token: ${SECRET} and sk-abcdef123 and ${'a'.repeat(40)}`)).not.toMatch(/SEEDED|sk-abc|aaaaaaaa/)
  })
})

describe('docs/configuration.md § Credentials', () => {
  const doc = readFileSync(join(CLI, 'docs', 'configuration.md'), 'utf8')
  const section = doc.split(/^### Credentials\s*$/m)[1]?.split(/^### /m)[0] ?? ''

  test('the section exists and the stale credential half of § Environment variables is gone', () => {
    expect(section.length).toBeGreaterThan(0)
    expect(doc.split(/^### Credentials\s*$/m)[0]).not.toMatch(/ANTHROPIC_API_KEY/)
  })

  test('every service, key, login, vendor page and setup pointer is in it', () => {
    for (const s of services) {
      const wants = [s.name, ...keysOf(s), s.vendor?.url, s.setup, s.signIn.login, s.signIn.entry, s.signIn.path].filter(Boolean)
      for (const w of wants) expect([s.id, w, section.includes(w)]).toEqual([s.id, w, true])
    }
  })
})
