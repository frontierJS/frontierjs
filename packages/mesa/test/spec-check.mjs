// Every claim the new §4 makes, checked against the compiler.
const { compileSource } = await import('../src/compiler.js')
const C = (script, cfg = {}) => compileSource(
  `<script>\n${script}\n</script><p>{1}</p>`, { filename: '/t/T.mesa', dev: false, ...cfg })

const checks = []
const chk = (label, ok) => checks.push([ok, label])

// 4.1 watches
let r = await C(`import { cart } from './s.js'\n$: cart.total`)
chk('4.1 external path → watchProxy + watchPath', /watchProxy/.test(r.result) && /watchPath/.test(r.result))
r = await C(`let filters = { q: '' }\n$: filters.q`)
chk('4.1 local object path → localWatchProxy', /localWatchProxy/.test(r.result))

// 4.2 explicit-dep effect: deferred + prev
r = await C(`let a = 1\nfunction f(){}\n$: a, () => f()`)
chk('4.2 deferred (first-run guard emitted)', /\$\$first_wh0/.test(r.result))
chk('4.2 passes (value, prev)',               /\(\$\$v, \$\$p\)/.test(r.result))
chk('4.2 handler runs untracked',             /untrack/.test(r.result))
r = await C(`import { cart } from './s.js'\nfunction f(){}\n$: cart.total, () => f()`)
chk('4.2 handler dep on an import registers a path watch', /watchPath\(cart/.test(r.result))

// 4.3 auto-tracked is eager
r = await C(`let a = 1\nfunction f(){}\n$: { f(a) }`)
chk('4.3 auto-tracked block is NOT deferred', !/\$\$first_wh/.test(r.result))

// 4.4 ordered group
r = await C(`let a=1\nfunction f(){}\nfunction g(){}\n$: {\n a, () => f()\n a, () => g()\n}`)
chk('4.4 ordered group → orderedGroup', /orderedGroup/.test(r.result))

// 4.5 writable derived
r = await C(`let cities = ['A']\n$: sel = cities[0]`)
chk('4.5 writable derived → createWritableSignal', /createWritableSignal/.test(r.result))

// 4.7 phase — user effects tagged
r = await C(`let a = 1\nfunction f(){}\n$: a, () => f()`)
chk('4.7 user effects tagged { user: true }', /\{ user: true \}/.test(r.result))

// 4.8 compile errors
for (const [label, src] of [
  ['4.8 $: { }',            `let a=1\n$: { }`],
  ['4.8 $: { count }',      `let count=1\n$: { count }`],
  ['4.8 $: { (a, b) }',     `let a=1,b=2\n$: { (a, b) }`],
  ['4.8 $: { cart.total }', `import { cart } from './s.js'\n$: { cart.total }`],
]) {
  const c = await C(src)
  chk(label + ' errors', (c.analysis.errors ?? []).some(e => /does nothing|is empty/.test(e)))
}

// 4.4 handlers inside a block must be inline
r = await C(`let a=1\nfunction syncFn(){}\n$: { a, syncFn }`)
chk('4.4 fn reference inside a block errors',
    (r.analysis.errors ?? []).some(e => /must be an inline/.test(e)))
r = await C(`let a=1\nfunction syncFn(){}\n$: a, syncFn`)
chk('4.4 fn reference unbraced is fine',
    !(r.analysis.errors ?? []).some(e => /must be an inline|does nothing/.test(e)))

let bad = 0
for (const [ok, label] of checks) { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${label}`) }
console.log(bad ? `\n  ${bad} claim(s) not backed by the compiler` : '\n  every documented claim verified')
process.exit(bad ? 1 : 0)
