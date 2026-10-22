import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { requiresOf, missingRequires, acquireMissing } from '../core/requires.js'
import { setEnvLine, hasEnvLine, placeholderFor, ensurePlaceholder, storeGlobal, globalEnvPath } from '../core/global-env.js'

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fli-requires-'))
  return { dir, file: globalEnvPath(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('requiresOf', () => {
  test('a bare key and a key with the page it is made on read the same way', () => {
    const meta = { requires: ['GITHUB_TOKEN', { DIGITALOCEAN_TOKEN: 'https://cloud.digitalocean.com/account/api/tokens/new' }] }
    expect(requiresOf(meta)).toEqual([
      { key: 'GITHUB_TOKEN', url: null, note: null },
      { key: 'DIGITALOCEAN_TOKEN', url: 'https://cloud.digitalocean.com/account/api/tokens/new', note: null },
    ])
  })
  test('the words after the URL are what to pick on that page', () => {
    expect(requiresOf({ requires: [{ T: 'https://x.test/new  Pick Full Access' }] }))
      .toEqual([{ key: 'T', url: 'https://x.test/new', note: 'Pick Full Access' }])
  })
  test('a value that is not a URL is not a link', () => {
    expect(requiresOf({ requires: [{ X: 'see the docs' }] })).toEqual([{ key: 'X', url: null, note: null }])
    expect(requiresOf(undefined)).toEqual([])
  })
  test('an empty value is missing, because a placeholder line loads as empty', () => {
    expect(missingRequires({ requires: ['A', 'B'] }, { A: 'x', B: '' }).map(r => r.key)).toEqual(['B'])
  })
})

describe('the global env file', () => {
  test('setEnvLine replaces the line it finds and appends the one it does not', () => {
    expect(setEnvLine('A=1\nB=\n', 'B', 'two')).toBe('A=1\nB=two\n')
    expect(setEnvLine('A=1', 'C', 'x y')).toBe('A=1\n\nC="x y"\n')
    expect(hasEnvLine('# A=1\nB=', 'A')).toBe(false)
    expect(hasEnvLine('# A=1\nB=', 'B')).toBe(true)
  })

  test('a placeholder names the key, how to set it and where it is made, once', () => {
    const h = home()
    try {
      expect(ensurePlaceholder('T', 'https://x.test/new', { home: h.dir })).toBe(true)
      expect(ensurePlaceholder('T', 'https://x.test/new', { home: h.dir })).toBe(false)
      const text = readFileSync(h.file, 'utf8')
      expect(text).toContain('fli eset T <value> --global')
      expect(text).toContain('make one at https://x.test/new')
      expect(text.match(/^T=$/mg)).toHaveLength(1)
      // and eset fills the placeholder line rather than adding a second
      expect(setEnvLine(text, 'T', 'tok').match(/^T=/mg)).toHaveLength(1)
      expect(placeholderFor('K')).not.toContain('make one')
    } finally { h.cleanup() }
  })

  test('storeGlobal creates the file under its header', () => {
    const h = home()
    try {
      storeGlobal('K', 'v', { home: h.dir })
      expect(readFileSync(h.file, 'utf8')).toMatch(/^# FLI global environment[\s\S]*\nK=v\n$/)
    } finally { h.cleanup() }
  })
})

describe('acquireMissing', () => {
  const missing = [{ key: 'T', url: 'https://x.test/new' }]

  test('with no person present it says what is missing and leaves the placeholder', async () => {
    const h = home(); const said = []
    try {
      const left = await acquireMissing('prov', missing, { interactive: false, home: h.dir, say: t => said.push(t), env: {} })
      expect(left).toEqual(missing)
      expect(said[0]).toBe('prov requires: T')
      expect(said.some(l => l.includes('fli eset T <value> --global'))).toBe(true)
      expect(said.some(l => l.includes('https://x.test/new'))).toBe(true)
      expect(readFileSync(h.file, 'utf8')).toContain('T=')
    } finally { h.cleanup() }
  })

  test('under --dry nothing is written', async () => {
    const h = home()
    try {
      await acquireMissing('prov', missing, { interactive: false, write: false, home: h.dir, say: () => {}, env: {} })
      expect(() => readFileSync(h.file)).toThrow()
    } finally { h.cleanup() }
  })

  test('at a terminal the page is offered, the paste is stored, and the run may go on', async () => {
    const h = home(); const opened = []; const env = {}
    const prompts = { confirm: async () => true, ask: async () => 'tok_1', close: () => {} }
    try {
      const left = await acquireMissing('prov', missing, { interactive: true, home: h.dir, say: () => {}, env, open: u => opened.push(u), prompts })
      expect(left).toEqual([])
      expect(opened).toEqual(['https://x.test/new'])
      expect(env.T).toBe('tok_1')
      expect(readFileSync(h.file, 'utf8')).toMatch(/^T=tok_1$/m)
      expect(readFileSync(h.file, 'utf8').match(/^T=/mg)).toHaveLength(1)
    } finally { h.cleanup() }
  })

  test('a skipped paste is still missing', async () => {
    const h = home()
    const prompts = { confirm: async () => false, ask: async () => null, close: () => {} }
    try {
      const left = await acquireMissing('prov', missing, { interactive: true, home: h.dir, say: () => {}, env: {}, open: () => { throw new Error('opened') }, prompts })
      expect(left.map(r => r.key)).toEqual(['T'])
    } finally { h.cleanup() }
  })
})
