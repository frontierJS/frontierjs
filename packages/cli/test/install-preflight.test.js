/**
 * test/install-preflight.test.js
 *
 * `fli dev` on a fresh clone started both surfaces with no node_modules, and
 * each failed in words that never said *install*. Pinned here:
 *
 *   · a package is looked for by name, walking UP — a workspace member whose
 *     packages are hoisted to the root is installed, and one dependency added
 *     by a pull is missing even with a node_modules beside it.
 *   · a `link:` target this machine's bun has no registration for is named,
 *     because `bun install` itself fails on it.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { missingPackages, unregisteredLinks } from '../core/install-preflight.js'

let dir
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fli-install-')) })
afterAll(()  => { rmSync(dir, { recursive: true, force: true }) })

function manifest(root, deps = {}, devDeps = {}) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: deps, devDependencies: devDeps }))
}

function install(root, name) {
  mkdirSync(join(root, 'node_modules', name), { recursive: true })
  writeFileSync(join(root, 'node_modules', name, 'package.json'), '{}')
}

test('a fresh clone is missing every declared package, dev ones included', () => {
  const root = join(dir, 'fresh')
  manifest(root, { '@frontierjs/junction': '^0.9.0' }, { vite: '^8.0.0' })
  expect(missingPackages(root)).toEqual(['@frontierjs/junction', 'vite'])
})

test('one package added by a pull is missing beside an installed tree', () => {
  const root = join(dir, 'pulled')
  manifest(root, { a: '1', b: '1' })
  install(root, 'a')
  expect(missingPackages(root)).toEqual(['b'])
})

test('a package hoisted to a parent node_modules is installed', () => {
  const ws = join(dir, 'ws')
  const member = join(ws, 'packages', 'app')
  manifest(member, { '@scope/x': '1' })
  install(ws, '@scope/x')
  expect(missingPackages(member)).toEqual([])
})

test('no manifest is nothing to check', () => {
  expect(missingPackages(join(dir, 'nowhere'))).toEqual([])
})

test('a link: target with no registration is named; a registered one is not', () => {
  const root = join(dir, 'linked')
  const bunGlobal = join(dir, 'bun-global')
  manifest(root, { '@frontierjs/junction': 'link:@frontierjs/junction', '@frontierjs/mesa': 'link:@frontierjs/mesa', vite: '^8.0.0' })
  mkdirSync(join(bunGlobal, '@frontierjs', 'mesa'), { recursive: true })
  expect(unregisteredLinks(root, { bunGlobal })).toEqual(['@frontierjs/junction'])
})
