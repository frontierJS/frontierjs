/*
 * Every whole-component example in the docs compiles.
 *
 * Nothing had ever compiled one. `VISION.md` is the language spec and the file
 * a new user copies from, and eight of its fences did not compile — six of them
 * the same `<mesa:window onkeydown={h}>`, unclosed, which is the only spelling
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
  // FJS-911: a rule the compiler cites by number must have a prose section, or
  // a reader following the citation lands in a summary-table row and cannot tell
  // a sentence never written from one deleted. A fence has no example to
  // compile there, so the fence test above cannot see it.
  it('every RULE the compiler cites has a section in VISION.md', () => {
    const vision = readFileSync(join(DOCS, 'VISION.md'), 'utf8')
    const sections = new Set([...vision.matchAll(/^> \*\*RULE (\d+[a-z]?)\*\*/gm)].map((m) => m[1]))
    const cited = new Set()
    const srcDir = join(DOCS, '..', 'src')
    for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
      for (const m of readFileSync(join(srcDir, f), 'utf8').matchAll(/\bRULE (\d+[a-z]?)\b/g)) cited.add(m[1])
    }
    expect(cited.size).toBeGreaterThan(0)
    expect([...cited].filter((n) => !sections.has(n)).sort()).toEqual([])
  })

  // FJS-3313: the same gap for a rule the compiler does not cite. A row of the
  // §22 table with no section is a claim with nowhere to read the reason.
  it('every row of the VISION.md rules table has a section', () => {
    const vision = readFileSync(join(DOCS, 'VISION.md'), 'utf8')
    const sections = new Set([...vision.matchAll(/^> \*\*RULE (\d+[a-z]?)\*\*/gm)].map((m) => m[1]))
    const rows = [...vision.matchAll(/^\| (\d+[a-z]?) \| /gm)].map((m) => m[1])
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.filter((n) => !sections.has(n))).toEqual([])
  })

  it('finds the component examples in VISION.md rather than nothing', () => {
    expect(files).toContain('VISION.md')
    expect(fencesOf(readFileSync(join(DOCS, 'VISION.md'), 'utf8')).length).toBeGreaterThanOrEqual(8)
  })
})
