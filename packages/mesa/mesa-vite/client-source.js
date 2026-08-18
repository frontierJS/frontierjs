/**
 * mesa-vite/client-source — the HMR client as ONE module's worth of source.
 *
 * A Vite plugin serves the client at a virtual id, which means it hands Vite a
 * STRING rather than a path — and a relative import inside that string resolves
 * against nothing. The client is two files (`client.js` holds the registry and
 * Vite's side of the handshake, `swap.js` holds the DOM swap jetty performs
 * too), so a plugin has to be given them already joined.
 *
 * Two plugins serve this client — this package's and Sierra's, each at an id of
 * its own (`FJS-D16`) — so the joining lives here rather than in either of
 * them. Sierra reaches it by path, the way it reaches the compiler.
 *
 * Fails closed. If the shape it edits stops matching, the alternative is a
 * client that silently ships an unresolvable import and puts every component on
 * the full-reload path with no error.
 */
import fs   from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// `import.meta.url` as a STRING, not through `new URL` — happy-dom installs its
// own global `URL` and `fileURLToPath` refuses an instance of it, which is how
// this spelling fails in a vitest environment against a path that is fine in a
// real dev server.
const HERE = path.dirname(fileURLToPath(import.meta.url))

const SWAP_IMPORT = "import { swapInstances } from './swap.js'"

/**
 * @returns {string} `swap.js` inlined ahead of `client.js`, with the import
 *          between them removed and `swapInstances` left as a local binding.
 */
export function hmrClientSource() {
  const swap   = fs.readFileSync(path.join(HERE, 'swap.js'),   'utf8')
  const client = fs.readFileSync(path.join(HERE, 'client.js'), 'utf8')

  if (!client.includes(SWAP_IMPORT))
    throw new Error(`[mesa] client.js no longer imports swapInstances as "${SWAP_IMPORT}" — the HMR client cannot be assembled`)

  const inlined = swap.replace('export function swapInstances', 'function swapInstances')
  if (inlined === swap)
    throw new Error('[mesa] swap.js no longer exports swapInstances — the HMR client cannot be assembled')

  return inlined + '\n' + client.replace(SWAP_IMPORT, '')
}
