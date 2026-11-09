// deploy-gate.test.js — Basecamp's deploy refuses an unpushed or ungraded HEAD (FJS-4118, FJS-D2040)
//
// The git half runs against a real repository and a real bare remote: a fake
// `pushedTo` would pass whatever `readGateFacts` asked git.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseCiRecord, gateVerdict, checkDeployGate, isBasecampApp } from '../core/deploy-gate.js'

const git = (cwd, ...argv) => {
  const r = spawnSync('git', argv, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const PASS = (sha, args = '') => `# 2026-11-08T00:00:00.000Z · ${sha} · ci ${args}\n\n✓ CI passed in 9.1s${args.includes('--fast') ? ' (fast tier — suites not run)' : ''}\n`
const FAIL = (sha) => `# 2026-11-08T00:00:00.000Z · ${sha} · ci\n\n✗ CI failed in 9.1s — 2 failure(s)\n`

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'fli-gate-'))
  const remote = join(dir, 'remote.git')
  const work = join(dir, 'work')
  mkdirSync(work)
  git(dir, 'init', '--bare', '-q', remote)
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'config', 'user.email', 't@t.t'); git(work, 'config', 'user.name', 't')
  mkdirSync(join(work, 'packages/basecamp'), { recursive: true })
  writeFileSync(join(work, 'packages/basecamp/package.json'), JSON.stringify({ name: '@frontierjs/basecamp' }))
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'one')
  git(work, 'remote', 'add', 'origin', remote)
  const app = join(work, 'packages/basecamp')
  const head = () => git(work, 'rev-parse', 'HEAD')
  const ci = (text) => { mkdirSync(join(work, '.cache'), { recursive: true }); writeFileSync(join(work, '.cache/ci-last.txt'), text) }
  return { dir, work, app, head, ci, push: () => git(work, 'push', '-q', '-u', 'origin', 'main') }
}

describe('parseCiRecord', () => {
  test('reads the header sha and the verdict line', () => {
    expect(parseCiRecord(PASS('abc1234'))).toMatchObject({ head: 'abc1234', passed: true, fast: false })
    expect(parseCiRecord(FAIL('abc1234'))).toMatchObject({ passed: false })
    expect(parseCiRecord(PASS('abc1234', '--fast'))).toMatchObject({ passed: true, fast: true })
    expect(parseCiRecord('not a record')).toBeNull()
  })
})

describe('gateVerdict', () => {
  const head = 'a'.repeat(40)
  const ok = { head, pushedTo: ['origin/main'], ci: { head, passed: true, fast: false } }
  test('passes a pushed commit with a green full run', () => expect(gateVerdict(ok).ok).toBe(true))
  test.each([
    ['unpushed', { ...ok, pushedTo: [] }, 'not on any remote'],
    ['no record', { ...ok, ci: null }, 'no CI record'],
    ['another commit', { ...ok, ci: { ...ok.ci, head: 'b'.repeat(40) } }, 'graded bbbbbbbbb'],
    ['fast tier', { ...ok, ci: { ...ok.ci, fast: true } }, 'fast tier'],
    ['red', { ...ok, ci: { ...ok.ci, passed: false } }, 'CI failed'],
  ])('refuses %s', (_, facts, said) => {
    const v = gateVerdict(facts)
    expect(v.ok).toBe(false)
    expect(v.refusals.join('\n')).toContain(said)
  })
  test('--unverified passes and names every refusal it skipped', () => {
    const v = gateVerdict({ ...ok, pushedTo: [], ci: null, unverified: true })
    expect(v.ok).toBe(true)
    expect(v.skipped).toHaveLength(2)
  })
})

describe('checkDeployGate on a real repository', () => {
  test('refuses until HEAD is pushed and graded, then passes', () => {
    const r = repo()
    try {
      expect(isBasecampApp(r.app)).toBe(true)
      expect(checkDeployGate(r.app).ok).toBe(false)
      r.push()
      expect(checkDeployGate(r.app).ok).toBe(false)               // pushed, no CI record
      r.ci(PASS(r.head().slice(0, 9)))
      expect(checkDeployGate(r.app).ok).toBe(true)
      writeFileSync(join(r.work, 'x'), '1'); git(r.work, 'add', 'x'); git(r.work, 'commit', '-qm', 'two')
      const moved = checkDeployGate(r.app)                        // a commit landed after the check
      expect(moved.ok).toBe(false)
      expect(moved.lines.map(l => l[1]).join('\n')).toContain('not on any remote')
      expect(checkDeployGate(r.app, { unverified: true }).lines.some(l => l[0] === 'warn')).toBe(true)
    } finally { rmSync(r.dir, { recursive: true, force: true }) }
  })
  test('a red record on the pushed HEAD refuses', () => {
    const r = repo()
    try {
      r.push(); r.ci(FAIL(r.head().slice(0, 9)))
      expect(checkDeployGate(r.app).lines.map(l => l[1]).join('\n')).toContain('CI failed')
    } finally { rmSync(r.dir, { recursive: true, force: true }) }
  })
})

describe('the ssh door', () => {
  test('01-preflight asks the gate before it takes the lock', () => {
    const step = readFileSync(new URL('../commands/deploy/_steps-docker/01-preflight.md', import.meta.url), 'utf8')
    expect(step).toContain('checkDeployGate(')
    expect(step.indexOf('checkDeployGate(')).toBeLessThan(step.indexOf('acquireLock('))
  })
  test('deploy declares --unverified', () => {
    expect(readFileSync(new URL('../commands/deploy/index.md', import.meta.url), 'utf8')).toMatch(/^  unverified:/m)
  })
})
