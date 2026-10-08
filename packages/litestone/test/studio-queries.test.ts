// Studio's saved queries live beside the database and never in it (FJS-D635).

import { describe, expect, it, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openSavedQueries, sidecarFor } from '../src/tools/studio-queries.js'

const dir = mkdtempSync(join(tmpdir(), 'studio-queries-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('Studio saved queries', () => {
  it('sits beside the database file, named the way SQLite names its own', () => {
    expect(sidecarFor('/app/db/shop.db')).toBe('/app/db/shop.db-studio.json')
    expect(sidecarFor('')).toBeNull()
  })

  it('saves, renames by upsert, lists by name and removes — across a reopen', () => {
    const path = join(dir, 'a.db-studio.json')
    const q = openSavedQueries(path)
    q.save('zeta', 'SELECT 1')
    q.save('alpha', 'SELECT 2')
    q.save('zeta', 'SELECT 3')
    const again = openSavedQueries(path).list()
    expect(again.map(r => [r.name, r.sql])).toEqual([['alpha', 'SELECT 2'], ['zeta', 'SELECT 3']])
    expect(again.find(r => r.name === 'zeta')!.id).toBe(1)
    openSavedQueries(path).remove(1)
    expect(openSavedQueries(path).list().map(r => r.name)).toEqual(['alpha'])
  })

  it('an absent file is an empty list, and listing writes nothing', () => {
    const path = join(dir, 'never.db-studio.json')
    expect(openSavedQueries(path).list()).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  it('a file that is not the shape is refused by name rather than read as empty', () => {
    const path = join(dir, 'bad.db-studio.json')
    writeFileSync(path, '{"rows": []}')
    expect(() => openSavedQueries(path).list()).toThrow(path)
    expect(readFileSync(path, 'utf8')).toBe('{"rows": []}')
  })

  it('an in-memory database keeps them for the process', () => {
    const q = openSavedQueries(null)
    q.save('one', 'SELECT 1')
    expect(q.list().map(r => r.name)).toEqual(['one'])
  })
})
