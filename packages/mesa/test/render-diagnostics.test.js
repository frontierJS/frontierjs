/**
 * @vitest-environment node
 *
 * render-diagnostics.test.js — what a server render SAYS when a component fails.
 *
 * A prerender runs hundreds of components per build, so a failure that names
 * neither the file nor the component is a failure with no address. Two shapes
 * reach the same place: a browser global that does not exist during a build
 * (FJS-870), and a spread carrying an attribute NAME the DOM refuses, which
 * takes the whole page down (FJS-872). Both used to arrive as a bare
 * `new Error(message)` with the original stack discarded — and the discarded
 * stack held the one frame that names the compiled module and its component
 * function.
 *
 * Every assertion here is about the message and the stack. Nothing about WHICH
 * globals a render should install, or whether a component reading `innerWidth`
 * should be reported at all, is decided here — see FJS-870's second half.
 *
 * The node environment is not a preference: vitest's happy-dom environment
 * installs `localStorage` as a global, so the absent-global half cannot happen
 * under it. A prerender runs under plain node and `initRenderer()` installs its
 * own globals, which is the shape this file has to reproduce.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderComponent } from '../src/render-component.js'

const cwd = '/tmp'

/** Render `src` as `name` and return the error it threw, or null. */
async function failure(name, src) {
  try {
    await renderComponent(src, { cwd, filename: `${cwd}/${name}`, target: 'html' })
    return null
  } catch (e) {
    return e
  }
}

describe('a missing browser global (FJS-870)', () => {
  it('names the file that read it', async () => {
    const err = await failure('Store.mesa', `<script>\n  const v = localStorage.getItem('x')\n</script>\n<p>{v}</p>\n`)
    expect(err).toBeTruthy()
    expect(err.message).toContain('Store.mesa')
  })

  it('says a build has no browser, and names the guard that works', async () => {
    const err = await failure('Store2.mesa', `<script>\n  const v = localStorage.getItem('x')\n</script>\n<p>{v}</p>\n`)
    expect(err.message).toContain('localStorage')
    expect(err.message).toContain('does not exist during a server render')
    expect(err.message).toContain("typeof localStorage !== 'undefined'")
  })

  it('keeps the original error as the cause', async () => {
    const err = await failure('Store3.mesa', `<script>\n  const v = sessionStorage.getItem('x')\n</script>\n<p>{v}</p>\n`)
    expect(err.cause).toBeInstanceOf(ReferenceError)
    expect(err.stack).toContain('Caused by:')
  })

  // The hint keys off the SHAPE of the failure, not a list of global names, so
  // an ordinary programming error must not collect browser advice.
  it('does not offer the browser hint for an unrelated throw', async () => {
    const err = await failure('Boom.mesa', `<script>\n  const v = (null).x\n</script>\n<p>{v}</p>\n`)
    expect(err).toBeTruthy()
    expect(err.message).not.toContain('a build has no browser')
  })
})

describe('a hostile attribute name in a spread (FJS-872)', () => {
  const src = `<script>\n  const attrs = { 'x" onmouseover="alert(1)': 'y', title: 'kept' }\n</script>\n<div {...attrs}>hi</div>\n`

  // This block used to assert the message of a THROW. The runtime now skips a
  // name the DOM refuses and warns, so a prerender of hundreds of pages is no
  // longer taken down by one key in one component's data. The concern is
  // unchanged and is still the only thing asked: the render has to say WHICH
  // key it dropped, or a silently missing attribute is the next defect.
  it('renders rather than taking the page down', async () => {
    const r = await renderComponent(src, { cwd, filename: `${cwd}/Bad.mesa`, target: 'html' })
    expect(r.html).toContain('hi')
  })

  it('drops the refused name and keeps the rest of the element', async () => {
    const r = await renderComponent(src, { cwd, filename: `${cwd}/Bad2.mesa`, target: 'html' })
    expect(r.html).toContain('title="kept"')
    expect(r.html).not.toContain('onmouseover')
  })

  it('names the key it dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await renderComponent(src, { cwd, filename: `${cwd}/Bad3.mesa`, target: 'html' })
      const msg = warn.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(msg).toContain('onmouseover')
      expect(msg).toMatch(/skipped|refused/)
    } finally { warn.mockRestore() }
  })
})

// The stack rewriting has to be asserted against something that still throws,
// which is the absent-global case. The compiled module executes from a temp
// `.mjs` in a scratch directory, so the frame naming the component points at a
// path nobody wrote; it is rewritten back to the `.mesa` it came from.
describe('the stack of a render that did fail', () => {
  it('points at the .mesa file, not the temp module', async () => {
    const err = await failure('Deep.mesa', `<script>\n  const v = localStorage.getItem('x')\n</script>\n<p>{v}</p>\n`)
    expect(err.stack).toContain('/tmp/Deep.mesa')
    expect(err.stack).not.toMatch(/Deep[^\n]*\.mjs/)
  })
})

describe('a render that succeeds is unchanged', () => {
  it('renders normally', async () => {
    const r = await renderComponent('<p>ok</p>\n', { cwd, filename: `${cwd}/Ok.mesa`, target: 'html' })
    expect(r.html).toContain('<p>ok</p>')
  })
})
