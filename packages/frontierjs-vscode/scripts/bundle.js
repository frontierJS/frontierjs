#!/usr/bin/env node
// scripts/bundle.js
//
// Bundles the two entry points a packaged extension runs — the extension host
// side and the language server — into self-contained CJS, over the top of the
// tsc output in out/.
//
// Why a bundle and not vsce's own dependency walk: this package is installed by
// bun, so node_modules/vscode-languageclient is a SYMLINK into the workspace
// root's .bun store. vsce follows it, tries to write paths above the extension
// root and dies with `invalid relative path: extension/../../...`. Bundling the
// three runtime deps in means `vsce package --no-dependencies` ships everything
// the extension actually loads.
//
// Two files are deliberately NOT bundled in:
//   - `vscode`, which the extension host provides
//   - out/litestone/parser-bundle.js, which server.js require()s by a computed
//     path (scripts/build-parser.js writes it, and it must sit next to server.js)
//
// Usage: node scripts/bundle.js

const esbuild = require('esbuild')
const path    = require('path')
const fs      = require('fs')

const ROOT = path.resolve(__dirname, '..')

const ENTRIES = [
  { in: 'src/extension.ts',         out: 'out/extension.js' },
  { in: 'src/litestone/server.ts',  out: 'out/litestone/server.js' },
]

async function main() {
  for (const entry of ENTRIES) {
    const outfile = path.join(ROOT, entry.out)

    await esbuild.build({
      entryPoints: [path.join(ROOT, entry.in)],
      bundle:      true,
      platform:    'node',
      format:      'cjs',
      target:      'node18',
      outfile,
      external:    ['vscode'],
      minify:      false,
      sourcemap:   false,
      logLevel:    'warning',
    })

    const size = fs.statSync(outfile).size
    console.log(`[bundle] ✓  ${entry.out} (${(size / 1024).toFixed(1)} KB)`)
  }

  // tsc wrote .js.map beside each entry; the bundles have no source map, and a
  // map pointing at the pre-bundle file makes a stack trace lie.
  for (const entry of ENTRIES) {
    const map = path.join(ROOT, entry.out + '.map')
    if (fs.existsSync(map)) fs.unlinkSync(map)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
