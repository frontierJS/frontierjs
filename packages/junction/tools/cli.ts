#!/usr/bin/env bun
// tools/cli.ts
// Package bin entry — powers `bunx @frontierjs/junction <command>`.
//
//   bunx @frontierjs/junction init [dir]      scaffold a new project
//   bunx @frontierjs/junction setup [audit]   setup wizard / project audit
//   bunx @frontierjs/junction repl [--port]   interactive REPL
//
// Each tool is a self-executing script that reads its own args from
// Bun.argv.slice(2), so we re-spawn it as its own process with the
// subcommand stripped rather than importing it in-process.

import { join } from 'node:path'

const [cmd, ...rest] = Bun.argv.slice(2)

const TOOLS: Record<string, string> = {
  init:    'init.ts',
  setup:   'setup.ts',
  repl:    'repl.ts',
  build:   'build-app.ts',
  surface: 'surface.ts',
  errors:  'errors-snapshot.ts',
}

const target = TOOLS[cmd ?? '']

if (!target) {
  console.log('Usage: junction <init|setup|repl|build|surface|errors> [args]')
  console.log()
  console.log('  init [dir]        scaffold a new Junction project')
  console.log('  setup [audit]     setup wizard, or non-interactive audit')
  console.log('  repl [--port N]   interactive REPL against a running app')
  console.log('  build <entry>     bundle an app  (--mode=js|binary|docker)')
  console.log('  surface --app <m> write the API surface snapshot  (--check in CI)')
  console.log('  errors            write the error boundary snapshot  (--check in CI)')
  process.exit(cmd ? 1 : 0)
}

const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, target), ...rest], {
  stdin:  'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await proc.exited)
