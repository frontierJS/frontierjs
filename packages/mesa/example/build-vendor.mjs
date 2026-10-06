/*
 * build-vendor.mjs — the REPL's third-party code, written to `example/vendor/`.
 *
 *   bun example/build-vendor.mjs
 *
 * The REPL used to import all of this off esm.sh, which made its drive a suite
 * that goes red on a train (`FJS-326`). The bundles are committed and the
 * importmap in `index.html` names them, so the page that ships is the page that
 * is tested. Re-run this when a devDependency moves.
 *
 * One `Bun.build` call, with splitting, rather than one per package: the
 * CodeMirror packages share `@codemirror/state`, and a second copy of it in the
 * page fails on an `instanceof` that no error message explains.
 */
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE   = fileURLToPath(new URL('.', import.meta.url))
const VENDOR = join(HERE, 'vendor')
const ENTRY  = join(VENDOR, '.entries')

/** The bare specifiers `index.html` and the compiler import, in the importmap. */
export const SPECIFIERS = [
  'acorn',
  'unified',
  'remark-parse',
  'remark-gfm',
  'remark-rehype',
  'rehype-slug',
  'rehype-stringify',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/commands',
  '@codemirror/lang-javascript',
  '@codemirror/lang-html',
  '@codemirror/autocomplete',
  '@lezer/highlight',
  '@replit/codemirror-vim',
]

const fileOf = (spec) => spec.replace(/^@/, '').replace(/\//g, '-') + '.js'

await rm(VENDOR, { recursive: true, force: true })
await mkdir(ENTRY, { recursive: true })

const entries = []
for (const spec of SPECIFIERS) {
  const path = join(ENTRY, fileOf(spec))
  // `export *` leaves the default behind, and five of these export only that.
  const hasDefault = 'default' in await import(spec)
  await writeFile(path, `export * from '${spec}'\n${hasDefault ? `export { default } from '${spec}'\n` : ''}`)
  entries.push(path)
}

const out = await Bun.build({
  entrypoints: entries,
  outdir: VENDOR,
  target: 'browser',
  format: 'esm',
  splitting: true,
  minify: true,
  naming: { entry: '[name].[ext]', chunk: 'chunk-[hash].[ext]' },
})
if (!out.success) {
  for (const log of out.logs) console.error(String(log))
  process.exit(1)
}
await rm(ENTRY, { recursive: true, force: true })

// A classic script, not a module: the page reads the global `LZString`.
await copyFile(
  fileURLToPath(import.meta.resolve('lz-string/libs/lz-string.min.js')),
  join(VENDOR, 'lz-string.min.js'),
)

const importmap = Object.fromEntries(SPECIFIERS.map((s) => [s, `./vendor/${fileOf(s)}`]))
console.log(JSON.stringify({ imports: importmap }, null, 2))
