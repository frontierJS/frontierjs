// test/tool-stdout.test.ts
//
// A tool's document on stdout arrives whole through a pipe.
//
// Every tool under tools/ ends with `process.exit`, because the app it booted
// holds a database and a poller open. Under Bun a stdout write still queued at
// that exit is dropped with no error on either side, so `fli app:atlas` parsed
// the first 16384 bytes of a 36 KB document. A file or a terminal hides it, and
// so does `spawnSync`'s own pipe, which drains fast enough to take all of it
// before the exit — the tool runs behind a shell pipe here, as `| jq` runs it.

import { describe, expect, it } from 'bun:test'
import { execSync }                         from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }                           from 'node:os'
import { join, resolve }                    from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

// Enough services that the atlas is several times a pipe buffer.
const APP = `
import { createApp, createService } from ${JSON.stringify(join(ROOT, 'index.ts'))}

export async function buildApp() {
  const app = createApp({
    config: {
      port:     0,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
    },
  })
  for (let i = 0; i < 200; i++) {
    app.services.register(createService({
      name:    'service-with-a-long-enough-name-' + i,
      methods: ['find', 'get'],
      async find() { return { data: [], total: 0, limit: 10, skip: 0 } },
      async get()  { return {} },
    }))
  }
  return app
}
`

describe('a tool writing its document to a pipe', () => {
  it('junction atlas arrives whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'junction-stdout-'))
    try {
      writeFileSync(join(dir, 'app.ts'), APP)
      const out = execSync(`"${process.execPath}" "${join(ROOT, 'tools/cli.ts')}" atlas --app app.ts 2>/dev/null | cat`, {
        cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20,
      })
      expect(out.length).toBeGreaterThan(64 * 1024)
      expect(() => JSON.parse(out)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  // The app's shutdown logs on stdout; a snapshot tool that stops it outside
  // `quietly` ends its document with two [App] Shutting down lines.
  it.each(['surface', 'jobs', 'notifications', 'principal'])('junction %s --stdout ends at the document', tool => {
    const dir = mkdtempSync(join(tmpdir(), 'junction-stdout-'))
    try {
      writeFileSync(join(dir, 'app.ts'), APP)
      const out = execSync(`"${process.execPath}" "${join(ROOT, 'tools/cli.ts')}" ${tool} --app app.ts --stdout 2>/dev/null | cat`, {
        cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20,
      })
      expect(out).not.toContain('Shutting down')
      expect(out).not.toContain('Shutdown complete')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
