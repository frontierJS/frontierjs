/*
 * Every whole-component example in the docs compiles.
 *
 * Nothing had ever compiled one. `VISION.md` is the language spec and the file
 * a new user copies from, and eight of its fences did not compile — six of them
 * the same `<mesa:window on:keydown={h}>`, unclosed, which is the only spelling
 * §12.1 showed and the one §23's flagship complete component used. The error
 * was `Unexpected EOF` with no file and no line, so nobody hit it and looked
 * (FJS-868).
 *
 * Only fences containing a `<script>` are graded. A fragment illustrating one
 * attribute names bindings it never declares, so compiling it would grade the
 * example against a rule it was never making — and a check that fires on
 * correct documentation is a check people delete.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileSource } from '../src/compiler.js'

const DOCS = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'docs')

const fencesOf = (src) => {
  const out = []
  const re = /^```(?:mesa|html)\n([\s\S]*?)^```/gm
  let m
  while ((m = re.exec(src))) {
    if (!/<script/.test(m[1])) continue
    out.push({ line: src.slice(0, m.index).split('\n').length, code: m[1] })
  }
  return out
}

const files = readdirSync(DOCS).filter((f) => f.endsWith('.md'))

describe('the docs compile', () => {
  for (const file of files) {
    const src = readFileSync(join(DOCS, file), 'utf8')
    const fences = fencesOf(src)
    if (!fences.length) continue

    it(`${file} — ${fences.length} component examples`, async () => {
      const bad = []
      for (const f of fences) {
        try {
          const ctx = await compileSource(f.code, { filename: `${file}:${f.line}`, dev: false, css: false })
          const errs = ctx?.analysis?.errors ?? []
          if (errs.length) bad.push(`${file}:${f.line} — ${errs[0]}`)
        } catch (e) {
          bad.push(`${file}:${f.line} — ${e.message}`)
        }
      }
      expect(bad).toEqual([])
    })
  }

  // A walker that matched nothing would pass every assertion above, so the
  // count is asserted too. Eleven, at the time of writing: most fences here
  // illustrate one attribute and are not components.
  it('finds the component examples in VISION.md rather than nothing', () => {
    expect(files).toContain('VISION.md')
    expect(fencesOf(readFileSync(join(DOCS, 'VISION.md'), 'utf8')).length).toBeGreaterThanOrEqual(8)
  })
})
