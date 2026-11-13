// web/test/layout-classes.test.ts — a layout class a screen writes is one a stylesheet defines.
//
// An undefined class is inert: `stack-sm` drew no flex column and no gap, so
// the sections of four screens ran together with no error anywhere (FJS-4157).
// The layout terms are where an invented size suffix is likeliest, so every
// `stack-*`, `cluster-*`, `grid-*` or `gap-*` a route writes is looked up in
// @frontierjs/css and the workbench's own sources.

import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const web = join(import.meta.dir, '..', 'src')
const kit = join(import.meta.dir, '..', '..', '..', 'css', 'src')

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(e => e.isFile() && ext.test(e.name))
    .map(e => join(e.parentPath, e.name))
}

const defined = new Set(
  [...files(kit, /\.css$/), ...files(web, /\.(css|mesa)$/)]
    .flatMap(f => [...readFileSync(f, 'utf8').matchAll(/\.(-?[a-z][\w-]*)/g)].map(m => m[1]))
)

test('every layout class a workbench screen writes is defined by a stylesheet', () => {
  const inert: string[] = []
  for (const f of files(web, /\.mesa$/)) {
    for (const [, cls] of readFileSync(f, 'utf8').matchAll(/\bclass="([^"{}]*)"/g)) {
      for (const c of cls.split(/\s+/)) {
        if (/^(stack|cluster|grid|gap)-/.test(c) && !defined.has(c)) inert.push(`${f.slice(web.length + 1)}: ${c}`)
      }
    }
  }
  expect(inert).toEqual([])
})
