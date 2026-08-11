#!/usr/bin/env node
// scripts/verify-package.js
//
// Packs the extension and then tests the ARTEFACT, not the working tree:
// unpacks the .vsix somewhere with no node_modules above it and drives the
// unpacked language server over LSP/stdio with the ordinary suite.
//
// A .vsix that builds is not an extension that runs. Everything this checks has
// failed here: the icon package.json names did not exist (vsce refuses), and the
// three runtime deps are bun symlinks into the workspace store, so a vsix built
// without bundling either dies at pack time or ships an extension whose first
// require() throws in the marketplace, where nothing tests it.
//
// Usage: node scripts/verify-package.js   (npm run verify:package)

const { execFileSync, spawnSync } = require('child_process')
const path = require('path')
const fs   = require('fs')
const os   = require('os')

const ROOT = path.resolve(__dirname, '..')
const PKG  = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

let fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`)
  if (!cond) fail++
}

const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'fjs-vsix-'))
const vsix = path.join(tmp, `${PKG.name}-${PKG.version}.vsix`)
const out  = path.join(tmp, 'unpacked')

console.log('\npack')
try {
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'vsce'),
    ['package', '--no-dependencies', '-o', vsix], { cwd: ROOT, stdio: 'inherit' })
  ok('vsce package succeeds', fs.existsSync(vsix))
} catch (e) {
  ok('vsce package succeeds', false, String(e.message).split('\n')[0])
  process.exit(1)
}

execFileSync('unzip', ['-q', vsix, '-d', out])
const ext = path.join(out, 'extension')
const has = p => fs.existsSync(path.join(ext, p))

console.log('\ncontents')
ok('marketplace icon shipped', has(PKG.icon))
for (const lang of PKG.contributes.languages) {
  if (!lang.icon) continue
  ok(`${lang.id} file icon: light`, has(lang.icon.light))
  ok(`${lang.id} file icon: dark`,  has(lang.icon.dark))
}
ok('parser bundle beside the server', has('out/litestone/parser-bundle.js'))
ok('no node_modules shipped', !has('node_modules'))

// The bundle is only real if nothing bare-requires a dependency that is no
// longer there. A computed require() (parser-bundle) is expected and excluded.
console.log('\nbundle')
for (const entry of ['out/extension.js', 'out/litestone/server.js']) {
  const src  = fs.readFileSync(path.join(ext, entry), 'utf8')
  const bare = [...src.matchAll(/require\(["']([^."'][^"']*)["']\)/g)]
    .map(m => m[1])
    .filter(m => !require('module').isBuiltin(m) && m !== 'vscode')
  ok(`${entry} requires nothing unbundled`, bare.length === 0, `found ${[...new Set(bare)].join(', ')}`)
}

// Mesa has no server: its providers are plain JS that tsc only emits with
// allowJs, and esbuild only bundles because client.ts imports rather than
// require()s them. Either slip ships an extension that throws on activation.
{
  const src = fs.readFileSync(path.join(ext, 'out', 'extension.js'), 'utf8')
  ok('mesa providers are in the bundle',
    ['provideHover', 'provideCompletionItems', 'provideDocumentSymbols'].every(f => src.includes(f)))
  // A downlevelled `import()` becomes a require(), and require() of mesa's ESM
  // compiler throws in the extension host — silently disabling diagnostics.
  ok('the compiler is loaded by a real dynamic import', src.includes('return import(specifier)'))
}

console.log('\nthe unpacked server answers LSP')
const suite = spawnSync('node', [path.join(ROOT, 'test', 'lsp.test.js')], {
  cwd: tmp,                                            // no node_modules above it
  env: { ...process.env, FJS_LSP_SERVER: path.join(ext, 'out', 'litestone', 'server.js') },
  encoding: 'utf8',
})
const tail = (suite.stdout || '').trim().split('\n').slice(-3).join('\n')
ok('lsp suite passes against the unpacked server', suite.status === 0,
  tail + (suite.stderr ? `\n${suite.stderr.trim().split('\n').slice(-3).join('\n')}` : ''))

console.log('\nthe unpacked mesa client answers')
const mesa = spawnSync('node', [path.join(ROOT, 'test', 'mesa.test.js')], {
  cwd: tmp,
  env: { ...process.env, FJS_MESA_CLIENT: path.join(ext, 'out', 'mesa', 'client.js') },
  encoding: 'utf8',
})
const mesaTail = (mesa.stdout || '').trim().split('\n').slice(-3).join('\n')
ok('mesa suite passes against the unpacked client', mesa.status === 0,
  mesaTail + (mesa.stderr ? `\n${mesa.stderr.trim().split('\n').slice(-3).join('\n')}` : ''))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `\n${fail} failed\n` : '\nall good\n')
process.exit(fail ? 1 : 0)
