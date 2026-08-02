#!/usr/bin/env bun
// tools/build-app.ts
// Bundle a Junction app into something you can hand to a server.
//
//   bun run build:app ./app.ts                          → dist/app/app.js  (needs bun)
//   bun run build:app ./app.ts --mode=binary             → self-contained executable
//   bun run build:app ./app.ts --mode=binary --target=bun-linux-x64-musl
//   bun run build:app ./app.ts --mode=docker             → app.js + Dockerfile
//   bun run build:app ./app.ts --mode=docker --artifact=binary --target=bun-linux-x64
//
// js is the default: ~270x smaller than a compiled binary, and the host almost
// always has bun anyway (CapRover ships oven/bun images).
//
// Neither mode can use directory autoload — see the guard below. Bundled apps
// must import their services statically and pass autoload: false.
//
// Not a Cloudflare Workers path. Junction depends on Bun.serve, bun:sqlite,
// Bun.file and Bun.main; workerd provides none of them and `bun build --target`
// offers only browser/bun/node. Targeting Workers is a transport + storage
// rewrite, not a build flag.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve }                    from 'node:path'

const args      = Bun.argv.slice(2)
const flag      = (n: string) => args.includes(`--${n}`)
const opt       = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=')
const positional = args.filter(a => !a.startsWith('--'))

const MODES     = ['js', 'binary', 'docker'] as const
const ARTIFACTS = ['js', 'binary'] as const
// bun-linux-*-musl included: Alpine deploys work, but the binary still needs
// libstdc++ from the base image.
const TARGETS = [
  'bun-linux-x64', 'bun-linux-arm64',
  'bun-linux-x64-musl', 'bun-linux-arm64-musl',
  'bun-darwin-x64', 'bun-darwin-arm64',
  'bun-windows-x64',
]

function die(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`)
  process.exit(1)
}

// ── Args ─────────────────────────────────────────────────────────────────────

const entryArg = positional[0]
if (!entryArg) die(`No entry file.\n     Usage: bun run build:app ./app.ts [--mode=js|binary|docker]`)

const entry = resolve(entryArg)
if (!existsSync(entry)) die(`Entry not found: ${entry}`)

const mode = (opt('mode') ?? 'js') as (typeof MODES)[number]
if (!MODES.includes(mode)) die(`Unknown --mode=${mode}. One of: ${MODES.join(', ')}`)

const artifact = mode === 'docker'
  ? ((opt('artifact') ?? 'js') as (typeof ARTIFACTS)[number])
  : (mode as (typeof ARTIFACTS)[number])
if (!ARTIFACTS.includes(artifact)) die(`Unknown --artifact=${artifact}. One of: ${ARTIFACTS.join(', ')}`)

const target = opt('target')
if (target && !TARGETS.includes(target)) die(`Unknown --target=${target}.\n     Known: ${TARGETS.join(', ')}`)
if (target && artifact !== 'binary') die(`--target only applies to a compiled binary. Add --mode=binary (or --artifact=binary).`)

const outdir  = resolve(opt('outdir') ?? join(process.cwd(), 'dist/app'))
const port    = opt('port') ?? '80'
const minify  = !flag('no-minify')
const sources = flag('sourcemap')

const name = basename(entry, extname(entry))

// ── Autoload guard ───────────────────────────────────────────────────────────
// Directory autoload does not survive bundling, in EITHER mode. Two independent
// reasons, both verified against this tree:
//
//  1. The scan root is resolved against Bun.main — the OUTPUT file, not the
//     source entry. Bundling ./app.ts to ./dist/app.js makes junction look for
//     ./dist/services. Inside a compiled binary Bun.main is /$bunfs/root, so it
//     looks there. A missing directory is a silent no-op in loader.ts.
//  2. findServiceFiles() globs '**/*.service.ts' — TypeScript source only. A
//     bundled or compiled .js service is invisible to it, so shipping the
//     services alongside the artifact does not help either.
//
// Net effect if unguarded: the server boots clean, logs "services":0, and 404s
// every autoloaded route. Measured: source "services":1 → bundled "services":0.
//
// The one case that still works is building IN PLACE — output written beside the
// original services/*.ts, with their own imports still resolvable at runtime.
//
// Detection is best-effort static analysis of the entry file, so the outcomes
// are graded rather than binary:
//   • services dir found, no opt-out          → ERROR (this build would 404)
//   • no opt-out, nothing found               → WARN  (config-driven autoload,
//                                                or a services dir added later)
//   • --allow-autoload with a dir found       → WARN loudly, build anyway
//   • autoload: false, or in-place js build   → silent, nothing to say

const entrySrc = readFileSync(entry, 'utf8')
// Strip comments so a commented-out example does not read as an opt-out.
const entryCode = entrySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const optedOut     = /autoload\s*:\s*false/.test(entryCode)
const explicitDir  = entryCode.match(/autoload\s*:\s*['"`]([^'"`]+)['"`]/)?.[1]
const scannedDir   = explicitDir
  ? resolve(process.cwd(), explicitDir)         // explicit path → CWD-relative
  : join(dirname(entry), 'services')            // default → beside the entry file

// Building in place keeps Bun.main in the same directory as the .ts services.
const inPlace  = artifact === 'js' && outdir === dirname(entry)
const dirFound = existsSync(scannedDir)

const whereMain = artifact === 'binary'
  ? '/$bunfs/root inside a binary'
  : `the output directory (${outdir})`

const warn = (msg: string) => console.warn(`\n  ! ${msg}`)

if (!optedOut && !inPlace) {
  if (dirFound && !flag('allow-autoload')) {
    die(`Autoload would silently break in this build.\n` +
        `     Found: ${scannedDir}\n\n` +
        `     Junction resolves the services directory against Bun.main — which is\n` +
        `     ${whereMain}, not your source tree.\n` +
        `     It also globs '**/*.service.ts', so shipping bundled .js services\n` +
        `     alongside does not work either. The loader treats a missing directory\n` +
        `     as a no-op, so you would get a clean boot and 404s on every route.\n\n` +
        `     Fix one of:\n` +
        `       • import the services statically and pass autoload: false  (recommended)\n` +
        `       • --outdir=${dirname(entry)} to build in place, keeping services/*.ts beside it\n` +
        `       • --allow-autoload to build anyway`)
  }

  if (dirFound) {
    warn(`Building with autoload despite ${scannedDir}.\n` +
         `    Those services will NOT load: the scan root is ${whereMain}, and only\n` +
         `    '**/*.service.ts' is matched. Expect a clean boot and 404s.`)
  } else {
    // Nothing found, but no opt-out either — autoload is still ON by default, so
    // anything resolved from junction.config.js or added to services/ later will
    // silently fail to load in this artifact.
    warn(`No 'autoload: false' found in ${basename(entry)}.\n` +
         `    Autoload is on by default and cannot work in a bundled build — the scan\n` +
         `    root is ${whereMain}, and only '**/*.service.ts' is matched.\n` +
         `    Register services statically and set autoload: false to make this explicit.`)
    const cfg = join(dirname(entry), 'junction.config.js')
    if (existsSync(cfg))
      warn(`${cfg} may set services.dir — not statically checkable. Verify your routes respond.`)
  }
}

// ── Build ────────────────────────────────────────────────────────────────────

mkdirSync(outdir, { recursive: true })

const isWin   = target?.includes('windows') ?? false
const outfile = artifact === 'binary'
  ? join(outdir, `${name}${target ? `-${target.replace(/^bun-/, '')}` : ''}${isWin ? '.exe' : ''}`)
  : join(outdir, `${name}.js`)

const cmd = [
  'bun', 'build',
  ...(artifact === 'binary' ? ['--compile'] : ['--target=bun']),
  ...(minify  ? ['--minify'] : []),
  ...(sources ? ['--sourcemap=linked'] : []),
  ...(target  ? [`--target=${target}`] : []),
  entry, '--outfile', outfile,
]

const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
if (proc.exitCode !== 0) {
  console.error(new TextDecoder().decode(proc.stderr))
  die(`Build failed.`)
}

// ── Dockerfile ───────────────────────────────────────────────────────────────
// Base image is dictated by what the artifact actually links against:
//   js               → needs a bun runtime
//   glibc binary     → libc/libpthread/libdl/libm  → debian-slim or distroless
//   musl binary      → musl libc + libstdc++       → alpine + apk add libstdc++
// Neither binary is static, so `scratch` will not work.

if (mode === 'docker') {
  const musl = target?.includes('musl') ?? false
  const file = basename(outfile)

  const dockerfile = artifact === 'js'
    ? `# Generated by junction build:app --mode=docker
FROM oven/bun:1-slim
WORKDIR /app
COPY ${file} .
ENV PORT=${port}
EXPOSE ${port}
CMD ["bun", "${file}"]
`
    : musl
      ? `# Generated by junction build:app --mode=docker --artifact=binary
# musl build — Alpine still needs libstdc++ for the Bun runtime.
# Base image arch must match --target=${target}.
FROM alpine:3.20
RUN apk add --no-cache libstdc++
WORKDIR /app
COPY ${file} .
ENV PORT=${port}
EXPOSE ${port}
CMD ["./${file}"]
`
      : `# Generated by junction build:app --mode=docker --artifact=binary
# glibc build — dynamically linked against libc/libpthread/libdl/libm.
# Base image arch must match ${target ? `--target=${target}` : 'the build host'}.
FROM debian:bookworm-slim
WORKDIR /app
COPY ${file} .
ENV PORT=${port}
EXPOSE ${port}
CMD ["./${file}"]
`

  writeFileSync(join(outdir, 'Dockerfile'), dockerfile)
  writeFileSync(join(outdir, '.dockerignore'), 'Dockerfile\n.dockerignore\n*.map\n')
}

// ── Report ───────────────────────────────────────────────────────────────────

const mb = (p: string) => {
  const b = statSync(p).size
  return b > 1024 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`
}

console.log(`\n  ✓ ${outfile.replace(process.cwd() + '/', '')}  (${mb(outfile)})`)
if (mode === 'docker') {
  console.log(`  ✓ ${join(outdir, 'Dockerfile').replace(process.cwd() + '/', '')}`)
  console.log(`\n  docker build -t ${name} ${outdir.replace(process.cwd() + '/', '')} && docker run -p ${port}:${port} ${name}`)
}
if (artifact === 'js')
  console.log(`\n  Needs bun on the host:  bun ${basename(outfile)}`)
else
  console.log(`\n  Self-contained — no bun required.`)
console.log()
