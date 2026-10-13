// FJS-1601: a linked checkout's local-db worker is outside Vite's allow list.
import { test, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
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

// A linked ui or css is outside the list too, and Vite refuses it whenever the
// browser asks before an importer has resolved it (a cached reload).
test('every linked @frontierjs package\'s real directory is allowed', async () => {
  const tmp  = realpathSync(mkdtempSync(resolve(tmpdir(), 'sierra-fs-allow-')))
  const real = resolve(tmp, 'framework', 'ui')
  const app  = resolve(tmp, 'app')
  mkdirSync(real, { recursive: true })
  mkdirSync(resolve(app, 'node_modules', '@frontierjs'), { recursive: true })
  symlinkSync(real, resolve(app, 'node_modules', '@frontierjs', 'ui'), 'dir')
  const c = await resolveConfig({ root: app, configFile: false, logLevel: 'silent', plugins: [fsAllowPlugin()] }, 'serve')
  expect(c.server.fs.allow).toContain(real)
})

// The walk is sierra's own: an `import { searchForWorkspaceRoot } from 'vite'`
// in a linked sierra loads a second vite into the app's dev server.
test('the workspace root is found without importing vite', async () => {
  const src = readFileSync(resolve(HERE, '../src/build/fs-allow-plugin.js'), 'utf8')
  expect(src).not.toMatch(/from 'vite'/)

  const tmp = realpathSync(mkdtempSync(resolve(tmpdir(), 'sierra-ws-root-')))
  const app = resolve(tmp, 'apps', 'one')
  mkdirSync(app, { recursive: true })
  writeFileSync(resolve(tmp, 'package.json'), '{"workspaces":["apps/*"]}')
  writeFileSync(resolve(app, 'package.json'), '{}')
  const c = await resolveConfig({ root: app, configFile: false, logLevel: 'silent', plugins: [fsAllowPlugin()] }, 'serve')
  expect(c.server.fs.allow[0]).toBe(tmp)
})
