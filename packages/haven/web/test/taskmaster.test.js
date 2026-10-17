// web/test/taskmaster.test.js — `#taskmaster` against the real `fli next` and a
// real child process: what he offers, and that one loop runs at a time.
import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkout, loopArgv, loopReport, proposals, running, startLoop } from '../src/lib/hash/taskmaster.js'

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
  const lock = startLoop({ pkg: 'litestone' }, opts)
  expect(lock.pkg).toBe('litestone')
  expect(running(opts)?.pid).toBe(lock.pid)
  expect(await until(() => Bun.file(seen).exists())).toBe(true)
  expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([root, '--pkg', 'litestone'])
  expect(() => startLoop({ pkg: 'auth' }, opts)).toThrow('fix-loop is already on litestone')
  writeFileSync(stop, '')
  expect(await until(() => running(opts) === null)).toBe(true)
  expect(startLoop({ ids: ['FJS-7'] }, opts).on).toBe('FJS-7')
  expect(await until(() => JSON.parse(readFileSync(seen, 'utf8')).includes('--ids'))).toBe(true)
  expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([root, '--ids', 'FJS-7'])
  writeFileSync(stop, '')
  expect(await until(() => running(opts) === null)).toBe(true)
  rmSync(dir, { recursive: true })
})

test('a plan that is not one is never put on a command line, a flag included', () => {
  for (const bad of ['x; rm -rf /', '--rows', '-p', '', 'a b', ['mesa']]) {
    expect(() => startLoop({ pkg: bad }, { root: '/nowhere' })).toThrow('not a package name')
  }
  expect(() => loopArgv({ ids: ['FJS-1', '--budget'] })).toThrow('not issue ids')
  expect(() => loopArgv({ ids: ['FJS-1', 'FJS-2', 'FJS-3', 'FJS-4'] })).toThrow('not issue ids')
  expect(() => loopArgv({ pkg: 'mesa', sev: 'S5' })).toThrow('not a severity')
  expect(() => loopArgv({ pkg: 'mesa', rows: 40 })).toThrow('not a row count')
  expect(() => loopArgv({ sev: 'S3' })).toThrow('a loop needs a package or an issue')
  expect(loopArgv({ pkg: 'sierra', sev: 'S3,S4', rows: 2 })).toEqual(['--pkg', 'sierra', '--sev', 'S3,S4', '--rows', '2'])
})

test("a loop's output reads back as the rows it took, each one's last outcome, and its summary", () => {
  const out = [
    '[fix-loop] 1/2 FJS-7 (S3, haven · mesa) — a haven thing',
    '[fix-loop]   sonnet/high: failed · $0.30 · 2 min · 9 turns (fix 9)',
    '[fix-loop]   opus/high: closed · $0.90 · 4 min · 20 turns (fix 20)',
    '',
    '[fix-loop] 2/2 FJS-8 (S4, sierra) — a sierra thing',
    '[fix-loop]   sonnet/high: blocked · $0.10 · 1 min · 3 turns (orient 3)',
    '',
    '[fix-loop] 1 closed · 1 waiting on a ruling · $1.30 spent · log /home/x/.fli/fix-loop.jsonl',
  ].join('\n')
  expect(loopReport(out)).toEqual({
    rows: [
      { id: 'FJS-7', severity: 'S3', pkg: ['haven', 'mesa'], title: 'a haven thing', outcome: 'closed' },
      { id: 'FJS-8', severity: 'S4', pkg: ['sierra'], title: 'a sierra thing', outcome: 'blocked' },
    ],
    summary: '1 closed · 1 waiting on a ruling · $1.30 spent',
    nothing: false,
  })
  expect(loopReport('[fix-loop] nothing ready\n\n[fix-loop] 0 closed · 0 waiting on a ruling · $0.00 spent · log x').nothing).toBe(true)
})
