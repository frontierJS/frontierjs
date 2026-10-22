#!/usr/bin/env bun
// tools/call.ts
// One service method, once, as somebody — then exit.
//
//   junction call --app src/app.ts orders.find '{"status":"paid","$limit":5}' --as alex@shop.test --tenant flagship
//   junction call --app src/app.ts orders.patch 12 '{"note":"late"}' --as alex@shop.test --tenant flagship
//
// Without this, calling a service as a person meant a dev server started in the
// background, a login by curl, a token copied by hand, a sleep and a kill — and
// when that got tedious, sqlite3 against the file, which answers with every gate
// off. This is the call without the socket, through `src/core/call-as.ts`, the
// path devtools' `POST /api/call` runs inside a live app: the app's own caller
// inside `app.runAs`, so the hooks, the gate and the envelope are a request's.
//
// The answer is JSON on stdout and nothing else is: the build's chatter, the
// standing and a refusal all go to stderr, so `| jq` reads it.

import { getFlag, fatal, loadApp, quietly, stopApp, writeOut } from './app-module.ts'
import { callAs }                                           from '../src/core/call-as.ts'

// ─── args ─────────────────────────────────────────────────────────────────────

// The flags that take a value, so the value is not read as an argument to the
// method. A flag named here and not handled below is a flag silently ignored.
const VALUED = new Set(['app', 'export', 'as', 'tenant'])

const argv = Bun.argv.slice(2)
const words: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const name = a.slice(2).split('=')[0]
    if (!VALUED.has(name)) fatal(`Unknown flag --${name}. junction call takes ${[...VALUED].map(f => `--${f}`).join(', ')}.`)
    if (!a.includes('=')) i++
    continue
  }
  words.push(a)
}

const USAGE =
  `junction call --app <module> <service>.<method> [id] [json] [--as <who>] [--tenant <id>]`

const appPath = getFlag('app')
if (!appPath) fatal(`Name the app module: ${USAGE}`)
if (!words[0]?.includes('.')) fatal(`Name a method as <service>.<method> — ${USAGE}`)

// A word that parses as JSON is that value, anything else is a string — so `12`
// is an id, `'{"a":1}'` is a bag, and `abc-123` is a string id without quoting
// it twice.
const args: unknown[] = words.slice(1).map(w => { try { return JSON.parse(w) } catch { return w } })

// ─── the call ─────────────────────────────────────────────────────────────────

const app = await loadApp(appPath, getFlag('export'))

const json = (value: unknown) => JSON.stringify(value, (_, v) => {
  if (typeof v === 'bigint')   return `${v}n`
  if (v instanceof Uint8Array) return `<${v.length} bytes>`
  return v
}, 2) ?? String(value)

const out = await callAs(app, {
  method: words[0],
  args,
  as:     getFlag('as') ?? undefined,
  tenant: getFlag('tenant') ?? undefined,
}, { around: quietly })

if (out.standing) console.error(`  Standing: ${out.standing}`)
if (!out.ok) {
  // A call never made is named; one that threw prints the status HTTP would
  // have sent, so a refusal reads apart from a bug.
  if (out.name) console.error(`  ${out.name} (${out.status}): ${out.message}`)
  else console.error(`\n  ✗  ${out.message}\n`)
  if (out.data) console.error(`  ${json(out.data).split('\n').join('\n  ')}`)
}

// `stop()` is what drains a job the boot's worker already claimed — exiting
// past it strands the job until its lease lapses.
await stopApp(app)
if (out.ok) await writeOut(json(out.result) + '\n')
process.exit(out.ok ? 0 : 1)
