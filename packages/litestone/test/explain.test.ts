// test/explain.test.ts — the catalog's second reader
//
// `litestone explain` exists to prove the catalog is a module rather than a
// Studio panel: the same rows answer in a terminal with no server, no schema
// and no database. So the assertions here are mostly about the things a second
// reader gets wrong — an ambiguous bare word, a near-miss, a machine caller —
// rather than about whether the prose renders.
//
// Spawned as a real subprocess, because the failure this guards against is a
// command that throws before it prints anything, which an in-process call to
// the render function would never see (FJS-269 was exactly that shape).

import { describe, test, expect } from 'bun:test'
import { resolve } from 'path'
import { spawnSync } from 'child_process'

const CLI = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')

/** Color codes make every assertion a substring puzzle; strip them. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

function run(...args: string[]) {
  const r = spawnSync('bun', [CLI, 'explain', ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  return { out: plain(r.stdout ?? ''), err: plain(r.stderr ?? ''), status: r.status }
}

describe('litestone explain', () => {
  test('needs no schema, no database and no cwd — it is the catalog and nothing else', () => {
    const r = spawnSync('bun', [CLI, 'explain', '@guarded'], { encoding: 'utf8', cwd: '/tmp' })
    expect(r.status).toBe(0)
    expect(plain(r.stdout)).toContain('asSystem()')
  })

  test('a word prints its arity, blurb and worked example', () => {
    const { out, status } = run('@guarded')
    expect(status).toBe(0)
    expect(out).toContain('@guarded')
    expect(out).toContain('(all)')
    expect(out).toContain('internalScore Int @guarded')
  })

  test('it says where a word is legal only when that is not the ordinary answer', () => {
    expect(run('@guarded').out).toContain("on a trait's field")   // refused in a type
    expect(run('@length').out).not.toContain('legal')             // legal wherever its level allows
  })

  test('a bare word that exists at two levels answers with both', () => {
    const { out } = run('unique')
    expect(out).toContain('@unique')
    expect(out).toContain('@@unique')
    expect(out).toContain('the prefix picks which')
  })

  test('the prefix disambiguates, so a caller who typed one gets one', () => {
    expect(run('@@unique').out).toContain('composite')
    expect(run('@unique').out).not.toContain('composite')
  })

  test('a near miss suggests rather than only refusing', () => {
    const { out, status } = run('gaurded')
    expect(status).toBe(1)
    expect(out).toContain('@guarded')
  })

  test('a word with enumerated values lists them', () => {
    expect(run('@@fts').out).toContain('trigram')
    expect(run('@relation').out).toContain('SetNull')
  })

  test('--visibility answers the question the other way round', () => {
    const { out } = run('--visibility')
    for (const w of ['@computed', '@transient', '@system', '@guarded', '@encrypted'])
      expect(out).toContain(w)
    expect(out).toContain('not expressible')   // the combination that is not a word
  })

  test('a field attribute in that table points at it', () => {
    expect(run('@system').out).toContain('--visibility')
  })

  test('with no word it lists every one, grouped', () => {
    const { out, status } = run()
    expect(status).toBe(0)
    expect(out).toContain('Declarations')
    expect(out).toContain('Field attributes')
    expect(out).toContain('Model attributes')
  })

  test('--json answers a machine, and an unknown word answers one too', () => {
    const all = JSON.parse(run('--json').out)
    expect(Array.isArray(all)).toBe(true)
    expect(all.length).toBeGreaterThan(80)

    const one = JSON.parse(run('@guarded', '--json').out)
    expect(one[0].word).toBe('guarded')
    expect(one[0].positions).toEqual(['field', 'traitField'])

    const miss = run('nosuchword', '--json')
    expect(miss.status).toBe(1)
    expect(JSON.parse(miss.out).error).toContain('nosuchword')
  })
})
