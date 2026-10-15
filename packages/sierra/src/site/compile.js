/**
 * site/compile.js — a built site as one executable.
 *
 * Every file under `dir` is embedded with `bun build --compile` and served by
 * `serveSite` from a map of published path → embedded file. The binary is the
 * same origin `sierra site --serve` and `site/deploy/` run, so it answers the
 * directory index, the cache split and the 404 page the same way; a server
 * written into the binary instead would be the hand-rolled one serve.js exists
 * to replace.
 *
 * The map is generated per compile, never written by hand: a file the walk
 * misses is a 404 in the binary and nowhere else.
 */

import { spawnSync }                                   from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }                                      from 'node:os'
import { dirname, join, relative, resolve, sep }       from 'node:path'
import { fileURLToPath }                               from 'node:url'

const SERVE = fileURLToPath(new URL('./serve.js', import.meta.url))

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name)
    return e.isDirectory() ? walk(full) : e.isFile() ? [full] : []
  })
}

/**
 * The entry the binary runs — exported so a test can read what was embedded.
 *
 * `functions` is the build's host-function entry. It is imported statically so
 * the bundler embeds it; the binary reads `env` from the process it runs in.
 */
export function siteEntry(dir, files, functions) {
  const lines = files.map((f, i) => `import f${i} from ${JSON.stringify(f)} with { type: 'file' }`)
  const pairs = files.map((f, i) =>
    `  [${JSON.stringify(relative(dir, f).split(sep).join('/'))}, f${i}],`)

  return `${lines.join('\n')}
import { serveSite } from ${JSON.stringify(SERVE)}
${functions ? `import * as functions from ${JSON.stringify(functions)}\n` : ''}
const files = new Map([
${pairs.join('\n')}
])

const at   = process.argv.indexOf('--port')
const port = Number(at !== -1 ? process.argv[at + 1] : process.env.PORT ?? 8700)
const host = process.env.HOST ?? '0.0.0.0'

const server = await serveSite({ files, port, host${functions ? ', functions, env: process.env' : ''} })
console.log('serving ' + files.size + ' files at ' + server.url)
`
}

/**
 * Compile `dir` into one executable at `outfile`.
 *
 * @param {object} opts
 * @param {string} opts.dir      the built site — what `serveSite({ dir })` serves
 * @param {string} opts.outfile  where the executable lands; must be outside `dir`
 * @param {string} [opts.target] a `bun build --target`, e.g. `bun-darwin-arm64`;
 *                               omitted builds for this machine
 * @param {string} [opts.functions]  the entry the build wrote for the site's host
 *                               functions (`.sierra/functions.js`), embedded
 * @returns {{ outfile: string, files: number }}
 */
export function compileSite({ dir, outfile, target, functions }) {
  const root = resolve(dir)
  const out  = resolve(outfile)
  // Inside the root, the next compile embeds the last binary in the new one.
  if (out === root || out.startsWith(root + sep))
    throw new Error(`the executable must land outside ${root} — got ${out}`)

  const files = walk(root)
  if (!files.some(f => relative(root, f) === 'index.html'))
    throw new Error(`no index.html in ${root} — build the site first`)

  // A directory this compile makes holds nothing but output, so it ignores
  // itself: the executable is the size of the runtime plus every image, and
  // the surface has no .gitignore of its own to keep it out of a commit.
  const outDir = dirname(out)
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, '.gitignore'), '*\n')
  }

  const work = mkdtempSync(join(tmpdir(), 'sierra-compile-'))
  try {
    const entry = join(work, 'entry.js')
    writeFileSync(entry, siteEntry(root, files, functions && resolve(functions)))

    const args = ['build', '--compile', entry, '--outfile', out]
    if (target) args.push('--target', target)
    const run = spawnSync('bun', args, { encoding: 'utf8' })
    if (run.error?.code === 'ENOENT')
      throw new Error('`bun` is not on PATH — compiling a site needs bun')
    if (run.status !== 0)
      throw new Error(`bun build --compile failed:\n${run.stderr || run.stdout}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  return { outfile: out, files: files.length }
}
