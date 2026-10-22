// @vitest-environment node
//
// render-symlinked-tmpdir.test.js — `options.tmpDir` inside a symlinked tree
// (`FJS-3437`). A site whose `node_modules` is one link to another tree's
// prerendered its first route and failed every one after it under Bun:
// the temp module was written through the link, and Bun's resolver, asked for
// a second file in a directory it had already listed, looked in the link's
// target and did not find it. The failure only exists in Bun, so the render
// runs in a Bun child.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/render-component.js')
const hasBun = spawnSync('bun', ['--version']).status === 0

describe.skipIf(!hasBun)('tmpDir under a symlinked node_modules', () => {
  it('renders every page, not only the first', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mesa-symlink-'))
    mkdirSync(path.join(dir, 'other/node_modules'), { recursive: true })
    mkdirSync(path.join(dir, 'site'))
    symlinkSync('../other/node_modules', path.join(dir, 'site/node_modules'))
    const script = path.join(dir, 'run.mjs')
    writeFileSync(script, `
      import { renderComponent } from ${JSON.stringify(src)}
      const out = []
      for (const t of ['one', 'two', 'three']) {
        const r = await renderComponent('<p>' + t + '</p>', {
          cwd: ${JSON.stringify(path.join(dir, 'site'))},
          filename: ${JSON.stringify(path.join(dir, 'site/__prerender__.mesa'))},
          tmpDir: ${JSON.stringify(path.join(dir, 'site/node_modules/.sierra/render'))},
        })
        out.push(r.html)
      }
      console.log(JSON.stringify(out))
    `)
    const run = spawnSync('bun', [script], { encoding: 'utf8' })
    expect(run.stderr).toBe('')
    expect(JSON.parse(run.stdout)).toEqual(['<p>one</p>', '<p>two</p>', '<p>three</p>'])
  }, 60000)
})
