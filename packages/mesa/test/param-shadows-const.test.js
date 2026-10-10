/**
 * param-shadows-const.test.js
 *
 * FJS-2490 — the names a const's initializer reads were collected without the
 * scope its own arrow parameters open, so a parameter named like another
 * top-level const was read as a reference to it. Two consts that call each
 * other's neighbour but never depend on each other closed a loop in Pass 4 and
 * the file was refused as a circular dependency.
 *
 * Run: npx vitest run param-shadows-const.test.js
 */

import { describe, it, expect } from 'vitest'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'

async function emit(script) {
  const ctx = await compile(`<script>\n${script}\n</script><b>x</b>`, {
    filename: 'Shadow.mesa',
    warning: () => {}
  })
  acorn.parse(ctx.result, { sourceType: 'module', ecmaVersion: 'latest' })
  return ctx.analysis?.errors ?? []
}

describe('an arrow parameter named like a top-level const', () => {
  it('is not an edge to that const', async () => {
    expect(await emit('const across = (bar, e) => bar + e\nconst bar = (el) => across(el, 1)')).toEqual([])
  })

  it('a destructured and a defaulted parameter are bindings too', async () => {
    expect(await emit('const a = ({ x: bar }, [baz] = []) => bar + baz\nconst bar = (el) => a(el)\nconst baz = (el) => a(el)')).toEqual([])
  })

  it('a real cycle is still refused', async () => {
    const errors = await emit('const a = () => b()\nconst b = () => a()')
    expect(errors.some((e) => e.includes('Circular dependency'))).toBe(true)
  })

  it('a read of the const outside the parameter list is still an edge', async () => {
    const errors = await emit('const a = (x) => b(x)\nconst b = (bar) => bar + a(1)')
    expect(errors.some((e) => e.includes('Circular dependency'))).toBe(true)
  })
})
