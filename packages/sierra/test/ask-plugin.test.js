// The ask panel is on in every Sierra dev server whose app has @frontierjs/cli,
// and off with the inspector. The drive that clicks it is website's
// verify:ask; this pins the turn-on, against a stub cli in a temp root so the
// answer does not depend on what this workspace happens to have installed.
import { test, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveConfig } from 'vite'
import { createSierraViteConfig } from '../src/build/index.js'
import { askPlugin, findAskModule } from '../src/build/ask-plugin.js'

const dir  = mkdtempSync(join(tmpdir(), 'sierra-ask-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const withCli = join(dir, 'with-cli')
const bare    = join(dir, 'bare')
const stub    = join(withCli, 'node_modules', '@frontierjs', 'cli')
mkdirSync(join(stub, 'core'), { recursive: true })
mkdirSync(bare)
writeFileSync(join(stub, 'package.json'), JSON.stringify({ name: '@frontierjs/cli', type: 'module' }))
writeFileSync(join(stub, 'core', 'vite-ask.js'), `
export function askPlugin() {
  let root = null
  return {
    name: 'fli:ask',
    configResolved(c) { root = c.root },
    resolveId(id) { return id === '/ask' ? '\\0ask' : null },
    load(id) { return id === '\\0ask' ? 'export default ' + JSON.stringify(root) : null },
    transformIndexHtml() { return [{ tag: 'script', attrs: { src: '/ask' } }] },
  }
}
`)

const names = (c) => c.plugins.flat().map(p => p?.name)

test('every Sierra config carries it, and inspect: false removes it with the inspector', () => {
  expect(names(createSierraViteConfig())).toContain('sierra:ask')
  expect(names(createSierraViteConfig({ mesa: { inspect: false } }))).not.toContain('sierra:ask')
})

test('dev only', () => {
  expect(askPlugin().apply).toBe('serve')
})

test('the cli is looked for from the Vite root', () => {
  expect(findAskModule(withCli)).toBe(join(stub, 'core', 'vite-ask.js'))
  expect(findAskModule(bare)).toBe(null)
})

test('with the cli, its hooks answer, and it is told the resolved root', async () => {
  const p = askPlugin()
  const c = await resolveConfig({ root: withCli, configFile: false, logLevel: 'silent', plugins: [p] }, 'serve')
  expect(p.transformIndexHtml()).toEqual([{ tag: 'script', attrs: { src: '/ask' } }])
  expect(p.resolveId('/ask')).toBe('\0ask')
  expect(p.load('\0ask')).toBe(`export default ${JSON.stringify(c.root)}`)
})

test('without the cli, nothing is injected and nothing is resolved', async () => {
  const p = askPlugin()
  await resolveConfig({ root: bare, configFile: false, logLevel: 'silent', plugins: [p] }, 'serve')
  expect(p.transformIndexHtml()).toEqual([])
  expect(p.resolveId('/ask')).toBe(null)
  expect(p.configureServer({})).toBeUndefined()
})
