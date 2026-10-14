// @vitest-environment node
/*
 * terminal-tags — the facts `src/terminal/tags.js` copies from another
 * package, held to their source. Mesa is a leaf and cannot import
 * `@frontierjs/css`, so the surface lineage the terminal blanks is a list of
 * its own; a composite added to `surface.css`'s base rule, or a variant that
 * starts painting `transparent`, would otherwise leave a terminal box showing
 * what is under it while a browser hides it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SURFACES, SEE_THROUGH, opaque } from '../src/terminal/tags.js'

const css = readFileSync(fileURLToPath(new URL('../../css/src/foundation/surface.css', import.meta.url)), 'utf8')

describe('the surface lineage', () => {
  it('is the base rule of surface.css', () => {
    const list = css.match(/^:where\(([^)]*)\)\s*\{/m)?.[1]
    expect(list).toBeTruthy()
    expect(list.split(',').map((s) => s.trim().replace(/^\./, ''))).toEqual(SURFACES)
  })

  it('sees through exactly the variants that set the background transparent', () => {
    const variants = [...css.matchAll(/^ {2}&\.([\w-]+)\s*\{([^}]*)\}/gm)]
    expect(variants.length).toBeGreaterThan(2)
    const clear = variants.filter(([, , body]) => /--surface-bg:\s*transparent/.test(body)).map(([, name]) => name)
    expect(clear).toEqual(SEE_THROUGH)
  })

  it('answers for a class attribute', () => {
    expect(opaque('card raised danger')).toBe(true)
    expect(opaque('surface  outlined')).toBe(false)
    expect(opaque('surface-body')).toBe(false)
    expect(opaque(null)).toBe(false)
  })
})
