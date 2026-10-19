// audit-browser-host.test.ts — what the client reaches for on a host that has no
// `process`, `Bun`, `Buffer` or `setImmediate` (audit run 2.3, `FJS-D305`).
//
// `#host` promises that a facility the browser lacks is refused BY NAME, with
// `code: 'HOST_UNAVAILABLE'`, at the moment it is reached. A ReferenceError for
// a server global is the other thing that can happen, and it is what a module
// gets by naming the global instead of asking `#host` — the walk in
// `engine-seam.test.ts` grades imports and cannot see it.
//
// The scenarios are `fixtures/audit-browser-scenarios.mjs`, run here under
// `node --conditions=browser` with those four globals removed
// (`fixtures/audit-browser-host.mjs`). The same file runs in Chrome over the
// wasm engine from `test/browser/audit-browser-seams.mjs`, which is where each
// `.failing` row below was first measured; this is the half `bun test` can
// spawn. Every assertion states the FIXED behavior.

import { describe, it, expect, test } from 'bun:test'
import { join } from 'path'

const FIXTURE = join(import.meta.dir, 'fixtures/audit-browser-host.mjs')

const probe = Bun.spawnSync(['node', '-e', "import('node:sqlite').then(()=>process.exit(0),()=>process.exit(1))"])
const available = probe.exitCode === 0

type Answer = Record<string, any>
let answers: Record<string, Answer> = {}

if (available) {
  const run = Bun.spawnSync(['node', '--conditions=browser', '--no-warnings', FIXTURE], { stdout: 'pipe', stderr: 'pipe' })
  const line = run.stdout.toString().trim().split('\n').pop() ?? '[]'
  try {
    for (const { name, value } of JSON.parse(line) as Array<{ name: string, value: Answer }>) answers[name] = value
  } catch {
    throw new Error(`the fixture printed no JSON:\n${run.stdout.toString()}\n${run.stderr.toString()}`)
  }
}

const d = describe.skipIf(!available)

d('the fixture is a browser-shaped host', () => {
  it('has none of the four server globals', () => {
    expect(answers['host-globals']).toEqual({ setImmediate: 'undefined', process: 'undefined', Buffer: 'undefined', Bun: 'undefined' })
  })

  // Two controls: where a module DOES ask `#host`, the refusal arrives by name.
  it('a jsonl model is refused by name, through #host', () => {
    expect(answers['jsonl']?.code).toBe('HOST_UNAVAILABLE')
    expect(answers['jsonl']?.message).toContain('mkdirSync is not available in a browser')
  })
  it('an @encrypted schema with no key is refused the same way as on a server', () => {
    expect(answers['encrypted-no-key']?.message).toContain('no encryption key')
  })
  it('an encryptionKey on a device is refused by #host, naming the attribute', () => {
    const v = answers['encrypted-with-key']
    expect(v.name).not.toBe('ReferenceError')
    expect(v.code).toBe('HOST_UNAVAILABLE')
    expect(v.message).toContain('@encrypted')
  })
})

d('a server global named outside #host', () => {
  // core/databases.js resolveDbPath asks `#host` for the env var behind `path env(...)`.
  test('a `database { path env(...) }` resolves its default, or is refused by name', () => {
    const v = answers['env-path']
    expect(v.name).not.toBe('ReferenceError')
    expect(v.opened === true || /not set|HOST_UNAVAILABLE/.test(`${v.message}${v.code}`)).toBe(true)
  })

  // core/audit-log.js armExitFlush: `typeof process?.on` evaluates `process`
  // before `typeof` can protect it, inside the create() that fired the log.
  test('a @@trail write lands and the write resolves; the trail failure is a warning', () => {
    const v = answers['trail']
    expect(v.landed).toBe(1)
    expect(v.threw).toBeNull()
  })

  // core/encryption.js opaqueMark took its digest from createHmac, which a
  // device refuses (FJS-3310).
  test('an @opaque value reaches the trail as [opaque:<digest>] and the write resolves', () => {
    const v = answers['opaque-trail']
    expect(v.threw).toBeNull()
    expect(JSON.stringify(v.warnings)).not.toContain('createHmac')
    expect(JSON.parse(v.after).sealed).toMatch(/^\[opaque:[A-Za-z0-9_-]{12}\]$/)
  })

  // core/client.js mints the cross-process writer id through `#host`'s processId.
  test('`announce crossProcess` opens, or is refused by name', () => {
    const v = answers['cross-process']
    expect(v.name).not.toBe('ReferenceError')
    expect(v.opened === true || v.code === 'HOST_UNAVAILABLE').toBe(true)
  })

  // core/hooks.js emit() and core/client.js dispatchEvent() defer through
  // `defer`, which falls back to setTimeout where there is no setImmediate.
  test('an onEvent listener fires after the write, and the write resolves', () => {
    const v = answers['on-event-hook']
    expect(v.threw).toBeNull()
    expect(v.fired).toBe(1)
    expect(v.landed).toBe(1)
  })

  // core/backup.js writes through #host, which refuses a file on a device.
  test('$backup on a device is refused by name', () => {
    const v = answers['backup']
    expect(v.name).not.toBe('ReferenceError')
    expect(v.code).toBe('HOST_UNAVAILABLE')
  })
})

describe('node:sqlite availability', () => {
  it('reports the skip rather than passing silently', () => {
    if (!available) console.warn('[skip] node:sqlite is unavailable — the browser-host scenarios did not run')
    expect(typeof available).toBe('boolean')
  })
})
