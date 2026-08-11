import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { findProjectRoot, findWorkspaceRoot } = await import('../core/utils.js')

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

  // A multi-repo workspace: a `workspaces` manifest, no .git of its own.
  mkdirSync(p('outlaw', 'packages', 'one'), { recursive: true })
  writeFileSync(p('outlaw', 'package.json'), '{"workspaces":["packages/*"]}')

  // packages/ alone is not a workspace marker.
  mkdirSync(p('bare', 'packages'), { recursive: true })
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

// The two resolvers answer different questions and must not be confused: every
// ws:* command wants the monorepo, and findProjectRoot stops at the deepest
// app. Standing in packages/basecamp they disagree, which is the whole point.
describe('findWorkspaceRoot', () => {
  test('a package subdirectory resolves to the workspace root', () => {
    expect(findWorkspaceRoot(p('packages', 'plain', 'src'))).toBe(ROOT)
  })

  test('an app nested in the workspace still resolves to the workspace', () => {
    // findProjectRoot answers packages/basecamp here — the app, not the repo.
    expect(findWorkspaceRoot(p('packages', 'basecamp'))).toBe(ROOT)
    expect(findProjectRoot(p('packages', 'basecamp'), null)).toBe(p('packages', 'basecamp'))
  })

  test('the workspace root itself resolves to itself', () => {
    expect(findWorkspaceRoot(ROOT)).toBe(ROOT)
  })

  test('a `workspaces` manifest with no .git is a workspace root', () => {
    expect(findWorkspaceRoot(p('outlaw', 'packages', 'one'))).toBe(p('outlaw'))
  })

  test('a directory with packages/ but neither marker is not a workspace', () => {
    // `bare/` has a packages/ dir and nothing else — walking up from it lands
    // on ROOT rather than claiming bare/ is a workspace.
    expect(findWorkspaceRoot(p('bare', 'packages'))).toBe(ROOT)
  })

  test('outside any workspace it answers null, so the caller can fall back', () => {
    expect(findWorkspaceRoot(tmpdir())).toBe(null)
  })
})
