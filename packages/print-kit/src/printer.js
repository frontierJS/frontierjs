/*
 * printer.js — one headless Chromium behind one seam (transit PLAN Q7, DL R5, R6; moved here by FJS-D816).
 *
 * `createPrinter()` answers `{ pdf, png, close }`: an HTML document in, a PDF or
 * a PNG of one element out. It drives Chrome through `@frontierjs/mesa/drive`
 * (`FJS-D554`), so there is one Chrome driver in the framework and this adds no
 * dependency.
 *
 * ── What a print page may do ──────────────────────────────────────────
 *
 * The document is built from LANDED data, which is somebody else's: a
 * customer name, a product note, a URL in a description. So the page the
 * printer loads it into is shut off from everything it could reach:
 *
 *   - offline (`createNetwork`), so an <img src="http://…"> in landed data
 *     cannot make the server fetch anything — an internal address included.
 *     Every refused request is counted in `stats().blocked`;
 *   - no page scripts, so a <script> that got past an escape runs nowhere.
 *     The driver's own `evaluate` still works: CDP is not the page;
 *   - loaded with `Page.setDocumentContent`, never navigated to a URL, so there
 *     is no origin to share storage or cookies with.
 *
 * A `data:` URL is not a request and still loads, which is how a chart PNG or
 * an inlined font reaches the page.
 *
 * ── One browser, one job at a time, a tab per job ─────────────────────
 *
 * Jobs are queued, and run in a tab that is replaced every 25 jobs (see
 * `inTab`). Chrome is launched on the first job (cold) and kept (warm)
 * until `close()`: an app that never prints never starts it.
 */
import { createNetwork, findChrome, openChrome } from '@frontierjs/mesa/drive'

/** @param {{ windowSize?: string, find?: () => string | null }} [opts] */
export function createPrinter({ windowSize = '1280,900', find = findChrome } = {}) {
  /** @type {any} */
  let browser = null
  /** @type {Promise<any> | null} */
  let starting = null
  let tail = Promise.resolve()
  let closed = false

  const counts = { launches: 0, jobs: 0, blocked: 0, coldMs: 0 }

  async function launch() {
    const t = performance.now()
    const b = await openChrome({ windowSize })
    // Heard on the browser's one socket, from every job's tab.
    b.on('Network.loadingFailed', (/** @type {{ errorText?: string }} */ p) => {
      if (p.errorText === 'net::ERR_INTERNET_DISCONNECTED') counts.blocked++
    })
    counts.launches++
    counts.coldMs = Math.round(performance.now() - t)
    return b
  }

  /**
   * The tab jobs run in, shut off before anything is put in it, and replaced
   * every `TAB_JOBS` jobs. One tab kept for ever held something of every job
   * in its renderer, however it was emptied — about 5 MB a PDF, 1 GB after
   * two hundred, measured — and a closed tab takes its renderer's memory with
   * it. A tab per job held Chrome flat but cost ~100 ms a print to set up;
   * replacing it every 25 bounds the growth and spends that once per 25.
   * The offline emulation and the script ban are per tab, so each gets both.
   */
  const TAB_JOBS = 25
  /** @type {{ targetId: string, page: any, jobs: number } | null} */
  let tab = null

  async function closeTab(/** @type {any} */ b) {
    const t = tab
    tab = null
    if (t) await b.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {})
  }

  async function freshTab(/** @type {any} */ b) {
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' })
    try {
      const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true })
      const cmd = (/** @type {string} */ method, /** @type {object} */ params) => b.send(method, params, sessionId)
      const evaluate = async (/** @type {string} */ expression) => {
        const r = await cmd('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        return r.result.value
      }
      const page = { cmd, evaluate }
      await cmd('Page.enable')
      const net = await createNetwork(page)
      await net.goOffline()
      await cmd('Emulation.setScriptExecutionDisabled', { value: true })
      await cmd('DOM.enable')
      return { targetId, page, jobs: 0 }
    } catch (e) {
      await b.send('Target.closeTarget', { targetId }).catch(() => {})
      throw e
    }
  }

  async function inTab(/** @type {any} */ b, /** @type {(page: any) => Promise<any>} */ fn) {
    if (tab && tab.jobs >= TAB_JOBS) await closeTab(b)
    tab ??= await freshTab(b)
    tab.jobs++
    try { return await fn(tab.page) }
    catch (e) { await closeTab(b); throw e }   // a job that failed leaves no tab in a state the next one inherits
  }

  async function ensure() {
    if (closed) throw new Error('printer: closed — create another to print again')
    if (browser) return browser
    starting ??= launch().finally(() => { starting = null })
    browser = await starting
    return browser
  }

  // A crashed or wedged renderer answers nothing, ever again. Drop the
  // browser so the next job starts a fresh one rather than queueing behind it.
  async function discard() {
    const b = browser
    browser = null
    tab = null
    if (b) await b.close().catch(() => {})
  }

  /** @template T @param {(page: any) => Promise<T>} job @returns {Promise<T>} */
  function enqueue(job) {
    const run = tail.then(async () => {
      const b = await ensure()
      try { return await inTab(b, job) }
      catch (e) {
        if (/did not answer|WebSocket|not open/i.test(String(/** @type {Error} */ (e)?.message))) await discard()
        throw e
      }
      finally { counts.jobs++ }
    })
    tail = run.then(() => {}, () => {})
    return run
  }

  /** Put `html` in the page and wait for what it draws with: fonts and images
   *  that are data: URLs, and the refusal of any that are not. */
  async function load(/** @type {any} */ b, /** @type {string} */ html) {
    const { frameTree } = await b.cmd('Page.getFrameTree')
    await b.cmd('Page.setDocumentContent', { frameId: frameTree.frame.id, html })
    await b.evaluate(`
      await document.fonts.ready;
      await Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r })));
      return true;
    `)
  }

  const bytes = (/** @type {string} */ base64) => new Uint8Array(Buffer.from(base64, 'base64'))

  return {
    /** The Chrome this printer would launch, or null. Asking launches nothing. */
    available: () => find(),

    /** A PDF of `html`. Its size, margins and margin boxes are the document's
     *  own `@page` rules (`preferCSSPageSize`), so the template decides them. */
    pdf(/** @type {string} */ html, { landscape = false } = {}) {
      return enqueue(async (b) => {
        await load(b, html)
        const r = await b.cmd('Page.printToPDF', {
          printBackground: true, preferCSSPageSize: true, landscape,
          displayHeaderFooter: false, generateTaggedPDF: true,
        })
        return bytes(r.data)
      })
    },

    /** A PNG of the first element `selector` matches, at `scale` device pixels
     *  per CSS pixel — 2 is sharp on a phone, which is where most email is read. */
    png(/** @type {string} */ html, { selector = 'body', scale = 2, width = 0 } = {}) {
      return enqueue(async (b) => {
        if (width) await b.cmd('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
        try {
          await load(b, html)
          const { root } = await b.cmd('DOM.getDocument', {})
          const { nodeId } = await b.cmd('DOM.querySelector', { nodeId: root.nodeId, selector })
          if (!nodeId) throw new Error(`printer.png: nothing in the document matches ${selector}`)
          const { model } = await b.cmd('DOM.getBoxModel', { nodeId })
          const [x1, y1, x2, , , y3] = model.border
          const r = await b.cmd('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: true,
            clip: { x: x1, y: y1, width: x2 - x1, height: y3 - y1, scale },
          })
          return bytes(r.data)
        } finally {
          if (width) await b.cmd('Emulation.clearDeviceMetricsOverride')
        }
      })
    },

    /** What this printer has done: launches, jobs, refused requests, and how
     *  long the last launch took (the cold cost a first print pays). */
    stats: () => ({ ...counts, running: !!browser }),

    /** Finish the queued jobs, then stop Chrome. */
    async close() {
      closed = true
      await tail
      if (starting) await starting.catch(() => {})
      await discard()
    },
  }
}

/** The printer as a junction plugin, without importing junction: the app
 *  claims it as `app.printer`. With no Chrome on the machine the app refuses
 *  to boot, by name — not at the first send, hours later, to a recipient. */
export function printerPlugin(/** @type {Parameters<typeof createPrinter>[0]} */ opts) {
  const printer = createPrinter(opts)
  return {
    name: 'printer',
    register(/** @type {{ claim(name: string, value: unknown): void }} */ app) { app.claim('printer', printer) },
    boot() {
      if (!printer.available())
        throw new Error(process.env.FJS_CHROME
          ? `printer: $FJS_CHROME names ${process.env.FJS_CHROME} and there is no such binary`
          : 'printer: no Chrome on this machine — install Chrome or Chromium, or point $FJS_CHROME at a binary')
    },
    async shutdown() { await printer.close() },
  }
}
