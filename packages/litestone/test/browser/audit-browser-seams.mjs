/*
 * audit-browser-seams.mjs — what the code outside the two seams assumes about
 * the host, asked in a real browser over the wasm engine (audit run 2.3,
 * `FJS-D305`).
 *
 *   node packages/litestone/test/browser/audit-browser-seams.mjs
 *
 * Prints every scenario's answer as JSON and a one-line verdict per row. The
 * expectations here state the FIXED behavior — a refusal by name through
 * `#host`, never a ReferenceError for a server global — so a row that fails is
 * an open finding and the exit code is the count of them. The same scenarios
 * run under `node --conditions=browser` from `test/audit-browser-host.test.ts`,
 * where `bun test` can reach them.
 *
 * Builds what it serves, with `--conditions=browser`, like
 * `verify-browser-client.mjs`; serves on 7561 so the two drives can run side by
 * side. Needs Chrome on PATH or $FJS_CHROME.
 */

import { spawnSync }                                  from 'node:child_process'
import { createServer }                               from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join, extname, dirname }                     from 'node:path'
import { fileURLToPath }                              from 'node:url'
import { openChrome }                                 from '../../../mesa/src/drive.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG  = join(HERE, '../..')
const OUT  = join(PKG, 'test/browser/dist-audit')
const PORT = 7561
const WASM_DIR = join(PKG, 'node_modules/@sqlite.org/sqlite-wasm/dist')

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json',
}

function build() {
  if (!existsSync(WASM_DIR)) {
    console.error(`[skip] @sqlite.org/sqlite-wasm is not installed — run \`bun install\` in ${PKG}`)
    process.exit(0)
  }
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const r = spawnSync('bun', [
    'build', '--target=browser', '--conditions=browser',
    join(HERE, 'audit-probe-worker.mjs'), '--outfile=' + join(OUT, 'worker.js'),
  ], { encoding: 'utf8' })
  if (r.status !== 0) { console.error(r.stderr ?? r.error?.message); process.exit(1) }
  for (const f of ['index.mjs', 'sqlite3.wasm']) cpSync(join(WASM_DIR, f), join(OUT, f))
  writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset=utf8><title>audit</title>
<script type=module>
window.results = new Promise((resolve, reject) => {
  const w = new Worker(new URL('./worker.js', location.href), { type: 'module' })
  w.onmessage = ({ data }) => data.err ? reject(new Error(data.err.message)) : resolve(data.ok)
  w.onerror   = (e) => reject(new Error('worker failed: ' + e.message))
  w.postMessage({ wasmUrl: new URL('./index.mjs', location.href).href })
})
</script>`)
}

function serve() {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0])
    const p   = join(OUT, rel === '/' ? 'index.html' : rel)
    if (!p.startsWith(OUT) || !existsSync(p)) { res.writeHead(404); return res.end('not here') }
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
    res.end(readFileSync(p))
  })
  return new Promise((r) => server.listen(PORT, () => r(server)))
}

// ─── what the fixed behavior is, per scenario ─────────────────────────────
//
// `true` when the browser's answer is the one `#host` promises: a value, or a
// refusal that names what was reached for. A ReferenceError is never that.
const notReference = (v) => !(v?.error && v.name === 'ReferenceError')
const EXPECT = {
  'engine-facts':       v => v.engine?.startsWith('sqlite-wasm') && v.journal === 'persist' && v.foreignKeys === 0 && v.fts5 && v.math && v.json,
  'host-globals':       v => v.setImmediate === 'undefined' && v.process === 'undefined' && v.Buffer === 'undefined',
  'env-path':           v => v.error ? /not set|HOST_UNAVAILABLE/.test(v.message + v.code) : v.opened === true,
  'tenancy-row':        v => v.opened === true && v.count === 1,
  'big-int':            v => v.snowflake === '1152921504606846976' && v.count === 1 && v.countType === 'number',
  'int-past-safe':      v => !!v.refused || v.type === 'number',
  'encrypted-with-key': v => v.error && v.code === 'HOST_UNAVAILABLE',
  'encrypted-no-key':   v => v.error && /no encryption key/.test(v.message),
  'trail':              v => v.landed === 1 && v.threw === null && v.warnings.some(w => /not available in a browser/.test(w)),
  'trail-device':       v => v.landed === 1 && v.threw === null,
  'jsonl':              v => v.error && v.code === 'HOST_UNAVAILABLE',
  'cross-process':      v => v.error && v.code === 'HOST_UNAVAILABLE',
  'on-event-hook':      v => v.fired === 1 && v.threw === null && v.landed === 1,
  'fts':                v => v.hits === 1,
  'json':               v => v.second === 2,
  'backup':             v => v.error && v.code === 'HOST_UNAVAILABLE',
  'engine-serialize':   v => v.type === 'Uint8Array' && v.bytes > 0,
}

async function main() {
  build()
  const server = await serve()
  const b = await openChrome()
  let results
  try {
    await b.navigate(`http://localhost:${PORT}/`)
    results = await b.evaluate('return await window.results')
  } finally {
    await b.close()
    server.close()
  }

  let bad = 0
  for (const { name, value } of results) {
    const ok = EXPECT[name] ? !!EXPECT[name](value) : null
    if (ok === false) bad++
    const mark = ok === null ? '·' : ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    console.log(`  ${mark} ${name}  ${JSON.stringify(value)}`)
  }
  console.log(bad ? `\n\x1b[31m${bad} of ${results.length} differ from the fixed behavior\x1b[0m` : `\n\x1b[32mall ${results.length} as promised\x1b[0m`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
