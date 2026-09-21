// scaffold-templates.test.ts
//
// Invariant 15 — *a clean compile is not proof of valid JS* — one package over.
// `tools/init.ts` writes an app's starting files as template literals, and
// `bun run typecheck` grades the TypeScript that HOLDS them, never the
// JavaScript they produce. Measured: a comment carrying `\\\`` parsed fine as
// TypeScript and emitted a file whose template literal ended two lines early
// (`FJS-903`).
//
// So the templates are extracted and the ones that can be parsed, are. What
// this does NOT do is run the scaffold — that is the `scaffold` CI phase's job,
// and it is full-tier only, which is why nothing cheap covered this.

import { describe, it, expect } from 'bun:test'

const SRC = new URL('../tools/init.ts', import.meta.url)

/** Every `write('name', \`…\`)` template in the file, with its literal text. */
function templates(src: string): Array<{ name: string; body: string; after: string }> {
  const out: Array<{ name: string; body: string; after: string }> = []
  const re = /write\(\s*'([^']+)'\s*,\s*`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    const start = i
    // Walk to the closing backtick, respecting escapes — the same scan the
    // JavaScript parser does, which is the point.
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue }
      if (src[i] === '`')  break
      i++
    }
    // What follows the closing backtick is the evidence: a template that ended
    // early is followed by the rest of its own text, not by the call's `)`.
    out.push({ name: m[1], body: src.slice(start, i), after: src.slice(i + 1, i + 3) })
  }
  return out
}

describe('what the scaffold writes', () => {

  it('finds templates at all, or every assertion below is vacuous', async () => {
    const found = templates(await Bun.file(SRC).text())
    expect(found.length).toBeGreaterThan(0)
  })

  it('every template ends where its call ends', async () => {
    // The symptom of an escaped backtick is not a bad character, it is a
    // literal that STOPPED EARLY — and the TypeScript around it still compiles,
    // so nothing else says so. A template that ended where it meant to is
    // followed by the call's own `)`.
    const early = templates(await Bun.file(SRC).text())
      .filter(t => !/^\)/.test(t.after.trimStart()))
      .map(t => t.name)
    expect(early).toEqual([])
  })

  it('no template puts a backslash immediately before its backtick', async () => {
    // The construct that causes it, refused by name: `\\` is an escaped
    // backslash, so the backtick after it is unescaped and closes the literal.
    const src = await Bun.file(SRC).text()
    expect(src.includes('\\\\`')).toBe(false)
  })

  it('every template with no interpolation emits JavaScript that parses', async () => {
    const found  = templates(await Bun.file(SRC).text())
    const plain  = found.filter(t => !t.body.includes('${'))
    // A guard on the guard: if interpolation ever reached every template, this
    // test would pass by checking nothing.
    expect(plain.length).toBeGreaterThan(0)

    for (const t of plain) {
      const path = `${import.meta.dir}/../.scaffold-check-${t.name.replace(/[^\w]/g, '_')}.js`
      await Bun.write(path, t.body.replace(/\\`/g, '`').replace(/\\\$/g, '$'))
      const proc = Bun.spawnSync(['bun', 'build', '--no-bundle', path])
      await Bun.file(path).delete()
      expect({ file: t.name, ok: proc.exitCode === 0 }).toEqual({ file: t.name, ok: true })
    }
  })
})
