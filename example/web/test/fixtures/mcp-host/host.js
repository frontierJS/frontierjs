/*
 * fixtures/mcp-host/host.js — the host page `verify-mcp-view.mjs` serves.
 *
 * ext-apps' own `AppBridge`, bundled by the drive at start: the reference host
 * the view's hand-written channel (`packages/sierra/src/mcp/host.js`) is graded
 * against, since a fake host written here would agree with the view wherever
 * both read the spec the same wrong way. Built with NO MCP client, so it
 * answers `ui/initialize` itself, `tools/call` through the handler below, and
 * every other request `-32601`.
 *
 * `tools/call` goes to this page's own origin, where the drive holds the MCP
 * session — a host's server, not its sandbox, is what speaks to the app.
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'

const seen = { sent: [], calls: [], sizes: [], initialized: false }
window.__host = seen

const { view, result, args, hostContext } = await (await fetch('/session')).json()

const frame = document.createElement('iframe')
frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
frame.style.cssText = 'width: 720px; height: 120px; border: 0'
frame.src = view
document.body.append(frame)

// What the view sends, by method, before the bridge reads it. A response to a
// host request has no method and is counted as one.
window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow) return
  const m = e.data
  seen.sent.push(typeof m?.method === 'string' ? m.method : 'response')
})

const bridge = new AppBridge(null, { name: 'verify-mcp-view', version: '1.0.0' }, { serverTools: {} }, { hostContext })

bridge.oncalltool = async (params) => {
  seen.calls.push(params)
  const res = await fetch('/call', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
  })
  return res.json()
}
bridge.onsizechange = ({ width, height }) => {
  seen.sizes.push({ width, height })
  if (height) frame.style.height = `${height}px`
}
bridge.oninitialized = async () => {
  seen.initialized = true
  await bridge.sendToolInput({ arguments: args })
  await bridge.sendToolResult(result)
}

// Connected before the frame's document runs: the view's `ui/initialize` is
// its first statement, and a bridge listening late never hears it.
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow))
window.__bridge = bridge
