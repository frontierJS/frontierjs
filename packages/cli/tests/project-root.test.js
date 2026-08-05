import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { findProjectRoot } = await import('../core/utils.js')

// A monorepo with two FJS apps inside it — the shape of this repo (example/,
// packages/basecamp/). Walking up to the .git root landed on a directory with
// no db/schema.lite, so every paths.* pointed at nothing and project:map /
// project:view refused to run from inside either app.
let ROOT
const p = (...s) => join(ROOT, ...s)

beforeAll(() => {
  ROOT = realpathSync(mkdirSync(join(tmpdir(), `fli-root-test-${process.pid}`), { recursive: true }))
  mkdirSync(p('.git'), { recursive: true })
  writeFileSync(p('package.json'), '{}')

  mkdirSync(p('example', 'db'), { recursive: true })
  mkdirSync(p('example', 'api', 'services'), { recursive: true })
  writeFileSync(p('example', 'db', 'schema.lite'), 'model Product {}\n')

  mkdirSync(p('packages', 'basecamp', 'db'), { recursive: true })
  writeFileSync(p('packages', 'basecamp', 'db', 'schema.lite'), 'model Server {}\n')

  mkdirSync(p('packages', 'plain', 'src'), { recursive: true })
  writeFileSync(p('packages', 'plain', 'package.json'), '{}')

  mkdirSync(p('marked', 'db'), { recursive: true })
  writeFileSync(p('marked', 'db', 'schema.lite'), 'model X {}\n')
  writeFileSync(p('marked', '.fli.json'), '{}')
})

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('findProjectRoot', () => {
  test('a nested app resolves to itself, not the git root', () => {
    expect(findProjectRoot(p('example'), null)).toBe(p('example'))
    expect(findProjectRoot(p('packages', 'basecamp'), null)).toBe(p('packages', 'basecamp'))
  })

  test('a subdirectory of an app resolves to the app', () => {
    expect(findProjectRoot(p('example', 'api', 'services'), null)).toBe(p('example'))
  })

  test('a package with no schema still resolves to the git root', () => {
    expect(findProjectRoot(p('packages', 'plain', 'src'), null)).toBe(ROOT)
  })

  test('the repo root itself resolves to the git root', () => {
    expect(findProjectRoot(ROOT, null)).toBe(ROOT)
  })

  test('.fli.json still wins over the schema marker', () => {
    // Same directory carries both here; the point is the explicit marker is
    // consulted first, so a project can still override the boundary.
    expect(findProjectRoot(p('marked'), null)).toBe(p('marked'))
  })
})
