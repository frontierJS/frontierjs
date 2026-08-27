/**
 * web/test/verify-catalogue.mjs — the catalogue, in a real browser.
 *
 * Started by `bun run verify:catalogue`. Unlike the other drives this one
 * starts BOTH servers itself and stops them again, because the thing it proves
 * spans them: a `File` column stores a reference in SQLite, the API serves the
 * bytes out of its own object storage, and the browser has to end up with an
 * <img> that decoded. A drive that assumed a running pair would pass against
 * whichever build those were serving.
 *
 * Two traps this file exists to stay out of:
 *
 *   · A dev server transforms a .mesa module once and caches it for the life of
 *     the process, so a compiler or component edit is invisible to a server
 *     that was already up. Both are started here, per run.
 *   · An <img> that is PRESENT is not an <img> that loaded. `naturalWidth` is 0
 *     for a broken image and the element is in the DOM either way, so every
 *     image assertion below reads naturalWidth and never querySelector alone.
 */
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const UI   = process.env.UI_URL  ?? 'http://localhost:8010'

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
// `detached` is what makes stopAll work. `npx vite` is a launcher: SIGTERM to
// the process this holds kills the launcher and leaves vite itself on 8010, so
// the NEXT drive refuses the port and says a dev server is running from an
// earlier run — which it is, and nothing said which run. Detached puts each
// server in its own process group, and stopAll signals the group.
function start(cmd, args, name) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    // The GROUP, negative pid. Falls back to the process itself where the
    // group is already gone, so a second call is not an error.
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

// Refuse a port that already answers rather than joining it. Vite hops to the
// next free port in silence and a dev server serves the code it STARTED with,
// so a leftover from the previous run would be tested instead of this one —
// and it would pass, against the old build.
for (const [port, what] of [[8110, 'the API'], [8010, 'the dev server']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

// Seeding is a step, not a boot side effect, so this drive takes it. Against an
// empty database every assertion below fails as "the row is not there", which
// reads as a regression in whatever was just changed. Idempotent — a seeded
// database costs one pass of existence checks.
execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

start('bun', ['run', 'api/index.ts'], 'api')
start('npx', ['vite', '-c', 'web/config/vite.config.js'], 'web')

if (!await waitFor(`${API}/api/products`, 'api')) { stopAll(); process.exit(1) }
if (!await waitFor(UI, 'web'))                    { stopAll(); process.exit(1) }

// ─── Chrome over CDP ───────────────────────────────────────────────────────

const chrome = start(CHROME, [
  '--headless=new', '--remote-debugging-port=9222', '--disable-gpu',
  '--no-sandbox', '--window-size=1400,1000', 'about:blank',
], 'chrome')

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const v = await (await fetch('http://localhost:9222/json/version')).json()
    wsUrl = v.webSocketDebuggerUrl
  } catch { await new Promise(r => setTimeout(r, 250)) }
}
if (!wsUrl) { console.error('chrome never came up'); stopAll(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}, sessionId) {
  const id = ++msgId
  return new Promise(res => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
}

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function goto(path, waitSel, atLeast = 1) {
  await send('Page.navigate', { url: UI + path }, sessionId)
  // Settle on the CONTENT this page is about, never on a fixed sleep and never
  // on the shell. The layout's nav and heading are in `main` before a single
  // row has been fetched, so a text-length check passes while the table is
  // still empty — which is a drive that fails on a slow run and passes on a
  // fast one, in whichever assertion happened to be first.
  for (let i = 0; i < 100; i++) {
    const n = await evaluate(`document.querySelectorAll('${waitSel}').length`)
    if (n >= atLeast) return
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`${path}: never rendered ${atLeast}× \`${waitSel}\``)
}

async function settleImages(sel) {
  // An <img> is in the DOM the moment the row renders and has naturalWidth 0
  // until the bytes arrive. Every image assertion below reads naturalWidth, so
  // they all have to wait for this rather than for the row.
  for (let i = 0; i < 60; i++) {
    const ok = await evaluate(`(() => {
      const els = [...document.querySelectorAll('${sel}')]
      return els.length > 0 && els.every(i => i.complete && i.naturalWidth > 0)
    })()`)
    if (ok) return
    await new Promise(r => setTimeout(r, 150))
  }
}

async function evaluate(expr) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(async () => (${expr}))()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result?.result?.value
}

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

console.log('\n  catalogue — the API')

const products = await (await fetch(`${API}/api/products?$limit=100`)).json()
const variants = await (await fetch(`${API}/api/product-variants?$limit=200`)).json()
const images   = await (await fetch(`${API}/api/product-images?$limit=100`)).json()

check('13 products seeded',        products.total, 13)
check('43 variants seeded',        variants.total, 43)
check('19 photographs seeded',     images.total,   19)
check('every image resolved to a URL', images.data.every(i => typeof i.file === 'string' && i.file.startsWith('http')), true)

// The File round trip: the ref the row carries has to be bytes the API serves.
const head = await fetch(images.data[0].file)
check('image URL serves bytes',    head.ok && head.headers.get('content-type'), 'image/png')

// The composite @@unique is the whole reason the option columns are not
// nullable — assert it holds through the API, not just in SQLite.
const dup = await fetch(`${API}/api/product-variants`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ productId: 1, sku: 'DRIVE-DUP', colour: 'Night Navy', size: 'm', price: 1 }),
})
check('anonymous variant write refused (@@gate)', dup.status, 401)

console.log('\n  catalogue — the products list')

await goto('/products/', '.product-row', 10)

// Ten rows, not thirteen: the page size is a PREFERENCE, set on /settings/ and
// defaulting to 10, so a full catalogue is two pages. The pager is what says
// all thirteen arrived.
check('one page of rows renders', await evaluate(`document.querySelectorAll('.product-row').length`), 10)
check('the pager counts all 13',
      await evaluate(`document.body.innerText.includes('13')`), true)
check('a price renders',
      await evaluate(`[...document.querySelectorAll('.product-row td')].some(td => td.textContent.includes('$'))`), true)

await settleImages('img.thumb')
check('every thumbnail decoded',
      await evaluate(`[...document.querySelectorAll('img.thumb')].filter(i => i.naturalWidth > 0).length`),
      n => n === 10)
check('a retired product is pilled',
      await evaluate(`[...document.querySelectorAll('.product-row')].some(r => r.textContent.includes('retired'))`), true)
check('an out-of-stock family is pilled',
      await evaluate(`[...document.querySelectorAll('.product-row')].some(r => r.textContent.includes('out of stock'))`), true)

console.log('\n  catalogue — one product')

await goto('/products/1/', 'table.grid tbody tr', 4)

await settleImages('img.hero, .swatch img')
check('hero photograph decoded',
      await evaluate(`(document.querySelector('img.hero')?.naturalWidth ?? 0) > 0`), true)
check('four colourway swatches',
      await evaluate(`document.querySelectorAll('.swatch').length`), 4)
check('every swatch decoded',
      await evaluate(`[...document.querySelectorAll('.swatch img')].every(i => i.naturalWidth > 0)`), true)
check('variant grid is 4 colours x 3 sizes',
      await evaluate(`[document.querySelectorAll('table.grid tbody tr').length,
                       document.querySelectorAll('table.grid thead th').length - 1]`), [4, 3])
check('sizes are in enum order, not alphabetical',
      await evaluate(`[...document.querySelectorAll('table.grid thead th')].slice(1).map(th => th.textContent.trim())`),
      ['s', 'm', 'l'])
check('the empty colourway says sold out',
      await evaluate(`[...document.querySelectorAll('table.grid tbody tr')]
        .find(r => r.textContent.includes('Olive'))?.textContent.includes('sold out')`), true)
check('twelve SKUs on screen',
      await evaluate(`[...document.querySelectorAll('table.grid tbody td')].filter(td => /FJS-TEE-/.test(td.textContent)).length`), 12)

// A swatch is a real control, not a decorated div — clicking it changes the hero.
//
// Whichever swatch is NOT already chosen. The buy box picks a colourway on
// load — the first one with stock — and it also owns the hero, so naming a
// colour here would assert nothing on the run where that colour is the
// default.
const before = await evaluate(`document.querySelector('img.hero')?.src ?? ''`)
await evaluate(`([...document.querySelectorAll('.swatch')]
  .find(b => b.getAttribute('aria-pressed') !== 'true')?.click(), true)`)
await new Promise(r => setTimeout(r, 400))
const after = await evaluate(`document.querySelector('img.hero')?.src ?? ''`)
check('clicking a swatch swaps the hero', before !== after && after.length > 0, true)

// ─── a photograph, put there by a person ──────────────────────────────────
//
// Everything above reads photographs the SEEDER wrote, and the seeder hands
// litestone a path on disk. This is the other direction and it is the one a
// shop actually does: somebody chooses a file in a browser and the shelf has a
// picture on it (`FJS-409`).
//
// The route is the ordinary one and that is the substance. A File anywhere in
// the payload turns the create into `multipart/form-data` at the client, the
// bridge merges it back into `ctx.data`, and `FileStorage` stores the bytes and
// writes the ref — so an upload is a create, through the service, with the gate
// and the row policies and `@accept` all on it. A signed URL or an upload route
// would be a second door with its own answer to who may write.

console.log('\n  catalogue — a photograph somebody uploaded')

const staffToken = (await (await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
})).json())?.token
const asStaff = { authorization: `Bearer ${staffToken}` }

const photo = readFileSync(join(ROOT, 'db/seed-media/fjs-hoodie-navy.png'))
const upload = (name, type, alt) => {
  const fd = new FormData()
  fd.append('productId', '1')
  fd.append('alt', alt)
  fd.append('position', '99')
  fd.append('file', new File([photo], name, { type }))
  return fetch(`${API}/api/product-images`, { method: 'POST', headers: asStaff, body: fd })
}

// `@@gate("0.4.4.5")` — reading a photograph is public and writing one is not.
// Asserted before the happy path, because a route that accepts a file from
// anybody is the same 201 as one that accepts it from staff.
const anon = new FormData()
anon.append('productId', '1'); anon.append('alt', 'from nobody')
anon.append('file', new File([photo], 'nobody.png', { type: 'image/png' }))
check('a stranger may not add a photograph',
      (await fetch(`${API}/api/product-images`, { method: 'POST', body: anon })).status, 401)

const made = await upload('uploaded.png', 'image/png', 'A hoodie, uploaded through a form')
const row  = await made.json()
check('staff may — and the create is multipart', made.status, 201)

// The two reads, which had disagreed. `find` resolved the stored reference into
// a public URL and `get(id)` answered the raw `{"key":…}` — so the same column
// was an <img src> in a list and a broken image on the detail screen beside it,
// and an edit form was handed the storage handle instead of the photograph
// (`FJS-541`). They are asked together here because either alone passes.
const viaGet  = await (await fetch(`${API}/api/product-images/${row.id}`, { headers: asStaff })).json()
const viaFind = (await (await fetch(`${API}/api/product-images?id=${row.id}`, { headers: asStaff })).json()).data[0]
check('the stored file reads back as a URL',        typeof viaGet.file === 'string' && viaGet.file.startsWith('http'), true)
check('…by id and in a list, identically',          viaGet.file, viaFind.file)

const served = await fetch(viaGet.file)
check('and the URL serves the bytes that went up',
      [served.status, served.headers.get('content-type'), (await served.arrayBuffer()).byteLength],
      [200, 'image/png', photo.byteLength])

// `@accept("image/png, image/jpeg, image/webp")` is a Data-boundary rule, so it
// refuses the same file the picker would have filtered out. Both halves exist
// on purpose: the dialog is a courtesy and this is the guard.
const wrong = await upload('notes.txt', 'text/plain', 'not a photograph')
check('a file the column does not accept is refused', wrong.status, 400)
check('…naming the type and the list',
      (await wrong.json()).message, m => /text\/plain/.test(m) && /image\/png/.test(m))

// ── and the same thing, done by a person ──────────────────────────────────
//
// The half no HTTP assertion reaches: that the FORM offers a file picker at
// all. Nothing on the product screen names this column — `<Form>` asks the
// resource, which read the schema — so a control that answered null would
// render a form with the photograph silently missing from it, which is what
// this feature was before today.

await goto('/products/1/', 'img.hero', 1)
await evaluate(`(localStorage.setItem('shop_token', ${JSON.stringify(staffToken)}), true)`)
await goto('/products/1/', '[data-add-photo-panel] input[type=file]', 1)

check('the generated form has a file picker',
      await evaluate(`!!document.querySelector('[data-add-photo-panel] input[type=file]')`), true)
// The list comes from `@accept` in the schema, through `x-litestone-accept`, to
// the dialog — so a person is told before choosing rather than after uploading.
check('…offering the types the schema accepts',
      await evaluate(`document.querySelector('[data-add-photo-panel] input[type=file]').accept`),
      'image/png, image/jpeg, image/webp')
check('…and an alt-text box beside it, because the column is required',
      await evaluate(`!!document.querySelector('[data-add-photo-panel] [name="alt"]')`), true)

const swatchesBefore = await evaluate(`document.querySelectorAll('.swatch').length`)

// A File cannot be put on an <input type="file"> by assignment — the list is
// read-only except through a DataTransfer, which is also what a real drop
// carries. Same door `@frontierjs/ui`'s own FileUpload spec uses.
await evaluate(`(() => {
  const dt = new DataTransfer()
  dt.items.add(new File([new Uint8Array(${JSON.stringify([...photo.subarray(0, 64)])})], 'from-the-browser.png', { type: 'image/png' }))
  document.querySelector('[data-add-photo-panel] .fjs-dropzone')
    .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  return true
})()`)
await evaluate(`(() => {
  const alt = document.querySelector('[data-add-photo-panel] [name="alt"]')
  alt.value = 'Chosen in a browser'
  alt.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
check('the chosen file previews before it is saved',
      await evaluate(`!!document.querySelector('[data-add-photo-panel] [data-file-preview]')`), true)

await evaluate(`(document.querySelector('[data-add-photo-panel] [data-add-photo]').click(), true)`)

// Asked of the API and not of the strip, because the strip is one swatch per
// COLOURWAY: a second photograph of a colour that already has one adds no
// element, so counting them answers a question about the gallery's shape rather
// than about whether anything uploaded. The row is the fact.
const ALT = 'Chosen in a browser'
const arrived = await (async () => {
  for (let i = 0; i < 60; i++) {
    const found = (await (await fetch(
      `${API}/api/product-images?alt=${encodeURIComponent(ALT)}`, { headers: asStaff })).json()).data ?? []
    if (found.length) return found[0]
    await new Promise(r => setTimeout(r, 200))
  }
  return null
})()
check('submitting the form uploads the file the browser chose', !!arrived, true)
check('…as a stored reference the API resolves to a URL',
      typeof arrived?.file === 'string' && arrived.file.startsWith('http'), true)
// `resetOnDone` — a form that keeps the file it just sent invites a second
// upload of the same photograph, and the preview is the only thing on screen
// that says whether it did.
check('…and the form is clear again, so the same file is not sent twice',
      await evaluate(`!document.querySelector('[data-add-photo-panel] [data-file-preview]')`), true)

// An <img> that is PRESENT is not an <img> that loaded — the trap this whole
// file is arranged around. The gallery reloaded after the save, so every
// photograph on screen has been read back through the service since the upload:
// a resolution that broke on the way out would show here as a swatch that is
// there and blank.
await settleImages('.swatch img')
check('…and the new photograph decoded in the browser that sent it',
      await evaluate(`[...document.querySelectorAll('.swatch img')].every(i => i.naturalWidth > 0)`), true)

// Put the catalogue back. `19 photographs seeded` above counts live rows, and
// this drive added two.
for (const stale of ((await (await fetch(`${API}/api/product-images?position=99&$limit=50`, { headers: asStaff })).json()).data ?? []))
  await fetch(`${API}/api/product-images/${stale.id}`, { method: 'DELETE', headers: asStaff })
for (const stale of ((await (await fetch(
  `${API}/api/product-images?alt=${encodeURIComponent(ALT)}&$limit=50`, { headers: asStaff })).json()).data ?? []))
  await fetch(`${API}/api/product-images/${stale.id}`, { method: 'DELETE', headers: asStaff })

console.log(`\n  ${pass} passed, ${fail} failed\n`)
stopAll()
process.exit(fail ? 1 : 0)
