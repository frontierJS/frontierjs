// FJS-2431 — under `bun --watch` a NEW service file is not in bun's import
// graph, so nothing restarts and its name answers 404. The loader watches the
// services dir and rewrites the entry with its own bytes (`FJS-D1121`).
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchForNewServices } from '../src/core/loader.ts'

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await Bun.sleep(20)
}

describe('watchForNewServices', () => {
  let dir = ''
  let handle: { close(): void } | null = null
  afterEach(() => { handle?.close(); handle = null; if (dir) rmSync(dir, { recursive: true, force: true }) })

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'fjs2431-'))
    writeFileSync(join(dir, 'a.service.ts'), 'export default {}')
  }

  test('a new *.service.ts restarts once and says so', async () => {
    setup()
    let restarts = 0
    const lines: string[] = []
    handle = watchForNewServices({
      dir, known: [join(dir, 'a.service.ts')], watching: true,
      restart: () => { restarts++ }, say: l => lines.push(l),
    })
    writeFileSync(join(dir, 'b.service.ts'), 'export default {}')
    await until(() => restarts > 0)
    await Bun.sleep(150)
    expect(restarts).toBe(1)
    expect(lines.join('\n')).toContain('b.service.ts')
  })

  test('an edit to a known file or a non-service file restarts nothing', async () => {
    setup()
    let restarts = 0
    handle = watchForNewServices({
      dir, known: [join(dir, 'a.service.ts')], watching: true,
      restart: () => { restarts++ }, say: () => {},
    })
    writeFileSync(join(dir, 'a.service.ts'), 'export default { x: 1 }')
    writeFileSync(join(dir, 'notes.md'), 'hi')
    await Bun.sleep(300)
    expect(restarts).toBe(0)
  })

  test('not under --watch there is no watcher', () => {
    setup()
    expect(watchForNewServices({ dir, known: [], watching: false, restart: () => {}, say: () => {} })).toBeNull()
  })
})
