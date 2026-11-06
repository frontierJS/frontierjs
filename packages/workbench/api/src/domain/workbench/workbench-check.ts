// src/domain/workbench/workbench-check.ts — run as its own process: the checkout's own
// `fli done` report, written to a file the workbench reads.
//
//   bun workbench-check.ts <done.js> <checkout> <out file> <started at> [<scope>]
//
// `scope` is JSON `{ chat, only }`, the root-relative files one chat wrote;
// absent grades the whole tree (FJS-D1959). The report names the chat and
// counts the files, since this process rewrites the whole file.
//
// A process of its own, detached, for the reason a run is one
// (`domain/workbench/workbench.ts`): `runDone` takes tens of seconds, and `bun --watch`
// restarts the API under it. The done.js is the CHECKOUT's,
// not this app's, because the checkout's copy is what states what finished
// means there — the same file its Stop hook runs.

import { renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL }             from 'node:url'

const [done, root, out, at, scoped] = process.argv.slice(2)
const scope = scoped ? JSON.parse(scoped) as { chat: string, only: string[] } : null
const named = scope && { chat: scope.chat, files: scope.only.length }

function write(value: object) {
  const tmp = `${out}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, out)
}

try {
  const { runDone } = await import(pathToFileURL(done).href)
  const report = await runDone(root, scope ? { only: scope.only } : {})
  write({ state: report.unfinished ? 'fail' : 'pass', at, pid: process.pid, report, scope: named })
} catch (e) {
  write({ state: 'error', at, pid: process.pid, scope: named, error: String((e as Error)?.message ?? e).slice(0, 2000) })
}
