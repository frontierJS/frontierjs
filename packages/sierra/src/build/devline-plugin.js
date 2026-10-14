/**
 * build/devline-plugin.js — the dev server's boot banner as one line for `fli dev`.
 *
 * `fli dev` runs this server beside the API and lays both out as one summary.
 * Under `FLI_DEV` Vite's banner (the version line and its URLs) is replaced by
 * the ready line `@frontierjs/toolbelt/devline` defines, carrying the URL and
 * what `schema-plugin.js` measured. Without the variable this plugin does
 * nothing, so `vite` run by hand prints what it always has.
 *
 * Vite prints the banner through its logger and then `server.printUrls()`, both
 * from its CLI after the server listens. The logger is replaced here because it
 * is the only handle on the first; it holds back INFO until the URLs would have
 * printed, and passes a warning or an error through at any time, since those
 * are what a person has to see.
 */

import { createLogger } from 'vite'
import { DEV_ENV, formatDevLine } from '@frontierjs/toolbelt/devline'

/**
 * @param {{ devFacts?: string[] }} sierraContext
 * @returns {import('vite').Plugin | null}
 */
export function devlinePlugin(sierraContext) {
  if (!process.env[DEV_ENV]) return null
  let ready = false

  return {
    name:  'sierra:devline',
    apply: 'serve',

    config(userConfig) {
      const inner = userConfig.customLogger
        ?? createLogger(userConfig.logLevel, { allowClearScreen: userConfig.clearScreen })
      return {
        customLogger: {
          ...inner,
          info:  (msg, opts) => { if (ready) inner.info(msg, opts) },
          warn:  (msg, opts) => inner.warn(msg, opts),
          warnOnce: (msg, opts) => inner.warnOnce(msg, opts),
          error: (msg, opts) => inner.error(msg, opts),
          clearScreen: () => {},
          hasErrorLogged: (e) => inner.hasErrorLogged(e),
          get hasWarned() { return inner.hasWarned },
        },
      }
    },

    configureServer(server) {
      server.printUrls = () => {
        const urls = server.resolvedUrls ?? { local: [], network: [] }
        console.log(formatDevLine({ ready: {
          ...(urls.local[0] && { url: urls.local[0] }),
          rows: [{
            name:  'Sierra',
            facts: [
              ...(sierraContext.devFacts ?? []),
              // `--host` asks for a phone on the LAN, so where it reaches is the answer.
              ...urls.network.map(u => `network ${u}`),
            ],
          }],
        } }))
        ready = true
      }
    },
  }
}
