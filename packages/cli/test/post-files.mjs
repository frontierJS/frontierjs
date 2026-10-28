/*
 * test/post-files.mjs — the post's file store on `wrangler dev`, with local R2
 * and the Durable Object's SQLite in a temp directory (IDEAS/frontier-files.md
 * Phase 1, THREATS B23–B24). A member's file is asked for, put and taken back
 * byte for byte; every refusal the store promises is asked for by name; and
 * the sweep is watched leaving no row and no object behind, after a last
 * download and at expiry. Then the client (Phase 2): `fli tell:upload` seals a
 * file, and `fli tell:download` and Chrome each take it back from the printed
 * link to the same sha256, while R2 holds neither its bytes nor its name.
 *
 * Nothing else asks it: `core/tell-worker.js` runs only in workerd, so a unit
 * test would be a fake of R2 and of the object's alarm, which are what break.
 *
 * Traps:
 * - The post answers on 5508 (fli's reserved block, docs/PORTS.md), and a port
 *   that already answers is refused rather than driven: it is another post.
 * - FILE_MAX is read off the post's own 413 rather than copied here, so the
 *   drive follows the constant.
 * - Expiry is a real minute: the shortest link a member may ask for. That
 *   case is asked first and checked last, so the minute overlaps the rest.
 * - Whether R2 still holds an object is asked of miniflare's blob directory,
 *   since no route lists objects. Wrangler's layout under `--persist-to` is
 *   `v3/r2/<bucket>/blobs`; a wrangler that moves it fails the count by name.
 * - fli runs from this checkout (bin/fli.js, never a bare `fli`) under a temp
 *   HOME holding the owner's key, so no real member's ~/.fli is touched.
 * - Chrome is mesa's driver, by relative path as the cli's browser drives
 *   read it; a machine with no Chrome fails the drive rather than skipping.
 */
export const holds = ['ports']

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateSigningKeys } from '@frontierjs/toolbelt/signature'
import { tellFetch } from '../core/tell.js'
import { openChrome } from '../../mesa/src/drive.js'

const PORT   = 5508
const ORIGIN = `http://127.0.0.1:${PORT}`
const worker = fileURLToPath(new URL('../core/tell-worker.js', import.meta.url))
const fliBin = fileURLToPath(new URL('../bin/fli.js', import.meta.url))

let failed = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}

if (await fetch(ORIGIN).then(() => true, () => false)) {
  console.error(`${ORIGIN} already answers: another post is running there. Stop it first.`)
  process.exit(1)
}

const dir   = mkdtempSync(join(tmpdir(), 'fli-post-files-'))
const state = join(dir, 'state')
const owner = await generateSigningKeys()
const config = join(dir, 'wrangler.jsonc')
writeFileSync(config, JSON.stringify({
  name: 'fli-tell-drive',
  main: worker,
  compatibility_date: '2026-09-01',
  vars: { OWNER_KEY: owner.publicKey, OWNER_NICK: 'drive' },
  durable_objects: { bindings: [{ name: 'POST', class_name: 'TellPost' }] },
  r2_buckets: [{ binding: 'FILES', bucket_name: 'frontier-files' }],
  migrations: [{ tag: 'v1', new_sqlite_classes: ['TellPost'] }],
}))

const wrangler = spawn('bunx', ['wrangler@4', 'dev', '--config', config, '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', state, '--inspector-port', '0', '--show-interactive-dev-session=false'],
  { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
let log = ''
wrangler.stdout.on('data', d => { log += d })
wrangler.stderr.on('data', d => { log += d })

const stop = () => { try { wrangler.kill('SIGTERM') } catch {} }
process.on('exit', stop)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const ask  = body => tellFetch(ORIGIN, owner, 'POST', '/file', body)
const put  = (id, token, bytes) => fetch(`${ORIGIN}/file/${id}`, { method: 'PUT', body: bytes, headers: { 'x-file-token': token } })
const take = id => fetch(`${ORIGIN}/file/${id}/bytes`)
const blobs = () => {
  const at = join(state, 'v3', 'r2', 'frontier-files', 'blobs')
  return existsSync(at) ? readdirSync(at).length : null
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
/** One `fli` run from this checkout, as the owner under the drive's HOME: `{ code, out }`. */
const fli = (home, cwd, ...args) => new Promise(resolve => {
  const child = spawn('bun', [fliBin, ...args], { cwd, env: { ...process.env, HOME: home, FLI_FRONTIER_POST: ORIGIN, NO_COLOR: '1' } })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  child.on('close', code => resolve({ code, out }))
})
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

try {
  for (let i = 0; ; i++) {
    if (await fetch(`${ORIGIN}/file`).then(() => true, () => false)) break
    if (i > 120 || wrangler.exitCode !== null) throw new Error(`wrangler dev did not answer on ${PORT}:\n${log}`)
    await sleep(500)
  }

  console.log('expiry, asked first so its minute overlaps the rest')
  const brief = await ask({ size: 1000, seconds: 60 })
  check(brief.status === 201, 'a one-minute link is asked for', JSON.stringify(brief.json))
  const briefPut = await put(brief.json.id, brief.json.putToken, crypto.getRandomValues(new Uint8Array(1000)))
  check(briefPut.status === 201, 'and put', await briefPut.text())

  console.log('who may ask')
  const unsigned = await fetch(`${ORIGIN}/file`, { method: 'POST', body: JSON.stringify({ size: 10 }) })
  check(unsigned.status === 401, 'an unsigned POST /file is refused', `${unsigned.status}`)
  const inner = await fetch(`${ORIGIN}/file/${brief.json.id}/take`, { method: 'POST', body: '{}' })
  check(inner.status === 404, 'an object step is not reachable from outside', `${inner.status}`)

  console.log('size')
  const huge = await ask({ size: 2 ** 40 })
  const max = Number(huge.json?.message?.match(/at most (\d+) bytes/)?.[1])
  check(huge.status === 413 && max > 24 * 1024 * 1024, `a file past the cap is refused, and the cap is ${max}`, JSON.stringify(huge.json))
  const over = await ask({ size: max + 1 })
  check(over.status === 413, 'FILE_MAX + 1 is refused by name', JSON.stringify(over.json))

  console.log('a full file, two downloads')
  const full = await ask({ size: max, downloads: 2 })
  check(full.status === 201 && full.json.downloads === 2, 'FILE_MAX is asked for', JSON.stringify(full.json))
  const bytes = new Uint8Array(max)
  // getRandomValues fills 64 KiB a call.
  for (let at = 0; at < max; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, max)))
  const short = await put(full.json.id, full.json.putToken, bytes.subarray(1))
  check(short.status === 400, 'a put of another length is refused', `${short.status} ${await short.text()}`)
  const badToken = await put(full.json.id, 'not-the-token', bytes)
  check(badToken.status === 403, 'a put with another token is refused', `${badToken.status}`)
  const early = await take(full.json.id)
  check(early.status === 409, 'a take before the put lands is refused', `${early.status}`)
  const stored = await put(full.json.id, full.json.putToken, bytes)
  check(stored.status === 201, 'the file is put', `${stored.status} ${await stored.clone().text()}`)
  const again = await put(full.json.id, full.json.putToken, bytes)
  check(again.status === 409, 'the token is spent once', `${again.status}`)
  check(blobs() === 2, 'R2 holds the two objects put', `${blobs()}`)

  const first = await take(full.json.id)
  check(first.status === 200 && same(new Uint8Array(await first.arrayBuffer()), bytes), 'the first download is the file byte for byte', `${first.status}`)
  const second = await take(full.json.id)
  check(second.status === 200 && same(new Uint8Array(await second.arrayBuffer()), bytes), 'the second, the last, is too', `${second.status}`)
  let third
  for (let i = 0; i < 20; i++) {
    third = await take(full.json.id)
    if (third.status === 404) break
    await sleep(250)
  }
  check(third.status === 404, 'after the last download the row is swept', `${third.status} ${await third.text()}`)
  check(blobs() === 1, 'and so is the object', `${blobs()}`)

  console.log('the budget')
  const asked = []
  let budget
  for (let i = 0; i < 1000; i++) {
    budget = await ask({ size: max })
    if (budget.status !== 201) break
    asked.push(budget.json.id)
  }
  check(budget.status === 507 && /holds all the bytes it may/.test(budget.json?.message), `an ask past FILE_BUDGET is refused by name, after ${asked.length}`, JSON.stringify(budget.json))
  const strangerKeys = await generateSigningKeys()
  const notMember = await tellFetch(ORIGIN, strangerKeys, 'DELETE', `/file/${asked[0]}`)
  check(notMember.status === 403, 'a delete by a key that is no member is refused', `${notMember.status}`)
  let deleted = 0
  for (const id of asked) deleted += (await tellFetch(ORIGIN, owner, 'DELETE', `/file/${id}`)).status === 200
  check(deleted === asked.length, 'the owner deletes every ask', `${deleted}/${asked.length}`)
  const room = await ask({ size: max })
  check(room.status === 201, 'and the budget is given back', JSON.stringify(room.json))

  console.log('the client: fli up, fli and Chrome down')
  const home = join(dir, 'home')
  mkdirSync(join(home, '.fli', 'frontier'), { recursive: true })
  writeFileSync(join(home, '.fli', 'config.json'), JSON.stringify({ frontier: { nick: 'drive' } }))
  writeFileSync(join(home, '.fli', 'frontier', 'key.json'), JSON.stringify(owner))
  const NAME = 'drive-sealed-name.txt'
  const MARK = 'the plaintext the post must never hold'
  const sent = join(dir, 'up')
  mkdirSync(sent)
  const plain = Buffer.concat([Buffer.from(MARK), crypto.getRandomValues(new Uint8Array(200_000)), Buffer.from(MARK)])
  writeFileSync(join(sent, NAME), plain)
  const before = new Set(existsSync(join(state, 'v3', 'r2', 'frontier-files', 'blobs')) ? readdirSync(join(state, 'v3', 'r2', 'frontier-files', 'blobs')) : [])
  const up = await fli(home, sent, 'tell:upload', NAME, '--downloads', '3', '--hours', '1')
  const link = up.out.match(/http:\/\/127\.0\.0\.1:\d+\/file\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]+/)?.[0]
  check(up.code === 0 && !!link, 'fli tell:upload prints a link with its key', up.out)
  check(/3 downloads, expires in (60 min|1 h)/.test(up.out), 'with the limits the post answered beside it', up.out)
  const blobDir = join(state, 'v3', 'r2', 'frontier-files', 'blobs')
  const held = readdirSync(blobDir).filter(b => !before.has(b)).map(b => readFileSync(join(blobDir, b)))
  check(held.length === 1 && !held[0].includes(Buffer.from(MARK)) && !held[0].includes(Buffer.from(NAME)) && held[0].length > plain.length,
    'R2 holds the file sealed: neither its plaintext nor its name', `${held.length} new, ${held.map(b => b.length)}`)

  const wrongKey = link.replace(/#(.)/, (_, c) => `#${c === 'A' ? 'B' : 'A'}`)
  const got = join(dir, 'down')
  mkdirSync(got)
  const forged = await fli(home, got, 'tell:download', wrongKey)
  check(forged.code !== 0 && /does not open the file/.test(forged.out) && readdirSync(got).length === 0, 'a key that does not open the file writes nothing', forged.out)
  const down = await fli(home, got, 'tell:download', link)
  const saved = existsSync(join(got, NAME)) ? readFileSync(join(got, NAME)) : null
  check(down.code === 0 && saved && sha(saved) === sha(plain), 'fli tell:download saves it under its own name, same sha256', down.out)
  check(/1 download left/.test(down.out), 'and says what is left on the link', down.out)

  const chromeDir = join(dir, 'chrome')
  mkdirSync(chromeDir)
  const browser = await openChrome()
  try {
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: chromeDir })
    await browser.navigate(link.split('#')[0])
    const keyless = await browser.evaluate(`return { disabled: document.getElementById('get').disabled, said: document.getElementById('said').textContent }`)
    check(keyless.disabled && /no key/.test(keyless.said), 'the page without its key offers no download', JSON.stringify(keyless))
    await browser.navigate(link)
    const page = await browser.evaluate(`return document.querySelector('main').textContent`)
    check(/1 download, expires in/.test(page), 'the page says the limits before the click', page)
    await browser.evaluate(`document.getElementById('get').click(); return true`)
    const said = await browser.waitFor(`/Saved|refused|does not open/.test(document.getElementById('said').textContent) && document.getElementById('said').textContent`)
      .catch(async () => `no answer on the page: ${await browser.evaluate(`return document.getElementById('said').textContent`)} [${browser.errors.join(' | ')}]`)
    let file = null
    for (let i = 0; i < 100 && !file; i++) {
      if (existsSync(join(chromeDir, NAME))) file = readFileSync(join(chromeDir, NAME))
      else await sleep(100)
    }
    check(file && sha(file) === sha(plain), 'Chrome saves it from the link under its own name, same sha256', `${said} — ${readdirSync(chromeDir)}`)
    check(/link is spent/.test(said), 'and says the link is spent', said)
    check(browser.errors.length === 0, 'the page reports no error, CSP included', browser.errors.join(' | '))
  } finally {
    await browser.close()
  }
  const spent = await fli(home, got, 'tell:download', link)
  check(spent.code !== 0 && readdirSync(got).length === 1, 'a spent link is refused and writes nothing', spent.out)

  console.log('expiry, checked last')
  const gone = brief.json.expires * 1000 - Date.now()
  if (gone > 0) await sleep(gone + 3000)
  const expired = await take(brief.json.id)
  check(expired.status === 404, 'an expired link is swept: its row is gone', `${expired.status} ${await expired.text()}`)
  check(blobs() === 0, 'and R2 holds no object', `${blobs()}`)
} catch (e) {
  console.error(e)
  failed++
} finally {
  stop()
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
