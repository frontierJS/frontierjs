/**
 * `<mesa:element this={tag}>` is markup, not a script host.
 *
 * The only check was `typeof tag === 'string' && tag`, so a tag arriving from
 * data could be `script`: createElement('script') is not parser-inserted, the
 * authored children become the body, and a `{code}` interpolation inside is a
 * text binding — eval with two data inputs and no diagnostic. It survives SSR
 * too, so a `target: 'static'` build writes the script into a public file
 * (FJS-838).
 *
 * The refusal is a throw, the same shape the empty-tag case already throws:
 * these elements execute or redirect on INSERT, so there is no partial render
 * that is safe to leave on the page.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { compile } from '../src/compiler.js'

function execCompiled(compiledJs, runtime) {
  const code = compiledJs
    .replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .trim()
    .replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  return new Function('$$runtime', code)(runtime)
}

async function compileAndExec(source, runtime) {
  const ctx = await compile(source, { debug: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  return execCompiled(ctx.result, runtime)
}

function mount(componentFn, runtime, props = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.flushSync()
  componentFn(anchor, props, null)
  runtime.flushSync()
  return {
    container,
    html: () => container.innerHTML,
    destroy() { container.innerHTML = ''; container.parentNode?.removeChild(container) },
  }
}

describe('<mesa:element this={tag}> — the tags it refuses', () => {
  let runtime
  beforeEach(async () => { runtime = await import('../src/runtime.js') })

  const refused = ['script', 'style', 'base', 'link', 'meta', 'iframe', 'object', 'embed']

  for (const tag of refused) {
    it(`refuses <${tag}> rather than building one`, async () => {
      const fn = await compileAndExec(
        `<script>let t = ${JSON.stringify(tag)}\nlet code = 'window.__pwn = 1'</script>` +
        `<mesa:element this={t}>{code}</mesa:element>`, runtime)
      expect(() => mount(fn, runtime)).toThrow(new RegExp(`<${tag}>`))
      expect(globalThis.__pwn).toBeUndefined()
    })
  }

  it('refuses regardless of case, since createElement is case-insensitive', async () => {
    const fn = await compileAndExec(
      `<script>let t = 'ScRiPt'</script><mesa:element this={t}>x</mesa:element>`, runtime)
    expect(() => mount(fn, runtime)).toThrow(/script/i)
  })

  it('says a dynamic tag is markup', async () => {
    const fn = await compileAndExec(
      `<script>let t = 'script'</script><mesa:element this={t}>x</mesa:element>`, runtime)
    let msg = ''
    try { mount(fn, runtime) } catch (e) { msg = e.message }
    expect(msg).toContain('[Mesa]')
    expect(msg).toContain('<mesa:element')
    expect(msg).toMatch(/markup/i)
  })

  it('the ordinary tags still build', async () => {
    for (const tag of ['h2', 'section', 'my-widget', 'span']) {
      const fn = await compileAndExec(
        `<script>let t = ${JSON.stringify(tag)}</script><mesa:element this={t}>x</mesa:element>`,
        runtime)
      const app = mount(fn, runtime)
      expect(app.html().toLowerCase()).toContain(`<${tag}`)
      app.destroy()
    }
  })
})
