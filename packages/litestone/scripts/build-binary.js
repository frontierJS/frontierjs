#!/usr/bin/env bun
// Compile the CLI into a standalone executable — no bun, no node_modules, no
// source tree required on the target machine.
//
//   bun run build:binary                 host platform → dist/litestone
//   bun run build:binary --all           every supported target
//   bun run build:binary --target=bun-darwin-arm64
//   bun run build:binary --no-bytecode   skip bytecode (slower start, smaller)
//
// Why this works at all: src/tools/cli.js imports its siblings with literal
// relative specifiers, so the bundler can follow them. Computed specifiers
// (`import(import.meta.dir + '/../core/x.js')`) are invisible to the bundler and
// produce a binary that dies at runtime with "Cannot find module /$bunfs/root/...".
// Keep them literal. Likewise, on-disk assets must be `with { type: 'text' }`
// imports — see STUDIO_HTML and BUILTIN_SEEDS in cli.js.

import { mkdirSync, rmSync, statSync } from 'fs'
import { resolve }                     from 'path'

const ROOT  = resolve(import.meta.dir, '..')
const ENTRY = resolve(ROOT, 'src/tools/cli.js')
const DIST  = resolve(ROOT, 'dist')

// Targets bun can cross-compile to. bun-linux-*-musl also exists if you need
// Alpine; add it here rather than passing --target twice.
const TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
]

const args     = process.argv.slice(2)
const flag     = n => args.includes(`--${n}`)
const getFlag  = n => args.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=')

// Bytecode roughly halves cold start (~55ms → ~28ms) at the cost of ~5MB.
const bytecode = !flag('no-bytecode')
const clean    = flag('clean')

const explicit = getFlag('target')
const targets  = flag('all') ? TARGETS : explicit ? [explicit] : [null]  // null = host

if (explicit && !TARGETS.includes(explicit)) {
  console.error(`✗ Unknown target: ${explicit}\n  Known: ${TARGETS.join(', ')}`)
  process.exit(1)
}

if (clean) rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

const mb = p => (statSync(p).size / 1024 / 1024).toFixed(1) + ' MB'

let failed = 0
for (const target of targets) {
  // Windows needs the .exe suffix or the produced file is not executable.
  // Match 'windows' specifically — 'darwin' contains the substring 'win'.
  const suffix  = target ? `-${target.replace(/^bun-/, '')}` : ''
  const isWin   = target ? target.includes('windows') : process.platform === 'win32'
  const ext     = isWin ? '.exe' : ''
  const outfile = resolve(DIST, `litestone${suffix}${ext}`)

  const cmd = [
    'bun', 'build', '--compile', '--minify',
    // Lets the CLI know it is running as a binary (see IS_COMPILED in cli.js).
    // Must be a define, not an import.meta.dir check: --bytecode rewrites
    // import.meta.dir to the build machine's source path, so path sniffing
    // reports "not compiled" in the very build we ship.
    '--define', 'process.env.LITESTONE_COMPILED="1"',
    ...(bytecode ? ['--bytecode'] : []),
    ...(target   ? [`--target=${target}`] : []),
    ENTRY, '--outfile', outfile,
  ]

  const label = target ?? 'host'
  const proc  = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  if (proc.exitCode !== 0) {
    failed++
    console.error(`  ✗ ${label}`)
    console.error(new TextDecoder().decode(proc.stderr).split('\n').map(l => `      ${l}`).join('\n'))
    continue
  }
  console.log(`  ✓ ${label.padEnd(18)} ${outfile.replace(ROOT + '/', '')}  (${mb(outfile)})`)
}

if (failed) {
  console.error(`\n✗ ${failed} target(s) failed`)
  process.exit(1)
}

console.log(`\n  Bytecode: ${bytecode ? 'on' : 'off'}`)
console.log(`  Note: \`litestone repl\` is unavailable in the binary — it needs a real bun on PATH.\n`)
