// web/test/lib/reload.test.mjs — the reload detector against a fake CDP surface.
// Run from example/: bun test web/test/lib/reload.test.mjs
import { test, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { watchReloads } from './reload.mjs'

const MAIN = (url) => ({ frame: { url } })

function fakeBrowser() {
  const listeners = {}
  const emit = (method, params) => (listeners[method] ?? []).forEach((fn) => fn(params))
  return {
    emit,
    on: (method, fn) => { (listeners[method] ??= []).push(fn) },
    cmd: async (method, params) => {
      if (method === 'Page.navigate') emit('Page.frameNavigated', MAIN(params.url))
      return {}
    },
  }
}

test('a navigation that Page.navigate started is the drive\'s own', async () => {
  const b = fakeBrowser()
  const reload = watchReloads(b)
  await b.cmd('Page.navigate', { url: 'http://x/' })
  expect(reload.reloaded).toBe(null)
})

test('the drive\'s own navigation still counts as its own when the event trails the answer', async () => {
  const b = fakeBrowser()
  b.cmd = async () => ({ frameId: 'main', loaderId: 'L1' })
  const reload = watchReloads(b)
  await b.cmd('Page.navigate', { url: 'http://x/' })
  b.emit('Page.frameNavigated', { frame: { url: 'http://x/', loaderId: 'L1' } })
  expect(reload.reloaded).toBe(null)
  // A reload after it is a new loader, and is still caught.
  b.emit('Page.frameNavigated', { frame: { url: 'http://x/', loaderId: 'L2' } })
  expect(reload.reloaded).toBe('http://x/')
})

test('a navigation with none in flight is a reload, and names the page', () => {
  const b = fakeBrowser()
  const reload = watchReloads(b)
  b.emit('Page.frameNavigated', MAIN('http://x/plans/1/'))
  expect(reload.reloaded).toBe('http://x/plans/1/')
  expect(reload.message()).toContain('RELOADED')
})

test('a subframe navigating is not a reload', () => {
  const b = fakeBrowser()
  const reload = watchReloads(b)
  b.emit('Page.frameNavigated', { frame: { url: 'http://x/embed', parentId: 'main' } })
  expect(reload.reloaded).toBe(null)
})

test('during() covers a navigation the drive starts from inside the page', async () => {
  const b = fakeBrowser()
  const reload = watchReloads(b)
  await reload.during(async () => b.emit('Page.frameNavigated', MAIN('http://x/')))
  expect(reload.reloaded).toBe(null)
  b.emit('Page.frameNavigated', MAIN('http://x/again'))
  expect(reload.reloaded).toBe('http://x/again')
})

test('the process exits 1 naming the cause, whatever path it leaves by', async () => {
  const lib = fileURLToPath(new URL('./reload.mjs', import.meta.url))
  const src = `
    import { watchReloads } from ${JSON.stringify(lib)}
    const fns = []
    watchReloads({ on: (m, fn) => fns.push(fn), cmd: async () => ({}) })
    fns[0]({ frame: { url: 'http://x/' } })
    process.exit(0)
  `
  const p = Bun.spawn(['bun', '-e', src], { stdout: 'pipe', stderr: 'pipe' })
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
  expect(code).toBe(1)
  expect(err).toContain('RELOADED')
})
