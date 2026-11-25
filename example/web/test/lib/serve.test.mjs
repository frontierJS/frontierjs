// web/test/lib/serve.test.mjs — the readiness wait every drive's servers pass.
// Run from example/: bun test web/test/lib/serve.test.mjs
import { test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keepTail, waitForServer } from './serve.mjs'

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

function captureErrors() {
  const lines = []
  const original = console.error
  console.error = (...args) => lines.push(args.join(' '))
  return { lines, restore: () => { console.error = original } }
}

test('a server that dies at boot is reported at once, with its stderr', async () => {
  const proc = keepTail(spawn(process.execPath, ['-e', 'console.error("EADDRINUSE :9999"); process.exit(3)'],
    { stdio: ['ignore', 'pipe', 'pipe'] }))
  const log = captureErrors()
  const t0 = Date.now()
  let up
  try { up = await waitForServer('http://127.0.0.1:9/', 'api', proc) } finally { log.restore() }
  expect(up).toBe(false)
  expect(Date.now() - t0).toBeLessThan(5000)
  expect(log.lines.join('\n')).toContain('api exited (3) before answering')
  expect(log.lines.join('\n')).toContain('EADDRINUSE :9999')
})

test('a server that answers is up', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  const proc = keepTail(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 'pipe', 'pipe'] }))
  try {
    expect(await waitForServer(`http://127.0.0.1:${server.port}/`, 'api', proc)).toBe(true)
  } finally { proc.kill(); server.stop(true) }
})

// FJS-4626: each drive carried its own copy of the wait, and the copies that
// never looked at the process polled a crashed server for the whole wait.
test('no drive carries its own server wait', () => {
  const copies = readdirSync(TEST_DIR)
    .filter(f => f.endsWith('.mjs'))
    .filter(f => /function waitFor\w*\(url\b|never answered on/.test(readFileSync(join(TEST_DIR, f), 'utf8')))
  expect(copies).toEqual([])
})
