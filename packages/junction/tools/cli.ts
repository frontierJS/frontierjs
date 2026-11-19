#!/usr/bin/env -S bun --no-env-file
// tools/cli.ts
// Package bin entry — powers `bunx @frontierjs/junction <command>`.
//
//   bunx @frontierjs/junction repl [--url]     interactive REPL
//
// Each tool is a self-executing script that reads its own args from
// Bun.argv.slice(2), so we re-spawn it as its own process with the
// subcommand stripped rather than importing it in-process.

import { join } from 'node:path'

const [cmd, ...rest] = Bun.argv.slice(2)

const TOOLS: Record<string, string> = {
  repl:    'repl.ts',
  app:     'app.ts',
  errors:  'errors-snapshot.ts',
  jobs:    'jobs-snapshot.ts',
  principal: 'principal-snapshot.ts',
  notifications: 'notifications-snapshot.ts',
  atlas:   'atlas.ts',
  call:    'call.ts',
}

const target = TOOLS[cmd ?? '']

if (!target) {
  console.log('Usage: junction <repl|app|errors|jobs|principal|notifications|atlas|call> [args]')
  console.log()
  console.log('  repl [--url U]    interactive REPL against a running app (or --host/--port/--https)')
  console.log('  app --app <m>     write the app snapshot — services, routes, plugins  (--check in CI)')
  console.log('  errors            write the error boundary snapshot  (--check in CI)')
  console.log('  jobs --app <m>    write the jobs snapshot — what runs with no caller (--check in CI)')
  console.log('  principal --app <m>  write the principal snapshot — who a caller becomes (--check in CI)')
  console.log('  notifications --app <m>  write the notifications snapshot — what this app can tell somebody (--check in CI)')
  console.log('  atlas --app <m>   print the whole app model as JSON — nothing committed, no --check')
  console.log('  call --app <m> <service>.<method> [id] [json] --as <who>  call one method as somebody, print the answer as JSON')
  console.log('  call --app <m> --as <who>  the same, as a prompt over the booted app (a terminal only)')
  console.log("  call --app <m> -e '<expr>' --as <who>  the prompt run once: the answer as JSON, exit 1 on a throw")
  console.log('  call ... --force   lets a sys write run under NODE_ENV=production')
  process.exit(cmd ? 1 : 0)
}

// A committed snapshot may not vary with this machine's .env (FJS-419): CI has
// none, so a CHAT_URL here added two plugins the gate never saw. call and repl
// boot or reach the real app and read it from the cwd as bun always does.
const SNAPSHOTS = new Set(['app', 'errors', 'jobs', 'principal', 'notifications'])
const envFile = SNAPSHOTS.has(cmd!) ? ['--no-env-file'] : []

const proc = Bun.spawn(['bun', ...envFile, 'run', join(import.meta.dir, target), ...rest], {
  stdin:  'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await proc.exited)
