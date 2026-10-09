/**
 * A parent that watches a path of a `let` and also passes that `let` down with
 * `bind:` lost a reassignment of it from an event handler (`FJS-2093`): the
 * markup kept the old value and the watch read the old value.
 *
 * Run: npx vitest run watch-bind-reassign.test.js
 */

import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const cx = (src) => compile(src, { debug: false, css: false })

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
  // eslint-disable-next-line no-new-func
  return new Function('$$runtime', ...importNames, code)(runtime, ...importValues)
}

async function mountPair(childSrc, parentSrc) {
  const child = execCompiled((await cx(childSrc)).result)
  const parentCtx = await cx(parentSrc)
  if (parentCtx.analysis.errors.length) throw new Error(parentCtx.analysis.errors[0])
  const parent = execCompiled(parentCtx.result, { './Child.mesa': child })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.flushSync()
  parent(anchor, {}, null)
  runtime.flushSync()
  return {
    q: (sel) => container.querySelector(sel),
    destroy: () => container.remove()
  }
}

const CHILD = `<script>
  export let record = {}
</script>
<span class="child">{record.notes}</span>`

const parentWith = ({ watch, bind }) => `<script>
  import Child from './Child.mesa'
  let draft = { notes: 'n0' }
  let seen = 'none'
  ${watch ? "$: draft.notes, () => { seen = draft.notes }" : ''}
  function set() { draft = { ...draft, notes: 'n1' } }
</script>
<button on:click={set}>go</button>
<p class="own">{draft.notes}</p>
<i class="seen">{seen}</i>
<Child ${bind ? 'bind:record={draft}' : 'record={draft}'} />`

describe('a reassigned let that is both watched by path and bound down', () => {
  for (const [label, opts] of [
    ['watch + bind:', { watch: true, bind: true }],
    ['watch alone', { watch: true, bind: false }],
    ['bind: alone', { watch: false, bind: true }]
  ]) {
    it(`${label}: the handler's reassignment renders, in parent and child`, async () => {
      const m = await mountPair(CHILD, parentWith(opts))
      expect.soft(m.q('.own').textContent).toBe('n0')
      // Mounted without mount(), so there is no delegation root to dispatch to.
      m.q('button').__click()
      runtime.flushSync()
      expect.soft(m.q('.own').textContent).toBe('n1')
      expect.soft(m.q('.child').textContent).toBe('n1')
      if (opts.watch) expect.soft(m.q('.seen').textContent).toBe('n1')
      m.destroy()
    })
  }
})
