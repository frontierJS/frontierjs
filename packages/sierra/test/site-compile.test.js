/*
 * test/site-compile.test.js — the site as one executable answers what the
 * directory does.
 *
 * The binary serves from Bun's embedded filesystem, which has no directories
 * and renames every file with a content hash. Both are invisible until a
 * request is made: a directory index that never resolves is a 404 on every
 * page but the root, and a cache answer read off the embedded name marks every
 * page immutable. So the same requests go to `serveSite({ dir })` and to the
 * compiled binary, and every answer must match.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn }                                       from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join }                                        from 'node:path'
import { tmpdir }                                      from 'node:os'

import { serveSite }   from '../src/site/serve.js'
import { compileSite } from '../src/site/compile.js'

const FILES = {
  'index.html':                 '<h1>home</h1>',
  'about/index.html':           '<h1>about</h1>',
  'assets/style-99887766.css':  'body{}',
  'media/photo.webp':           'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'robots.txt':                 'User-agent: *',
  '404.html':                   '<h1>no such page</h1>',
  'big/index.html':             '<h1>big</h1>' + '<p>lorem ipsum dolor sit amet</p>'.repeat(200),
}

const PATHS = ['/', '/about/', '/about', '/assets/style-99887766.css', '/media/photo.webp',
  '/robots.txt', '/big/', '/nope/', '/%zz', '/../etc/passwd']

let WORK, dirServer, bin

async function answer(base, path, headers = {}) {
  const res = await fetch(base + path, { headers })
  return {
    path,
    status:   res.status,
    type:     res.headers.get('content-type'),
    cache:    res.headers.get('cache-control'),
    encoding: res.headers.get('content-encoding'),
    body:     await res.text(),
  }
}

beforeAll(async () => {
  WORK = mkdtempSync(join(tmpdir(), 'sierra-compile-test-'))
  const dist = join(WORK, 'dist')
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(join(dist, rel, '..'), { recursive: true })
    writeFileSync(join(dist, rel), body)
  }
  dirServer = await serveSite({ dir: dist })

  const { outfile } = compileSite({ dir: dist, outfile: join(WORK, 'site') })

  // Port 0 and read the real one back, so parallel runs cannot collide. Run
  // from an empty directory: a binary that reads dist/ off the disk passes
  // anywhere dist/ happens to sit beside it.
  const cwd  = mkdtempSync(join(WORK, 'empty-'))
  const proc = spawn(outfile, ['--port', '0'], { cwd, env: { ...process.env, HOST: '127.0.0.1' } })
  const url  = await new Promise((ok, fail) => {
    let out = ''
    proc.stdout.on('data', d => {
      out += d
      const m = /at (http:\/\/\S+)/.exec(out)
      if (m) ok(m[1])
    })
    proc.on('exit', code => fail(new Error(`binary exited ${code}: ${out}`)))
  })
  bin = { proc, url }
}, 60_000)

afterAll(async () => {
  bin?.proc.kill()
  await dirServer?.close()
  rmSync(WORK, { recursive: true, force: true })
})

describe('the compiled site', () => {
  test('answers every path exactly as the directory does', async () => {
    for (const path of PATHS) {
      expect(await answer(bin.url, path)).toEqual(await answer(dirServer.url, path))
    }
  })

  test('compresses and ranges as the directory does', async () => {
    const gz = { 'Accept-Encoding': 'gzip' }
    expect(await answer(bin.url, '/big/', gz)).toEqual(await answer(dirServer.url, '/big/', gz))
    const range = { Range: 'bytes=0-9' }
    expect(await answer(bin.url, '/media/photo.webp', range))
      .toEqual(await answer(dirServer.url, '/media/photo.webp', range))
  })

  test('a page revalidates although its embedded name carries a hash', async () => {
    const res = await answer(bin.url, '/about/')
    expect(res.cache).toBe('public, max-age=0, must-revalidate')
  })
})

describe('compileSite', () => {
  test('refuses an executable inside the directory it embeds', () => {
    expect(() => compileSite({ dir: join(WORK, 'dist'), outfile: join(WORK, 'dist', 'site') }))
      .toThrow(/outside/)
  })

  test('an output directory it made ignores itself', () => {
    const out = join(WORK, 'made', 'site')
    compileSite({ dir: join(WORK, 'dist'), outfile: out })
    expect(readFileSync(join(WORK, 'made', '.gitignore'), 'utf8')).toBe('*\n')
  }, 60_000)

  test('refuses a directory with no index.html', () => {
    const empty = mkdtempSync(join(WORK, 'nothing-'))
    expect(() => compileSite({ dir: empty, outfile: join(WORK, 'x') })).toThrow(/index\.html/)
  })
})
