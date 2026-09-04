// pview-state.test.js — `fli project:view` answers whether the app is running.
//
// The viewer is read off FILES, so it draws a complete chain of responsibility
// for an app that is not started and looks identical either way. `/state` is
// the half that cannot come from the tree.
//
// It is answered by the command's own server rather than fetched from the app,
// and that is the design: a browser reaching `localhost:8110/api/health` from
// the viewer's origin is a cross-origin request the app has no reason to allow,
// and a CORS failure would read as *the app is down*.
//
// This boots the real command, because the thing under test is the WIRING —
// that the route exists, that it resolves `core/runnables.js` from `fliRoot`,
// and that its shape is the one the badge reads. Every one of those is fine in
// isolation and can still be absent from the command file.
//
// It spawns, so it is careful: a fixed test-tier port, a bounded wait, and a
// kill of the process GROUP. `fli` is a launcher — signaling the pid leaves
// what it started running, which is the defect that cost this repo an
// afternoon of orphaned suites.

import { describe, test, expect, afterAll } from 'bun:test'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const CLI  = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(CLI, '../..')
const APP  = resolve(REPO, 'example')

// Tooling on the TEST tier, so a drive cannot collide with a `project:view`
// somebody has open on 8501.
const PORT = 7502
const BASE = `http://localhost:${PORT}`

let child = null
afterAll(() => {
  if (!child) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
})

const hasApp = existsSync(resolve(APP, 'db', 'schema.lite'))

describe.if(hasApp)('GET /state', () => {

  test('the command serves it, and it is the shape the badge reads', async () => {
    child = spawn('bun', [resolve(CLI, 'bin/fli.js'), 'project:view', '--port', String(PORT), '--no-open'], {
      cwd: APP, stdio: 'ignore', detached: true,
    })

    // Bounded: a server that never comes up must fail this test rather than
    // hang the suite.
    let body = null
    for (let i = 0; i < 60 && !body; i++) {
      body = await fetch(`${BASE}/state`).then(r => r.json()).catch(() => null)
      if (!body) await Bun.sleep(250)
    }
    expect(body).not.toBeNull()

    expect(typeof body.at).toBe('string')
    expect(Array.isArray(body.rows)).toBe(true)
    expect(body.rows.length).toBeGreaterThan(0)

    // The app's OWN surfaces, and not the tooling block: `fli gui` being up is
    // not a fact about the app this page maps, and putting it in the badge
    // would make the badge mean two things.
    for (const r of body.rows) {
      expect(r.id.startsWith('surface:')).toBe(true)
      expect(typeof r.port).toBe('number')
      expect(body.state[r.id]).toBeDefined()
      expect(['up', 'down', 'claimed-dead', 'unknown']).toContain(body.state[r.id].state)
    }

    // Every surface an app has takes a port, so none of them can be `unknown` —
    // which is the answer for a row that cannot be probed at all.
    expect(body.rows.every(r => body.state[r.id].state !== 'unknown')).toBe(true)
  }, 30_000)

})
