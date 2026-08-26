/**
 * <mesa:element this={tag}> — an element whose tag is an expression (FJS-023).
 *
 * It was not a feature and compiled without complaint: the element and every
 * child vanished from the output, so a component that used it rendered nothing
 * and said nothing. `@frontierjs/ui`'s SectionHeader carries an explicit h1–h6
 * ladder because of it.
 *
 * The same silence covered every other unknown `mesa:*` name, so a typo was
 * indistinguishable from a feature that does not work. Both are assertions here.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { compile } from '../src/compiler.js'

function execCompiled(compiledJs, runtime) {
  const code = compiledJs
    .replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .trim()
    .replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  // eslint-disable-next-line no-new-func
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
    find: sel => container.querySelector(sel),
    destroy() {
      container.innerHTML = ''
      container.parentNode?.removeChild(container)
    },
  }
}

const cx = src => compile(src, { debug: false, css: false })

// ── the unknown-name family ──────────────────────────────────────────────────

describe('unknown mesa: elements', () => {
  it('names a misspelling instead of emitting nothing', async () => {
    const out = await cx(`<div><mesa:wndow on:click={f} /></div>`)
    expect(out.analysis.errors.join('')).toContain('<mesa:wndow> is not a Mesa element')
  })

  it('lists the elements that do exist', async () => {
    const out = await cx(`<mesa:thing />`)
    const msg = out.analysis.errors.join('')
    for (const known of ['boundary', 'element', 'window', 'portal', 'head']) {
      expect(msg).toContain(known)
    }
  })

  it('a nested <mesa:mounted> says where it belongs', async () => {
    const out = await cx(`<div><mesa:mounted /></div>`)
    expect(out.analysis.errors.join('')).toContain('top-level')
  })

  it('the elements that do exist still compile', async () => {
    for (const src of [
      `<mesa:window on:resize={() => {}} />`,
      `<mesa:head><title>x</title></mesa:head>`,
      `<mesa:portal to={document.body}><p>x</p></mesa:portal>`,
    ]) {
      expect((await cx(src)).analysis.errors).toEqual([])
    }
  })
})

// ── <mesa:element> ───────────────────────────────────────────────────────────

describe('<mesa:element> — compile', () => {
  it('requires a tag expression', async () => {
    const out = await cx(`<mesa:element>x</mesa:element>`)
    expect(out.analysis.errors.join('')).toContain('requires a tag expression')
  })

  it('compiles the element under a placeholder tag, keyed on the expression', async () => {
    const out = await cx(`<script>let t = 'h2'</script><mesa:element this={t}>x</mesa:element>`)
    expect(out.analysis.errors).toEqual([])
    expect(out.result).toContain('mesa-dynamic-element')
    expect(out.result).toContain('$$runtime.keyBlock')
    expect(out.result).toContain('$$runtime.dynamicElement')
  })
})

describe('<mesa:element> — rendering', () => {
  let runtime
  beforeEach(async () => { runtime = await import('../src/runtime.js') })

  it('renders the tag the expression names', async () => {
    const fn = await compileAndExec(
      `<script>let t = 'h2'</script><mesa:element this={t}>Title</mesa:element>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('h2')).toBeTruthy()
    expect(app.find('h2').textContent).toBe('Title')
    expect(app.html()).not.toContain('mesa-dynamic-element')
    app.destroy()
  })

  it('a derived tag follows its source', async () => {
    const fn = await compileAndExec(
      `<script>let level = 2\nconst t = 'h' + level\nfunction deeper() { level++ }</script>` +
      `<mesa:element this={t}>Title</mesa:element><button on:click={deeper}>+</button>`,
      runtime)
    const app = mount(fn, runtime)
    expect(app.find('h2')).toBeTruthy()
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('h2')).toBeNull()
    expect(app.find('h3')?.textContent).toBe('Title')
    app.destroy()
  })

  it('carries static attributes and classes onto the real element', async () => {
    const fn = await compileAndExec(
      `<script>let t = 'section'</script>` +
      `<mesa:element this={t} class="panel" role="region">x</mesa:element>`, runtime)
    const app = mount(fn, runtime)
    const el = app.find('section')
    expect(el.getAttribute('role')).toBe('region')
    expect(el.className).toContain('panel')
    app.destroy()
  })

  it('a reactive attribute updates without a rebuild', async () => {
    const fn = await compileAndExec(
      `<script>let t = 'div'\nlet n = 0\nfunction bump() { n++ }</script>` +
      `<mesa:element this={t} data-n={n}>{n}</mesa:element><button on:click={bump}>+</button>`,
      runtime)
    const app = mount(fn, runtime)
    const before = app.find('div[data-n]')
    app.find('button').__click?.()
    runtime.flushSync()
    const after = app.find('div[data-n]')
    expect(after.getAttribute('data-n')).toBe('1')
    expect(after.textContent).toBe('1')
    expect(after).toBe(before)   // the tag did not change, so neither did the node
    app.destroy()
  })

  it('handles its own events', async () => {
    const fn = await compileAndExec(
      `<script>let t = 'button'\nlet n = 0\nfunction bump() { n++ }</script>` +
      `<mesa:element this={t} on:click={bump}>{n}</mesa:element>`, runtime)
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('button').textContent).toBe('1')
    app.destroy()
  })

  it('refuses an empty tag by name rather than rendering a stray node', async () => {
    const fn = await compileAndExec(
      `<script>let t = ''</script><mesa:element this={t}>x</mesa:element>`, runtime)
    // The throw is inside an effect, which the runtime reports rather than
    // rethrowing — so assert on the factory directly.
    expect(() => runtime.dynamicElement(() => '', () => null)())
      .toThrow(/expected a tag name/)
    expect(() => runtime.dynamicElement(() => null, () => null)())
      .toThrow(/expected a tag name/)
    expect(fn).toBeTypeOf('function')
  })
})
