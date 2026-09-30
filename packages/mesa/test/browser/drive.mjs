/*
 * drive.mjs — the spec runner this repo's browser drives share.
 *
 * Loads `*.spec.mjs` files, hands each one a `t` over a real Chrome, and prints
 * the report. The browser itself is `src/drive.js` (`@frontierjs/mesa/drive`);
 * this half is not published, because an app's drive is its own script and
 * wants a browser, not a run. `@frontierjs/ui` and the cli read it by relative
 * path, beside mesa's own three drives.
 */
import { readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { openChrome } from '../../src/drive.js'

export const green = (s) => `\x1b[32m${s}\x1b[0m`
export const red   = (s) => `\x1b[31m${s}\x1b[0m`
export const dim   = (s) => `\x1b[2m${s}\x1b[0m`

// ─── the spec runner ──────────────────────────────────────────────────

/** What every spec is handed, before the caller extends it. `rows` is the
 *  spec's own result list; `allowed` collects the page errors this spec has
 *  said it is provoking. */
function baseAssertions(rows, browser, allowed) {
  return {
    evaluate: browser.evaluate,
    /** Expect a page error matching `re` rather than failing on it.
     *
     *  A spec that provokes a diagnostic on purpose — a duplicate `{#each}`
     *  key, a component that will not compile — is asserting the thing the
     *  drive otherwise treats as a failure. Stating the pattern is not the
     *  same as muting the channel: anything else the page reports still
     *  fails, which is the difference between an allowance and a silence. */
    allow: (re) => allowed.push(re),
    press:    browser.press,
    type:     browser.type,
    key:      browser.key,
    clickAt:  browser.clickAt,
    ok:  (v, label) => rows.push({ name: label, ok: !!v, detail: `got ${JSON.stringify(v)}` }),
    /** Assert on a value that is REACHED rather than one already there. Mesa
     *  flushes its effects on a microtask, so the DOM behind a state change
     *  lands after the round trip that caused it: a plain read straight after
     *  a click sees the previous value and reports a working component as
     *  broken. Polls up to 2s and returns early.
     *
     *  `ms` is for a round trip that is not a microtask. A file-watch → compile
     *  → socket → re-render is seconds, not milliseconds, and measurably so:
     *  the second write to one file arrived ~4.5s after it was made. Waiting
     *  the default there reports working HMR as an update that never came. */
    eventually: async (expr, expected, label, ms = 2000) => {
      const want = String(expected)
      const actual = await browser.evaluate(`
        const t0 = Date.now();
        let v;
        for (;;) {
          v = (${expr});
          if (String(v) === ${JSON.stringify(want)} || Date.now() - t0 > ${Number(ms)}) break;
          await new Promise(r => setTimeout(r, 20));
        }
        return { v };
      `)
      rows.push({
        name: label, ok: String(actual.v) === want,
        detail: `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual.v)}`,
      })
    },
    is: (actual, expected, label) => rows.push({
      name: label, ok: Object.is(actual, expected),
      detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    }),
    match: (actual, re, label) => rows.push({
      name: label, ok: re.test(String(actual ?? '')),
      detail: `expected ${re} to match ${JSON.stringify(actual)}`,
    }),
  }
}

/** Run every `*.spec.mjs` under `specDir` against a page at `origin`.
 *
 *  Returns `{ results, infra, failures }` and prints the report. The caller
 *  owns the server, the exit code and anything it wants printed alongside.
 *
 *    origin    — navigated to once, before the first spec
 *    ready     — an expression the page sets when its own boot has finished
 *    extend    — `(browser) => ({ … })`, extra members on `t`
 *    teardown  — run after each spec, BEFORE its errors are read: a teardown
 *                that throws is a real defect and belongs to the spec that
 *                caused it. An expression string is evaluated in the page; a
 *                function is called with the browser, for a drive that has to
 *                put something back on disk as well
 *    coverage  — `{ all, show, noun }`, checked against each spec's `covers`
 *    notes     — `() => string[]`, printed under the spec rows
 *    bootstrap — script run before anything else in every document, for a
 *                drive over a page it does not own */
export async function runSpecs({
  origin, specDir, filters = [], verbose = false,
  ready, extend, teardown, coverage, notes, windowSize, bootstrap,
}) {
  let specFiles = existsSync(specDir)
    ? readdirSync(specDir).filter((f) => f.endsWith('.spec.mjs')).sort()
    : []

  if (filters.length)
    specFiles = specFiles.filter((f) => filters.some((x) => f.includes(x)))

  if (!specFiles.length) {
    console.error(filters.length ? `No spec matches: ${filters.join(', ')}` : 'No specs found.')
    return { results: [], infra: 1, failures: 1 }
  }

  // Exit 2 is the runner's infrastructure answer, the same as a page that
  // never boots; the driver itself throws.
  const browser = await openChrome({ windowSize, bootstrap }).catch((e) => {
    console.error(e.message)
    process.exit(2)
  })

  await browser.navigate(origin, ready).catch((e) => {
    console.error(`The page never booted: ${e.message}`)
    process.exit(2)
  })

  const results = []          // { spec, name, ok, detail }
  const covered = new Set()
  let infra = 0

  for (const file of specFiles) {
    const mod = await import(join(specDir, file))
    const specName = mod.name ?? basename(file, '.spec.mjs')
    const rows = []
    const allowed = []
    const t = { ...baseAssertions(rows, browser, allowed), ...(extend?.(browser) ?? {}) }

    browser.errors.length = 0
    try {
      await mod.run(t)
    } catch (err) {
      rows.push({ name: 'spec threw', ok: false, detail: String(err.message ?? err) })
      infra++
    }
    if (typeof teardown === 'function') {
      try { await teardown(browser) } catch (err) {
        rows.push({ name: 'teardown threw', ok: false, detail: String(err.message ?? err) })
      }
    } else if (teardown) {
      await browser.evaluate(teardown).catch(() => {})
    }
    for (const e of browser.errors) {
      if (allowed.some((re) => re.test(e))) continue
      rows.push({ name: 'the page reported an error', ok: false, detail: e })
    }

    for (const c of mod.covers ?? []) covered.add(c)
    for (const r of rows) results.push({ spec: specName, ...r })
  }

  await browser.close()

  // ─── report ─────────────────────────────────────────────────────────

  const bySpec = new Map()
  for (const r of results) {
    if (!bySpec.has(r.spec)) bySpec.set(r.spec, [])
    bySpec.get(r.spec).push(r)
  }

  console.log('')
  for (const [spec, rows] of bySpec) {
    const bad = rows.filter((r) => !r.ok).length
    console.log(`${bad ? red('✗') : green('✓')} ${spec} ${dim(`(${rows.length - bad}/${rows.length})`)}`)
    for (const r of rows) {
      if (!r.ok) console.log(`    ${red('✗')} ${r.name}\n      ${r.detail}`)
      // `--verbose` prints the passes too. Worth having: a spec that THROWS
      // half way reports one failure and no clue which step it reached, and
      // the rows are the only record of how far it got.
      else if (verbose) console.log(`    ${green('✓')} ${dim(r.name)}`)
    }
  }

  for (const line of notes?.() ?? []) console.log(`${dim('!')} ${line}`)

  let unknown = []
  if (coverage) {
    // Coverage is the point of the exercise, so it is reported every run
    // rather than being a number kept by hand in a status file.
    const all = coverage.all
    unknown = [...covered].filter((c) => !all.includes(c))
    const gap = all.filter((c) => !covered.has(c))

    console.log('')
    console.log(`${all.length - gap.length}/${all.length} ${coverage.noun ?? 'cases'} opened in a browser by this drive`)
    if (coverage.show && gap.length) console.log(dim('not yet: ' + gap.join(', ')))
    for (const u of unknown)
      console.log(red(`✗ a spec claims to cover "${u}" — no such entry`))
  }

  const failures = results.filter((r) => !r.ok).length + unknown.length
  console.log(failures
    ? red(`${failures} failing`) + dim(`, ${results.length - failures + unknown.length} passing`)
    : green(`${results.length} passing`))
  console.log('')

  return { results, infra, failures }
}
