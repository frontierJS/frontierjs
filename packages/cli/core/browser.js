// ─── browser.js — a page, opened, for something to be asked of it ────────────
//
// The tutorial teaches Data, API and Deployment by asking the running world.
// The UI realm had no way to be asked at all: every assertion in every lesson
// is HTTP or a file, so a person finishes the course having never seen a form
// render. This is what lets a lesson open one.
//
// The browser is `@frontierjs/mesa/drive`, the one every drive shares
// (`FJS-D554`): the launch, the temp profile and its sweep, and the collected
// errors are its. What stays here is the shape a lesson asks in — an
// EXPRESSION that answers a value, where the driver evaluates a function body —
// and the one retry a lesson needs and a drive must not have.
//
// A lesson asks `findChrome()` before it opens anything, because no Chrome is a
// SKIP, a fact about the machine rather than about the app.

import { openChrome, findChrome } from '@frontierjs/mesa/drive'

export { findChrome }

/**
 * Open one page and hand back what a probe needs.
 *
 *   eval(expr)   evaluate in the page, awaited, answered as JSON
 *   errors       everything the page threw or logged as an error, live
 *   close()      stop Chrome and remove the profile
 *
 * Throws with a sentence naming the fix when there is no Chrome.
 */
export async function openPage({ url, windowSize = '1280,900' } = {}) {
  const browser = await openChrome({ windowSize })

  const page = {
    errors: browser.errors,
    goto: (to) => browser.navigate(to),
    /** Evaluate in the page and answer the VALUE, so a probe writes
     *  `await page.eval('document.querySelectorAll("input").length')` and gets
     *  a number. */
    async eval(expr) {
      // A navigation destroys the execution context, and a form flow navigates
      // by design — a sign-in, a save that goes to the record it just made. The
      // evaluate that lands in that window fails about the CONTEXT rather than
      // about the page, which reads to a caller as the assertion being wrong.
      // Retried once, and only for that: any other throw is the page's. It is
      // not the driver's, because a drive's evaluate may be the click that
      // navigated, and running that twice submits twice.
      for (let attempt = 0; ; attempt++) {
        try {
          return await browser.evaluate(`return (${expr})`)
        } catch (e) {
          const stale = /navigated or closed|context was destroyed|Cannot find context/i.test(e.message)
          if (!stale || attempt > 0) throw e
          await new Promise(r => setTimeout(r, 300))
        }
      }
    },
    close: () => browser.close(),
  }

  if (url) await page.goto(url)
  return page
}
