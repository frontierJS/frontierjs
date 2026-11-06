// FJS-3973 -- the local provider's traversal guard refuses a sibling of its root
// whose name merely begins with the root's, not only a key that climbs out by `..`.

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { LocalProvider } from '../src/storage/providers/local.js'

describe('LocalProvider key guard (FJS-3973)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ls-trav-'))
  const root = join(parent, 'storage')
  mkdirSync(root, { recursive: true })
  const provider = new LocalProvider({ localPath: root }) as any
  afterAll(() => rmSync(parent, { recursive: true, force: true }))

  test('a key inside the root resolves', () => {
    expect(provider._filePath('Clip/1/a.bin')).toBe(join(root, 'Clip/1/a.bin'))
  })

  test('a key climbing out of the root is refused', () => {
    expect(() => provider._filePath('../x')).toThrow(/Invalid key/)
  })

  test('a key resolving to a sibling whose name begins with the root is refused', () => {
    expect(() => provider._filePath(`../${basename(root)}-evil/x`)).toThrow(/Invalid key/)
  })
})
