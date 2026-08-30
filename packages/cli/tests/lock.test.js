// ─── core/lock.js ────────────────────────────────────────────────────────────
// The deploy lock: its format, its parser, and the four scripts, EXECUTED in a
// real shell rather than compared as strings.
//
// Executed because the property that matters is not what the script says — it is
// that `set -C` actually refuses a second writer, that a refresh from another run
// does not clobber, and that a takeover reports what it displaced. The format it
// replaced was asserted nowhere and the pid in it was dead on arrival
// (`FJS-573`).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  LOCK_BASENAME, lockPath, safeValue, renderLock, parseLock,
  acquireScript, refreshScript, releaseScript, describeLock, humanAge,
} from '../core/lock.js'

const OURS = {
  run: 'a1b2c3d4', actor: 'jo', target: 'production',
  started: '2026-08-29T10:00:00Z',
}

let dir, file
const sh = (script) => {
  try {
    const out = execFileSync('sh', ['-s'], { input: script, cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { ok: true, out: out.trim() }
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? '').trim(), why: String(e.stderr ?? '').trim() }
  }
}
const body = () => (existsSync(file) ? readFileSync(file, 'utf8') : '')

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fli-lock-')); file = lockPath(dir) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// ─── the format ──────────────────────────────────────────────────────────────

describe('the format', () => {
  test('renders one field per line and round-trips', () => {
    const full = { ...OURS, step: '04-build-api', stepAt: '2026-08-29T10:04:00Z' }
    const parsed = parseLock(renderLock(full))
    for (const k of Object.keys(full)) expect(parsed[k]).toBe(full[k])
    expect(parsed.legacy).toBe(false)
  })

  test('an absent field is omitted rather than written empty', () => {
    expect(renderLock(OURS).split('\n').some(l => l.startsWith('step='))).toBe(false)
    expect(parseLock(renderLock(OURS)).step).toBe(null)
  })

  test('an empty file is no lock at all', () => {
    expect(parseLock('')).toBe(null)
    expect(parseLock('   \n ')).toBe(null)
    expect(parseLock(null)).toBe(null)
  })

  // The file on a server may have been written by an fli that predates this
  // format. A lock nobody can parse is a directory nobody can deploy to.
  test('the format it replaced still parses, and says it is legacy', () => {
    const old = parseLock('58231:2026-08-29T09:00:00Z:production')
    expect(old.legacy).toBe(true)
    expect(old.target).toBe('production')
    expect(old.run).toBe(null)
  })

  test('a value cannot carry a newline or a quote into the file', () => {
    expect(safeValue("a'b")).not.toContain("'")
    expect(safeValue('a\nrun=other')).not.toContain('\n')
    expect(safeValue('$(id)')).toBe('-id-')
  })

  test('the file name is one constant', () => {
    expect(lockPath('/srv/app')).toBe(`/srv/app/${LOCK_BASENAME}`)
  })
})

// ─── the scripts, run ────────────────────────────────────────────────────────

describe('acquire', () => {
  test('takes a free lock and writes what is true', () => {
    const r = sh(acquireScript(file, OURS))
    expect(r.ok).toBe(true)
    expect(r.out).toBe('ok')
    expect(parseLock(body()).run).toBe(OURS.run)
    expect(parseLock(body()).actor).toBe('jo')
  })

  test('refuses a held one and hands back its body on stdout', () => {
    sh(acquireScript(file, OURS))
    const r = sh(acquireScript(file, { ...OURS, run: 'zzzz' }))
    expect(r.ok).toBe(false)
    expect(r.out).toStartWith('HELD')
    expect(parseLock(r.out.replace(/^HELD\n/, '')).run).toBe(OURS.run)
    expect(parseLock(body()).run).toBe(OURS.run)
  })

  // `set -C` is the compare-and-set. A `[ -f ]` test alone is two operations
  // with a window between them, and the guard was only ever that test.
  test('noclobber refuses the redirect, not just the guard', () => {
    writeFileSync(file, 'existing\n')
    const r = sh(`set -C\nprintf '%s\\n' 'run=x' > ${file} || { echo REFUSED; exit 1; }\necho ok`)
    expect(r.ok).toBe(false)
    expect(r.out).toBe('REFUSED')
    expect(body()).toBe('existing\n')
  })
})

describe('refresh', () => {
  test('records the step and when it started', () => {
    sh(acquireScript(file, OURS))
    const r = sh(refreshScript(file, { ...OURS, step: '04-build-api', stepAt: '2026-08-29T10:04:00Z' }))
    expect(r.out).toBe('ok')
    const held = parseLock(body())
    expect(held.step).toBe('04-build-api')
    expect(held.run).toBe(OURS.run)
  })

  test('will not write over another run', () => {
    sh(acquireScript(file, OURS))
    const r = sh(refreshScript(file, { run: 'other', started: 'z', step: '06-swap' }))
    expect(r.out).toBe('stolen')
    expect(parseLock(body()).run).toBe(OURS.run)
    expect(parseLock(body()).step).toBe(null)
  })

  // A refresh is the first thing a resumed run does, and it runs before the
  // lock exists on a machine that had none.
  test('writes a lock that is not there', () => {
    expect(sh(refreshScript(file, { ...OURS, step: '01-preflight' })).out).toBe('ok')
    expect(parseLock(body()).step).toBe('01-preflight')
  })
})

describe('takeover', () => {
  test('reports what it displaced, then holds it', () => {
    sh(acquireScript(file, OURS))
    sh(refreshScript(file, { ...OURS, step: '06-swap', stepAt: 'z' }))
    const r = sh(acquireScript(file, { ...OURS, run: 'new1', actor: 'sam' }, { takeover: true }))
    expect(r.ok).toBe(true)
    expect(r.out).toContain('TOOK:')
    expect(r.out).toContain('06-swap')
    expect(parseLock(body()).run).toBe('new1')
  })

  test('a takeover of nothing says nothing and still takes it', () => {
    const r = sh(acquireScript(file, OURS, { takeover: true }))
    expect(r.out).toBe('ok')
    expect(parseLock(body()).run).toBe(OURS.run)
  })
})

describe('release', () => {
  test('removes it, and removing one that is gone is fine', () => {
    sh(acquireScript(file, OURS))
    sh(releaseScript(file))
    expect(existsSync(file)).toBe(false)
    expect(sh(releaseScript(file)).ok).toBe(true)
  })
})

// ─── what an operator reads ──────────────────────────────────────────────────

describe('describeLock', () => {
  const NOW = Date.parse('2026-08-29T10:06:00Z')

  test('no lock is not held', () => {
    expect(describeLock(null).held).toBe(false)
  })

  test('names who, since when, and which step', () => {
    const d = describeLock(parseLock(renderLock({ ...OURS, step: '04-build-api', stepAt: '2026-08-29T10:04:00Z' })), { now: NOW })
    expect(d.held).toBe(true)
    expect(d.lines[0]).toContain('jo')
    expect(d.lines[0]).toContain('production')
    expect(d.lines[0]).toContain('6m ago')
    expect(d.lines[1]).toContain('04-build-api')
    expect(d.lines[1]).toContain('2m')
  })

  // The whole point of recording the step: the same duration means opposite
  // things in a build and in the swap.
  test('a run that had not started a step says so rather than inventing one', () => {
    const d = describeLock(parseLock(renderLock(OURS)), { now: NOW })
    expect(d.lines[1]).toContain('no step recorded')
  })

  test('a legacy lock says its number cannot be probed', () => {
    const d = describeLock(parseLock('58231:2026-08-29T09:00:00Z:production'), { now: NOW })
    expect(d.legacy).toBe(true)
    expect(d.lines.join(' ')).toContain('cannot be probed')
  })

  test('an unreadable timestamp is unknown rather than a wrong duration', () => {
    const d = describeLock(parseLock(renderLock({ ...OURS, started: 'not-a-time' })), { now: NOW })
    expect(d.ageMs).toBe(null)
    expect(d.lines[0]).not.toContain('ago')
  })

  test('humanAge steps s → m → h', () => {
    expect(humanAge(4_000)).toBe('4s')
    expect(humanAge(240_000)).toBe('4m')
    expect(humanAge(7_200_000)).toBe('2h')
    expect(humanAge(null)).toBe('unknown')
  })
})
