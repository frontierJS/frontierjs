/*
 * tests/browser/run.mjs — the GUI's front page, opened.
 *
 * `fli gui` is 1,700 lines of page and `tests/server.test.js` covers the API
 * under it, so until this file the page itself had never been rendered by
 * anything. A dashboard is the worst thing to leave that way: every row on it
 * is a claim about a real process, and a row that renders as nothing looks
 * exactly like a project with nothing in it.
 *
 * ── What is here and what is in mesa ──────────────────────────────────
 *
 * Chrome, the CDP protocol and the spec runner are `mesa/test/browser/drive.mjs`,
 * read by RELATIVE path for the reason `@frontierjs/ui`'s drive states: a
 * workspace dep resolves to a copy under `node_modules/.bun/`, so a by-name
 * import would drive an install-time snapshot. What is left here is what makes
 * it THIS drive — the server, and the workspace it is pointed at.
 *
 * Run it against the repo itself rather than a fixture, because the readers are
 * already covered over a fixture in `tests/runnables.test.js` and what this
 * cannot answer from a fixture is whether the real thing has any rows at all.
 */
import { fileURLToPath } from 'node:url'
import { join, resolve }  from 'node:path'
import { runSpecs, dim }  from '../../../mesa/test/browser/drive.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI  = resolve(HERE, '../..')
const REPO = resolve(CLI, '../..')

const argv      = process.argv.slice(2)
const serveOnly = argv.includes('--serve')
const verbose   = argv.includes('--verbose')
const filters   = argv.filter(a => !a.startsWith('--'))

// The server reads both of these off globals. `projectRoot` is the workspace,
// which is what a person running `fli gui` from the repo root would get.
global.fliRoot     = CLI
global.projectRoot = REPO

// 7500 is the tooling slot on the TEST tier, so a drive cannot collide with a
// `fli gui` somebody has open on 8500 while they run it.
const PORT = process.env.FLI_GUI_TEST_PORT ?? '7500'
process.env.FLI_PORT = PORT
const origin = `http://localhost:${PORT}`

const { startServer } = await import('../../core/server.js')
const server = startServer()
await new Promise((ok, no) => { server.once('listening', ok); server.once('error', no) })

if (serveOnly) {
  console.log(`fli gui served at ${origin}`)
  console.log(dim('the front page is the dashboard; the sidebar is the command registry'))
} else {
  const { infra, failures } = await runSpecs({
    origin,
    specDir: join(HERE, 'specs'),
    filters,
    verbose,
    // The page fetches its inventory before it can draw a row, so waiting on
    // load alone races the first paint against an empty container.
    ready: `document.querySelectorAll('#dash-groups section').length > 0`,
  })

  server.close()
  process.exit(failures || infra ? 1 : 0)
}
