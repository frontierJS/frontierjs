#!/usr/bin/env node
// scripts/build-parser.js
//
// Bundles the Litestone parser (ESM) into a single CJS file the language server
// can require(). Runs automatically before tsc via the "prebuild" npm script.
//
// Parser path resolution (first match wins):
//   1. LITESTONE_SRC env var              e.g. LITESTONE_SRC=/abs/path/to/litestone/src
//   2. Sibling directory in monorepo      ../litestone/src/parser.js
//   3. npm-installed package              node_modules/@frontierjs/litestone/src/parser.js
//
// Usage:
//   node scripts/build-parser.js           one-shot build
//   node scripts/build-parser.js --watch   rebuild on parser changes

const esbuild = require('esbuild')
const path    = require('path')
const fs      = require('fs')

const ROOT    = path.resolve(__dirname, '..')
const OUTFILE = path.join(ROOT, 'out', 'litestone', 'parser-bundle.js')
const WATCH   = process.argv.includes('--watch')

// ─── Locate parser ────────────────────────────────────────────────────────────

function resolveParser() {
  const candidates = [
    // 1. Explicit env var
    process.env.LITESTONE_SRC
      ? path.join(process.env.LITESTONE_SRC, 'parser.js')
      : null,
    // 2. Sibling directory (monorepo layout)
    path.resolve(ROOT, '..', 'litestone', 'src', 'parser.js'),
    // 3. npm package
    path.resolve(ROOT, 'node_modules', '@frontierjs', 'litestone', 'src', 'parser.js'),
  ].filter(Boolean)

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`[build-parser] resolved: ${p}`)
      return p
    }
  }

  console.error('[build-parser] ERROR: cannot find litestone parser.')
  console.error('  Tried:')
  candidates.forEach(p => console.error(`    ${p}`))
  console.error()
  console.error('  Options:')
  console.error('    1. Set LITESTONE_SRC=/path/to/litestone/src')
  console.error('    2. Place litestone/ next to frontierjs-vscode/ in your monorepo')
  console.error('    3. npm install @frontierjs/litestone')
  process.exit(1)
}

// ─── Build ────────────────────────────────────────────────────────────────────

async function build() {
  const parserEntry = resolveParser()

  // Ensure out/litestone/ exists
  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true })

  const options = {
    entryPoints: [parserEntry],
    bundle:      true,
    platform:    'node',
    format:      'cjs',
    outfile:     OUTFILE,
    // Don't bundle Node built-ins — they're available in the extension host
    external:    ['fs', 'path', 'os', 'crypto', 'child_process'],
    // Keep the output readable for debugging
    minify:      false,
    sourcemap:   'inline',
    logLevel:    'info',
  }

  if (WATCH) {
    // esbuild watch mode — rebuilds automatically when parser.js changes
    const ctx = await esbuild.context(options)
    await ctx.watch()
    console.log(`[build-parser] watching ${parserEntry}`)
    console.log(`[build-parser] output  ${OUTFILE}`)
    // Keep process alive — the TypeScript watch task runs alongside this
    process.on('SIGINT', async () => { await ctx.dispose(); process.exit(0) })
  } else {
    const result = await esbuild.build(options)
    if (result.errors.length) {
      console.error('[build-parser] build failed')
      process.exit(1)
    }
    const size = fs.statSync(OUTFILE).size
    console.log(`[build-parser] ✓  ${OUTFILE} (${(size / 1024).toFixed(1)} KB)`)
  }
}

build().catch(e => { console.error(e); process.exit(1) })
