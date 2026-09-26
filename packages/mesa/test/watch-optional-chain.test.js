// watch-optional-chain.test.js
//
// `$: (server?.status, () => …)` — an optional chain in a watch DEPENDENCY —
// was refused as a compiler bug: two of the six sites that spelled a watch
// signal's name sliced the path before reading `?.` as `.`, and referenced
// `$$watch_server__status` beside a declared `$$watch_server_status`
// (`FJS-1025`). The chain is written exactly when the root can be null, so each
// case mounts with it null, gives it a value, then moves the path.

import { describe, it, expect, beforeEach } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

// `./store.js` resolves to the object handed in, as one ESM instance would.
async function comp(src, store) {
  const ctx = await compileSource(src, { filename: `/C${Math.random()}.mesa`, dev: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  let code = ctx.result.replace(/^import \{ ([^}]+) \} from '\.\/store\.js';$/m, 'const { $1 } = __store;')
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __c = ') + '\nreturn __c'
  const Comp = new Function('$$runtime', '__store', code)(runtime, store)
  const a = document.createElement('span')
  document.body.appendChild(a)
  runtime.mount(a, Comp, {})
  await tick()
}

const settle = async () => { runtime.flushSync(); await tick() }

beforeEach(() => { document.body.innerHTML = ''; globalThis.__log = [] })

describe('an optional chain in a watch dependency (FJS-1025)', () => {
  const local = (line) => `<script>
  import { hook } from './store.js'
  let server = null
  hook((v) => { server = v }, (s) => { server.status = s })
${line}
</script>`

  // A handler is handed the value and skips the mount run; a group entry is
  // handed nothing and runs at mount, where the chain is what keeps it alive.
  for (const [form, line, first] of [
    ['a handler',       '  $: server?.status, (s) => __log.push(s)',                 []],
    ['a parenthesized', '  $: (server?.status, (s) => __log.push(s))',               []],
    ['a group',         '  $: { server?.status, () => __log.push(server?.status) }', [undefined]],
  ]) {
    it(`${form} over a local let compiles, mounts null, and fires as the path moves`, async () => {
      let give, move
      await comp(local(line), { hook: (g, m) => { give = g; move = m } })
      give({ status: 'up' }); await settle()
      move('down');           await settle()
      expect(__log).toEqual([...first, 'up', 'down'])
    })
  }

  it('over an import, through a nested chain', async () => {
    const store = { fleet: { server: null } }
    await comp(`<script>
  import { fleet } from './store.js'
  $: fleet.server?.status, (s) => __log.push(s)
  $: { fleet?.server?.status, () => __log.push('g:' + fleet?.server?.status) }
</script>`, store)
    runtime.watchProxy(store.fleet).server = { status: 'up' }; await settle()
    runtime.watchProxy(store.fleet).server.status = 'down';   await settle()
    expect(__log.filter((x) => !x.startsWith('g:'))).toEqual(['up', 'down'])
    expect(__log.filter((x) => x.startsWith('g:'))).toEqual(['g:undefined', 'g:up', 'g:down'])
  })
})
