// src/core/workbench-check.ts — run as its own process: the checkout's own
// `fli done` report, written to a file the workbench reads.
//
//   bun workbench-check.ts <done.js> <checkout> <out file> <started at>
//
// A process of its own, detached, for the reason a run is one
// (`core/workbench.ts`): `runDone` is synchronous and takes tens of seconds,
// and `bun --watch` restarts the API under it. The done.js is the CHECKOUT's,
// not this app's, because the checkout's copy is what states what finished
// means there — the same file its Stop hook runs.

import { renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL }             from 'node:url'

const [done, root, out, at] = process.argv.slice(2)

function write(value: object) {
  const tmp = `${out}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, out)
}

try {
  const { runDone } = await import(pathToFileURL(done).href)
  const report = runDone(root)
  write({ state: report.unfinished ? 'fail' : 'pass', at, pid: process.pid, report })
} catch (e) {
  write({ state: 'error', at, pid: process.pid, error: String((e as Error)?.message ?? e).slice(0, 2000) })
}
