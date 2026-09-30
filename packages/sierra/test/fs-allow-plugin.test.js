// FJS-1601: a linked checkout's local-db worker is outside Vite's allow list.
import { test, expect } from 'bun:test'
import { realpathSync } from 'fs'
import { resolve } from 'path'
import { resolveConfig } from 'vite'
import { fsAllowPlugin } from '../src/build/fs-allow-plugin.js'

const SIERRA = realpathSync(resolve(import.meta.dir, '..'))

test('dev server allows sierra\'s real directory beside the workspace root', async () => {
  const root = resolve(import.meta.dir, 'fixtures')
  const c = await resolveConfig({ root, configFile: false, logLevel: 'silent', plugins: [fsAllowPlugin()] }, 'serve')
  expect(c.server.fs.allow).toContain(SIERRA)
  expect(c.server.fs.allow.length).toBeGreaterThan(1)
})

test('an app\'s own fs.allow is added to, not replaced', async () => {
  const c = await resolveConfig({
    configFile: false, logLevel: 'silent', plugins: [fsAllowPlugin()],
    server: { fs: { allow: ['/somewhere/else'] } },
  }, 'serve')
  expect(c.server.fs.allow).toContain('/somewhere/else')
  expect(c.server.fs.allow).toContain(SIERRA)
})
