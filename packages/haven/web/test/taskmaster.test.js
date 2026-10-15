// web/test/taskmaster.test.js — `#taskmaster` against the real `fli next` and a
// real child process: what he offers, and that one loop runs at a time.
import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkout, proposals, running, startLoop } from '../src/taskmaster.js'

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await Bun.sleep(25) }
  return false
}

test('a checkout is where scripts/fix-loop.mjs sits; an installed Haven has none', () => {
  expect(checkout()).toBe(join(import.meta.dir, '../../../..'))
  const installed = mkdtempSync(join(tmpdir(), 'haven-installed-'))
  expect(checkout({ from: join(installed, 'a', 'b', 'c', 'd') })).toBeNull()
  rmSync(installed, { recursive: true })
})

test('he offers a package per row fli next ranks that the loop can take, none byHand, the top row naming each', async () => {
  const root = checkout()
  const offers = await proposals({ root })
  const ranked = JSON.parse(await Bun.$`${process.execPath} ${join(root, 'packages/cli/bin/fli.js')} next --json --limit 100`.cwd(root).text()).ready
  expect(offers.length).toBeGreaterThan(0)
  const free = ranked.filter((r) => !r.byHand)
  expect(offers[0]).toEqual({ pkg: free[0].pkg[0], id: free[0].id, severity: free[0].severity, title: free[0].title })
  expect(new Set(offers.map((o) => o.pkg)).size).toBe(offers.length)
  for (const o of offers) expect(ranked.find((r) => r.id === o.id).byHand).toBe(false)
})

test('a yes starts the loop on the package, detached; a second yes is refused while it lives and lets go when it ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-taskmaster-'))
  const root = join(dir, 'root')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  const seen = join(dir, 'argv')
  const stop = join(dir, 'stop')
  writeFileSync(join(root, 'scripts', 'fix-loop.mjs'), `
    import { writeFileSync, existsSync } from 'node:fs'
    writeFileSync(${JSON.stringify(seen)}, JSON.stringify([process.cwd(), ...process.argv.slice(2)]))
    while (!existsSync(${JSON.stringify(stop)})) await new Promise((r) => setTimeout(r, 20))
  `)
  const opts = { root, file: join(dir, 'lock.json'), log: join(dir, 'loop.log') }
  expect(running(opts)).toBeNull()
  const lock = startLoop('litestone', opts)
  expect(lock.pkg).toBe('litestone')
  expect(running(opts)?.pid).toBe(lock.pid)
  expect(await until(() => Bun.file(seen).exists())).toBe(true)
  expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([root, '--pkg', 'litestone'])
  expect(() => startLoop('auth', opts)).toThrow('fix-loop is already on litestone')
  writeFileSync(stop, '')
  expect(await until(() => running(opts) === null)).toBe(true)
  expect(startLoop('auth', opts).pkg).toBe('auth')
  rmSync(dir, { recursive: true })
})

test('a name that is not a package is never put on a command line, a flag included', () => {
  for (const bad of ['x; rm -rf /', '--rows', '-p', '', 'a b']) {
    expect(() => startLoop(bad, { root: '/nowhere' })).toThrow('not a package name')
  }
})
