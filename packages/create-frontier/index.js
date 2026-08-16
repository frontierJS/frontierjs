#!/usr/bin/env node

// ─── create-frontier ──────────────────────────────────────────────────────────
//
//   npm create frontier@latest my-app
//   bun create frontier my-app
//   npx create-frontier my-app
//
// The one thing this package is: an entry point. Everything it does after
// resolving a name is `fli new`, run out of the `@frontierjs/cli` it depends on,
// so there is exactly one implementation of what a FrontierJS app looks like.
// A second copy of the scaffold living here is how the two would start
// disagreeing about the framework's own defaults.
//
// It adds three things `fli new` cannot, because they are about being invoked
// through `npm create` rather than about scaffolding:
//
//  1. **`--project <cwd>`.** fli finds a project root by walking UP from cwd,
//     which is right for every other command and wrong for this one: run inside
//     an existing repository, `fli new my-app` writes into that repository's
//     root rather than beside you. Pinning cwd makes "here" mean here.
//
//  2. **A prompt for the name.** `npm create frontier@latest` with no arguments
//     is what people type; `fli new` with no name is an error, correctly, since
//     every other caller passes one.
//
//  3. **A bun check, up front.** The app it writes runs on Bun — `bun run dev`,
//     `bun --watch run api/index.ts`, `bun:sqlite` beneath Junction. Finding
//     that out after a successful scaffold and a five-second install is the
//     worst moment to find it out.

import { spawn, spawnSync }   from 'node:child_process'
import { createRequire }      from 'node:module'
import { dirname, resolve }   from 'node:path'
import { existsSync }         from 'node:fs'
import { createInterface }    from 'node:readline/promises'
import { stdin, stdout }      from 'node:process'

const c = {
  dim:  (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red:  (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}

const die = (message, ...rest) => {
  console.error(`${c.red('✗')} ${message}`)
  for (const line of rest) console.error(`  ${line}`)
  process.exit(1)
}

// ─── the runtime the app will need ────────────────────────────────────────────
// Not the runtime this script is under — `npm create` runs it on node, and that
// is fine. What matters is whether the app can start once it exists.

const hasBun = spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0
if (!hasBun) {
  die(
    'FrontierJS applications run on Bun, and no `bun` was found on your PATH.',
    '',
    'Install it, then run this again:',
    c.cyan('  curl -fsSL https://bun.sh/install | bash'),
    '',
    c.dim('Junction is Bun-only — Bun.serve is its transport and bun:sqlite is'),
    c.dim('its cache and database. There is no Node build of it to fall back to.'),
  )
}

// ─── the scaffold itself ──────────────────────────────────────────────────────
// `@frontierjs/cli` declares no `exports` map, so a subpath resolves as a plain
// path. Resolving package.json rather than bin/fli.js keeps this working if the
// bin ever moves.

const require = createRequire(import.meta.url)

let fliBin
try {
  fliBin = resolve(dirname(require.resolve('@frontierjs/cli/package.json')), 'bin', 'fli.js')
} catch {
  die('could not resolve @frontierjs/cli — this package is broken, please report it.')
}
if (!existsSync(fliBin)) {
  die(`@frontierjs/cli resolved, but it ships no ${fliBin}`)
}

// ─── the name ─────────────────────────────────────────────────────────────────
// The arguments are forwarded UNTOUCHED and a prompted name is prepended. This
// script must not sort them into flags and positionals, because it does not
// know which flags take a value — an early version did, and `--source npm`
// reached fli as `--source true` with a stray `npm` beside it. `fli new` owns
// every flag, and a list of them restated here is a list that goes stale.
//
// So: the name is argv[0] and only argv[0], which is how `npm create frontier
// my-app --flags` is typed and how `fli new <name>` is documented.

const argv    = process.argv.slice(2)
const given   = argv.length > 0 && !argv[0].startsWith('-') ? argv[0] : null
const isHere  = argv.includes('--here')

const VALID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/

let name = given

if (!name && !isHere) {
  if (!stdin.isTTY) {
    die(
      'a project name is required.',
      '',
      c.cyan('  npm create frontier@latest my-app'),
      c.dim('  (or pass --here to scaffold into the current directory)'),
    )
  }
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    while (!name) {
      const answer = (await rl.question(`${c.bold('Project name')} ${c.dim('(lowercase, hyphens)')}: `)).trim()
      if (!answer)             { console.error(c.dim('  a name, or ctrl-c to stop')); continue }
      if (!VALID.test(answer)) { console.error(c.dim('  lowercase letters, digits and hyphens only')); continue }
      name = answer
    }
  } catch {
    // Ctrl+D at the prompt rejects the question with an AbortError, and an
    // unhandled one prints ten lines of node internals at somebody who was
    // trying to back out. Nothing has been written at this point.
    rl.close()
    console.error(`\n${c.dim('nothing written.')}`)
    process.exit(130)
  } finally {
    rl.close()
  }
}

// ─── run it ───────────────────────────────────────────────────────────────────
// process.execPath rather than a `fli` on PATH: a globally installed fli of a
// different vintage is exactly what this command exists to make unnecessary.

const args = ['new', ...(given ? [] : name ? [name] : []), ...argv, '--project', process.cwd()]

const child = spawn(process.execPath, [fliBin, ...args], { stdio: 'inherit' })
child.on('exit',  (code, signal) => process.exit(signal ? 1 : code ?? 1))
child.on('error', (err) => die(`could not run the scaffold: ${err.message}`))
