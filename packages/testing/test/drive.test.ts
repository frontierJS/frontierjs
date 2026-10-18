// drive.test.ts — the half of `@frontierjs/testing/drive` that needs no browser:
// what is refused before anything starts, and what is stopped when a start
// fails. Every case here fails before Chrome would open, so none launches one.

import { afterEach, expect, test } from 'bun:test'
import { join }                    from 'node:path'
import { drive }                   from '../src/drive.ts'

const SERVE = join(import.meta.dir, 'fixtures', 'serve.ts')

// drive() owns the exit code, and bun test would report the file failed.
afterEach(() => { process.exitCode = 0 })

function freePort() {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = s.port
  s.stop(true)
  return port
}

async function answers(port: number) {
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); return true }
  catch { return false }
}

test('a port that already answers is refused, and nothing is started', async () => {
  const held = Bun.serve({ port: 0, fetch: () => new Response('someone else') })
  let ran = false
  try {
    const result = await drive({
      servers: [{ name: 'web', cmd: ['sh', '-c', 'exit 0'], url: `http://localhost:${held.port}/` }],
    }, async () => { ran = true })
    expect(result.failed[0]).toContain(`web: port ${held.port} already answers`)
    expect(ran).toBe(false)
    expect(process.exitCode).toBe(1)
  } finally { held.stop(true) }
})

test('a server that exits before it answers is named, with what it printed', async () => {
  const result = await drive({
    servers: [{ name: 'api', cmd: ['sh', '-c', 'echo boom >&2; exit 3'], url: `http://localhost:${freePort()}/` }],
  }, async () => {})
  expect(result.failed[0]).toMatch(/^api exited \(3\) before .* answered:\n {2}boom/)
})

// The launcher is a shell whose CHILD holds the port, which is the shape of
// `bun run web`: killing the shell alone would leave the server up.
test('a started server is stopped as a group when a later one fails', async () => {
  const port = freePort()
  const result = await drive({
    servers: [
      { name: 'web', cmd: ['sh', '-c', `bun ${SERVE} & wait`], env: { PORT: String(port) }, url: `http://localhost:${port}/` },
      { name: 'api', cmd: ['sh', '-c', 'exit 1'], url: `http://localhost:${freePort()}/` },
    ],
  }, async () => {})
  expect(result.failed[0]).toMatch(/^api exited \(1\)/)
  expect(await answers(port)).toBe(false)
})
