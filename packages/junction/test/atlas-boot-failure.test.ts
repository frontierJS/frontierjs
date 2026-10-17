// test/atlas-boot-failure.test.ts
//
// `junction atlas` boots the app, and an app that refuses to boot (`FJS-2816`)
// has to say WHY where its caller reads it. The caller is `fli app:atlas`,
// which keeps the last six lines of stderr: Bun's own crash dump puts the
// message above the stack and its version line, so the message was cut and a
// named refusal read as a crash with no cause.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ATLAS = resolve(import.meta.dir, '../tools/atlas.ts')
const INDEX = resolve(import.meta.dir, '../index.ts')

describe('junction atlas — an app that will not boot', () => {
  it('ends its stderr on the refusal message, so a six-line tail still holds it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-boot-'))
    try {
      writeFileSync(join(dir, 'app.ts'), `
        import { createApp } from ${JSON.stringify(INDEX)}
        export const app = createApp({
          config: { port: 0 },
        })
        app.configure({
          name:     'collider',
          register: () => {},
          boot:     () => { throw new Error("service 'people' is already registered by this app") },
        })
      `)
      const run  = Bun.spawnSync(['bun', ATLAS, '--app', join(dir, 'app.ts')], { cwd: dir })
      const tail = run.stderr.toString().trim().split('\n').slice(-6).join('\n')

      expect(run.exitCode).toBe(1)
      expect(tail).toContain(`Plugin "collider" boot failed: service 'people' is already registered by this app`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
