// @vitest-environment node
/*
 * terminal-tags — the facts `src/terminal/tags.js` copies from another
 * package, held to their source. Mesa is a leaf and cannot import
 * `@frontierjs/css`, so the surface lineage the terminal blanks is a list of
 * its own; a composite added to `surface.css`'s base rule, or a variant that
 * starts painting `transparent`, would otherwise leave a terminal box showing
 * what is under it while a browser hides it. The border-clearing variants
 * and the tone names are held the same way (FJS-D1423).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SURFACES, SEE_THROUGH, BORDERED, BORDERLESS, opaque, bordered, paintsClass, stackRows } from '../src/terminal/tags.js'
import { TONES } from '@frontierjs/toolbelt/tty'

const css   = readFileSync(fileURLToPath(new URL('../../css/src/foundation/surface.css', import.meta.url)), 'utf8')
const tones = readFileSync(fileURLToPath(new URL('../../css/src/foundation/tones.css', import.meta.url)), 'utf8')

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

describe('the borders and tones a terminal draws', () => {
  it('clears the border on exactly the variants that set it transparent', () => {
    const variants = [...css.matchAll(/^ {2}&\.([\w-]+)\s*\{([^}]*)\}/gm)]
    const clear = variants.filter(([, , body]) => /--_surface-border:\s*transparent/.test(body)).map(([, name]) => name)
    expect(clear).toEqual(BORDERLESS)
  })

  it('borders only members of the surface lineage', () => {
    for (const name of BORDERED) expect(SURFACES).toContain(name)
    expect(bordered('card primary')).toBe(true)
    expect(bordered('card raised')).toBe(false)
    expect(bordered('surface')).toBe(false)
  })

  it('names every tone tones.css declares, and no other', () => {
    const declared = [...tones.matchAll(/^\.([a-z]+)\s*\{\s*--bg-mix:/gm)].map(([, name]) => name)
    expect(declared.length).toBeGreaterThan(2)
    expect(Object.keys(TONES)).toEqual(declared)
  })

  it('sends a class: name only when the runtime reads it', () => {
    expect(paintsClass('danger')).toBe(true)
    expect(paintsClass('text-muted')).toBe(true)
    expect(paintsClass('raised')).toBe(true)
    expect(paintsClass('stack')).toBe(true)
    expect(paintsClass('cluster')).toBe(false)
  })

  it('leaves a row in a stack unless its gap is under 1rem', () => {
    expect(stackRows('card stack')).toBe(1)
    expect(stackRows('stack', '1rem')).toBe(1)
    expect(stackRows('stack', '0.25rem')).toBe(0)
    expect(stackRows('stack', '12px')).toBe(0)
    expect(stackRows('stack', 'var(--space-sm)')).toBe(1)
    expect(stackRows('cluster')).toBe(0)
  })
})
