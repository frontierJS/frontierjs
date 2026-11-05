// workspace-members.test.js -- the one owner of workspace membership.
//
// A walker that lists `packages/` one level deep stops seeing a member two
// levels down without a word. The fixture holds one of those, and two
// directories a glob matches that are not members.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'

import { workspaceMembers, memberByName, memberByPath, packageMembers, memberOfFile } from '../core/workspace-members.js'

let root
const put = (rel, body) => {
  mkdirSync(join(root, rel), { recursive: true })
  if (body) writeFileSync(join(root, rel, 'package.json'), JSON.stringify(body))
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fli-ws-members-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', workspaces: ['packages/*', 'packages/group/*', 'apps/site'] }))
  put('packages/a',               { name: '@t/a' })
  put('packages/group/b',         { name: '@t/b' })
  put('packages/group/noManifest')
  put('packages/zz-empty')
  put('apps/site',                { name: '@t/site' })
  put('apps/other',               { name: '@t/other' })
})
afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

describe('workspaceMembers', () => {
  test('reaches a two-level member, in the list order, and skips a directory with no manifest', () => {
    const m = workspaceMembers(root)
    expect(m.map(x => x.name)).toEqual(['@t/a', '@t/b', '@t/site'])
    expect(m.map(x => x.folder)).toEqual(['a', 'b', 'site'])
    expect(m.map(x => x.path)).toEqual(['packages/a', 'packages/group/b', 'apps/site'])
    expect(m[1].dir).toBe(join(root, 'packages/group/b'))
    expect(m[1].manifest).toEqual({ name: '@t/b' })
  })

  test('a grouping folder and a manifest-less sibling are absent; a directory the list does not name is too', () => {
    const paths = workspaceMembers(root).map(x => x.path)
    expect(paths).not.toContain('packages/group')
    expect(paths).not.toContain('packages/group/noManifest')
    expect(paths).not.toContain('packages/zz-empty')
    expect(paths).not.toContain('apps/other')
  })

  test('a literal also matched by a glob is one member', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/a', 'packages/*'] }))
    expect(workspaceMembers(root).filter(x => x.path === 'packages/a').length).toBe(1)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', workspaces: ['packages/*', 'packages/group/*', 'apps/site'] }))
  })

  test('a root with no package.json or no workspaces has no members', () => {
    expect(workspaceMembers(join(root, 'packages'))).toEqual([])
    writeFileSync(join(root, 'apps/other/package.json'), '{"name":"@t/other"}')
    expect(workspaceMembers(join(root, 'apps/other'))).toEqual([])
  })

  test('a pattern it does not read is refused by name, not dropped', () => {
    const bad = mkdtempSync(join(tmpdir(), 'fli-ws-members-bad-'))
    try {
      writeFileSync(join(bad, 'package.json'), JSON.stringify({ workspaces: ['packages/**'] }))
      expect(() => workspaceMembers(bad)).toThrow(/packages\/\*\*/)
    } finally { rmSync(bad, { recursive: true, force: true }) }
  })

  test('lookups by name and by path', () => {
    expect(memberByName(root, '@t/b').path).toBe('packages/group/b')
    expect(memberByPath(root, 'apps/site').name).toBe('@t/site')
    expect(memberByName(root, '@t/nope')).toBeUndefined()
  })

  test('packageMembers keeps what is under packages/ and not inside another member', () => {
    put('packages/a/example', { name: '@t/a-example' })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*', 'packages/group/*', 'packages/a/example', 'apps/site'] }))
    expect(packageMembers(root).map(x => x.path)).toEqual(['packages/a', 'packages/group/b'])
  })

  test('memberOfFile attributes a file by the longest member path, not by parts[1]', () => {
    const members = packageMembers(root)
    expect(memberOfFile(members, 'packages/group/b/src/x.js').path).toBe('packages/group/b')
    expect(memberOfFile(members, 'packages/a/src/x.js').path).toBe('packages/a')
    expect(memberOfFile(members, 'packages/group/loose.js')).toBeUndefined()
    expect(memberOfFile(members, 'packages/ab/x.js')).toBeUndefined()
  })
})
