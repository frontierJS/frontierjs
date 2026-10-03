// FJS-1601: a linked checkout's local-db worker is outside Vite's allow list.
import { test, expect } from 'vitest'
import { realpathSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { resolveConfig } from 'vite'
import { fsAllowPlugin } from '../src/build/fs-allow-plugin.js'

const HERE   = dirname(fileURLToPath(import.meta.url))
const SIERRA = realpathSync(resolve(HERE, '..'))

test('dev server allows sierra\'s real directory beside the workspace root', async () => {
  const root = resolve(HERE, 'fixtures')
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
