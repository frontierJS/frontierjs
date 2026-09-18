// web/test/lib/offline.mjs — put a real browser on a real dead network.
//
// The Homestead work (`IDEAS/homestead.md`) is a series of claims about what an
// app does with no server reachable, and every one of them is easy to prove
// against a stub and wrong in a stockroom. A test that swaps `fetch` for a
// throwing function proves that the code under it handles a throwing function.
// It does not drop the WebSocket, it does not fail a request that was already
// in flight, and it does not survive the reconnect — which is where the defects
// are. *Fake clients hide real bugs* is the house rule and offline is the case
// it was written for.
//
// So this is Chrome's own offline mode, the one the DevTools network panel
// switches, driven over CDP.
//
// ── What has to be true for it to work ──────────────────────────────────────
//
//   · `Network.enable` first, on the SAME session. Without it the emulate call
//     comes back as an error rather than doing nothing, which at least says so.
//   · The emulation is per TARGET. A drive that opens a second tab has put one
//     tab offline and left the other on the network, and the two will disagree
//     about what the app can reach.
//   · `latency` and the two throughputs are not optional. Omitting them is a
//     protocol error, and `-1` is how the throughputs mean "no limit" on the
//     way back.
//   · **It does not close a socket that is already open.** New connections are
//     refused; an existing one keeps carrying frames, so an app whose client
//     holds one is still talking to its server while the page is being told it
//     is offline. That is the one arrangement that reads green and means
//     nothing. Going offline here is therefore two things: the emulation, and
//     severing the sockets the page opened, through a registry installed with
//     `Page.addScriptToEvaluateOnNewDocument` so it is in place before the
//     client builds its own.
//

//     Severing is harsher than a real outage, which leaves a socket that still
//     looks open and swallows a send until a timeout. The harsher case is the
//     one a queue has to handle first; the silent-swallow case is a latency
//     emulation rather than an offline one, and it is worth its own assertion.
//
//   · **It is not a page-wide off switch.** Vite's HMR client holds a socket of
//     its own and reloads the page when it closes — with the network down that
//     reload lands on Chrome's ERR_INTERNET_DISCONNECTED screen and the app is
//     gone mid-assertion. It is told apart by its SUBPROTOCOL, `vite-hmr`, and
//     not by its origin: a dev server that proxies the API — which is what a
//     scaffold writes, and what `example` does — puts the app's own socket on
//     the page's origin too, so an origin rule skips the one socket that
//     matters and reports that there was nothing to cut.
//
// ── The half that is not the CDP call ───────────────────────────────────────
//
// Coming back online is not one moment. The page's `fetch` works again as soon
// as the emulation is lifted, but the Junction client's WebSocket was dropped
// when the network went, and it reconnects on its own backoff — so a drive that
// asserts the instant `goOnline()` resolves is asking a client that is still
// down. `waitOnline` is therefore part of this module and not left to each
// caller: it waits for the browser to agree (`navigator.onLine`) and then for
// the app's own socket, which is the signal that actually matters.
//
// A service worker has its own network and is not covered by this. That is
// phase 3's problem and it is written here so phase 3 does not discover it.

const OFFLINE = { offline: true,  latency: 0, downloadThroughput: 0,  uploadThroughput: 0 }
const ONLINE  = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }

/**
 * The network controls for one attached CDP session.
 *
 * `send` and `sessionId` are the drive's own — every drive in this directory
 * builds them the same way, and passing them in keeps this module free of a
 * second opinion about how Chrome is reached.
 *
 *   const net = await createNetwork(send, sessionId, evaluate)
 *   await net.withOffline(async () => { … })   // restores even on a throw
 */
export async function createNetwork(send, sessionId, evaluate) {
  await send('Network.enable', {}, sessionId)

  // How many sockets the last going-offline actually cut. It is the difference
  // between *the app's connection is down* and *this page never had one*, and
  // without it `waitOnline` waits out its whole budget on a page that opens no
  // socket at all — a 30-second red with nothing wrong.
  let lastSevered = 0

  // Before the app's first script runs, so the client's own socket is caught.
  // A Proxy rather than a subclass: `instanceof WebSocket` keeps working and
  // the static constants still read through.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        const Native = WebSocket
        const open = new Set()
        globalThis.__fjsSockets = open
        globalThis.WebSocket = new Proxy(Native, {
          construct(target, args) {
            const sock = new target(...args)
            // The subprotocol is the only reliable way to tell vite's own
            // socket from the app's: both are same-origin whenever the dev
            // server proxies the API, which is the default a scaffold writes.
            const protos = [].concat(args[1] ?? [])
            sock.__fjsVite = protos.includes('vite-hmr')
            open.add(sock)
            sock.addEventListener('close', () => open.delete(sock))
            return sock
          },
        })
      })()
    `,
  }, sessionId)

  const emulate = async (conditions) => {
    const r = await send('Network.emulateNetworkConditions', conditions, sessionId)
    if (r?.error) throw new Error(`Network.emulateNetworkConditions: ${JSON.stringify(r.error)}`)
  }

  /**
   * Close the sockets the APP opened, and answer how many there were.
   *
   * Cross-origin only, which is not a refinement — it is what makes the drive
   * stable. Vite's HMR client holds a socket to the page's own origin, and it
   * reloads the page when that socket closes; with the network emulated down
   * the reload lands on Chrome's ERR_INTERNET_DISCONNECTED screen and the app
   * is gone mid-assertion. Junction's socket is on the API's origin, which is
   * the one worth cutting. In a deployment where the API is same-origin this
   * rule would cut nothing, and the drive would have to name the origin
   * instead; in dev they are two ports and this is exact.
   */
  const severSockets = () => evaluate(`
    (() => {
      const open = globalThis.__fjsSockets
      if (!open) return null
      let n = 0
      for (const s of [...open]) {
        if (s.__fjsVite) continue
        if (s.readyState === 0 || s.readyState === 1) { n++; s.close(4000, 'verify: offline') }
        open.delete(s)
      }
      return n
    })()
  `)

  /**
   * Is the app's connection back up?
   *
   * Asked of the registry rather than of anything the app renders. A status
   * attribute on a screen is an app's choice and most do not make it, so a
   * check against one is a wait that silently never waits — which is how the
   * positive control below came to run against a client still inside its
   * reconnect backoff, and fail for a reason that was not the app's.
   */
  const socketUp = () => evaluate(`
    (() => {
      const open = globalThis.__fjsSockets
      if (!open) return null
      let any = false
      for (const s of open) {
        if (s.__fjsVite) continue
        any = true
        if (s.readyState === 1) return true
      }
      return any ? false : null
    })()
  `)

  /**
   * Wait for the network, and by default for the app's socket to come back
   * with it — they are not the same moment, and the gap is a reconnect backoff.
   */
  async function waitOnline({ tries = 120, socket = true } = {}) {
    // Nothing was cut, so there is no reconnect to wait for. A page that opens
    // its socket lazily — after sign-in, or on the first subscription — is the
    // ordinary case, not a failure.
    const wantSocket = socket && lastSevered > 0
    for (let i = 0; i < tries; i++) {
      if (await evaluate('navigator.onLine')) {
        if (!wantSocket) return true
        const ws = await socketUp()
        // Null is a page with no registry — nothing to wait for. False is a
        // socket that has not come back yet, which is what to wait for.
        if (ws === null || ws === true) return true
      }
      await new Promise(r => setTimeout(r, 250))
    }
    return false
  }

  return {
    /**
     * Chrome refuses new connections AND the page's open sockets are closed.
     * Answers how many sockets it severed — null when the registry is absent,
     * which means the page loaded before it was installed.
     */
    async goOffline() {
      await emulate(OFFLINE)
      lastSevered = (await severSockets()) ?? 0
      return lastSevered
    },

    /** Lift it. The page can reach the network again; its socket may not be back yet. */
    goOnline: () => emulate(ONLINE),

    waitOnline,

    /** How many sockets the last going-offline cut. */
    get severed() { return lastSevered },

    /**
     * Run `fn` with the network down, and put it back whatever happens.
     *
     * The restore is in a `finally` because a failed assertion inside the block
     * would otherwise leave every later assertion in the drive running against
     * a dead network, and they would all fail for a reason that is not theirs.
     */
    /**
     * `sever: false` emulates the network down and leaves the app's socket
     * open, which is what a real outage looks like for its first seconds — the
     * peer has not noticed yet. It is a WEAKER outage, and the difference
     * between the two is worth asserting rather than choosing between.
     */
    async withOffline(fn, { sever = true } = {}) {
      await emulate(OFFLINE)
      lastSevered = sever ? ((await severSockets()) ?? 0) : 0
      try { return await fn() }
      finally { await emulate(ONLINE) }
    },
  }
}
