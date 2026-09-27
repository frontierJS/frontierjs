// bun-fence.test.js — a fenced `bun link` leaves the machine's global dir alone.
//
// Run for real against bun, under a fake HOME, because what matters is where
// bun writes and that an app still resolves its `link:` spec afterwards, and
// neither is a fact about the helper's return value. The fake HOME is also
// what keeps a broken fence from re-pointing this machine's own links.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync }                                 from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir }                                    from 'node:os'
import { join }                                      from 'node:path'

import { fenceBunGlobal } from '../core/bun-fence.js'

const NAME = '@frontierjs/zz-fence-probe'

let base
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'fjs-bun-fence-test-')) })
afterEach(()  => rmSync(base, { recursive: true, force: true }))

function bun(args, cwd, env) {
  const r = spawnSync('bun', args, { cwd, env, encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`bun ${args.join(' ')}: ${r.stderr || r.stdout}`)
}

describe('fenceBunGlobal', () => {
  test('a fenced `bun link` does not touch the global dir, and a `link:` spec still resolves', () => {
    const home = join(base, 'home')
    const pkg  = join(base, 'pkg')
    const app  = join(base, 'app')
    for (const d of [home, pkg, app]) mkdirSync(d)
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: NAME, version: '0.0.0', main: 'i.js' }))
    writeFileSync(join(pkg, 'i.js'), 'module.exports = 1\n')
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { [NAME]: `link:${NAME}` } }))

    const machine = { ...process.env, HOME: home }
    delete machine.BUN_INSTALL
    delete machine.BUN_INSTALL_CACHE_DIR
    const { env } = fenceBunGlobal(machine, join(base, 'fence'))

    bun(['link'], pkg, env)
    bun(['install'], app, env)

    expect(existsSync(join(home, '.bun', 'install', 'global', 'node_modules', NAME))).toBe(false)
    expect(realpathSync(join(app, 'node_modules', NAME))).toBe(realpathSync(pkg))
  })

  test('the package cache stays where the machine had it', () => {
    expect(fenceBunGlobal({ HOME: '/h' }, '/f').env.BUN_INSTALL_CACHE_DIR).toBe('/h/.bun/install/cache')
    expect(fenceBunGlobal({ BUN_INSTALL: '/b' }, '/f').env.BUN_INSTALL_CACHE_DIR).toBe('/b/install/cache')
    expect(fenceBunGlobal({ BUN_INSTALL_CACHE_DIR: '/c' }, '/f').env.BUN_INSTALL_CACHE_DIR).toBe('/c')
  })
})
