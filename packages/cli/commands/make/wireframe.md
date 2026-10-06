---
title: make:wireframe
description: Turn a wireframe (a screen in @frontierjs/css terms, as JSON) into components, a page and a draft schema
examples:
  - fli make:wireframe design/Tasks.wireframe.json
  - fli make:wireframe design/Tasks.wireframe.json --dry
args:
  -
    name: file
    description: The wireframe — { screen, names?, models?, tree }, every node a vocabulary term
    required: true
---

<script>
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
</script>

A **wireframe** is a screen written in `@frontierjs/css`'s vocabulary — a JSON
tree whose every node is a term (`Card`, `Badge`, `Split` …), with the text the
screen showed. A person or a vision model writes one from a screenshot; this
reads it. `IDEAS/wireframe.md` is the design.

What repeats is a component, and what differs between the copies is its props.
It writes one `.mesa` per component, the page as `<Screen>.mesa` with the
screenshot's own data lifted into those props, and `tones.js` where a tone
followed a value — all under `web/src/components/<Screen>/`. Beside the
wireframe it writes `<Screen>.draft.lite`, a schema read off the components,
which nothing loads: what survives is moved into `db/schema.lite` by hand.

Everything written is graded with the APP's own mesa and litestone — a `.mesa`
that does not compile, or a draft that does not parse, fails the command. A
grader the app does not have is named, never skipped quietly.

```js
const { readWireframe, analyze, report, draw, emitMesa, draftSchema, KIT_PROPS, WireframeError } =
  await import(resolve(global.fliRoot, 'core/wireframe.js'))

const root  = $.paths.root
const file  = resolve(process.cwd(), arg.file)
if (!existsSync(file)) { log.error(`no such file: ${file}`); process.exitCode = 1; return }

// The vocabulary this CLI ships with — the same package the app styles with.
const vocab = createRequire(join(global.fliRoot, 'package.json'))('@frontierjs/css/vocabulary.json')

let wf
try {
  wf = readWireframe(JSON.parse(readFileSync(file, 'utf8')), vocab)
} catch (e) {
  log.error(e instanceof WireframeError ? `the wireframe is refused:\n  ${e.problems.join('\n  ')}` : `not JSON: ${e.message}`)
  process.exitCode = 1
  return
}

const a = analyze(wf)
console.log(report(a))
console.log('')
console.log(draw(a, { width: Math.max(80, process.stdout.columns || 110), color: !!process.stdout.isTTY }))

// ─── the kit the app has ─────────────────────────────────────────────────
// Asked of the installed package rather than listed, so an app on an older kit
// gets class markup where a component is missing instead of an import that fails.
const uiDir = join(root, 'node_modules', '@frontierjs', 'ui', 'components')
const kit   = {}
if (existsSync(uiDir)) {
  for (const group of readdirSync(uiDir)) {
    for (const name of Object.keys(KIT_PROPS)) {
      if (existsSync(join(uiDir, group, name + '.mesa'))) kit[name] = `@frontierjs/ui/components/${group}/${name}.mesa`
    }
  }
} else {
  log.warn('@frontierjs/ui is not installed here — every term is written as class markup')
}

const files   = emitMesa(a, { kit })
const outDir  = join($.paths.webComponents, wf.screen)
const draft   = draftSchema(a)
const draftAt = join(dirname(file), `${wf.screen}.draft.lite`)

if (flag.dry) {
  for (const f of Object.keys(files)) log.dry(`Would create: ${join(outDir, f)}`)
  log.dry(`Would create: ${draftAt}`)
  return
}

// A wireframe is a first draft; a second run over an edited one must not
// silently replace components somebody has started changing.
if (existsSync(outDir)) { log.error(`${outDir} already exists — delete it or move it, then run again`); process.exitCode = 1; return }
if (existsSync(draftAt)) { log.error(`${draftAt} already exists — delete it or move it, then run again`); process.exitCode = 1; return }

mkdirSync(outDir, { recursive: true })
for (const [f, src] of Object.entries(files)) writeFileSync(join(outDir, f), src, 'utf8')
writeFileSync(draftAt, draft, 'utf8')
log.success(`Created ${Object.keys(files).length} files in ${outDir}`)
log.success(`Created ${draftAt}`)

// ─── grade what was written ──────────────────────────────────────────────
// With the APP's mesa and litestone, read out of their own exports maps, since
// this package depends on neither and a grader beside the global fli would be
// whatever version happened to be installed there.
const pkgOf = (name) => {
  const dir = join(root, 'node_modules', '@frontierjs', name)
  return existsSync(join(dir, 'package.json')) ? { dir, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } : null
}
const target = (p, key) => { const e = p.pkg.exports?.[key]; return typeof e === 'string' ? e : e?.import }

let failed = 0
const mesa = pkgOf('mesa')
const compilerAt = mesa && target(mesa, './compiler')
if (compilerAt) {
  const { compileSource } = await import(pathToFileURL(join(mesa.dir, compilerAt)).href)
  // A clean compile is not proof of valid JS (Invariant 15): the output is parsed too.
  let parseJs = null
  try { parseJs = (await import(pathToFileURL(createRequire(join(mesa.dir, 'package.json')).resolve('acorn')).href)).parse } catch {}
  for (const f of Object.keys(files).filter(f => f.endsWith('.mesa'))) {
    try {
      const ctx  = await compileSource(files[f], { filename: join(outDir, f), dev: false })
      const code = typeof ctx === 'string' ? ctx : ctx.result ?? ctx.code
      if (parseJs) parseJs(code, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch (e) {
      failed++
      log.error(`${f} does not compile: ${e.message}`)
    }
  }
  if (!parseJs) log.warn("mesa's acorn was not found — compiled, but the output was not parsed")
} else {
  log.warn('@frontierjs/mesa is not installed here — the .mesa files were NOT compiled')
}

const ls = pkgOf('litestone')
const parserAt = ls && target(ls, './parser')
if (parserAt) {
  const { parse } = await import(pathToFileURL(join(ls.dir, parserAt)).href)
  const r = parse(draft)
  if (!r.valid) { failed++; log.error(`${wf.screen}.draft.lite does not parse:\n  ${r.errors.map(e => e.message || e).join('\n  ')}`) }
} else {
  log.warn('@frontierjs/litestone is not installed here — the draft schema was NOT parsed')
}

if (failed) { process.exitCode = 1; return }
log.success('graded: every .mesa compiles and the draft parses')
```
