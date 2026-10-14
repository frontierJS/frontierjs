/**
 * mcp/index.js — the runtime inside an MCP App view.
 *
 * A view is one HTML document the agent's host runs in a sandboxed iframe —
 * no network of its own, every call out through the host as `tools/call`
 * (`IDEAS/agent-client-ui.md` § The wire). `build/mcp-build.js` writes a boot
 * and an entry per resource file; both import this module, and nothing else
 * in an app does. The widget runtime (`widget/index.js`) is the same shape one
 * surface over: a page this app does not own, a generated entry, one runtime.
 *
 * What is here today is the mount, the pick of a file's Resource for the
 * form the build generates over a file with no markup half, and the host's
 * context applied to the document. The relay client
 * — `mcpApp()`, the handle `harborApp()` answers for an extension page — is
 * step 3.1 of the plan, and until it lands the boot refuses by name below
 * rather than mounting a view whose every call would fail somewhere a console
 * does not show.
 */

import { mount }     from '@frontierjs/mesa/runtime'
import { setScheme } from '../theme/index.js'

/**
 * The page's client, relayed through the host — `{ client, registry, user }`,
 * the handle `createResource(name, { app })` takes.
 *
 * Not built. Plan step 3.1 (`IDEAS/agent-client-ui.md`): `createJunctionClient({ relay })`
 * where `relay` turns a call into a `tools/call` request to `window.parent`,
 * installed as the page's own client so a resource file naming no `app` reaches it.
 */
export function mcpApp() {
  throw new Error(
    '[sierra/mcp] mcpApp() is not built — the relay to the host is step 3.1 of ' +
    'IDEAS/agent-client-ui.md. The document was built, and nothing in it can call the app yet.'
  )
}

/**
 * The Resource a resource file exports.
 *
 * A resource file exports it under the SERVICE's name (`export const orders`),
 * which the build does not know and does not scan for: the module is already
 * loaded by the time the generated form runs, so the real object is read
 * rather than its declaration. It is known by the two methods `<Form>` calls
 * on it. One Resource per file is Invariant 19, so two is refused rather than
 * picked between — two NAMES for one object is one Resource, since a file may
 * alias its export — and none is refused by name: a form over nothing would
 * render empty in a sandbox no console shows.
 *
 * @param {Record<string, unknown>} module  `import * as Resource from '<file>'`
 * @param {string} name                      the file's name, for the message
 */
export function resourceIn(module, name) {
  const found = []
  for (const [key, v] of Object.entries(module)) {
    if (!v || typeof v !== 'object' || typeof v.save !== 'function' || typeof v.formFields !== 'function') continue
    const seen = found.find(f => f[1] === v)
    if (seen) seen[0] += `/${key}`
    else found.push([key, v])
  }
  if (found.length === 1) return found[0][1]
  if (found.length === 0) {
    throw new Error(`[sierra/mcp] ${name}.mesa exports no Resource — a view is a form over createResource(), and nothing in the file's <script module> is one.`)
  }
  throw new Error(
    `[sierra/mcp] ${name}.mesa exports ${found.length} Resources (${found.map(([k]) => k).join(', ')}) — ` +
    `one Resource per file (Invariant 19), so the view cannot say which one its form is over.`
  )
}

/**
 * Apply what the host says about its environment.
 *
 * `ctx` is the spec's `McpUiHostContext` — the whole of it on
 * `ui/initialize`'s answer, and on `ui/notifications/host-context-changed`
 * ONLY the fields that changed, so a key that is absent is a key that is as
 * it was, and nothing is reset for it. What is read today is `theme`, the
 * host's `'light' | 'dark'`, handed to Sierra's switch as the scheme: the
 * switch owns the class on `<html>` (Bridge index) and maps the word onto the
 * pair the app declared, which the boot initialized it with. The host's style
 * variables are later work (plan § Phase 5).
 *
 * @param {{ theme?: 'light'|'dark' } & Record<string, unknown>} ctx
 */
export function applyHostContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return
  if ('theme' in ctx) setScheme(ctx.theme)
}

/**
 * Mount a view into the document.
 *
 * The anchor is a comment appended to `<body>`, which is what the document
 * the build wrote has an empty one of. The handshake that seeds the record
 * and reports the size (plan step 3.3) wraps this; the mount itself is Mesa's.
 *
 * @param {Function} View            the resource file's compiled default export
 * @param {{ name?: string, props?: object }} [options]
 * @returns {{ $dom: Node, find: (sel: string) => Element|null, destroy: () => void }}
 */
export function mountView(View, { name = 'view', props = {} } = {}) {
  const label = document.createComment(`view:${name}`)
  document.body.appendChild(label)
  return mount(label, View, { props })
}
