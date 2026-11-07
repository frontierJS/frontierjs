// The deploy preflight's journal guard (core/migration-journal.js), over real
// migration files, litestone's real checksum, and a fake box that answers the
// probe the way the running container would.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { checksum } from '@frontierjs/litestone/migrate'
import {
  journalDisagreements, journalRefusal, journalProbeScript, parseProbe, checkJournal,
} from '../core/migration-journal.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const INITIAL = 'CREATE TABLE "lead" (id INTEGER PRIMARY KEY);\n'
const EVOLVE  = 'ALTER TABLE "lead" ADD COLUMN name TEXT;\n'
const FILES   = { '20260801000000_initial_schema.sql': INITIAL, '20260802000000_evolve.sql': EVOLVE }

let TMP, DIR

beforeEach(() => {
  TMP = resolve(ROOT, `.tmp-journal-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  DIR = join(TMP, 'db/migrations')
  mkdirSync(join(DIR, 'main'), { recursive: true })
  mkdirSync(join(DIR, 'audit'), { recursive: true })
  for (const [f, sql] of Object.entries(FILES)) writeFileSync(join(DIR, 'main', f), sql)
  writeFileSync(join(DIR, 'audit/20260801000000_audit_trail.sql'), 'CREATE TABLE "t" (id INTEGER);\n')
})
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

const journalOf = (files) => Object.entries(files).map(([name, sql]) => ({ name, checksum: checksum(sql) }))
const auditJournal = [{ name: '20260801000000_audit_trail.sql', checksum: checksum('CREATE TABLE "t" (id INTEGER);\n') }]

// A box whose container is `running` and prints `probe` for the journal probe.
// `commands` is every script it was handed, in order.
const fakeBox = ({ running = true, probe = null, throws = false } = {}) => {
  const commands = []
  return {
    commands,
    run: (script) => {
      commands.push(script)
      if (!running) throw new Error('No such object')
    },
    capture: (script) => {
      commands.push(script)
      if (throws) throw new Error('bun: command not found')
      return probe === null ? '' : `noise before\n${JSON.stringify(probe)}\n`
    },
  }
}

const probeOf = (main, audit = auditJournal) => ({ multi: true, journals: { main, audit } })
const check = (box, extra = {}) =>
  checkJournal({ machine: box, container: 'app_api', migrationsRoot: DIR, ...extra })

describe('journalDisagreements', () => {
  test('a journal the files agree with answers nothing, pending files included', () => {
    expect(journalDisagreements(journalOf({ '20260801000000_initial_schema.sql': INITIAL }), join(DIR, 'main'))).toEqual([])
    expect(journalDisagreements(journalOf(FILES), join(DIR, 'main'))).toEqual([])
  })

  test('an applied file edited since names the file and both checksums', () => {
    writeFileSync(join(DIR, 'main/20260801000000_initial_schema.sql'), INITIAL + '-- reformatted\n')
    const [d, ...rest] = journalDisagreements(journalOf(FILES), join(DIR, 'main'))
    expect(rest).toEqual([])
    expect(d).toEqual({
      file:    '20260801000000_initial_schema.sql',
      applied: checksum(INITIAL),
      local:   checksum(INITIAL + '-- reformatted\n'),
    })
  })

  test('an applied row with no file is reported with no local checksum', () => {
    rmSync(join(DIR, 'main/20260802000000_evolve.sql'))
    expect(journalDisagreements(journalOf(FILES), join(DIR, 'main')))
      .toEqual([{ file: '20260802000000_evolve.sql', applied: checksum(EVOLVE), local: null }])
  })
})

describe('journalRefusal', () => {
  test('names each file with both checksums and says what to do', () => {
    const text = journalRefusal({
      main:  [{ file: 'a.sql', applied: 'aaaa', local: 'bbbb' }],
      audit: [{ file: 'b.sql', applied: 'cccc', local: null }],
    })
    expect(text).toContain('main/a.sql -- edited after it was applied (box aaaa, release bbbb)')
    expect(text).toContain('audit/b.sql -- applied on the box (checksum cccc), but this release has no such file')
    expect(text).toContain('Restore the applied text')
    expect(text).toContain('new migration')
    expect(text).toContain('reinstall')
  })
})

describe('parseProbe', () => {
  test('reads the last JSON line and answers null for anything else', () => {
    expect(parseProbe('warn\n{"multi":true,"journals":{}}\n')).toEqual({ multi: true, journals: {} })
    expect(parseProbe('')).toBeNull()
    expect(parseProbe('{not json')).toBeNull()
    expect(parseProbe('{"x":1}')).toBeNull()
  })
})

describe('checkJournal', () => {
  test('a matching journal passes', () => {
    expect(check(fakeBox({ probe: probeOf(journalOf(FILES)) }))).toEqual({ ok: true })
  })

  test('an edited file refuses, naming it and both checksums', () => {
    writeFileSync(join(DIR, 'main/20260801000000_initial_schema.sql'), INITIAL.replace('lead', 'prospect'))
    const v = check(fakeBox({ probe: probeOf(journalOf(FILES)) }))
    expect(v.ok).toBe(false)
    expect(v.message).toContain('main/20260801000000_initial_schema.sql')
    expect(v.message).toContain(checksum(INITIAL))
    expect(v.message).toContain(checksum(INITIAL.replace('lead', 'prospect')))
  })

  test('the second database is read against its own directory', () => {
    writeFileSync(join(DIR, 'audit/20260801000000_audit_trail.sql'), 'CREATE TABLE "other" (id INTEGER);\n')
    const v = check(fakeBox({ probe: probeOf(journalOf(FILES)) }))
    expect(v.ok).toBe(false)
    expect(v.message).toContain('audit/20260801000000_audit_trail.sql')
    expect(v.message).not.toContain('main/')
  })

  test('an applied row with no file refuses', () => {
    rmSync(join(DIR, 'main/20260802000000_evolve.sql'))
    const v = check(fakeBox({ probe: probeOf(journalOf(FILES)) }))
    expect(v.ok).toBe(false)
    expect(v.message).toContain('main/20260802000000_evolve.sql')
    expect(v.message).toContain('no such file')
  })

  test('a flat migrations directory is read as one database', () => {
    for (const [f, sql] of Object.entries(FILES)) writeFileSync(join(DIR, f), sql)
    writeFileSync(join(DIR, '20260801000000_initial_schema.sql'), INITIAL + '--edit\n')
    const v = check(fakeBox({ probe: { multi: false, journals: { main: journalOf(FILES) } } }))
    expect(v.ok).toBe(false)
    expect(v.message).toContain('main/20260801000000_initial_schema.sql')
  })

  test('no journal table (null) or an empty one passes', () => {
    writeFileSync(join(DIR, 'main/20260801000000_initial_schema.sql'), 'edited\n')
    expect(check(fakeBox({ probe: probeOf(null, []) }))).toEqual({ ok: true })
  })

  test('no container passes, and asks nothing of it', () => {
    const box = fakeBox({ running: false, probe: probeOf(journalOf(FILES)) })
    expect(check(box)).toEqual({ ok: true })
    expect(box.commands.some(c => c.includes('bun -e'))).toBe(false)
  })

  test('a probe that fails or prints nothing passes', () => {
    expect(check(fakeBox({ throws: true }))).toEqual({ ok: true })
    expect(check(fakeBox({ probe: null }))).toEqual({ ok: true })
  })

  test('both reads ask the box under --dry, so a dry run is refused on a mismatch', () => {
    writeFileSync(join(DIR, 'main/20260801000000_initial_schema.sql'), 'edited\n')
    const opts = []
    const box = fakeBox({ probe: probeOf(journalOf(FILES)) })
    const seen = { run: box.run, capture: box.capture }
    box.run = (script, o) => { opts.push(o); return seen.run(script) }
    box.capture = (script, o) => { opts.push(o); return seen.capture(script) }
    expect(check(box).ok).toBe(false)
    expect(opts).toEqual([{ dry: false }, { dry: false }])
  })

  test('the probe goes to the named container, read-only', () => {
    const script = journalProbeScript('app_api')
    expect(script).toStartWith('docker exec app_api sh -c ')
    expect(script).toContain('readonly: true')
  })
})
