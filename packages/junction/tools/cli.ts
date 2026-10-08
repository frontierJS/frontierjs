#!/usr/bin/env bun
// tools/cli.ts
// Package bin entry — powers `bunx @frontierjs/junction <command>`.
//
//   bunx @frontierjs/junction repl [--port]   interactive REPL
//
// Each tool is a self-executing script that reads its own args from
// Bun.argv.slice(2), so we re-spawn it as its own process with the
// subcommand stripped rather than importing it in-process.

import { join } from 'node:path'

const [cmd, ...rest] = Bun.argv.slice(2)

const TOOLS: Record<string, string> = {
  repl:    'repl.ts',
  surface: 'surface.ts',
  errors:  'errors-snapshot.ts',
  jobs:    'jobs-snapshot.ts',
  principal: 'principal-snapshot.ts',
  notifications: 'notifications-snapshot.ts',
  atlas:   'atlas.ts',
  call:    'call.ts',
}

const target = TOOLS[cmd ?? '']

if (!target) {
  console.log('Usage: junction <repl|surface|errors|jobs|principal|notifications|atlas|call> [args]')
  console.log()
  console.log('  repl [--port N]   interactive REPL against a running app')
  console.log('  surface --app <m> write the API surface snapshot  (--check in CI)')
  console.log('  errors            write the error boundary snapshot  (--check in CI)')
  console.log('  jobs --app <m>    write the jobs snapshot — what runs with no caller (--check in CI)')
  console.log('  principal --app <m>  write the principal snapshot — who a caller becomes (--check in CI)')
  console.log('  notifications --app <m>  write the notifications snapshot — what this app can tell somebody (--check in CI)')
  console.log('  atlas --app <m>   print the whole app model as JSON — nothing committed, no --check')
  console.log('  call --app <m> <service>.<method> [id] [json] --as <who>  call one method as somebody, print the answer as JSON')
  process.exit(cmd ? 1 : 0)
}

const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, target), ...rest], {
  stdin:  'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await proc.exited)
