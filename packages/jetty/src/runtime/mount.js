// mount.js — Mesa component mount helper.
//
// Calls into the real Mesa runtime when @frontierjs/mesa/runtime is available.
// Mesa exports its own `mount(label, component, options)` — we delegate to it
// and let Mesa handle block creation, anchor placement, and delegation.
//
// Resolution: Mesa is an optional peer dep. The dynamic import below lets
// Vite bundle Mesa into consumer chunks when it's installed. Without it a
// function app is refused by name; a { render } stub or a string never needs it.
//
// IMPORTANT — no /* @vite-ignore */ comment here. With @vite-ignore, Vite
// leaves the import as-is for runtime resolution; in a browser/extension
// context, bare specifiers can't be resolved at runtime, so the import
// always fails and the stub fallback runs even when Mesa is installed.
// Without @vite-ignore, Vite resolves the specifier at build time, bundles
// the runtime into the consumer chunk, and the import succeeds.
//
// When Mesa isn't installed, the build fails at this line with a clear
// "could not resolve" error. To prevent that for jetty's own dev/test
// where Mesa isn't installed, jetty's mesa-plugin.js detects Mesa absence
// and the test fixtures use { render } stubs that never need Mesa.
//
// Mesa's compiled component shape:
//   export default function Component(__anchor, __props) { ... }
//
// Mesa's mount API:
//   mount(labelNode, component, { props, root }) — labelNode is a DOM node,
//   anchor is inserted after it. Returns { $dom, find, destroy }.

let _runtime = null
let _runtimeWarned = false

async function loadRuntime() {
  if (_runtime !== null) return _runtime
  try {
    _runtime = await import('@frontierjs/mesa/runtime')
  } catch (err) {
    _runtime = false
    if (!_runtimeWarned) {
      console.warn(
        '[jetty] @frontierjs/mesa/runtime not available — a function app cannot mount. ' +
        'Install @frontierjs/mesa for compiled components. ' +
        '(error: ' + (err?.message ?? 'unknown') + ')'
      )
      _runtimeWarned = true
    }
  }
  return _runtime
}

/**
 * Mount an app into a DOM root. The shape decides the mounter, never the arity:
 *   - a function is ALWAYS a compiled Mesa component, mounted by Mesa
 *   - `{ render(root, props) }` is a stub and receives the real root
 *   - a string is set as the root's HTML
 *
 * A function when Mesa's runtime is missing is refused by name. Calling it with
 * the root instead would hand a compiled component the wrong first argument
 * and fail somewhere that names neither.
 *
 * @param {Element|ShadowRoot} root — DOM container receiving the component
 * @param {Function|{ render: Function }|string} app — compiled Mesa component or stub
 * @param {object} [props] — props passed to the component
 * @returns {Promise<{ destroy?: () => void }>}
 */
export async function mountInto(root, app, props = {}) {
  if (app == null) {
    root.textContent = '[jetty] no app provided'
    return {}
  }

  if (typeof app === 'function') {
    const runtime = await loadRuntime()
    if (runtime && typeof runtime.mount === 'function') {
      return mountWithMesa(root, app, props, runtime)
    }
    const msg = '[jetty] a function `app` is a compiled Mesa component and needs @frontierjs/mesa; ' +
                'a stub is `{ render(root, props) }`'
    console.error(msg)
    root.textContent = msg
    return {}
  }

  return mountStub(root, app, props)
}

function mountWithMesa(root, Component, props, runtime) {
  // Mesa's mount() takes a "label" node (an existing DOM node) and inserts
  // its anchor comment AFTER that label. We need to give it something whose
  // parentNode is our root. Easiest: create a placeholder text node and
  // insert it as the only child of root.
  const label = document.createTextNode('')
  root.appendChild(label)

  try {
    const handle = runtime.mount(label, Component, {
      props,
      // Pass shadow root if root IS a shadow root — Mesa scopes styles + delegation there.
      root: (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) ? root : undefined,
    })
    return {
      destroy() {
        try { handle?.destroy?.() } catch (e) { console.warn('[jetty] mesa destroy threw', e) }
        try { label.remove() } catch {}
        // Clear any remaining DOM Mesa appended
        while (root.firstChild) root.removeChild(root.firstChild)
      },
    }
  } catch (err) {
    console.error('[jetty] Mesa mount failed:', err)
    root.textContent = `[jetty] mount error: ${err.message}`
    return { destroy: () => {} }
  }
}

// --- stub mount: a string or { render(root, props) } ---

function mountStub(root, app, props) {
  if (typeof app === 'string') {
    root.innerHTML = app
    return { destroy: () => { root.innerHTML = '' } }
  }
  if (typeof app?.render === 'function') {
    app.render(root, props)
    return { destroy: () => { root.innerHTML = '' } }
  }
  root.textContent = '[jetty] unsupported app shape'
  return {}
}
