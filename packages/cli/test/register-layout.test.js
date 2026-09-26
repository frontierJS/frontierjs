// register-layout.test.js — a project that is not this one.
//
// Every other register suite writes `FJS-` rows at the fixture's root, which is
// this repo's own layout and so the one a hardcoded reader passes. This fixture
// is the other layout: `ELA-` ids, the files in `.project/`, and links written
// both relative to the register file and relative to the project root. A reader
// that still assumes either half of this repo's layout reads it as empty, so
// every assertion here is about a record that must be FOUND.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { readRegisters, findRegisterRoot, registerLayout } from '../core/registers.js'
import { runRegisterCheck } from '../core/register-check.js'
import { rankNext }         from '../core/next.js'
import { decide }           from '../core/decide.js'

const TODAY = new Date('2026-09-25T12:00:00')

let ROOT

function project(declared) {
  const root = mkdtempSync(join(tmpdir(), 'fli-layout-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ela', registers: declared }))
  mkdirSync(join(root, 'api', 'src'), { recursive: true })
  writeFileSync(join(root, 'api', 'src', 'texts.js'), '')
  mkdirSync(join(root, '.project', 'IDEAS'), { recursive: true })

  writeFileSync(join(root, '.project', 'ISSUES.md'), [
    '# Issues',
    '',
    '## S2 — high',
    '',
    '| Id | Area | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
    '| <a id="ela-001"></a>ELA-001 | api | **STOP throws** | open | 2026-09-25 | [texts](../api/src/texts.js) · [texting](IDEAS/texting.md) |',
    '',
    '## S3 — medium',
    '',
    '| Id | Area | Title | Status | Verified | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
    '| <a id="ela-003"></a>ELA-003 | api | **No consent check** | open | 2026-09-25 | [texts](api/src/texts.js), blocked by ELA-001, per ELA-D1 |',
    '',
  ].join('\n'))

  writeFileSync(join(root, '.project', 'DECISIONS.md'), [
    '# Decisions',
    '',
    '## API & integrations',
    '',
    '### <a id="ela-d1"></a>2026-09-20 · `ELA-D1` — Telnyx is the only SMS provider',
    '',
    'Body.',
    '',
  ].join('\n'))

  writeFileSync(join(root, '.project', 'IDEAS', 'texting.md'), [
    '---',
    'id: texting',
    'status: proposed',
    '---',
    '',
    '# Idea — Texting, after ELA-D1',
    '',
    '## Open questions',
    '',
    '- **Keep n8n as the inbound path?** Two paths behave differently today.',
    '  - **A** — keep it, and route Telnyx through the same hooks',
    '  - **B** — drop it',
    '  - **Recommend A** — the hooks are where STOP is handled',
    '',
  ].join('\n'))

  return root
}

beforeAll(() => { ROOT = project({ prefix: 'ELA', dir: '.project' }) })
afterAll(()  => { rmSync(ROOT, { recursive: true, force: true }) })

describe('a declared prefix and directory', () => {

  test('every record is read, with paths from the project root', () => {
    const doc = readRegisters(ROOT)
    expect(doc.prefix).toBe('ELA')
    expect(doc.issues.map(r => r.id)).toEqual(['ELA-001', 'ELA-003'])
    expect(doc.decisions.map(r => r.id)).toEqual(['ELA-D1'])
    expect(doc.ideas.map(r => r.id)).toEqual(['texting'])
    expect(doc.issues[0].file).toBe('.project/ISSUES.md')
    expect(doc.ideas[0].file).toBe('.project/IDEAS/texting.md')
    expect(doc.unparsed).toEqual([])
  })

  test('citations are read under the declared prefix', () => {
    const [, consent] = readRegisters(ROOT).issues
    expect(consent.refs).toEqual(['ELA-001', 'ELA-D1'])
  })

  test('the check grades it clean, links resolving from the file and from the root', () => {
    const { errors } = runRegisterCheck({ root: ROOT, staleDays: 0 })
    expect(errors).toEqual([])
  })

  test('a row under another prefix is unparsed, not read', () => {
    const root = project({ prefix: 'ELA', dir: '.project' })
    const path = join(root, '.project', 'ISSUES.md')
    writeFileSync(path, readFileSync(path, 'utf8') +
      '| FJS-9 | api | **Pasted from elsewhere** | open | 2026-09-25 | — |\n')
    const doc = readRegisters(root)
    expect(doc.issues.map(r => r.id)).not.toContain('FJS-9')
    expect(doc.unparsed.map(u => u.text)).toEqual([expect.stringContaining('FJS-9')])
    rmSync(root, { recursive: true, force: true })
  })

  test('the register root is found from inside a surface', () => {
    expect(findRegisterRoot(join(ROOT, 'api', 'src'))).toBe(ROOT)
    expect(registerLayout(ROOT).dir).toBe(join(ROOT, '.project'))
  })

  test('a blocker is recognized under the declared prefix', () => {
    const out = rankNext(ROOT, { touched: new Set() })
    expect(out.blocked.map(r => r.id)).toEqual(['ELA-003'])
  })

  test('a ruling is minted under the prefix, into the directory, linking from there', () => {
    const root = project({ prefix: 'ELA', dir: '.project' })
    const out  = decide({ root, id: 'texting:keep-n8n-as-the-inbound-path', pick: 'A', section: 'API & integrations', today: TODAY })
    expect(out.ok).toBe(true)
    expect(out.ruling).toBe('ELA-D2')
    const dec = readFileSync(join(root, '.project', 'DECISIONS.md'), 'utf8')
    expect(dec).toContain('### <a id="ela-d2"></a>2026-09-25 · `ELA-D2`')
    expect(dec).toContain('](IDEAS/texting.md)')
    rmSync(root, { recursive: true, force: true })
  })

})

describe('an undeclared prefix', () => {

  test('the check refuses and names the key', () => {
    const root = project({ dir: '.project' })
    expect(() => runRegisterCheck({ root })).toThrow(/"registers": \{ "prefix"/)
    rmSync(root, { recursive: true, force: true })
  })

  test('a malformed one is quoted back', () => {
    const root = project({ prefix: 'ela-', dir: '.project' })
    expect(() => runRegisterCheck({ root })).toThrow(/"ela-" is not/)
    rmSync(root, { recursive: true, force: true })
  })

  test('decide refuses rather than minting an id under no prefix', () => {
    const root = project({ dir: '.project' })
    const out  = decide({ root, id: 'texting:keep-n8n-as-the-inbound-path', pick: 'A', section: 'API & integrations', today: TODAY })
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/registers\.prefix/)
    rmSync(root, { recursive: true, force: true })
  })

})
