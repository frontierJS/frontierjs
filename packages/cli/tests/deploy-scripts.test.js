// ─── deploy-scripts.test.js — every script a deploy sends to a machine parses ─
//
// The check that was not being run.
//
// Nine of the ten multi-line commands in the deploy pipeline were shell syntax
// errors on the target, and had been for as long as they existed. Nothing found
// them because nothing executed the pipeline — it only runs against a server —
// and a broken script is invisible in the source: `then;` and `do;` are what
// `.replace(/\n\s*/g, '; ')` produces out of perfectly readable JavaScript.
//
// So the source is read, every script literal handed to a machine is extracted,
// its `${…}` holes are plugged, and `sh -n` is asked whether the result is a
// shell script. `sh -n` parses without executing, which is why this can cover
// `docker rm` and `nginx -s reload` on a machine that has neither.
//
// What it CANNOT see is a script that parses and does the wrong thing. That is
// what the `deploy` CI phase is for; this is the cheap half, and it is the half
// that would have caught all nine.

import { describe, test, expect } from 'bun:test'
import { execFileSync } from 'child_process'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const DEPLOY = new URL('../commands/deploy', import.meta.url).pathname

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name)
  return statSync(full).isDirectory() ? walk(full) : full.endsWith('.md') ? [full] : []
})

// ─── extraction ──────────────────────────────────────────────────────────────
//
// A hand-rolled scan rather than a regex: a template literal can hold `${…}`
// holes that themselves contain backticks, and a regex from backtick to backtick
// truncates the script at the first of those and then reports it as valid.

/** Read one template literal starting at the backtick at `i`. Answers the raw body and the index after it. */
export function readTemplate(src, i) {
  if (src[i] !== '`') return null
  let out = ''
  let j = i + 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') { out += src[j] + src[j + 1]; j += 2; continue }
    if (c === '`') return { body: out, end: j + 1 }
    if (c === '$' && src[j + 1] === '{') {
      // Skip the hole, counting braces and any nested template inside it.
      let depth = 1
      let k = j + 2
      while (k < src.length && depth > 0) {
        if (src[k] === '`') { const inner = readTemplate(src, k); if (!inner) break; k = inner.end; continue }
        if (src[k] === '{') depth++
        if (src[k] === '}') depth--
        k++
      }
      out += 'X'          // a hole stands for a value; its content is not shell
      j = k
      continue
    }
    out += c
    j++
  }
  return null
}

const VERBS = /\.(run|capture)\(\s*/g

/** Every script literal passed to `machine.run` / `machine.capture` in one file. */
export function scriptsIn(src) {
  const out = []
  for (const m of src.matchAll(VERBS)) {
    const at = m.index + m[0].length
    const t  = readTemplate(src, at)
    if (t) out.push(t.body)
    else if (src[at] === "'" || src[at] === '"') {
      const q = src[at]
      const end = src.indexOf(q, at + 1)
      if (end > 0) out.push(src.slice(at + 1, end))
    }
  }
  return out
}

const parses = (script) => {
  try { execFileSync('sh', ['-n'], { input: script, stdio: ['pipe', 'pipe', 'pipe'] }); return { ok: true } }
  catch (e) { return { ok: false, why: String(e.stderr).trim() } }
}

// ─── the extractor has to be right first ─────────────────────────────────────

describe('the extractor', () => {
  test('reads a plain template', () => {
    expect(scriptsIn('machine.run(`echo hi`)')).toEqual(['echo hi'])
  })

  test('a ${} hole becomes a placeholder rather than shell', () => {
    expect(scriptsIn('machine.run(`docker stop ${container}`)')).toEqual(['docker stop X'])
  })

  // The case a regex gets wrong: a nested template inside a hole ends the match
  // early, so the tail of the script is never checked.
  test('a nested template inside a hole does not truncate the script', () => {
    const src = 'machine.run(`echo ${a ? `x` : `y`} ; if true; then echo z; fi`)'
    expect(scriptsIn(src)).toEqual(['echo X ; if true; then echo z; fi'])
  })

  test('a multi-line script keeps its newlines', () => {
    expect(scriptsIn('m.run(`if true; then\n  echo a\nfi`)')).toEqual(['if true; then\n  echo a\nfi'])
  })

  test('a quoted string argument is read too', () => {
    expect(scriptsIn("machine.run('sudo nginx -t')")).toEqual(['sudo nginx -t'])
  })

  test('capture is scanned as well as run', () => {
    expect(scriptsIn('m.capture(`git rev-parse HEAD`)')).toEqual(['git rev-parse HEAD'])
  })
})

// ─── the corpus ──────────────────────────────────────────────────────────────

const FILES = walk(DEPLOY)
const CORPUS = FILES.flatMap(f => scriptsIn(readFileSync(f, 'utf8')).map(script => ({ f, script })))

describe('every script the deploy pipeline sends to a machine', () => {
  // A guard over an empty corpus passes and proves nothing — the way this check
  // dies is by the verbs being renamed, not by a script going bad.
  test('the corpus is not empty', () => {
    expect(CORPUS.length).toBeGreaterThan(25)
  })

  test('covers the commands that go to a machine', () => {
    const dirs = new Set(CORPUS.map(c => c.f.replace(DEPLOY + '/', '').split('/')[0]))
    for (const d of ['_steps-docker', '_steps-revert', '_steps-rollback', '_steps-setup'])
      expect([...dirs]).toContain(d)
  })

  for (const { f, script } of CORPUS) {
    const where = f.replace(DEPLOY + '/', '')
    const first = script.split('\n')[0].slice(0, 48)
    test(`${where} · ${first}`, () => {
      const v = parses(script)
      expect(v.ok ? '' : `${v.why}\n${script}`).toBe('')
    })
  }
})

// ─── and the shape that broke them ───────────────────────────────────────────

describe('the join that produced the nine', () => {
  // Kept as an assertion rather than a comment: `; `-joining a shell script is
  // still a natural-looking thing to write, and it is still wrong.
  test('collapsing a block onto one line with `; ` is a syntax error', () => {
    const block = 'if [ -f x ]; then\n  echo yes\nfi'
    expect(parses(block).ok).toBe(true)
    expect(parses(block.replace(/\n\s*/g, '; ')).ok).toBe(false)
  })

  test('and so is a loop', () => {
    const loop = 'for i in 1 2; do\n  echo $i\ndone'
    expect(parses(loop).ok).toBe(true)
    expect(parses(loop.replace(/\n\s*/g, '; ')).ok).toBe(false)
  })

  test('no deploy command joins a script that way any more', () => {
    const offenders = FILES
      .filter(f => /replace\(\/\\n\\s\*\/g, '; '\)/.test(readFileSync(f, 'utf8')))
      .map(f => f.replace(DEPLOY + '/', ''))
    expect(offenders).toEqual([])
  })
})
