// ─── bench.test.js — the byte gate and the boot probe ───────────────────────
//
// The gate is the half that can fail a build, so its ratchet rules are pinned
// here: it falls, it never rises on `--update`, and an unmeasured baseline key
// is not a pass. Boot is driven against a throwaway Bun server rather than an
// app, because what bench owns is the spawn, the wait and the process-tree read.

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { firstLoadRefs, gatedMetrics, measureBoot, measureSurface, ratchet, treeRss } from '../core/bench.js'

const dir = mkdtempSync(join(tmpdir(), 'fli-bench-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('firstLoadRefs', () => {
  test('local scripts, stylesheets and modulepreloads; not remote, data or other rels', () => {
    const html = `
      <link rel="icon" href="/favicon.svg">
      <script type="module" src="/assets/a.js?v=1"></script>
      <link rel="modulepreload" href="/assets/b.js">
      <link rel="stylesheet" href="/assets/c.css">
      <link rel="stylesheet" href="https://cdn.example/x.css">
      <script src="//cdn.example/y.js"></script>
      <script type="speculationrules">{}</script>`
    expect(firstLoadRefs(html)).toEqual(['/assets/a.js', '/assets/b.js', '/assets/c.css'])
  })
})

describe('measureSurface', () => {
  test('reads dist/client for an SPA and counts what index.html names', () => {
    const dist = join(dir, 'spa')
    mkdirSync(join(dist, 'client', 'assets'), { recursive: true })
    mkdirSync(join(dist, 'server'), { recursive: true })
    writeFileSync(join(dist, 'client', 'index.html'), '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"><script src="/assets/gone.js"></script>')
    writeFileSync(join(dist, 'client', 'assets', 'app.js'), 'console.log("hi")\n'.repeat(200))
    writeFileSync(join(dist, 'client', 'assets', 'app.css'), 'a{color:red}\n'.repeat(50))
    writeFileSync(join(dist, 'server', 'entry.js'), 'x')
    const m = measureSurface(dist)
    expect(m.files).toBe(4)
    expect(m.firstLoad.requests).toBe(4)
    expect(m.firstLoad.jsBrotli).toBeGreaterThan(0)
    expect(m.firstLoad.cssBrotli).toBeGreaterThan(0)
    expect(m.firstLoad.missing).toEqual(['/assets/gone.js'])
    expect(m.js.brotli).toBeLessThan(m.js.raw)
  })

  test('null when nothing is built', () => {
    expect(measureSurface(join(dir, 'absent'))).toBeNull()
  })
})

describe('ratchet', () => {
  const base = { 'web.totalBrotli': 100, 'web.files': 10, 'site.files': 5 }

  test('a rise is a regression and --update does not write it', () => {
    const v = ratchet({ 'web.totalBrotli': 120, 'web.files': 10, 'site.files': 5 }, base)
    expect(v.regressions).toEqual([{ key: 'web.totalBrotli', was: 100, now: 120 }])
    expect(v.next['web.totalBrotli']).toBe(100)
    expect(v.adopted['web.totalBrotli']).toBe(120)
  })

  test('a fall is written back; a new key is recorded; a missing key is unmeasured and kept', () => {
    const v = ratchet({ 'web.totalBrotli': 90, 'web.files': 10, 'web.new': 7 }, base)
    expect(v.regressions).toEqual([])
    expect(v.improvements).toEqual([{ key: 'web.totalBrotli', was: 100, now: 90 }])
    expect(v.unbaselined).toEqual([{ key: 'web.new', value: 7 }])
    expect(v.unmeasured).toEqual(['site.files'])
    expect(v.next).toEqual({ 'web.totalBrotli': 90, 'web.files': 10, 'site.files': 5, 'web.new': 7 })
  })

  test('an unbuilt surface contributes no keys rather than zeros', () => {
    expect(gatedMetrics({ web: null, site: null })).toEqual({})
  })
})

describe('measureBoot', () => {
  const server = (port) => `bun -e "Bun.serve({port:${port},fetch:()=>new Response('ok')});setInterval(()=>{},1e3)"`

  test('waits for the url, reads the tree RSS, and leaves nothing listening', async () => {
    const port = 18000 + Math.floor(Math.random() * 1000)
    const url = `http://localhost:${port}/`
    const r = await measureBoot({ cmd: server(port), cwd: dir, url, settleMs: 100 })
    expect(r.coldStartMs).toBeGreaterThan(0)
    if (treeRss(process.pid) != null) expect(r.rssIdle).toBeGreaterThan(1024 * 1024)
    await Bun.sleep(300)
    await expect(fetch(url)).rejects.toThrow()
  })

  test('refuses a url that already answers', async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    try {
      await expect(measureBoot({ cmd: 'true', cwd: dir, url: `http://localhost:${s.port}/` })).rejects.toThrow(/already answers/)
    } finally { s.stop(true) }
  })

  test('a command that exits before ready is an error naming the command', async () => {
    const port = 19000 + Math.floor(Math.random() * 1000)
    await expect(measureBoot({ cmd: 'exit 3', cwd: dir, url: `http://localhost:${port}/`, timeoutMs: 5000 })).rejects.toThrow(/exited 3/)
  })
})
