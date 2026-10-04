---
title: test:bench
description: What a built app costs — bytes on the wire, bytes on disk, memory once booted
examples:
  - fli test:bench
  - fli test:bench --update
  - fli test:bench --boot "bun run api" --url http://localhost:8110/health
flags:
  update:
    type: boolean
    description: Write improvements and newly measured numbers into bench.baseline.json — never a raise
    defaultValue: false
  adopt:
    type: boolean
    description: Write every measured number, raises included. The visible line in a diff that says a regression was chosen
    defaultValue: false
  boot:
    type: string
    description: Command that starts the API, to measure cold start and RSS (needs --url)
    defaultValue: ''
  url:
    type: string
    description: URL that answers 200 once the booted API is ready
    defaultValue: ''
  settle:
    type: string
    description: Milliseconds to let the booted process idle before reading RSS
    defaultValue: '3000'
  json:
    type: boolean
    description: Answer a machine
    defaultValue: false
---

Measures a **built** app and compares the byte counts against `bench.baseline.json`.
It never builds: build first (`bun run build`, `bun run build:site`), because a bench
that rebuilt would answer for the tree it just made rather than the one you have.

Two kinds of number, never mixed:

- **Bytes are gated.** Brotli totals, first-load JS and CSS, request count and file
  count per built surface (`web/`, `site/`) are the same on every machine for the same
  build, so a rise is a failure (exit 1). The baseline ratchets down only: `--update`
  records an improvement and cannot raise, `--adopt` can, so a raise is a line in a diff.
- **Boot is reported.** Cold start and RSS are one machine on one afternoon. Pass
  `--boot` and `--url` to start the API, wait for it to answer, let it idle, read the
  RSS of the whole process tree and kill it. A URL that already answers is refused.

Disk (`node_modules`, `db/*.db`) is printed and not gated — an install differs by
machine and a database by what was seeded.

```js
const { resolve } = await import('node:path')
const bench = await import(resolve(global.fliRoot, 'core/bench.js'))

const root = context.paths.root

const surfaces = Object.fromEntries(
  bench.BUILT_SURFACES.map(name => [name, bench.measureSurface(resolve(root, name, 'dist'))]),
)
const disk = bench.measureDisk(root)

let boot = null
if (flag.boot) {
  if (!flag.url) { log.error('--boot needs --url, the address that answers once the app is up'); process.exitCode = 2; return }
  try {
    boot = await bench.measureBoot({ cmd: flag.boot, cwd: root, url: flag.url, settleMs: Number(flag.settle) })
  } catch (err) {
    log.error(err.message)
    process.exitCode = 2
    return
  }
}

if (!Object.values(surfaces).some(Boolean)) {
  log.error('nothing built — no web/dist or site/dist. Build a surface first.')
  process.exitCode = 2
  return
}

const current = bench.gatedMetrics(surfaces)
const baseline = bench.readBaseline(root)
const verdict = bench.ratchet(current, baseline)

if (flag.adopt) bench.writeBaseline(root, verdict.adopted)
else if (flag.update) bench.writeBaseline(root, verdict.next)

if (flag.json) {
  echo(JSON.stringify({ surfaces, disk, boot, verdict: { ...verdict, next: undefined, adopted: undefined } }, null, 2))
} else {
  echo(bench.formatBench({ surfaces, disk, boot, verdict }))
}

if (verdict.regressions.length && !flag.adopt) {
  log.error(`${verdict.regressions.length} metric(s) above baseline`)
  process.exitCode = 1
} else if (flag.adopt || flag.update) {
  log.success(`${bench.BASELINE_FILE} written`)
} else {
  log.success('within baseline')
}
```
