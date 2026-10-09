/*
 * test/framework-checkout.test.js
 *
 * FJS-1637 / FJS-D579 — `fli new` defaults `--source local` from a framework
 * checkout and npm anywhere else. The probe is a checkout marker, not a
 * sibling: in an npm install `fliRoot/..` is `node_modules/@frontierjs/`,
 * where `junction/package.json` exists whenever junction is installed too.
 */

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

import { isFrameworkCheckout } from '../core/utils.js'

const roots = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const tree = (files) => {
  const base = mkdtempSync(join(tmpdir(), 'fjs-checkout-'))
  roots.push(base)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(base, rel, '..'), { recursive: true })
    writeFileSync(join(base, rel), body)
  }
  return base
}

const WS = JSON.stringify({ name: 'ws', workspaces: ['packages/*'] })

test('a cli under <workspace>/packages/ is a framework checkout', () => {
  const base = tree({ 'package.json': WS, 'packages/cli/package.json': '{}', 'packages/junction/package.json': '{}' })
  expect(isFrameworkCheckout(join(base, 'packages/cli'))).toBe(true)
})

test('a cli installed beside junction in node_modules is not a checkout', () => {
  const base = tree({
    'package.json': WS,
    'node_modules/@frontierjs/cli/package.json': '{}',
    'node_modules/@frontierjs/junction/package.json': '{}',
  })
  expect(isFrameworkCheckout(join(base, 'node_modules/@frontierjs/cli'))).toBe(false)
})

test('a packages/ directory under a root with no workspaces is not a checkout', () => {
  const base = tree({ 'package.json': '{"name":"x"}', 'packages/cli/package.json': '{}' })
  expect(isFrameworkCheckout(join(base, 'packages/cli'))).toBe(false)
})

test('a workspace that vendors the cli inside node_modules/ is not a checkout', () => {
  const base = tree({ 'package.json': WS, 'node_modules/packages/cli/package.json': '{}' })
  expect(isFrameworkCheckout(join(base, 'node_modules/packages/cli'))).toBe(false)
})

test('this very cli, run from the repo, is a checkout', () => {
  expect(isFrameworkCheckout(resolve(import.meta.dir, '..'))).toBe(true)
})

test('fli new defaults --source from the probe, with the flag and env still winning', () => {
  const md = readFileSync(join(import.meta.dir, '../commands/project/new.md'), 'utf8')
  expect(md).toMatch(/isFrameworkCheckout\(global\.fliRoot\)\s*\?\s*'local'\s*:\s*'npm'/)
})
