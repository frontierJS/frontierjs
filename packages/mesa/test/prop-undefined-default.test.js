// FJS-1538 — a prop passed as `undefined` is "not given": the declared default applies
import { describe, it, expect } from 'vitest'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { renderComponent } from '../src/render-component.js'

const DIR = '/tmp/mesa1538'

async function render(parent, child, data = {}) {
  await mkdir(DIR, { recursive: true })
  await writeFile(path.join(DIR, 'Child.mesa'), child)
  return (await renderComponent(parent, { cwd: DIR, data, target: 'html' })).html
}

const CHILDREN = {
  let: `<script>\n  export let source = 'DEFAULT'\n</script>\n<i>{source}</i>`,
  const: `<script>\n  export const source = 'DEFAULT'\n</script>\n<i>{source}</i>`,
  var: `<script>\n  export var source = 'DEFAULT'\n</script>\n<i>{source}</i>`,
  deferred: `<script>\n  let base = 'BASE'\n  export let source = base + '!'\n</script>\n<i>{source}</i>`,
}

describe('FJS-1538: undefined prop applies the declared default', () => {
  for (const [kind, child] of Object.entries(CHILDREN)) {
    const dflt = kind === 'deferred' ? 'BASE!' : 'DEFAULT'
    it(`${kind}: source={cfg.image} with no image`, async () => {
      const html = await render(
        `<script>\n  import Child from './Child.mesa'\n  export let cfg = {}\n</script>\n<Child source={cfg.image} />`,
        child
      )
      expect(html).toContain(`<i>${dflt}</i>`)
    })
    it(`${kind}: literal source={undefined}`, async () => {
      const html = await render(
        `<script>\n  import Child from './Child.mesa'\n</script>\n<Child source={undefined} />`,
        child
      )
      expect(html).toContain(`<i>${dflt}</i>`)
    })
  }
  it('explicit null clears the default', async () => {
    const html = await render(
      `<script>\n  import Child from './Child.mesa'\n</script>\n<Child source={null} />`,
      CHILDREN.let
    )
    expect(html).not.toContain('DEFAULT')
  })
})

// ── The push after mount ─────────────────────────────────────────────────────
// The first render read the default; the effect that follows pushes the
// parent's current value, and `undefined` there blanked the child.

import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

function execCompiled(js, userImports = {}) {
  const importNames = [], importValues = []
  const importRe = /^import\s+(.+?)\s+from\s+'([^']+)';$/gm
  let m
  while ((m = importRe.exec(js)) !== null) {
    if (m[2] === '@frontierjs/mesa/runtime.js') continue
    importNames.push(m[1].trim())
    importValues.push(userImports[m[2]])
  }
  const code = js
    .replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .trim()
    .replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  return new Function('$$runtime', ...importNames, code)(runtime, ...importValues)
}

describe('FJS-1538: a later undefined from the parent restores the default', () => {
  for (const [kind, child] of Object.entries(CHILDREN)) {
    if (kind === 'const' || kind === 'var') continue
    it(`${kind}: given, then undefined, then null`, async () => {
      const dflt = kind === 'deferred' ? 'BASE!' : 'DEFAULT'
      const childFn = execCompiled((await compile(child, { debug: false, css: false })).result)
      const parentCtx = await compile(
        `<script>\n  import Child from './Child.mesa'\n  let v = 'GIVEN'\n</script>\n` +
        `<button on:click={() => (v = undefined)}>u</button>` +
        `<button class="n" on:click={() => (v = null)}>n</button>` +
        `<Child source={v} />`,
        { debug: false, css: false }
      )
      const parentFn = execCompiled(parentCtx.result, { './Child.mesa': childFn })
      const container = document.createElement('div')
      document.body.appendChild(container)
      const anchor = document.createComment('')
      container.appendChild(anchor)
      parentFn(anchor, {}, null)
      runtime.flushSync()
      expect(container.querySelector('i').textContent).toBe('GIVEN')
      container.querySelector('button').__click()
      runtime.flushSync()
      expect(container.querySelector('i').textContent).toBe(dflt)
      container.querySelector('.n').__click()
      runtime.flushSync()
      expect(container.querySelector('i').textContent).toBe('')
      container.remove()
    })
  }
})
