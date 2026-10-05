/**
 * happy-dom and the unified/remark/rehype stack are OPTIONAL peers: a
 * client-only app installs mesa without them. That holds only while nothing a
 * client build reaches imports one STATICALLY — a single top-level `import`
 * from the compiler or the runtime and every such app fails on install of a
 * package it was told it did not need. This walks the static import graph from
 * each client entry; the server half reaches its peers through `import()`,
 * which the walk does not follow.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import * as acorn from 'acorn'
import { missingPeer } from '../src/optional-peer.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg  = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

const OPTIONAL = Object.keys(pkg.peerDependenciesMeta)
  .filter((name) => pkg.peerDependenciesMeta[name].optional && name !== 'vite')

const CLIENT_ENTRIES = [
  'src/runtime.js',
  'src/compiler.js',
  'src/drive.js',
  'mesa-vite/index.js',
  'mesa-vite/client.js',
  'mesa-vite/swap.js',
  'mesa-vite/hmr.js',
]

function staticImports(file) {
  const ast = acorn.parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' })
  return ast.body
    .filter((n) => n.source && /^(Import|ExportNamed|ExportAll)Declaration$/.test(n.type))
    .map((n) => n.source.value)
}

function reachedPackages(entry) {
  const seen = new Set()
  const bare = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const spec of staticImports(file)) {
      if (spec.startsWith('.')) {
        const next = resolve(dirname(file), spec)
        if (existsSync(next)) walk(next)
      } else bare.add(spec)
    }
  }
  walk(resolve(ROOT, entry))
  return bare
}

describe('optional peers', () => {
  it('names the server-half packages as optional peers', () => {
    expect(OPTIONAL).toEqual(expect.arrayContaining([
      'happy-dom', 'unified', 'remark-parse', 'remark-gfm', 'remark-rehype', 'rehype-slug', 'rehype-stringify',
    ]))
    for (const name of OPTIONAL) expect(pkg.dependencies?.[name]).toBeUndefined()
  })

  it.each(CLIENT_ENTRIES)('%s reaches no optional peer statically', (entry) => {
    const reached = [...reachedPackages(entry)].filter((spec) => OPTIONAL.some((p) => spec === p || spec.startsWith(`${p}/`)))
    expect(reached).toEqual([])
  })

  it('names the feature and the install when the peer itself is missing', () => {
    const err = Object.assign(new Error("Cannot find package 'happy-dom' imported from /x/render.js"), { code: 'ERR_MODULE_NOT_FOUND' })
    expect(() => missingPeer('happy-dom', 'renderToHTML')(err))
      .toThrow(/renderToHTML needs happy-dom.*bun add happy-dom/)
  })

  it('passes through a package missing BELOW the peer', () => {
    const err = Object.assign(new Error("Cannot find package 'whatwg-mimetype' imported from /x/happy-dom/lib/index.js"), { code: 'ERR_MODULE_NOT_FOUND' })
    expect(() => missingPeer('happy-dom', 'renderToHTML')(err)).toThrow(err)
  })
})
