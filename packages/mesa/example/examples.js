/**
 * Mesa REPL — example components
 *
 * Each entry:
 *   key:   string  — select option value
 *   file:  string  — filename shown in the REPL header
 *   group: string  — optgroup label in the example selector
 *   src:   string  — Mesa source
 *   files: [{ name, content }]  — optional extra files, opened as editor tabs
 *          and importable from `src` as './Name.mesa' or './name.js'
 *
 * To add an example: add an entry to EXAMPLES. The select menu builds itself.
 *
 * Two authoring traps, both of which cost time on 2026-08-02:
 *   - Mesa syntax in prose is PARSED. A heading reading `{#await}` opens a real
 *     await block; `{class}` in a paragraph is an expression. Write the literal
 *     as `{'{#await}'}`.
 *   - An auto-effect that writes something it also reads is a cycle. The runtime
 *     caps it at 1000 passes and warns; the example just looks wrong.
 *
 * `repl.test.js` compiles every example and every extra file, and checks that
 * each documented language feature appears in at least one of them.
 */

export const EXAMPLES = {

  // ── Signals ──────────────────────────────────────────────────────────────────

  counter: {
    file: 'Counter.mesa',
    group: 'Signals',
    src: `<script>
  // let   = reactive signal — re-renders on assignment
  // const = derived value  — recomputes when deps change
  // var   = non-reactive   — snapshot, invisible to graph

  let count = 0
  const double  = count * 2
  const isEven  = count % 2 === 0
  const label   = isEven ? 'even' : 'odd'

  var initial = count     // frozen at init, never updates

  function increment() { count++ }
  function decrement() { count-- }
  function reset()     { count = 0 }
</script>

<h2>Counter</h2>
<p>count: <strong>{count}</strong> — {label}</p>
<p>double: {double}</p>
<p>initial (var snapshot): {initial}</p>
<div>
  <button on:click={decrement}>−</button>
  <button on:click={increment}>+</button>
  <button on:click={reset}>Reset</button>
</div>`
  },

  derivedChain: {
    file: 'DerivedChain.mesa',
    group: 'Signals',
    src: `<script>
  // Derived consts chain automatically — each recomputes only when
  // its direct deps change. The compiler detects the dependency graph.

  let base   = 2
  let factor = 3
  let offset = 10

  const squared  = base * base              // deps: [base]
  const scaled   = squared * factor         // deps: [squared, factor]
  const shifted  = scaled + offset          // deps: [scaled, offset]
  const display  = shifted.toFixed(0)       // deps: [shifted]
  const isLarge  = shifted > 100            // deps: [shifted]

  const MAX   = 1000   // static const — no deps, inlined
  const LABEL = 'result'
</script>

<h2>Derived chain</h2>
<p>base: {base} — factor: {factor} — offset: {offset}</p>
<p>base² = {squared}</p>
<p>squared × factor = {scaled}</p>
<p>{LABEL}: {display} {isLarge ? '(large!)' : ''} / {MAX}</p>

<button on:click={() => base++}>base++</button>
<button on:click={() => factor++}>factor++</button>
<button on:click={() => offset += 5}>offset+5</button>
<button on:click={() => { base = 2; factor = 3; offset = 10 }}>Reset</button>`
  },

  replaceNotMutate: {
    file: 'ReplaceNotMutate.mesa',
    group: 'Signals',
    src: `<script>
  // Mesa let signals are shallow — only the REFERENCE is tracked.
  // Mutating a property notifies nothing. There are exactly two ways out.

  let user  = { name: 'Alice', score: 0 }
  let items = ['apples', 'bananas']

  // Derived from object signal — recomputes when user is replaced
  const greeting = 'Hello, ' + user.name + '!'
  const itemCount = items.length

  // ── Way 1: replace the value ──────────────────────────────────────────────
  function rename() {
    user = { ...user, name: 'Bob' }
  }

  function addPoints() {
    user = { ...user, score: user.score + 10 }
  }

  // ── Way 2: mutate, then say so ────────────────────────────────────────────
  // \`x = x\` is not a no-op. Self-assignment means "I mutated this in place,
  // notify anyway" and skips the equality guard for that one write. The same
  // idiom announces an externally mutated import (see Shared State).
  function addPointsByMutation() {
    user.score += 5
    user = user
  }

  function addItem() {
    items = [...items, 'cherry']
  }

  function removeFirst() {
    items = items.slice(1)
  }

  // ── Way 3: watch the object, then mutate freely ───────────────────────────
  // \`$:\` with no body is a watch. It opts this local object into deep
  // watching, and from then on mutation IS reactive — no copying.
  let prefs = { theme: 'light', density: 'cosy' }
  $: prefs

  function toggleTheme() {
    prefs.theme = prefs.theme === 'light' ? 'dark' : 'light'   // mutated in place
  }
</script>

<h2>Replace, don't mutate</h2>

<p>{greeting} — score: {user.score}</p>
<p>{itemCount} item{itemCount === 1 ? '' : 's'}: {items.join(', ')}</p>
<div>
  <button on:click={rename}>Rename to Bob</button>
  <button on:click={addPoints}>+10 points</button>
  <button on:click={addPointsByMutation}>+5 (mutate, then user = user)</button>
</div>
<div>
  <button on:click={addItem}>Add cherry</button>
  <button on:click={removeFirst}>Remove first</button>
</div>

<p class="watched">
  theme: {prefs.theme} — mutated in place, and reactive because of <code>$: prefs</code>
</p>
<div>
  <button on:click={toggleTheme}>Toggle theme</button>
</div>

<style>
  .watched { margin-top: 16px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
</style>`
  },

  internalSlotValues: {
    file: 'InternalSlotValues.mesa',
    group: 'Signals',
    src: `<script>
  // Map, Set, Date, RegExp, Promise, typed arrays — values whose state lives in
  // internal slots — are handed through the watch proxy untouched. Every method
  // works, and their CONTENTS are not reactive: mutating a Map or advancing a
  // Date fires nothing, because that state lives where no proxy trap can see
  // it. Wrapping them would not have helped; it only broke method calls with
  // "incompatible receiver".
  //
  // Reassigning the variable that holds one is reactive as always. So the rule
  // is the ordinary Mesa rule with no exception: replacement is reactive,
  // mutation is not.
  //
  // Plain objects are different — declare a watch and they go deep, including
  // delete.

  let tags     = new Map([['draft', 2]])
  let selected = new Set(['a'])
  let seenAt   = new Date(2026, 0, 1)

  // The declared watch is what opts this plain object into deep reactivity —
  // without it, the delete below would be just as invisible as tags.set().
  let flags = { beta: true, verbose: false, legacy: true }
  $: flags

  function mutateMap()   { tags.set('review', 1) }              // invisible
  function replaceMap()  { tags = new Map(tags).set('done', 4) } // reactive

  function mutateSet()   { selected.add('b') }                  // invisible
  function replaceSet()  { selected = new Set([...selected, 'c']) }

  function advanceDate() { seenAt.setDate(seenAt.getDate() + 1) } // invisible
  function replaceDate() { seenAt = new Date(seenAt.getTime() + 864e5) }

  function dropFlag()    { delete flags.legacy }                 // reactive
  function addFlag()     { flags.fresh = true }                  // reactive
</script>

<h2>Values the proxy cannot see into</h2>

<p><strong>Map</strong> — {tags.size} entries: {[...tags.keys()].join(', ')}</p>
<button on:click={mutateMap}>tags.set(...) — nothing happens</button>
<button on:click={replaceMap}>tags = new Map(tags) — updates</button>

<p><strong>Set</strong> — {selected.size} selected: {[...selected].join(', ')}</p>
<button on:click={mutateSet}>selected.add(...) — nothing happens</button>
<button on:click={replaceSet}>selected = new Set(...) — updates</button>

<p><strong>Date</strong> — {seenAt.toDateString()}</p>
<button on:click={advanceDate}>setDate(+1) — nothing happens</button>
<button on:click={replaceDate}>seenAt = new Date(...) — updates</button>

<hr/>

<p><strong>Plain object under a watch</strong> —
   legacy={flags.legacy} · fresh={flags.fresh}</p>
<button on:click={dropFlag}>delete flags.legacy</button>
<button on:click={addFlag}>flags.fresh = true</button>

<p class="keys">Object.keys: {Object.keys(flags).join(', ')} — see below</p>

<p class="note">
  The "nothing happens" buttons DO mutate — click one, then click the replace
  button beside it and watch the earlier change appear along with the new one.
  The write landed; only the notification was missing. That is why the rule is
  worth knowing rather than worth fighting: reach for replacement and the
  question never comes up.
</p>

<p class="note">
  A read subscribes; an <em>enumeration</em> does not. The Object.keys line
  above refreshes only because the line before it reads flags.legacy — on its
  own it would sit there stale through both buttons, since the proxy's ownKeys
  trap adds no subscription. Spreading ({'{'}...flags{'}'}) is fine, because
  that reads every key.
</p>

<style>
  button { margin: 0 6px 8px 0; font: inherit; padding: 4px 10px;
           border: 1px solid #d1d5db; border-radius: 6px; background: #fff;
           cursor: pointer; }
  .note  { font-size: 12px; color: #9ca3af; max-width: 460px; margin-top: 12px; }
  .keys  { font-size: 12px; color: #6b7280; }
</style>`,
  },

  varSampler: {
    file: 'VarSampler.mesa',
    group: 'Signals',
    src: `<script>
  // var escapes the reactive graph.
  // Reads reactive values at declaration time without subscribing.
  // Writes are invisible — nothing re-renders when var changes.
  // Use for: snapshots, staging, memoization, rollback values.

  let price    = 100
  let quantity = 1

  var snapshot = price     // frozen at declaration, never updates
  var previous = null      // script-side bookkeeping only

  function applyDiscount() {
    previous = price                          // capture before change
    price    = +(price * 0.9).toFixed(2)     // reactive — re-renders
  }

  function rollback() {
    if (previous !== null) price = previous
  }

  const total   = price * quantity
  const savings = snapshot - price
</script>

<h2>var: non-reactive sampler</h2>
<p>Live price: <strong>{price}</strong></p>
<p>Original snapshot (frozen): <strong>{snapshot}</strong></p>
<p>Savings: {savings.toFixed(2)}</p>
<p>Total: {total.toFixed(2)}</p>
<button on:click={applyDiscount}>Apply 10% discount</button>
<button on:click={rollback}>Rollback</button>
<button on:click={() => quantity++}>qty+</button>`
  },

  destructuring: {
    file: 'Destructuring.mesa',
    group: 'Signals',
    src: `<script>
  // const {a, b} = obj  →  compiler expands to:
  //   const a = createMemo(() => obj.a)
  //   const b = createMemo(() => obj.b)
  //
  // Replacing the source signal re-derives all extracted values.
  // This is static compile-time expansion — NOT the same as $: reactive rebinding.

  let user = { name: 'Alice', role: 'admin', age: 30 }
  let arr  = [10, 20, 30]

  const { name, role }        = user
  const { name: displayName } = user   // alias
  const { age = 0 }           = user   // with default

  const [first, second] = arr

  function updateUser() {
    user = { name: 'Bob', role: 'editor', age: 25 }
  }

  function shiftArr() {
    arr = [99, 20, 30]
  }
</script>

<h2>Destructuring</h2>
<p>name: {name} — role: {role} — age: {age}</p>
<p>displayName (alias): {displayName}</p>
<p>arr[0]: {first} — arr[1]: {second}</p>
<button on:click={updateUser}>Change user</button>
<button on:click={shiftArr}>Change arr[0]</button>`
  },

  writableDerived: {
    file: 'WritableDerived.mesa',
    group: 'Signals',
    src: `<script>
  // $: myVar = expr  — writable derived signal.
  // Re-derives when deps change, but can be overridden manually.
  // Override holds until the next dep change — then derivation wins again.
  //
  // Contrast with:
  //   let myVar = expr   — snapshot at init, independent forever
  //   const myVar = expr — read-only derived, never manually writable

  let items    = ['Apples', 'Bananas', 'Cherries']
  $: selected  = items[0]   // re-derives when items changes

  // Optimistic UI: override immediately, re-derive on next data change
  let price    = 100
  $: displayPrice = price   // tracks price, but can be optimistically overridden

  function addItem() {
    items = [...items, 'Dates']
    // selected re-derives to items[0] — still 'Apples'
  }

  function replaceItems() {
    items = ['Elderberry', 'Figs', 'Grapes']
    // selected re-derives to 'Elderberry'
  }

  function pickSecond() {
    selected = items[1]     // manual override — holds until items changes
  }

  function applyDiscount() {
    displayPrice = +(price * 0.9).toFixed(2)  // optimistic — holds until price changes
  }

  function fetchNewPrice() {
    price = 150             // displayPrice re-derives to 150
  }
</script>

<h2>$: writable derived</h2>

<p>items: {items.join(', ')}</p>
<p>selected (re-derives on items change): <strong>{selected}</strong></p>
<div>
  <button on:click={addItem}>Add item</button>
  <button on:click={replaceItems}>Replace all</button>
  <button on:click={pickSecond}>Pick second (override)</button>
</div>

<hr/>

<p>price: {price} — displayPrice: <strong>{displayPrice}</strong></p>
<div>
  <button on:click={applyDiscount}>Optimistic discount</button>
  <button on:click={fetchNewPrice}>Fetch new price (re-derives)</button>
</div>`
  },

  orderedGroup: {
    file: 'OrderedGroup.mesa',
    group: 'Signals',
    src: `<script>
  // Chained watch+handlers — each watches its own dep and drives the next.
  // Because the microtask scheduler coalesces writes, when a fires:
  //   1. $: a handler runs → sets b
  //   2. $: b handler runs → sets c
  // All in one flush, in declaration order.

  let a = 1
  let b = 0
  let c = 0
  let log = []

  // Step 1: when a changes → update b
  $: a, () => {
    b = a * 2
    log = [...log, 'A→B: a=' + a + ', b=' + (a * 2)]
  }

  // Step 2: when b changes → update c
  $: b, () => {
    c = b + 10
    log = [...log, 'B→C: b=' + b + ', c=' + (b + 10)]
  }

  function changeA() { a++ }
  function changeB() { b += 5 }
  function changeBoth() { a = 10; b = 3 }
  function reset() { a = 1; b = 0; c = 0; log = [] }
</script>

<h2>Chained watch+handlers</h2>
<p>a={a} → b={b} → c={c}</p>

<div>
  <button on:click={changeA}>a++ (A fires, then B)</button>
  <button on:click={changeB}>b+=5 (only B fires)</button>
  <button on:click={changeBoth}>a=10, b=3 (A then B)</button>
  <button on:click={reset}>Reset</button>
</div>

<hr/>
<p style="font-size:11px;color:#6b7280">Execution log (clears on reset):</p>
{#each log as entry (entry + log.indexOf(entry))}
  <p style="font-size:11px;color:#6b7280;margin:0">• {entry}</p>
{/each}`
  },



  props: {
    file: 'Props.mesa',
    group: 'Props & Binding',
    src: `<script>
  // export let   = reactive prop — parent writes, component reads/writes
  // export const = immutable prop — parent sets once, component cannot reassign
  // export var   = snapshot prop — captured at mount, ignores future parent updates

  export let price    = 49.99
  export let quantity = 1

  export const sku      = 'WGT-001'
  export const currency = 'USD'

  export var taxRate = 0.08
  export var region  = 'US'

  const subtotal  = price * quantity
  const taxAmount = subtotal * taxRate
  const total     = subtotal + taxAmount
  const inStock   = quantity > 0
</script>

<h2>Props — export let / const / var</h2>
<p>SKU: {currency}-{sku} — Region: {region}</p>
<p>Tax rate: {taxRate} (frozen at mount)</p>
<hr/>
<p>{price} × {quantity} = {subtotal.toFixed(2)}</p>
<p>Tax: {taxAmount.toFixed(2)}</p>
<p><strong>Total: {total.toFixed(2)}</strong></p>
<p>In stock: {inStock}</p>
<button on:click={() => quantity++}>Add to cart</button>
<button on:click={() => quantity = Math.max(0, quantity - 1)}>Remove</button>
<button on:click={() => price = +(price * 0.9).toFixed(2)}>10% off</button>`
  },

  attributeForwarding: {
    file: 'ForwardHost.mesa',
    group: 'Props & Binding',
    files: [
      {
        name: 'Btn.mesa',
        content: `<script>
  // A wrapper component has to hand the caller's leftovers to the real
  // element, or every consumer hits a wall the first time they need
  // type="submit", aria-label, data-testid, or an id.
  //
  //   $props      every prop passed in, declared or not
  //   $attributes the ones this component did NOT declare — what to forward
  //   $slots      which named slots the caller actually filled
  //
  // $attributes is the subtraction. Spreading $props instead would write
  // tone="danger" and loading="false" onto the DOM node.

  export let tone    = 'neutral'
  export let loading = false

  const declared = Object.keys($props).length
</script>

<button class="btn {tone}" disabled={loading} {...$attributes}>
  {#if loading}<span class="spin">◌</span>{/if}
  <slot>Button</slot>
  {#if $slots.badge}<span class="badge"><slot name="badge" /></span>{/if}
</button>

<p class="meta">
  {declared} props in · declared: tone, loading · forwarded:
  {Object.keys($attributes).join(', ') || '(none)'}
</p>

<style>
  .btn { border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 12px;
         background: #fff; cursor: pointer; font: inherit; }
  .btn.danger  { border-color: #dc2626; color: #dc2626; }
  .btn.success { border-color: #16a34a; color: #16a34a; }
  .btn:disabled { opacity: .5; cursor: default; }
  .badge { margin-left: 6px; font-size: 10px; background: #eef2ff;
           border-radius: 999px; padding: 1px 6px; }
  .meta  { font-size: 11px; color: #9ca3af; margin: 2px 0 10px; }
</style>`,
      },
    ],
    src: `<script>
  import Btn from './Btn.mesa'

  let busy = false
  let clicks = 0

  // Spreading a plain object works on any element too — same mechanism,
  // no component involved.
  const linkAttrs = { href: '#none', title: 'spread onto an anchor', rel: 'nofollow' }
</script>

<h2>Forwarding attributes</h2>

<Btn tone="danger" type="submit" aria-label="Delete this record" data-testid="del"
     onclick={() => clicks++}>
  Delete
</Btn>

<Btn tone="success" id="save-btn" onclick={() => clicks++}>
  Save
  <span slot="badge">new</span>
</Btn>

<Btn loading={busy} onclick={() => busy = !busy}>Toggle loading</Btn>

<p>clicked {clicks}x</p>

<hr/>

<p>Spread on a plain element: <a {...linkAttrs}>an anchor</a></p>

<p style="font-size:12px;color:#9ca3af">
  Inspect the buttons: <code>type</code>, <code>aria-label</code>,
  <code>data-testid</code> and <code>id</code> reached the real
  <code>&lt;button&gt;</code>, while <code>tone</code> and <code>loading</code>
  stayed behind as declared props.
</p>`,
  },

  formValidation: {
    file: 'FormValidation.mesa',
    group: 'Props & Binding',
    src: `<script>
  let name    = ''
  let email   = ''
  let age     = ''
  let touched = { name: false, email: false, age: false }

  // Derived validation — recomputes as user types
  const nameErr  = name.trim().length < 2  ? 'Min 2 characters' : ''
  const emailErr = !email.includes('@')    ? 'Enter a valid email' : ''
  const ageNum   = parseInt(age)
  const ageErr   = isNaN(ageNum) || ageNum < 18 || ageNum > 120
                   ? 'Must be 18–120' : ''

  const isValid   = !nameErr && !emailErr && !ageErr
                    && name && email && age
  const canSubmit = isValid

  function touch(field) {
    touched = { ...touched, [field]: true }
  }

  function submit() {
    touched = { name: true, email: true, age: true }
    if (!isValid) return
    alert('Submitted! ' + name + ' <' + email + '> age ' + ageNum)
  }
</script>

<h2>Form validation</h2>

<p>
  <label>Name</label><br/>
  <input bind:value={name} on:blur={() => touch('name')} placeholder="Full name" />
  {#if touched.name && nameErr}<span style="color:#ef4444;font-size:12px"> {nameErr}</span>{/if}
</p>
<p>
  <label>Email</label><br/>
  <input bind:value={email} on:blur={() => touch('email')} placeholder="you@example.com" />
  {#if touched.email && emailErr}<span style="color:#ef4444;font-size:12px"> {emailErr}</span>{/if}
</p>
<p>
  <label>Age</label><br/>
  <input bind:value={age} on:blur={() => touch('age')} placeholder="18+" type="number" />
  {#if touched.age && ageErr}<span style="color:#ef4444;font-size:12px"> {ageErr}</span>{/if}
</p>

<button on:click={submit} style="opacity:{canSubmit?1:0.5}">
  Submit
</button>`
  },

  // ── Template ─────────────────────────────────────────────────────────────────

  ifEach: {
    file: 'IfEach.mesa',
    group: 'Template',
    src: `<script>
  let items  = ['Apples', 'Bananas', 'Cherries']
  let filter = ''

  const filtered  = items.filter(i =>
    i.toLowerCase().includes(filter.toLowerCase())
  )
  const count     = filtered.length
  const hasItems  = items.length > 0
  const hasFilter = filter.length > 0

  const ALL_NAMES = ['Dates','Elderberry','Figs','Grapes','Honeydew',
                     'Jackfruit','Kiwi','Lemon','Mango','Nectarine']

  function addItem() {
    const available = ALL_NAMES.filter(n => !items.includes(n))
    if (!available.length) return
    items = [...items, available[Math.floor(Math.random() * available.length)]]
  }
  function clear() { items = [] }
</script>

<div>
  <h2>Filtered List — {count} item{count === 1 ? '' : 's'}</h2>

  <div style="margin-bottom:8px">
    <input bind:value={filter} placeholder="Filter…" />
    <button on:click={addItem}>Add random</button>
    <button on:click={clear}>Clear all</button>
  </div>

  {#if !hasItems}
    <p><em>No items. Add some!</em></p>
  {:else}
    {#each filtered as item (item)}
      <div>
        <span>{item}</span>
        <button on:click={() => items = items.filter(i => i !== item)}>✕</button>
      </div>
    {:else}
      <p><em>No matches for "{filter}"</em></p>
    {/each}
  {/if}
</div>`,
  },

  todoList: {
    file: 'TodoList.mesa',
    group: 'Template',
    src: `<script>
  let todos = [
    { id: 1, text: 'Learn Mesa', done: true  },
    { id: 2, text: 'Build a REPL', done: true },
    { id: 3, text: 'Ship it', done: false },
  ]
  let newText = ''

  const remaining = todos.filter(t => !t.done).length
  const total     = todos.length
  const allDone   = remaining === 0

  function addTodo() {
    if (!newText.trim()) return
    todos   = [...todos, { id: Date.now(), text: newText.trim(), done: false }]
    newText = ''
  }

  function toggle(id) {
    todos = todos.map(t => t.id === id ? { ...t, done: !t.done } : t)
  }

  function remove(id) {
    todos = todos.filter(t => t.id !== id)
  }

  function clearDone() {
    todos = todos.filter(t => !t.done)
  }
</script>

<h2>Todo — {remaining} / {total} remaining</h2>

<div>
  <input bind:value={newText} placeholder="New todo…" />
  <button on:click={addTodo}>Add</button>
  <button on:click={clearDone}>Clear done</button>
</div>

{#if allDone && total > 0}
  <p><em>All done!</em></p>
{/if}

{#each todos as todo (todo.id)}
  <div style="display:flex;align-items:center;gap:8px;padding:3px 0">
    <input type="checkbox" on:click={() => toggle(todo.id)} />
    <span style="text-decoration:{todo.done?'line-through':'none'};color:{todo.done?'#9ca3af':'inherit'}">{todo.text}</span>
    <button on:click={() => remove(todo.id)}>✕</button>
  </div>
{/each}`
  },

  // ── Reactivity ───────────────────────────────────────────────────────────────

  nestedEach: {
    file: 'NestedEach.mesa',
    group: 'Template',
    src: `<script>
  // {#each} inside {#each}, both keyed, both using the index.
  //
  // The key is what makes a reorder a MOVE rather than a rebuild: the block
  // that already exists for that key is moved, and its DOM and its effects
  // survive. The index is a signal of its own, so a card that has not moved
  // still renumbers when the cards above it change.
  //
  let columns = [
    { id: 'todo',  title: 'To do',  cards: [
      { id: 'c1', text: 'Draft the schema' },
      { id: 'c2', text: 'Name the nouns' },
      { id: 'c3', text: 'Sketch the routes' },
    ] },
    { id: 'doing', title: 'Doing', cards: [
      { id: 'c4', text: 'Wire the bridge' },
    ] },
    { id: 'done',  title: 'Done',  cards: [
      { id: 'c5', text: 'Pick the invariants' },
      { id: 'c6', text: 'Write it down' },
    ] },
  ]

  function shuffleColumns() {
    columns = [columns[2], columns[0], columns[1]]
  }

  function reverseCards(colId) {
    columns = columns.map(c =>
      c.id === colId ? { ...c, cards: [...c.cards].reverse() } : c)
  }

  function move(colId, from, to) {
    columns = columns.map(c => {
      if (c.id !== colId) return c
      const cards = [...c.cards]
      if (to < 0 || to >= cards.length) return c
      const [row] = cards.splice(from, 1)
      cards.splice(to, 0, row)
      return { ...c, cards }
    })
  }

  function rename(colId, cardId) {
    columns = columns.map(c => c.id !== colId ? c : {
      ...c,
      cards: c.cards.map(k => k.id !== cardId ? k : { ...k, text: k.text + '!' }),
    })
  }
</script>

<h2>Nested keyed lists</h2>

<button on:click={shuffleColumns}>Shuffle columns</button>

<div class="board">
  {#each columns as col, ci (col.id)}
    <section class="col">
      <header>{ci + 1}. {col.title} <em>({col.cards.length})</em></header>

      {#each col.cards as card, i (card.id)}
        <article class="card">
          <span class="idx">{ci + 1}.{i + 1}</span>
          <span class="text">{card.text}</span>
          <button class="mini" on:click={() => move(col.id, i, i - 1)}>↑</button>
          <button class="mini" on:click={() => move(col.id, i, i + 1)}>↓</button>
          <button class="mini" on:click={() => rename(col.id, card.id)}>!</button>
        </article>
      {:else}
        <p class="empty">nothing here</p>
      {/each}

      <button class="rev" on:click={() => reverseCards(col.id)}>Reverse</button>
    </section>
  {/each}
</div>

<p class="note">
  Both the column index and the card index come from the loop, and both update
  on a reorder without the rows being rebuilt. Drop the keys and every reorder
  becomes a full rebuild instead — which is invisible until a row holds state
  the rebuild throws away.
</p>

<style>
  .board { display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
  .col   { border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px;
           min-width: 190px; background: #fafafa; }
  header { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
  header em { color: #9ca3af; font-weight: 400; font-style: normal; }
  .card  { display: flex; align-items: center; gap: 5px; background: #fff;
           border: 1px solid #e5e7eb; border-radius: 6px; padding: 4px 6px;
           margin-bottom: 4px; font-size: 12px; }
  .idx   { color: #9ca3af; font-family: monospace; font-size: 11px; }
  .text  { flex: 1; }
  .mini  { border: none; background: #f3f4f6; border-radius: 4px; cursor: pointer;
           font-size: 11px; padding: 1px 5px; }
  .rev   { font-size: 11px; margin-top: 4px; }
  .empty { font-size: 11px; color: #9ca3af; font-style: italic; }
  .note  { font-size: 12px; color: #9ca3af; max-width: 460px; margin-top: 12px; }
</style>`,
  },

  keyBlock: {
    file: 'KeyBlock.mesa',
    group: 'Template',
    src: `<script>
  // {#key expr} — destroy and recreate content when expr changes.
  // Every re-creation:
  //   • removes the old DOM and inserts a fresh clone
  //   • disposes all effects inside the block (bindText, eachBlock, etc.)
  //   • re-runs any {@attach} functions on the new elements
  //   • replays CSS animations (elements enter fresh each time)
  //
  // Primary use case: force a child component to reset its internal state.
  // Secondary use case: replay enter animations on data change.

  let userId   = 1
  let resetKey = 0

  const users = {
    1: { name: 'Alice', role: 'Admin',  color: '#dbeafe' },
    2: { name: 'Bob',   role: 'Editor', color: '#dcfce7' },
    3: { name: 'Carol', role: 'Viewer', color: '#fef9c3' },
  }

  const user = users[userId]

  function nextUser()   { userId = userId < 3 ? userId + 1 : 1 }
  function forceReset() { resetKey++ }
</script>

<div style="display:flex;gap:8px;margin-bottom:12px">
  <button on:click={nextUser}>Next user →</button>
  <button on:click={forceReset}>Force reset ↺</button>
</div>

<!-- {#key [userId, resetKey]} — recreates the card on any change to either value.
     The CSS animation replays on every recreate. -->
{#key [userId, resetKey]}
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;max-width:320px;
              background:{user.color};animation:fadeUp .25s ease-out">
    <h3 style="margin:0 0 4px">{user.name}</h3>
    <p style="margin:0 0 10px;color:#374151;font-size:13px">{user.role}</p>
    <p style="margin:0;font-size:11px;color:#6b7280">
      key: [{userId}, {resetKey}] — animation replays on every recreate
    </p>
  </div>
{/key}

<style>
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
</style>`,
  },

  snippets: {
    file: 'Snippets.mesa',
    group: 'Template',
    src: `<script>
  // {#snippet name(args)} defines a reusable template fragment.
  // {@render name(args)} mounts it inline — can be called multiple times.
  // Snippets close over reactive variables from the outer component scope.

  let filter = 'all'

  const people = [
    { name: 'Alice', role: 'Engineer', status: 'active'   },
    { name: 'Bob',   role: 'Designer', status: 'inactive' },
    { name: 'Carol', role: 'Manager',  status: 'active'   },
    { name: 'Dan',   role: 'Engineer', status: 'active'   },
  ]

  const filtered = filter === 'all'
    ? people
    : people.filter(p => p.status === filter)

  const activeCount   = people.filter(p => p.status === 'active').length
  const inactiveCount = people.length - activeCount
</script>

{#snippet badge(status)}
  <span class="badge" data-status={status}>{status}</span>
{/snippet}

{#snippet row(person)}
  <tr class="row">
    <td class="name">{person.name}</td>
    <td class="role">{person.role}</td>
    <td>{@render badge(person.status)}</td>
  </tr>
{/snippet}

<style>
  .badge { display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px }
  .badge[data-status="active"]   { background:#d1fae5;color:#065f46 }
  .badge[data-status="inactive"] { background:#f3f4f6;color:#6b7280 }
  table { width:100%;border-collapse:collapse;font-size:13px }
  th { padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;border-bottom:2px solid #e5e7eb }
  td.name { padding:8px 12px;font-weight:500 }
  td.role { padding:8px 12px;color:#6b7280;font-size:13px }
  td      { padding:8px 12px;border-bottom:1px solid #f3f4f6 }
  .filters { display:flex;gap:8px;margin-bottom:12px }
  .filters button { padding:4px 12px;border-radius:4px;border:1px solid #e5e7eb;background:#fff;cursor:pointer }
  .filters button.active { background:#1e1e2e;color:#fff;border-color:#1e1e2e }
</style>

<div class="filters">
  <button class={filter === 'all'      ? 'active' : ''} on:click={() => filter = 'all'}>All ({people.length})</button>
  <button class={filter === 'active'   ? 'active' : ''} on:click={() => filter = 'active'}>Active ({activeCount})</button>
  <button class={filter === 'inactive' ? 'active' : ''} on:click={() => filter = 'inactive'}>Inactive ({inactiveCount})</button>
</div>

<table>
  <thead>
    <tr><th>Name</th><th>Role</th><th>Status</th></tr>
  </thead>
  <tbody>
    {#each filtered as person (person.name)}
      {@render row(person)}
    {/each}
  </tbody>
</table>

{#if filtered.length === 0}
  <p style="color:#9ca3af;font-size:13px;margin-top:12px">No results.</p>
{/if}`,
  },

  watchHandler: {
    file: 'WatchHandler.mesa',
    group: 'Reactivity',
    src: `<script>
  // $: dep, handler  — explicit dep, handler runs untracked
  // Dep changes trigger the handler. Handler body does NOT auto-subscribe.

  let count = 0
  let name  = 'Alice'
  const doubled = count * 2

  // Single dep
  $: count, () => {
    document.title = 'count: ' + count
  }

  // Multi dep — both count and name trigger this handler
  $_logBoth: (count, name), () => {
    console.log('[logBoth] count:', count, 'name:', name)
  }
</script>

<h2>$: watch + handler</h2>
<p>count: {count} — doubled: {doubled}</p>
<p>name: {name}</p>
<p style="font-size:12px;color:#6b7280">Page title and console update on change.</p>

<input bind:value={name} placeholder="name" />
<br/>
<button on:click={() => count++}>count++</button>
<button on:click={() => count = 0}>Reset</button>`
  },

  objectPathWatch: {
    file: 'ObjectPathWatch.mesa',
    group: 'Reactivity',
    src: `<script>
  // Watching a PATH on a local object.
  //
  // "$: settings.theme, handler" opts \`settings\` into deep watching and
  // subscribes to that path alone. A write elsewhere in the object does not
  // wake this handler — compare the two counters below.
  //
  // The handler receives (current, previous). Because a watch+handler is
  // deferred — it does not run on mount — the first call already has a real
  // previous value, so there is no undefined to guard against.

  let settings = { theme: 'light', fontSize: 14, profile: { name: 'Ada' } }

  let themeLog    = []
  let fontChanges = 0
  let nameLog     = ''

  $: settings.theme, (now, before) => {
    themeLog = [...themeLog, before + ' -> ' + now]
  }

  $: settings.fontSize, () => { fontChanges++ }

  // A watch covers its path AND everything beneath it.
  $: settings.profile, (now) => { nameLog = 'profile changed, name is ' + now.name }

  function toggleTheme() {
    settings.theme = settings.theme === 'light' ? 'dark' : 'light'
  }
  function bigger()  { settings.fontSize = settings.fontSize + 1 }
  function rename()  { settings.profile.name = settings.profile.name === 'Ada' ? 'Grace' : 'Ada' }
  function replace() { settings = { ...settings, profile: { name: 'Linus' } } }
</script>

<h2>Watching a path on a local object</h2>

<p>theme: <strong>{settings.theme}</strong> · fontSize: <strong>{settings.fontSize}</strong>
   · name: <strong>{settings.profile.name}</strong></p>

<button on:click={toggleTheme}>Toggle theme</button>
<button on:click={bigger}>fontSize + 1</button>
<button on:click={rename}>Rename</button>
<button on:click={replace}>Replace whole object</button>

<hr/>

<p style="font-size:12px;color:#6b7280">
  theme watch fired {themeLog.length}x · fontSize watch fired {fontChanges}x
</p>
{#each themeLog as line, i (i)}
  <p style="font-size:11px;color:#6b7280;margin:0">• {line}</p>
{/each}
<p style="font-size:11px;color:#6b7280">{nameLog}</p>

<p style="font-size:12px;color:#9ca3af;margin-top:10px">
  Renaming fires the profile watch and nothing else — a watch covers its path
  and everything beneath it, and no more. Replacing the whole object re-proxies
  it, and the same watches stay live against the new one: that costs one firing
  of <em>every</em> watch on the object, which is why the log can show an
  unchanged pair like <code>dark -> dark</code> after a replace.
</p>`,
  },

  orderedWatchBlock: {
    file: 'OrderedWatchBlock.mesa',
    group: 'Reactivity',
    src: `<script>
  // A "$: { }" block runs the code inside it. Two entry shapes live there:
  //
  //   dep, () => { ... }   an explicit watch — fires only when dep changes
  //   plain statements     an auto-effect — subscribes to whatever it reads
  //
  // Entries run in declaration order, once per flush, batched together. That
  // is what separate "$:" lines do not give you: order inside the block is
  // guaranteed, so a later entry always sees what an earlier one wrote.
  //
  // The handler must be an INLINE function. A reference to one declared
  // elsewhere is a compile error — the compiler cannot see its dependencies.

  let quantity  = 2
  let unitPrice = 10
  let log = []

  let subtotal = 0
  let shipping = 0
  let total    = 0

  $: {
    quantity, () => {
      subtotal = quantity * unitPrice
      log = [...log, '1. subtotal = ' + subtotal]
    }
    subtotal, () => {
      shipping = subtotal > 50 ? 0 : 5
      log = [...log, '2. shipping = ' + shipping]
    }
    shipping, () => {
      total = subtotal + shipping
      log = [...log, '3. total = ' + total]
    }
  }

  function reset() { quantity = 2; log = [] }
</script>

<h2>Ordered watch group</h2>

<p>{quantity} × {unitPrice} = {subtotal} + {shipping} shipping =
   <strong>{total}</strong></p>

<button on:click={() => quantity++}>quantity++</button>
<button on:click={() => quantity += 4}>quantity += 4 (crosses free shipping)</button>
<button on:click={reset}>Reset</button>

<hr/>
<p style="font-size:11px;color:#6b7280">
  Run order — each entry sees the previous one's write:
</p>
{#each log as line, i (i)}
  <p style="font-size:11px;color:#6b7280;margin:0">{line}</p>
{/each}`,
  },

  cleanupOnRerun: {
    file: 'CleanupOnRerun.mesa',
    group: 'Reactivity',
    src: `<script>
  // $onCleanup registers a function that runs BEFORE the handler re-runs
  // and when the component is destroyed.
  // Must be called before the first await in an async handler.
  // Use it to: cancel timers, abort fetches, clear intervals.

  let query    = ''
  let status   = 'idle'
  let results  = []
  let runCount = 0

  $_search: query, async () => {
    if (!query.trim()) {
      results = []
      status  = 'idle'
      return
    }

    // This timer is cancelled when query changes before it fires
    const id = setTimeout(async () => {
      status = 'searching'
      await new Promise(r => setTimeout(r, 500))
      runCount++
      results = [
        query + ' result A',
        query + ' result B',
        query.toUpperCase() + ' result C',
      ]
      status = 'done'
    }, 400)

    // $onCleanup runs before next execution — cancels in-flight timer
    $onCleanup(() => {
      clearTimeout(id)
      status = 'cancelled'
    })

    status = 'waiting'
  }
</script>

<h2>$onCleanup — cancel on rerun</h2>
<p>Status: <strong>{status}</strong> — completed searches: {runCount}</p>

<input bind:value={query} placeholder="Type to search (debounced 400ms)…" />

{#if results.length}
  {#each results as r (r)}
    <p>• {r}</p>
  {/each}
{/if}`
  },

  watchAsync: {
    file: 'WatchAsync.mesa',
    group: 'Reactivity',
    src: `<script>
  let query   = ''
  let results = []
  let searching = false

  $: query, async () => {
    if (!query.trim()) { results = []; return }
    searching = true
    const id = setTimeout(async () => {
      await new Promise(r => setTimeout(r, 300))
      results = [
        'Result for: ' + query,
        'Another: ' + query.toUpperCase(),
        query + ' (cached)',
      ]
      searching = false
    }, 400)
    $onCleanup(() => { clearTimeout(id); searching = false })
  }
</script>

<h2>async watch + handler</h2>
<p>Searches 400ms after you stop typing.</p>

<input bind:value={query} placeholder="Type to search…" />

{#if searching}
  <p><em>Searching…</em></p>
{:else if results.length}
  {#each results as r (r)}
    <p>• {r}</p>
  {/each}
{:else if query}
  <p><em>Type more to search</em></p>
{/if}`
  },

  debugLabels: {
    file: 'DebugLabels.mesa',
    group: 'Reactivity',
    src: `<script>
  // $: is the base form.
  // $_name: is identical but attaches a debug label visible in the Graph panel.
  // $anyName: without underscore is reserved — compiler error.
  // $watch: and $effect: are removed — compiler errors.

  let count = 0
  let name  = 'world'
  let log   = ''

  const greeting = 'Hello, ' + name + '!'

  $_logCount: count, () => {
    console.log('[logCount] count is now', count)
  }

  $_updateLog: (count, name), () => {
    log = 'count=' + count + '  name=' + name
  }

  $_nameSettled: name, async () => {
    const t = setTimeout(() => {
      console.log('[nameSettled] name settled:', name)
    }, 200)
    $onCleanup(() => clearTimeout(t))
  }
</script>

<h2>$_name: debug labels</h2>
<p>greeting: <strong>{greeting}</strong></p>
<p>log (from $_updateLog): <em>{log}</em></p>
<p><input bind:value={name} placeholder="name" /></p>
<button on:click={() => count++}>count++</button>
<button on:click={() => count = 0}>Reset</button>
<p style="font-size:11px;color:#9ca3af">
  Check the Graph tab — debug names appear on watch handlers.
</p>`
  },

  // ── Async ────────────────────────────────────────────────────────────────────

  asyncOnce: {
    file: 'AsyncOnce.mesa',
    group: 'Async',
    src: `<script>
  // const x = await expr  with no reactive deps → runs once at mount.
  // $async.x.loading / fetching / error / status are auto-generated.

  const config = await Promise.resolve({
    theme: 'light',
    version: '0.3',
    features: ['signals', 'derive', 'watch']
  })
</script>

<h2>Async — one-shot</h2>

{#if $async.config.loading}
  <p><em>Loading config…</em></p>
{:else}
  <p>Theme: {config?.theme}</p>
  <p>Version: {config?.version}</p>
  <p>Features: {config?.features?.join(', ')}</p>
{/if}`
  },

  asyncDerived: {
    file: 'AsyncDerived.mesa',
    group: 'Async',
    src: `<script>
  // const x = await expr(dep)  where dep is reactive → re-runs when dep changes.
  // In-flight requests are automatically cancelled when dep changes.
  // $async.user.fetching is true any time a fetch is in progress.

  let userId = 1

  const user = await fetch(
    'https://jsonplaceholder.typicode.com/users/' + userId
  ).then(r => r.json()).catch(() => ({ name: 'Offline', email: 'n/a' }))
</script>

<h2>Async derived — User {userId}</h2>

{#if $async.user.fetching}
  <p><em>Loading…</em></p>
{:else if $async.user.error}
  <p style="color:#ef4444">Error: {$async.user.error.message}</p>
{:else}
  <p><strong>{user?.name}</strong></p>
  <p>{user?.email}</p>
  <p>{user?.address?.city}, {user?.address?.zipcode}</p>
{/if}

<button on:click={() => userId = Math.min(10, userId + 1)}>Next user →</button>
<button on:click={() => userId = Math.max(1,  userId - 1)}>← Prev user</button>`
  },

  // ── Kitchen Sink ─────────────────────────────────────────────────────────────

  kitchenSink: {
    file: 'KitchenSink.mesa',
    group: 'Kitchen Sink',
    src: `<script>
  // ── All three prop types ───────────────────────────────────────────────────
  export let  initialBudget = 500     // reactive prop — parent can update, component can reassign
  export const currency     = 'USD'   // immutable prop — parent sets, component cannot reassign
  export var  region        = 'US'    // snapshot prop — captured once at mount, never updates

  // ── Reactive state ────────────────────────────────────────────────────────
  let cart  = []
  let query = ''
  let tab   = 'shop'   // 'shop' | 'cart' | 'orders'
  let theme = 'light'

  // ── Non-reactive sampler ──────────────────────────────────────────────────
  var openingBudget = initialBudget   // snapshot at mount — never updates

  // ── Context ───────────────────────────────────────────────────────────────
  $context.theme  = theme             // provides theme to any descendant
  $context.region = region            // provides snapshot region downward

  // ── Catalogue (static const — no deps) ───────────────────────────────────
  const catalogue = [
    { id: 1, name: 'Apples',     price: 1.20, emoji: '🍎' },
    { id: 2, name: 'Bread',      price: 2.50, emoji: '🍞' },
    { id: 3, name: 'Coffee',     price: 8.99, emoji: '☕' },
    { id: 4, name: 'Eggs',       price: 3.49, emoji: '🥚' },
    { id: 5, name: 'Feta',       price: 4.99, emoji: '🧀' },
    { id: 6, name: 'Granola',    price: 6.50, emoji: '🥣' },
  ]

  // ── Derived consts ────────────────────────────────────────────────────────
  const filtered   = catalogue.filter(p =>
    p.name.toLowerCase().includes(query.toLowerCase())
  )
  const cartTotal  = cart.reduce((s, i) => s + i.price * i.qty, 0)
  const cartCount  = cart.reduce((s, i) => s + i.qty, 0)
  const cartLines  = cart.length
  const overBudget = cartTotal > initialBudget

  // ── Writable derived — re-derives but can be overridden ───────────────────
  $: budget = initialBudget - cartTotal

  // ── Async ─────────────────────────────────────────────────────────────────
  const orders = await Promise.resolve([
    { id: 'ORD-001', total: 24.50, status: 'delivered' },
    { id: 'ORD-002', total: 11.20, status: 'in transit' },
  ])

  // ── Watch + handler with cleanup ──────────────────────────────────────────
  $_cartChange: cartTotal, () => {
    if (cartTotal > 0)
      console.log('[cart] total now ' + cartTotal.toFixed(2))
  }

  $_queryLog: query, async () => {
    if (!query) return
    const t = setTimeout(() =>
      console.log('[search] settled:', query), 300)
    $onCleanup(() => clearTimeout(t))
  }

  // ── Auto-tracked side effect ───────────────────────────────────────────────
  $: document.title = 'KitchenSink — ' + cartCount + ' items'

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  $onMount(() => console.log('[mount] region:', region, 'currency:', currency))

  // ── Functions ─────────────────────────────────────────────────────────────
  function addToCart(product) {
    const existing = cart.find(i => i.id === product.id)
    cart = existing
      ? cart.map(i => i.id === product.id ? { ...i, qty: i.qty + 1 } : i)
      : [...cart, { ...product, qty: 1 }]
  }

  function removeFromCart(id) { cart = cart.filter(i => i.id !== id) }

  function checkout() {
    alert('Checked out ' + cartCount + ' items for ' + currency + ' ' + cartTotal.toFixed(2))
    cart = []
    tab  = 'orders'
  }

  function toggleTheme() { theme = theme === 'light' ? 'dark' : 'light' }

  // ── Snippet props — optional slots passed from a parent component ──────────
  export let header = null    // parent can pass: {#snippet header()}<h1>Hi</h1>{/snippet}
  export let footer = null    // parent can pass: {#snippet footer()}<p>Bye</p>{/snippet}
</script>

<!-- Optional header snippet — renders if parent provided one -->
{@render header?.()}

<!-- Nav + theme toggle -->
<div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap">
  <button on:click={() => tab = 'shop'}
    style="font-weight:{tab==='shop'?'700':'400'}">🛒 Shop</button>
  <button on:click={() => tab = 'cart'}
    style="font-weight:{tab==='cart'?'700':'400'}">Cart ({cartCount})</button>
  <button on:click={() => tab = 'orders'}
    style="font-weight:{tab==='orders'?'700':'400'}">Orders</button>
  <span style="margin-left:auto;font-size:11px;color:#9ca3af">
    {region} · {currency}
  </span>
  <button on:click={toggleTheme}>{theme === 'light' ? '🌙' : '☀️'}</button>
</div>

<!-- Budget bar — uses writable derived $: budget -->
<p style="font-size:12px;color:{overBudget?'#ef4444':'#6b7280'};margin-bottom:8px">
  Budget: \${openingBudget.toFixed(2)} ·
  spent: \${cartTotal.toFixed(2)} ·
  remaining: <strong style="color:{overBudget?'#ef4444':'inherit'}">\${budget.toFixed(2)}</strong>
  {#if overBudget}⚠ Over!{/if}
</p>

<hr/>

<!-- Snippets — reusable template fragments -->
{#snippet priceTag(item)}
  <span style="font-size:11px;color:#6b7280">\${item.price.toFixed(2)} {currency}</span>
{/snippet}

{#snippet statusBadge(status)}
  <span style="font-size:10px;padding:1px 7px;border-radius:99px;
    background:{status==='delivered'?'#d1fae5':'#fef3c7'};
    color:{status==='delivered'?'#065f46':'#92400e'}">{status}</span>
{/snippet}

<!-- ── Tabs ── -->

{#if tab === 'shop'}
  <input bind:value={query} placeholder="Search…" style="margin-bottom:8px;width:100%"/>

  {#if filtered.length === 0}
    <p style="color:#9ca3af"><em>No match for "{query}"</em></p>
  {:else}
    {#each filtered as p (p.id)}
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f3f4f6">
        <span style="font-size:18px">{p.emoji}</span>
        <span style="flex:1">{p.name}</span>
        {@render priceTag(p)}
        <button on:click={() => addToCart(p)}>＋</button>
      </div>
    {/each}
  {/if}

{:else if tab === 'cart'}
  {#if cartLines === 0}
    <p style="color:#9ca3af"><em>Cart is empty.</em></p>
  {:else}
    {#each cart as item (item.id)}
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f3f4f6">
        <span style="font-size:18px">{item.emoji}</span>
        <span style="flex:1">{item.name} × {item.qty}</span>
        {@render priceTag({ price: item.price * item.qty })}
        <button on:click={() => removeFromCart(item.id)}>✕</button>
      </div>
    {/each}
    <p style="margin-top:10px"><strong>Total: \${cartTotal.toFixed(2)} {currency}</strong></p>
    <button on:click={checkout}>Checkout</button>
  {/if}

{:else}
  {#if $async.orders.loading}
    <p><em>Loading orders…</em></p>
  {:else}
    {#each orders as o (o.id)}
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f3f4f6">
        <span style="flex:1;font-size:12px">{o.id}</span>
        {@render statusBadge(o.status)}
        <strong style="font-size:12px">\${o.total.toFixed(2)}</strong>
      </div>
    {/each}
  {/if}
{/if}

<!-- Optional footer snippet -->
{@render footer?.()}

<style>
  button {
    background: #1e1e2e;
    color: #fff;
    border: none;
    padding: 4px 11px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: opacity .15s;
  }
  button:hover { opacity: .8; }
  input {
    border: 1px solid #d1d5db;
    border-radius: 4px;
    padding: 5px 9px;
    font-size: 13px;
    outline: none;
  }
</style>`,
  },

  // ── Events ───────────────────────────────────────────────────────────────────

  eventModifiers: {
    file: 'EventModifiers.mesa',
    group: 'Events',
    src: `<script>
  // on:event|modifier|modifier(arg)
  //
  // Compile-time → addEventListener options:
  //   |once    — remove handler after first call
  //   |passive — promise not to call preventDefault (scroll performance)
  //   |capture — fire in capture phase
  //
  // Guard modifiers → inline guards before handler body:
  //   |preventDefault  — e.preventDefault()
  //   |stopPropagation — e.stopPropagation()
  //   |self            — only when target === currentTarget
  //   |trusted         — only real user events (not dispatchEvent)
  //
  // Wrap modifiers → handler wrapped at runtime:
  //   |debounce(ms)  — debounce; arg can be a reactive variable: |debounce({delay})
  //   |throttle(ms)  — throttle

  let log    = []
  let delay  = 300
  let input  = ''
  let clicks = 0

  function addLog(msg) { log = [...log.slice(-6), { msg, id: Date.now() + Math.random() }] }

  function handleDebounced() {
    addLog('debounced: "' + input + '"')
  }

  function handleOnce() {
    clicks++
    addLog("once-click fired (won't fire again)")
  }

  function handleSelf() {
    addLog('self: clicked the container, not a child')
  }

  function handleSubmit() {
    addLog('form submitted — default prevented, no page reload')
  }
</script>

<h2>Event modifiers</h2>

<!-- |preventDefault on form submit -->
<form on:submit|preventDefault={handleSubmit} style="margin-bottom:12px">
  <input type="text" value="type anything" />
  <button type="submit">Submit (no reload)</button>
</form>

<!-- |once — listener removes itself after first call -->
<div style="margin-bottom:8px">
  <button on:click|once={handleOnce}>Click me (fires once only)</button>
  <span style="font-size:12px;color:#6b7280"> — clicked {clicks}×</span>
</div>

<!-- |debounce with reactive delay arg -->
<div style="margin-bottom:12px">
  <label style="font-size:12px">Debounce delay: {delay}ms</label>
  <input type="range" min="100" max="1000" step="100" bind:value={delay} />
  <br/>
  <input
    bind:value={input}
    on:input|debounce({delay})={handleDebounced}
    placeholder="Type — fires {delay}ms after you stop"
    style="margin-top:4px;width:280px"
  />
</div>

<!-- |self — fires only when clicking the container, not children -->
<div
  on:click|self={handleSelf}
  style="padding:12px;background:#f3f4f6;border-radius:4px;
         margin-bottom:12px;cursor:pointer"
>
  Click grey area (|self) — not the button below
  <button on:click={() => addLog('inner button clicked')}>inner button</button>
</div>

<div style="font-size:12px;font-family:monospace;padding:8px;background:#f9fafb;
            border:1px solid #e5e7eb;border-radius:4px;min-height:40px">
  {#each log as entry (entry.id)}
    <div>→ {entry.msg}</div>
  {:else}
    <div style="color:#9ca3af">events appear here…</div>
  {/each}
</div>`
  },

  bindGroup: {
    file: 'BindGroup.mesa',
    group: 'Events',
    src: `<script>
  // bind:group={signal}
  //
  // Checkboxes → signal is an array. Selected values are added/removed.
  // Radios     → signal is a scalar. Set to the selected value.

  let toppings = ['cheese']
  let size     = 'M'
  let crust    = 'thin'

  const toppingPrice = { cheese: 0, pepperoni: 1.50, mushrooms: 1.00, olives: 0.75 }
  const sizePrice    = { S: 8, M: 11, L: 14 }

  const extrasTotal = toppings.reduce((s, t) => s + (toppingPrice[t] || 0), 0)
  const total       = (sizePrice[size] || 0) + extrasTotal
</script>

<h2>Pizza Builder — bind:group</h2>

<h3 style="margin:8px 0 4px">Size (radio → scalar)</h3>
{#each ['S', 'M', 'L'] as s (s)}
  <label style="margin-right:12px">
    <input type="radio" bind:group={size} value={s} />
    {s} — \${sizePrice[s]}
  </label>
{/each}

<h3 style="margin:8px 0 4px">Crust</h3>
{#each ['thin', 'thick', 'stuffed'] as c (c)}
  <label style="margin-right:12px">
    <input type="radio" bind:group={crust} value={c} />
    {c}
  </label>
{/each}

<h3 style="margin:8px 0 4px">Toppings (checkbox → array)</h3>
{#each Object.keys(toppingPrice) as t (t)}
  <label style="margin-right:12px">
    <input type="checkbox" bind:group={toppings} value={t} />
    {t} {toppingPrice[t] > 0 ? '(+\$' + toppingPrice[t].toFixed(2) + ')' : '(free)'}
  </label>
{/each}

<hr style="margin:12px 0"/>
<p>
  <strong>{size}</strong> {crust} crust
  with {toppings.length ? toppings.join(', ') : 'no toppings'}
</p>
<p><strong>Total: \${total.toFixed(2)}</strong></p>`
  },

  // ── DOM ──────────────────────────────────────────────────────────────────────

  bindThis: {
    file: 'BindThis.mesa',
    group: 'DOM',
    src: `<script>
  // bind:this={var} — capture the raw DOM node into a reactive variable.
  // Set immediately after element mounts. Use in $onMount or handlers.

  let canvas
  let inputEl
  let focused = false

  $onMount(() => {
    const ctx = canvas.getContext('2d')
    drawShapes(ctx, '#6366f1', '#f59e0b')
  })

  function drawShapes(ctx, a, b) {
    ctx.clearRect(0, 0, 300, 100)
    ctx.fillStyle = a
    ctx.fillRect(10, 10, 80, 80)
    ctx.fillStyle = b
    ctx.beginPath()
    ctx.arc(150, 50, 40, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = a
    ctx.fillRect(210, 10, 80, 80)
  }

  function recolor(a, b) {
    drawShapes(canvas.getContext('2d'), a, b)
  }

  function focusInput() {
    inputEl.focus()
    inputEl.select()
  }
</script>

<h2>bind:this</h2>

<canvas bind:this={canvas} width="300" height="100"
  style="border:1px solid #e5e7eb;border-radius:4px;display:block;margin-bottom:8px">
</canvas>

<div style="margin-bottom:16px">
  <button on:click={() => recolor('#6366f1','#f59e0b')}>Indigo / Amber</button>
  <button on:click={() => recolor('#10b981','#f43f5e')}>Green / Rose</button>
  <button on:click={() => recolor('#8b5cf6','#06b6d4')}>Violet / Cyan</button>
</div>

<div>
  <input
    bind:this={inputEl}
    placeholder="Click the button to focus me"
    style="width:240px"
    on:focus={() => focused = true}
    on:blur={() => focused = false}
  />
  <button on:click={focusInput}>Focus</button>
  <span style="font-size:12px;color:{focused?'#10b981':'#9ca3af'}">
    {focused ? '● focused' : '○ blurred'}
  </span>
</div>`
  },

  styleClass: {
    file: 'StyleClass.mesa',
    group: 'DOM',
    src: `<script>
  // class:name={expr}  — conditionally apply a CSS class
  // class:name         — shorthand: applies class when variable "name" is truthy
  //
  // style:prop={expr}           — reactive inline style (pure expression)
  // style:prop="{expr}unit"     — mixed value: expression + literal suffix (e.g. "{size}px")

  let active  = false
  let loading = false
  let size    = 16
  let hue     = 220
  let opacity = 1

  const bg      = 'hsl(' + hue + ', 70%, 55%)'
  const textCol = 'hsl(' + hue + ', 70%, 15%)'

  function toggle() {
    loading = true
    setTimeout(() => { active = !active; loading = false }, 500)
  }
</script>

<style>
  .card {
    padding: 16px;
    border-radius: 8px;
    border: 2px solid #e5e7eb;
    transition: border-color 0.2s, background 0.2s;
    margin-bottom: 12px;
  }
  .active  { border-color: #6366f1; background: #eef2ff; }
  .loading { opacity: 0.5; pointer-events: none; }
</style>

<h2>class: and style: directives</h2>

<!-- class: with expression and shorthand form -->
<div class="card" class:active class:loading>
  <code>class:active</code> (shorthand — applies when <code>active</code> is truthy)<br/>
  <code>class:loading</code> (shorthand)<br/>
  <br/>
  Status: <strong style="color:{active?'#6366f1':'#9ca3af'}">
    {loading ? 'loading…' : active ? 'active' : 'inactive'}
  </strong>
</div>

<button on:click={toggle} style="margin-bottom:20px">Toggle active</button>

<!-- style: with pure expression and mixed template value -->
<div style="margin-bottom:8px">
  <label style="font-size:12px">font-size: {size}px</label>
  <input type="range" min="10" max="36" bind:value={size} />
</div>
<div style="margin-bottom:8px">
  <label style="font-size:12px">hue: {hue}</label>
  <input type="range" min="0" max="360" bind:value={hue} />
</div>
<div style="margin-bottom:12px">
  <label style="font-size:12px">opacity: {opacity.toFixed(2)}</label>
  <input type="range" min="0" max="1" step="0.05" bind:value={opacity} />
</div>

<!--
  style:font-size="{size}px"  — mixed template literal value
  style:color={textCol}       — pure expression
  style:opacity={opacity}     — pure expression
-->
<p
  style:font-size="{size}px"
  style:color={textCol}
  style:background-color={bg}
  style:opacity={opacity}
  style="padding:10px 14px;border-radius:6px;display:inline-block"
>
  Live styled text — {size}px, hue {hue}
</p>`
  },

  attachLifecycle: {
    file: 'AttachLifecycle.mesa',
    group: 'DOM',
    src: `<script>
  // {@attach fn}  — element-level lifecycle
  //
  // fn(el) is called when element mounts.
  // Cleanup return values:
  //   () => void  — called before re-run and on element destroy
  //   Promise     — element stays in DOM until resolved (deferred removal for exit animations)

  let log = []
  function addLog(msg) { log = [...log.slice(-7), msg] }

  // Autofocus on mount
  function autofocus(el) {
    el.focus()
    addLog('mounted + focused: ' + el.tagName)
    return () => addLog('cleanup: ' + el.tagName)
  }

  // Tooltip — reactive: re-runs when the expression changes
  function tooltip(text) {
    return (el) => {
      el.title = text
      addLog('tooltip: "' + text + '"')
      return () => { el.removeAttribute('title'); addLog('tooltip removed') }
    }
  }

  // ResizeObserver
  function watchSize(el) {
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      addLog('size: ' + Math.round(width) + ' × ' + Math.round(height))
    })
    ro.observe(el)
    addLog('ResizeObserver started')
    return () => { ro.disconnect(); addLog('ResizeObserver stopped') }
  }

  let count = 0
</script>

<h2>&#123;@attach&#125; element lifecycle</h2>

<input
  {@attach autofocus}
  placeholder="Auto-focused on mount"
  style="display:block;margin-bottom:8px;width:240px"
/>

<button
  {@attach tooltip('Clicked ' + count + ' times')}
  on:click={() => count++}
  style="margin-bottom:8px"
>
  Hover me — clicked {count}×
  <span style="font-size:11px;color:#9ca3af">(tooltip re-attaches on count change)</span>
</button>

<div
  {@attach watchSize}
  style="resize:both;overflow:auto;width:200px;min-height:60px;
         background:#f3f4f6;padding:8px;border-radius:4px;
         border:1px solid #e5e7eb;margin-bottom:12px;cursor:se-resize"
>
  Drag corner to resize →
</div>

<div style="font-size:11px;font-family:monospace;padding:8px;
            background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;min-height:36px">
  {#each log as entry (entry)}
    <div>→ {entry}</div>
  {:else}
    <div style="color:#9ca3af">lifecycle events appear here…</div>
  {/each}
</div>`
  },

  // ── Globals ──────────────────────────────────────────────────────────────────

  mesaWindow: {
    file: 'MesaWindow.mesa',
    group: 'Globals',
    src: `<script>
  // <mesa:window> — bind events and properties to window
  //
  // on:event={handler}      — window.addEventListener
  // bind:innerWidth={var}   — reactive, updates on resize
  // bind:scrollY={var}      — reactive, updates on scroll
  // bind:online={var}       — reactive, updates on network change
  //
  // Supported bindable props:
  //   innerWidth, innerHeight, outerWidth, outerHeight,
  //   devicePixelRatio, scrollX, scrollY, online

  let innerWidth = 0
  let scrollY    = 0
  let online     = true
  let keyLog     = []
  let mx = 0, my = 0

  function handleKey(e) {
    keyLog = [...keyLog.slice(-5),
      e.key + (e.ctrlKey ? '+ctrl' : '') + (e.shiftKey ? '+shift' : '')]
  }

  function handleMouse(e) { mx = e.clientX; my = e.clientY }
</script>

<mesa:window
  bind:innerWidth={innerWidth}
  bind:scrollY={scrollY}
  bind:online={online}
  on:keydown={handleKey}
  on:mousemove={handleMouse}
/>

<h2>&lt;mesa:window&gt;</h2>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
  <div style="padding:10px;background:#f3f4f6;border-radius:6px">
    <div style="font-size:11px;color:#6b7280;margin-bottom:2px">innerWidth</div>
    <strong>{innerWidth}px</strong>
  </div>
  <div style="padding:10px;background:#f3f4f6;border-radius:6px">
    <div style="font-size:11px;color:#6b7280;margin-bottom:2px">scrollY</div>
    <strong>{scrollY}px</strong>
  </div>
  <div style="padding:10px;background:{online?'#d1fae5':'#fee2e2'};border-radius:6px">
    <div style="font-size:11px;color:#6b7280;margin-bottom:2px">online</div>
    <strong>{online ? '✓ online' : '✗ offline'}</strong>
  </div>
  <div style="padding:10px;background:#f3f4f6;border-radius:6px">
    <div style="font-size:11px;color:#6b7280;margin-bottom:2px">mouse</div>
    <strong>{mx}, {my}</strong>
  </div>
</div>

<p style="font-size:12px;color:#6b7280">Resize window, scroll, move mouse, or press keys.</p>

<div style="font-size:12px;font-family:monospace;margin-top:8px">
  <span style="color:#6b7280">last keys: </span>
  {#each keyLog as k (k)}
    <span style="background:#e5e7eb;padding:1px 6px;border-radius:3px;margin-right:3px">{k}</span>
  {:else}
    <span style="color:#9ca3af">press any key…</span>
  {/each}
</div>
`
  },

  mesaPortal: {
    file: 'MesaPortal.mesa',
    group: 'Globals',
    src: `<script>
  // <mesa:portal to={target}> — render children into any DOM node
  //
  // Useful for modals and toasts that need to escape overflow:hidden
  // or stacking context. The "to" expr is reactive — portal moves if it changes.
  // Content is removed when the component is destroyed.

  let showModal = false
  let showToast = false
  let toastMsg  = ''
  let timer     = null

  function toast(msg) {
    toastMsg  = msg
    showToast = true
    clearTimeout(timer)
    timer = setTimeout(() => { showToast = false }, 2500)
  }
</script>

<h2>&lt;mesa:portal&gt;</h2>

<p style="font-size:12px;color:#6b7280;margin-bottom:12px">
  Modal and toast render into <code>document.body</code> — they escape
  this component's overflow and stacking context entirely.
</p>

<div style="display:flex;gap:8px;margin-bottom:16px">
  <button on:click={() => showModal = true}>Open modal</button>
  <button on:click={() => toast('Saved successfully ✓')}>Toast: Saved</button>
  <button on:click={() => toast('Link copied to clipboard')}>Toast: Copied</button>
</div>

<!-- Clipped container — normal absolute positioning would be clipped here -->
<div style="overflow:hidden;height:72px;padding:12px;background:#fef3c7;
            border:2px dashed #fbbf24;border-radius:4px;position:relative">
  <p style="margin:0;font-size:12px">
    This box has <code>overflow:hidden</code> and <code>position:relative</code>.<br/>
    A normal modal would be clipped. The portal is not.
  </p>
</div>

<!-- Modal portal -->
{#if showModal}
  <mesa:portal to={document.body}>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.45);
                display:flex;align-items:center;justify-content:center;z-index:1000"
         on:click|self={() => showModal = false}>
      <div style="background:white;border-radius:12px;padding:24px 28px;
                  max-width:340px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.25)">
        <h3 style="margin:0 0 8px">Modal via portal</h3>
        <p style="color:#6b7280;margin:0 0 16px;font-size:14px">
          Rendered directly into document.body. Sits above everything.
        </p>
        <button on:click={() => showModal = false}>Close</button>
      </div>
    </div>
  </mesa:portal>
{/if}

<!-- Toast portal -->
{#if showToast}
  <mesa:portal to={document.body}>
    <div style="position:fixed;bottom:24px;right:24px;z-index:9999;
                background:#1f2937;color:white;padding:10px 16px;
                border-radius:8px;font-size:14px;
                box-shadow:0 4px 16px rgba(0,0,0,0.3)">
      {toastMsg}
    </div>
  </mesa:portal>
{/if}`
  },

  // ── Context ──────────────────────────────────────────────────────────────────

  contextBasic: {
    file: 'ContextBasic.mesa',
    group: 'Context',
    src: `<script>
  // $context — subtree-scoped shared state.
  //
  // Write to $context.key at top level to provide to all descendants.
  // Read with let/const/var — same semantics as regular variables:
  //
  //   const x = $context.key   — read-only, re-renders when provider changes
  //   let   x = $context.key   — writable derived, overridable locally
  //   var   x = $context.key   — snapshot at mount, non-reactive
  //
  // Unlike stores, context is per-instance — two <Panel> components
  // each have their own independent $context.theme.

  // ── Provider (this component) ──────────────────────────────────────────────

  let darkMode  = false
  let accentHue = 220

  // Both are provided reactively — descendants auto-update when these change
  $context.theme   = darkMode ? 'dark' : 'light'
  $context.accent  = 'hsl(' + accentHue + ', 70%, 55%)'

  // Also provide a setter so descendants can toggle mode
  $context.toggleDark = () => { darkMode = !darkMode }
</script>

<style>
  .panel {
    padding: 16px;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
  }
  .panel.dark {
    background: #1f2937;
    border-color: #374151;
    color: #f9fafb;
  }
</style>

<h2>$context — Provider</h2>

<div style="margin-bottom:12px">
  <label style="font-size:12px">darkMode: {darkMode ? 'on' : 'off'}</label>
  <button on:click={() => darkMode = !darkMode}>Toggle dark mode</button>
</div>
<div style="margin-bottom:12px">
  <label style="font-size:12px">accentHue: {accentHue}</label>
  <input type="range" min="0" max="360" bind:value={accentHue} />
</div>

<p style="font-size:12px;color:#6b7280">
  The child below reads from context — it has no props, no imports.
  Change the controls above to see it update.
</p>

<!-- Inline child to simulate a descendant reading context -->
<!--
  In a real app this would be a separate .mesa file:

  // ThemedCard.mesa
  <script>
    const theme  = $context.theme    // read-only — re-renders when provider changes
    const accent = $context.accent   // derived expr from provider
    const toggle = $context.toggleDark
  </script>
  <div class="panel" class:dark={theme === 'dark'}>
    <p style:color={accent}>Themed content</p>
    <button onclick={toggle}>Toggle from child</button>
  </div>
-->`
  },

  contextIsolation: {
    file: 'ContextIsolation.mesa',
    group: 'Context',
    // Display.mesa must come before Counter.mesa — extra files compile in
    // order, and each one can only import the ones before it.
    files: [
      {
        name: 'Display.mesa',
        content: `<script>
  // A descendant of <Counter>. No props and no imports — it reads whatever
  // the NEAREST provider above it put in $context.
  //
  //   const → read-only, re-renders when the provider's value changes
  const count  = $context.count
  const accent = $context.accent
  const inc    = $context.inc
  const double = $context.double
  const reset  = $context.reset
</script>

<div class="value" style:color={accent}>{count}</div>

<div class="row">
  <button on:click={inc}>+1</button>
  <button on:click={double}>&times;2</button>
  <button on:click={reset}>reset</button>
</div>

<style>
  .value { font-size: 36px; font-weight: 600; margin-bottom: 8px; }
  .row   { display: flex; gap: 6px; flex-wrap: wrap; }
</style>`,
      },
      {
        name: 'Counter.mesa',
        content: `<script>
  import Display from './Display.mesa'

  // Every <Counter> runs this script again, so every instance gets its own
  // \`count\` and its own $context. That is the whole point: a store is one
  // object everybody shares; a context belongs to one subtree.
  export let label  = ''
  export let accent = '#6366f1'

  let count = 0

  // Provide at the TOP LEVEL — a provide inside a function is a compile error.
  // \`count\` is reactive, so descendants re-render when it changes.
  $context.count  = count
  $context.accent = accent
  $context.inc    = () => count++
  $context.double = () => count = count * 2 || 1
  $context.reset  = () => count = 0
</script>

<div class="box" style:border-color={accent}>
  <div class="label">{label}</div>
  <Display />
</div>

<style>
  .box   { padding: 16px; border: 2px solid; border-radius: 8px; }
  .label { font-size: 11px; color: #6b7280; margin-bottom: 4px; }
</style>`,
      },
    ],
    src: `<script>
  // INSTANCE ISOLATION — the thing context does that a store cannot.
  //
  // Counter.mesa provides its own $context.count, and the <Display> inside it
  // reads that value. Two <Counter> elements are two instances, so there are
  // two independent contexts: clicking one does nothing to the other. A store
  // is a single module-level object — both counters would share it.
  //
  // Open the Counter.mesa and Display.mesa tabs above.
  import Counter from './Counter.mesa'
</script>

<h2>Context — instance isolation</h2>

<p class="note">
  Each box is one &lt;Counter&gt;. It provides $context.count; the
  &lt;Display&gt; inside reads it. No props pass between them, and neither
  counter can see the other's state.
</p>

<div class="grid">
  <Counter label="Instance A" accent="#6366f1" />
  <Counter label="Instance B" accent="#10b981" />
</div>

<p class="note">
  Nothing here is global. Add a third &lt;Counter&gt; and it starts at zero,
  with its own count, its own accent, its own subtree.
</p>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .note { font-size: 12px; color: #6b7280; margin-bottom: 16px; }
</style>`
  },

  // ── Animation ────────────────────────────────────────────────────────────────

  viewTransitions: {
    file: 'ViewTransitions.mesa',
    group: 'Animation',
    src: `<script>
  // $.transition(fn) — wraps a state change in the View Transitions API.
  //
  // The browser captures a screenshot of the current DOM, applies the
  // state change, then cross-fades between old and new. No height collapse,
  // no timing coordination.
  //
  // Control the animation with CSS view-transition-name and
  // ::view-transition-old / ::view-transition-new pseudo-elements.
  //
  // Falls back to batch(fn) in browsers without View Transitions support.

  const tabs = ['Home', 'About', 'Work', 'Contact']
  let   tab  = 'Home'

  const content = {
    Home:    { icon: '🏠', text: 'Welcome home.' },
    About:   { icon: '👤', text: 'A builder of things.' },
    Work:    { icon: '💼', text: 'Five years of shipped products.' },
    Contact: { icon: '✉️', text: 'hello@example.com' },
  }

  let items  = ['Alpha', 'Beta', 'Gamma']
  let nextId = 4

  function switchTab(t) { $.transition(() => tab = t) }

  function addItem() {
    $.transition(() => { items = [...items, 'Item ' + nextId++] })
  }

  function removeFirst() {
    $.transition(() => { if (items.length) items = items.slice(1) })
  }
</script>

<style>
  ::view-transition-old(tab-content),
  ::view-transition-new(tab-content) {
    animation-duration: 180ms;
    animation-timing-function: ease;
  }
  ::view-transition-old(tab-content) { animation-name: vt-fade-out }
  ::view-transition-new(tab-content) { animation-name: vt-fade-in  }
  @keyframes vt-fade-out { to   { opacity: 0 } }
  @keyframes vt-fade-in  { from { opacity: 0 } }
</style>

<h2>$.transition — View Transitions API</h2>

<!-- Tab nav -->
<div style="display:flex;gap:4px;margin-bottom:0">
  {#each tabs as t (t)}
    <button
      on:click={() => switchTab(t)}
      style="padding:6px 14px;border:none;border-radius:6px 6px 0 0;cursor:pointer;
             background:{tab===t?'white':'#f3f4f6'};
             border-bottom:{tab===t?'2px solid #6366f1':'2px solid transparent'};
             font-weight:{tab===t?600:400}"
    >{t}</button>
  {/each}
</div>

<!-- view-transition-name causes browser to animate this area -->
<div style="view-transition-name:tab-content;padding:20px;background:white;
            border-radius:0 8px 8px 8px;border:1px solid #e5e7eb;margin-bottom:16px">
  <div style="font-size:32px">{content[tab].icon}</div>
  <p style="margin:6px 0 0;color:#374151">{content[tab].text}</p>
</div>

<!-- List with transitions -->
<h3 style="margin:0 0 8px;font-size:14px">Transitioning list</h3>
<div style="margin-bottom:8px">
  <button on:click={addItem}>+ Add</button>
  <button on:click={removeFirst}>− Remove first</button>
</div>
{#each items as item (item)}
  <div style="padding:7px 12px;background:#f3f4f6;border-radius:4px;margin-bottom:4px">
    {item}
  </div>
{/each}

<p style="font-size:11px;color:#9ca3af;margin-top:10px">
  Requires Chrome / Edge / Safari 18+. Instant fallback in other browsers.
</p>`
  },

  entranceExit: {
    file: 'EntranceExit.mesa',
    group: 'Animation',
    src: `<script>
  // $.entrance({ in, out }) — enter/exit animation via {@attach}
  //
  // in(el)   — called when element mounts
  // out(el)  — called when element is about to be removed
  //            return a Promise → element stays in DOM until it resolves

  let show  = true
  let items = [
    { id: 1, text: 'First item',  color: '#dbeafe' },
    { id: 2, text: 'Second item', color: '#dcfce7' },
    { id: 3, text: 'Third item',  color: '#fef9c3' },
  ]
  let nextId = 4

  // Web Animations API — fade up/down
  const fade = $.entrance({
    in:  (el) => el.animate(
      [{ opacity: 0, transform: 'translateY(-8px)' },
       { opacity: 1, transform: 'translateY(0)' }],
      { duration: 250, easing: 'ease-out', fill: 'forwards' }
    ),
    out: (el) => el.animate(
      [{ opacity: 1, transform: 'translateY(0)' },
       { opacity: 0, transform: 'translateY(-8px)' }],
      { duration: 200, easing: 'ease-in', fill: 'forwards' }
    ).finished   // returning a Promise defers element removal until animation ends
  })

  // CSS slide — uses $.slide() built-in
  const slideIn = $.slide({ duration: 280 })

  const colors = ['#dbeafe','#dcfce7','#fef9c3','#fce7f3','#ede9fe']

  function addItem() {
    items = [...items, {
      id: nextId,
      text: 'Item ' + nextId,
      color: colors[nextId % colors.length]
    }]
    nextId++
  }

  function removeItem(id) {
    items = items.filter(i => i.id !== id)
  }
</script>

<h2>$.entrance — enter/exit animations</h2>

<p style="font-size:12px;color:#6b7280;margin-bottom:12px">
  Elements animate in on mount and animate out before removal.
  The element stays in the DOM until its exit Promise resolves — no height jump.
</p>

<!-- Single toggle with WAAPI fade -->
<div style="margin-bottom:16px">
  <button on:click={() => show = !show}>
    {show ? 'Hide' : 'Show'} banner
  </button>
  {#if show}
    <div {@attach fade}
         style="margin-top:8px;padding:12px 16px;background:#eef2ff;
                border-left:3px solid #6366f1;border-radius:0 6px 6px 0">
      Fades in/out via Web Animations API — <code>&#123;@attach fade&#125;</code>
    </div>
  {/if}
</div>

<!-- Dynamic list with CSS slide -->
<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
  <button on:click={addItem}>+ Add item</button>
  <span style="font-size:11px;color:#9ca3af">slides in/out via <code>$.slide()</code></span>
</div>

{#each items as item (item.id)}
  <div
    {@attach slideIn}
    style="display:flex;justify-content:space-between;align-items:center;
           padding:8px 12px;border-radius:6px;margin-bottom:6px;
           background:{item.color}"
  >
    <span>{item.text}</span>
    <button
      on:click={() => removeItem(item.id)}
      style="border:none;background:none;cursor:pointer;font-size:16px;opacity:0.5"
    >×</button>
  </div>
{/each}`,
  },

  cssTransitions: {
    file: 'CssTransitions.mesa',
    group: 'Animation',
    src: `<script>
  // CSS transition primitives — $.fade(), $.slide(), $.fly()
  // Zero dependencies, no WAAPI needed.
  // Each returns an attachment function for use with {@attach}.

  let showFade  = true
  let showSlide = true
  let showFly   = true

  // $.fade({ duration?, easing? }) — opacity transition
  const fadeAnim = $.fade({ duration: 200 })

  // $.slide({ duration?, easing? }) — height collapse/expand + opacity
  const slideAnim = $.slide({ duration: 280 })

  // $.fly({ x?, y?, duration?, easing? }) — translate + fade
  const flyUp    = $.fly({ y: -16, duration: 220 })
  const flyRight = $.fly({ x: 20, y: 0, duration: 220 })
</script>

<h2>CSS transition primitives</h2>
<p style="font-size:12px;color:#6b7280;margin-bottom:16px">
  Built-in animations using CSS transitions — no Web Animations API, no dependencies.
</p>

<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">

  <!-- $.fade() -->
  <div>
    <div style="font-size:11px;font-weight:600;margin-bottom:6px;color:#374151">$.fade()</div>
    <button on:click={() => showFade = !showFade} style="margin-bottom:8px;display:block">
      {showFade ? 'Hide' : 'Show'}
    </button>
    {#if showFade}
      <div {@attach fadeAnim}
           style="padding:10px;background:#dbeafe;border-radius:6px;font-size:12px">
        Opacity transition
      </div>
    {/if}
  </div>

  <!-- $.slide() -->
  <div>
    <div style="font-size:11px;font-weight:600;margin-bottom:6px;color:#374151">$.slide()</div>
    <button on:click={() => showSlide = !showSlide} style="margin-bottom:8px;display:block">
      {showSlide ? 'Hide' : 'Show'}
    </button>
    {#if showSlide}
      <div {@attach slideAnim}
           style="padding:10px;background:#dcfce7;border-radius:6px;font-size:12px">
        Height collapse<br/>with overflow hidden
      </div>
    {/if}
  </div>

  <!-- $.fly() -->
  <div>
    <div style="font-size:11px;font-weight:600;margin-bottom:6px;color:#374151">$.fly()</div>
    <button on:click={() => showFly = !showFly} style="margin-bottom:8px;display:block">
      {showFly ? 'Hide' : 'Show'}
    </button>
    {#if showFly}
      <div {@attach flyUp}
           style="padding:10px;background:#fef9c3;border-radius:6px;font-size:12px">
        Translate + fade
      </div>
    {/if}
  </div>

</div>`,
  },

  // ── Markdown ──────────────────────────────────────────────────────────────────

  markdownBasic: {
    file: 'BlogPost.md',
    group: 'Markdown',
    src: `---
title: My First Mesa Post
date: 2025-01-15
author: Ada Lovelace
tags: [mesa, markdown, tutorial]
---

# {title}

*By {author} · {date}*

---

Welcome to **Mesa** — a reactive UI language where markdown is a first-class citizen.

## What you get for free

A \`.md\` file is a Mesa component whose template is markdown — the extension is what
picks the pipeline, not the presence of frontmatter. Frontmatter keys become
\`export const\` declarations, so \`{title}\`, \`{author}\` and \`{date}\` all work as
reactive Mesa expressions.

## Code blocks are untouched

\`\`\`js
let count = 0
function inc() { count++ }
\`\`\`

## Lists work normally

- Frontmatter → \`export const\`
- GFM tables, footnotes, strikethrough
- Mesa expressions \`{expr}\` inside prose
- Mesa components inline

> All tags from **{author}**: {tags.join(', ')}

That's it!`,
  },

  markdownInteractive: {
    file: 'InteractivePost.md',
    group: 'Markdown',
    src: `---
title: Interactive Markdown
summary: Mesa expressions and reactive state inside markdown prose.
---

<script>
  let count = 0
  let name  = 'reader'

  function inc() { count++ }
  function dec() { if (count > 0) count-- }
</script>

# {title}

Hello, {name}! Type your name: <input bind:value={name} style="border:1px solid #ccc;padding:2px 6px;border-radius:4px"/>

---

## Reactive state in prose

You have clicked the button **{count} time{count === 1 ? '' : 's'}**.

<div style="display:flex;gap:8px;margin:12px 0">
  <button on:click={dec} style="padding:4px 12px;border:1px solid #ccc;border-radius:4px">−</button>
  <button on:click={inc} style="padding:4px 12px;background:#6366f1;color:#fff;border:none;border-radius:4px">+</button>
</div>

{#if count === 0}
  *Click the button to get started.*
{:else if count < 5}
  Getting warmed up…
{:else if count < 10}
  Now we're cooking 🔥
{:else}
  You've clicked **{count}** times. Impressive.
{/if}

---

> **{summary}**`,
  },

  markdownFrontmatter: {
    file: 'Frontmatter.md',
    group: 'Markdown',
    src: `---
title: Frontmatter Reference
version: 1.0
published: true
tags: [docs, reference]
rating: 4.5
---

# Frontmatter

Every frontmatter key becomes an \`export const\` declaration automatically.
No script block needed for static metadata.

Supported value types: **string**, **number**, **boolean**, **array**.

- \`title\` (string) — **{title}**
- \`version\` (number) — **v{version}**
- \`published\` (boolean) — **{published ? 'yes' : 'no'}**
- \`tags\` (array) — **{tags.join(' + ')}**
- \`rating\` (number) — **{rating}/5**

## Live values

Rating: {rating}/5 — {rating >= 4 ? 'excellent' : rating >= 3 ? 'good' : 'fair'}

Published: {published ? 'yes' : 'no'}

## Mixing with a script block

Add a script block to declare reactive state alongside frontmatter constants.
Frontmatter values are immutable (export const) — use let in the script for
anything that changes at runtime.`,
  },

  // ── Basics ───────────────────────────────────────────────────────────────────

  helloWorld: {
    file: 'HelloWorld.mesa',
    group: 'Basics',
    src: `<script>
  let name = 'World'
</script>

<h2>Hello, {name}!</h2>
<input bind:value={name} placeholder="Your name" />`,
  },

  rawHTML: {
    file: 'RawHTML.mesa',
    group: 'Basics',
    src: `<script>
  // {@html expr} injects raw HTML directly into the DOM.
  // Use only with trusted content — no sanitization is applied.

  let bold    = true
  let content = '<strong>Bold text</strong> and <em>italic text</em>'

  const markdown = \`
    <h3>Rendered Markdown</h3>
    <p>Mesa supports <strong>raw HTML injection</strong> via <code>{@html}</code>.</p>
    <ul>
      <li>Reactive — updates when the expression changes</li>
      <li>Previous nodes removed before new HTML is inserted</li>
    </ul>
  \`
</script>

<h2>Raw HTML</h2>

<p>Inline: {@html content}</p>

<hr/>

{@html markdown}

<hr/>

<p>Dynamic: {@html bold ? '<strong>BOLD</strong>' : 'normal'}</p>
<button on:click={() => bold = !bold}>Toggle bold</button>`,
  },

  tailwindStyling: {
    file: 'TailwindStyling.mesa',
    group: 'Basics',
    src: `<script>
  // Mesa's REPL includes the Tailwind Play CDN — utility classes work out of the box.
  // Use class: directives for conditional classes.

  let liked   = false
  let count   = 0
  let variant = 'primary'

  const variants = {
    primary:  'bg-blue-600 hover:bg-blue-700 text-white',
    success:  'bg-green-600 hover:bg-green-700 text-white',
    danger:   'bg-red-600 hover:bg-red-700 text-white',
  }
</script>

<div class="p-6 max-w-sm font-sans">
  <div class="rounded-xl border border-gray-200 shadow-sm overflow-hidden">
    <div class="bg-gradient-to-br from-indigo-500 to-purple-600 h-32"></div>

    <div class="p-4">
      <h3 class="text-lg font-semibold text-gray-900">Mesa Component</h3>
      <p class="text-sm text-gray-500 mt-1">Tailwind utility classes work in the REPL.</p>

      <div class="flex items-center justify-between mt-4">
        <button
          class="flex items-center gap-2 text-sm px-3 py-1.5 rounded-full border transition-colors"
          class:border-pink-400={liked}
          class:text-pink-600={liked}
          class:border-gray-200={!liked}
          class:text-gray-500={!liked}
          on:click={() => { liked = !liked; if (liked) count++ }}
        >
          {liked ? '♥' : '♡'} {count}
        </button>

        <select
          class="text-sm border border-gray-200 rounded px-2 py-1"
          bind:value={variant}
        >
          <option value="primary">Primary</option>
          <option value="success">Success</option>
          <option value="danger">Danger</option>
        </select>
      </div>

      <button
        class="mt-3 w-full py-2 rounded-lg text-sm font-medium transition-colors {variants[variant]}"
      >
        {variant.charAt(0).toUpperCase() + variant.slice(1)} Button
      </button>
    </div>
  </div>
</div>`,
  },

  // ── Shared State ─────────────────────────────────────────────────────────────

  sharedStore: {
    file: 'SharedStore.mesa',
    group: 'Shared State',
    src: `<script>
  // Mesa has no store API. Shared state is plain JavaScript.
  // For LOCAL state: use let + replacement — replace the whole value to trigger re-renders.
  // For IMPORTED store objects: use $: path watching — push/splice/assign become reactive.

  // Local reactive state — let + replacement
  let items = []
  let total = 0

  const itemCount = items.length
  const isEmpty   = itemCount === 0

  function addItem() {
    const names = ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry']
    const name  = names[Math.floor(Math.random() * names.length)]
    const price = +(Math.random() * 10 + 1).toFixed(2)
    items = [...items, { name, price }]         // replace — triggers re-render
    total = +items.reduce((s, i) => s + i.price, 0).toFixed(2)
  }

  function removeItem(idx) {
    items = items.filter((_, i) => i !== idx)   // replace
    total = +items.reduce((s, i) => s + i.price, 0).toFixed(2)
  }

  function clearCart() {
    items = []
    total = 0
  }
</script>

<h2>Cart</h2>
<p>{itemCount} item{itemCount === 1 ? '' : 's'} — Total: <strong>\${total.toFixed(2)}</strong></p>

{#each items as item, i (i)}
  <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
    <span>{item.name} — \${item.price.toFixed(2)}</span>
    <button on:click={() => removeItem(i)}>✕</button>
  </div>
{:else}
  <p style="color:#9ca3af">Cart is empty.</p>
{/each}

<div style="margin-top:12px;display:flex;gap:8px">
  <button on:click={addItem}>Add random item</button>
  <button on:click={clearCart} disabled={isEmpty}>Clear</button>
</div>`,
  },

  reactiveArray: {
    file: 'ReactiveArray.mesa',
    group: 'Shared State',
    src: `<script>
  // let arr = [...] — shallow signal. Only reference replacement is tracked.
  // To make push/splice/sort reactive: use $: arr to watch the array object.
  // Mesa wraps it in a Proxy — mutations now fire re-renders.

  let items = ['Apples', 'Bananas', 'Cherries']
  $: items   // watch the array — push/splice/sort now reactive

  const count = items.length

  function push() {
    const opts = ['Dates', 'Elderberry', 'Figs', 'Grapes', 'Honeydew']
    items.push(opts[Math.floor(Math.random() * opts.length)])
  }

  function pop()     { items.pop() }
  function shift()   { items.shift() }
  function reverse() { items.reverse() }
  function sort()    { items.sort() }
  function reset()   { items = ['Apples', 'Bananas', 'Cherries'] }
</script>

<h2>Reactive Array</h2>
<p>{count} item{count === 1 ? '' : 's'}</p>

{#each items as item (item)}
  <div style="display:flex;align-items:center;gap:6px;margin:2px 0">
    <span>{item}</span>
  </div>
{:else}
  <p style="color:#9ca3af">Empty.</p>
{/each}

<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:6px">
  <button on:click={push}>push()</button>
  <button on:click={pop}>pop()</button>
  <button on:click={shift}>shift()</button>
  <button on:click={reverse}>reverse()</button>
  <button on:click={sort}>sort()</button>
  <button on:click={reset}>reset</button>
</div>`,
  },

  reactiveObject: {
    file: 'ReactiveObject.mesa',
    group: 'Shared State',
    src: `<script>
  // $: obj.path — watch a specific property path for mutations.
  // Works on both let signals and imported store objects.
  // Mesa wraps the object in a Proxy — property assignment becomes reactive.

  let user = {
    profile: { name: 'Alice', bio: 'Engineer' },
    prefs:   { theme: 'light', lang: 'en' },
    stats:   { posts: 12, followers: 340 },
  }

  // Watch specific paths — surgical reactivity, not the whole object
  $: user.profile.name
  $: user.prefs.theme
  $: user.stats.followers

  const isDark = user.prefs.theme === 'dark'

  function rename()      { user.profile.name = user.profile.name === 'Alice' ? 'Bob' : 'Alice' }
  function toggleTheme() { user.prefs.theme  = isDark ? 'light' : 'dark' }
  function follow()      { user.stats.followers++ }
</script>

<h2>Reactive Object</h2>

<div style="display:flex;flex-direction:column;gap:8px">
  <p>Name: <strong>{user.profile.name}</strong></p>
  <p>Theme: {user.prefs.theme} {isDark ? '🌙' : '☀️'}</p>
  <p>Followers: {user.stats.followers}</p>

  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <button on:click={rename}>Toggle name</button>
    <button on:click={toggleTheme}>Toggle theme</button>
    <button on:click={follow}>Follow</button>
  </div>
</div>`,
  },

  asyncBoundary: {
    file: 'AsyncBoundary.mesa',
    group: 'Async',
    src: `<script>
  // <mesa:boundary> gates content behind async derived data.
  // Global {#snippet pending()} and {#snippet failed(error)} are shared
  // by all boundaries in the component — define them once, use everywhere.
  // Multiple boundaries per component — each gates its own section.

  let userId = 1

  // Both re-run when userId changes, in-flight requests cancelled automatically
  const user = await fetch(
    'https://jsonplaceholder.typicode.com/users/' + userId
  ).then(r => r.json())

  const posts = await fetch(
    'https://jsonplaceholder.typicode.com/posts?userId=' + userId + '&_limit=3'
  ).then(r => r.json())
</script>

<h2>Async Boundary</h2>

<div style="display:flex;gap:8px;margin-bottom:16px;align-items:center">
  <button on:click={() => userId = Math.max(1, userId - 1)}>← Prev</button>
  <span>User {userId}</span>
  <button on:click={() => userId = Math.min(10, userId + 1)}>Next →</button>
</div>

<mesa:boundary>
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px">
    <strong>{user?.name}</strong>
    <p style="color:#6b7280;font-size:13px">{user?.email}</p>
    <p style="color:#6b7280;font-size:13px">{user?.company?.name}</p>
  </div>
</mesa:boundary>

<mesa:boundary>
  <h3 style="font-size:14px;margin-bottom:8px">Recent posts</h3>
  {#each posts ?? [] as post (post.id)}
    <div style="padding:8px 0;border-bottom:1px solid #f3f4f6">
      <p style="font-size:13px;font-weight:500">{post.title}</p>
    </div>
  {/each}
</mesa:boundary>

{#snippet pending()}
  <p style="color:#9ca3af;font-style:italic">Loading…</p>
{/snippet}

{#snippet failed(error)}
  <p style="color:#ef4444">Error: {error.message}</p>
{/snippet}`,
  },

  mesaMounted: {
    file: 'MesaMounted.mesa',
    group: 'Async',
    src: `<script>
  // $mounted(fn) — wraps an async function that runs after the component mounts.
  // <mesa:mounted /> gates the entire template: nothing renders until the
  // Promise resolves. The pending/failed snippets show in the meantime.
  //
  // Use this for: data that must load before ANY content is visible,
  // imperative mount-time setup, or redirecting on auth failure.

  let user  = null
  let error = null

  // $mounted() returns a Promise — only one per component (compiler error if used twice)
  const mounting = $mounted(async () => {
    // Simulate auth check + profile fetch after mount
    await new Promise(r => setTimeout(r, 1200))

    // Simulate 25% chance of auth failure
    if (Math.random() < 0.25) throw new Error('Not authenticated')

    user = await fetch('https://jsonplaceholder.typicode.com/users/1').then(r => r.json())
  })
</script>

<!-- Gates entire template — nothing below renders until mounting resolves -->
<mesa:mounted onerror={(err) => { error = err }} />

<div style="max-width:300px">
  <h2 style="margin:0 0 4px">{user?.name}</h2>
  <p style="color:#6b7280;font-size:13px;margin:0 0 2px">{user?.email}</p>
  <p style="color:#6b7280;font-size:13px;margin:0 0 12px">{user?.company?.name}</p>
  <p style="font-size:12px;color:#9ca3af">
    Loaded after mount — component was fully mounted before fetch began.
  </p>
</div>

{#snippet pending()}
  <div style="display:flex;align-items:center;gap:10px;color:#6b7280;font-size:13px">
    <span style="animation:spin 1s linear infinite;display:inline-block">⟳</span>
    Loading profile…
  </div>
{/snippet}

<!-- Top level: a <style> nested inside a {#snippet} is dropped, so the
     spinner had no @keyframes and never turned. -->
<style>
  @keyframes spin { to { transform: rotate(360deg) } }
</style>

{#snippet failed(err)}
  <div style="color:#ef4444;font-size:13px">
    <p style="margin:0 0 4px;font-weight:500">Failed to load</p>
    <p style="margin:0 0 12px">{err?.message ?? 'Unknown error'}</p>
    <button on:click={() => window.location.reload()}>Retry</button>
  </div>
{/snippet}`,
  },

  // ── Styling ───────────────────────────────────────────────────────────────────

  scopedCSS: {
    file: 'ScopedCSS.mesa',
    group: 'Styling',
    src: `<script>
  // Styles in <style> are scoped to this component automatically.
  // The compiler adds a unique class to every element and selector.

  let theme = 'blue'
  let size  = 'md'

  const themes = ['blue', 'green', 'rose', 'amber']
  const sizes  = ['sm', 'md', 'lg']
</script>

<style>
  .card {
    border-radius: 8px;
    padding: 20px;
    border: 1px solid #e5e7eb;
    max-width: 320px;
    font-family: sans-serif;
  }
  h3 { margin: 0 0 8px; font-size: 15px; }
  p  { margin: 0 0 14px; font-size: 13px; color: #6b7280; }

  .blue  { background: #eff6ff; border-color: #bfdbfe; }
  .green { background: #f0fdf4; border-color: #bbf7d0; }
  .rose  { background: #fff1f2; border-color: #fecdd3; }
  .amber { background: #fffbeb; border-color: #fde68a; }

  .sm .content { font-size: 12px; }
  .md .content { font-size: 14px; }
  .lg .content { font-size: 16px; }

  .controls { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
  button {
    padding: 3px 10px; border-radius: 4px; border: 1px solid #d1d5db;
    background: white; cursor: pointer; font-size: 12px;
  }
  button.active { background: #1e1e2e; color: white; border-color: #1e1e2e; }
</style>

<div class="card {theme} {size}">
  <h3>Scoped styles</h3>
  <div class="content">
    <p>These styles apply only to this component — the compiler scopes them
    automatically. No class name collisions with parent or sibling components.</p>
  </div>

  <div class="controls">
    {#each themes as t (t)}
      <button class={theme === t ? 'active' : ''} on:click={() => theme = t}>{t}</button>
    {/each}
  </div>
  <div class="controls">
    {#each sizes as s (s)}
      <button class={size === s ? 'active' : ''} on:click={() => size = s}>{s}</button>
    {/each}
  </div>
</div>`,
  },

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  lifecycle: {
    file: 'Lifecycle.mesa',
    group: 'Lifecycle',
    src: `<script>
  // $onMount — runs after the component is inserted into the DOM.
  // $onDestroy — runs when the component is removed.
  // Neither runs on the server (SSR).

  let elapsed = 0
  let mounted = false
  let log = []

  function addLog(msg) {
    log = [...log, msg]
  }

  $onMount(() => {
    mounted = true
    addLog('$onMount fired — component is in the DOM')
    const id = setInterval(() => {
      elapsed++
    }, 1000)

    // Store cleanup in $onDestroy — called when component unmounts
    $onDestroy(() => {
      clearInterval(id)
      addLog('$onDestroy fired — interval cleared')
    })
  })
</script>

<h2>Lifecycle</h2>
<p>Mounted: <strong>{mounted ? 'yes' : 'no'}</strong></p>
<p>Elapsed: <strong>{elapsed}s</strong></p>

<ul style="font-size:13px;color:#374151">
  {#each log as entry (entry)}
    <li>{entry}</li>
  {:else}
    <li style="color:#9ca3af">No events yet…</li>
  {/each}
</ul>`,
  },

  // ── Module Context ────────────────────────────────────────────────────────────

  moduleContext: {
    file: 'ModuleContext.mesa',
    group: 'Module Context',
    src: `<script module>
  // <script module> runs once at module load — shared across ALL instances.
  // Exports are available to other modules that import this component.

  let totalInstances = 0
  let totalClicks    = 0

  export function getStats() {
    return { totalInstances, totalClicks }
  }
</script>

<script>
  // Per-instance script — runs once per component mount.
  // Can read/write module-level variables.

  totalInstances++
  let instanceId    = totalInstances
  let instanceClicks = 0

  function click() {
    instanceClicks++
    totalClicks++
  }

  $onDestroy(() => {
    totalInstances--
  })
</script>

<div style="border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin-bottom:8px;max-width:280px">
  <p style="margin:0 0 6px;font-size:13px">
    Instance <strong>#{instanceId}</strong> — clicked <strong>{instanceClicks}</strong>×
  </p>
  <p style="margin:0 0 10px;font-size:12px;color:#6b7280">
    Total across all instances: <strong>{totalClicks}</strong> clicks,
    <strong>{totalInstances}</strong> mounted
  </p>
  <button on:click={click}>Click me</button>
</div>`,
  },

  // ── SVG ───────────────────────────────────────────────────────────────────────

  svgClock: {
    file: 'Clock.mesa',
    group: 'SVG',
    src: `<script>
  // SVG works natively in Mesa — no special handling needed.
  // $onMount starts the tick, $onDestroy clears it.

  let now = new Date()

  $onMount(() => {
    const id = setInterval(() => { now = new Date() }, 1000)
    $onDestroy(() => clearInterval(id))
  })

  const sec = now.getSeconds()
  const min = now.getMinutes() + sec / 60
  const hr  = now.getHours() % 12 + min / 60

  const secAngle = sec * 6
  const minAngle = min * 6
  const hrAngle  = hr * 30

  // Pre-build static hour markers as a raw SVG string — no {#each} needed
  const markers = Array.from({ length: 12 }, (_, h) => {
    const isMajor = h % 3 === 0
    const y2 = isMajor ? 13 : 9
    const sw = isMajor ? 2 : 1
    return \`<line x1="50" y1="5" x2="50" y2="\${y2}"
      transform="rotate(\${h * 30} 50 50)"
      stroke="#1e1e2e" stroke-width="\${sw}"/>\`
  }).join('')
</script>

<svg viewBox="0 0 100 100" width="220" height="220" style="display:block">
  <!-- Face -->
  <circle cx="50" cy="50" r="48" fill="#faf9f7" stroke="#1e1e2e" stroke-width="2"/>

  <!-- Hour markers — static, rendered via {@html} -->
  {@html markers}

  <!-- Hour hand — reactive -->
  <line x1="50" y1="50" x2="50" y2="26"
    transform="rotate({hrAngle} 50 50)"
    stroke="#1e1e2e" stroke-width="3.5" stroke-linecap="round"/>

  <!-- Minute hand -->
  <line x1="50" y1="50" x2="50" y2="16"
    transform="rotate({minAngle} 50 50)"
    stroke="#1e1e2e" stroke-width="2" stroke-linecap="round"/>

  <!-- Second hand -->
  <line x1="50" y1="56" x2="50" y2="13"
    transform="rotate({secAngle} 50 50)"
    stroke="#f5900a" stroke-width="1" stroke-linecap="round"/>

  <!-- Center cap -->
  <circle cx="50" cy="50" r="2.5" fill="#1e1e2e"/>
</svg>

<p style="font-size:12px;color:#9ca3af;margin-top:4px">
  {now.toLocaleTimeString()}
</p>`,
  },

  svgBarChart: {
    file: 'BarChart.mesa',
    group: 'SVG',
    src: `<script>
  let bars = [
    { label: 'Mon', value: 65 },
    { label: 'Tue', value: 82 },
    { label: 'Wed', value: 47 },
    { label: 'Thu', value: 91 },
    { label: 'Fri', value: 73 },
    { label: 'Sat', value: 38 },
    { label: 'Sun', value: 56 },
  ]

  const W    = 340
  const H    = 160
  const padL = 30
  const padB = 24

  const max  = Math.max(...bars.map(b => b.value))
  const barW = (W - padL) / bars.length

  function barX(i)    { return padL + i * barW + barW * 0.15 }
  function barH(v)    { return (v / max) * H }
  function barY(v)    { return H - barH(v) }
  function labelX(i)  { return padL + i * barW + barW * 0.5 }

  function randomize() {
    bars = bars.map(b => ({ ...b, value: Math.floor(Math.random() * 85) + 10 }))
  }

  function highlight(i) { selected = i }
  let selected = null
</script>

<svg viewBox="0 0 {W} {H + padB}" width="100%" style="max-width:400px;display:block">
  <!-- Baseline -->
  <line x1={padL} y1={H} x2={W} y2={H} stroke="#e5e7eb" stroke-width="1"/>

  {#each bars as bar, i (bar.label)}
    <rect
      x={barX(i)}
      y={barY(bar.value)}
      width={barW * 0.7}
      height={barH(bar.value)}
      fill={selected === i ? '#fe8a11' : '#4f46e5'}
      rx="2"
      style="cursor:pointer;transition:fill .15s"
      on:click={() => selected = selected === i ? null : i}
    />
    <text
      x={labelX(i)} y={H + 16}
      text-anchor="middle"
      font-size="11" fill="#6b7280"
    >{bar.label}</text>
    {#if selected === i}
      <text
        x={labelX(i)} y={barY(bar.value) - 4}
        text-anchor="middle"
        font-size="10" font-weight="600" fill="#fe8a11"
      >{bar.value}</text>
    {/if}
  {/each}
</svg>

<button on:click={randomize} style="margin-top:8px">Randomize</button>`,
  },

  // ── 7GUIs ─────────────────────────────────────────────────────────────────────

  guiTemperature: {
    file: 'Temperature.mesa',
    group: '7GUIs',
    src: `<script>
  // 7GUIs — Temperature Converter
  // Two inputs that stay in sync. Changing either updates the other.

  let celsius    = 0
  let fahrenheit = 32

  function onCelsius(e) {
    celsius    = +e.target.value
    fahrenheit = +(celsius * 9/5 + 32).toFixed(2)
  }

  function onFahrenheit(e) {
    fahrenheit = +e.target.value
    celsius    = +((fahrenheit - 32) * 5/9).toFixed(2)
  }
</script>

<h2>Temperature Converter</h2>

<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
  <input
    type="number"
    value={celsius}
    on:change={onCelsius}
    style="width:100px"
  />
  <span>°C =</span>
  <input
    type="number"
    value={fahrenheit}
    on:change={onFahrenheit}
    style="width:100px"
  />
  <span>°F</span>
</div>

<p style="font-size:12px;color:#9ca3af;margin-top:12px">
  {#if celsius <= 0}
    Freezing or below 🧊
  {:else if celsius < 20}
    Cool 🌤
  {:else if celsius < 30}
    Warm ☀️
  {:else}
    Hot 🔥
  {/if}
</p>`,
  },

  guiTimer: {
    file: 'Timer.mesa',
    group: '7GUIs',
    src: `<script>
  // 7GUIs — Timer
  // Elapsed progresses until it reaches duration. Slider adjusts duration live.

  let elapsed  = 0
  let duration = 10

  const progress = Math.min(elapsed / duration, 1)
  const done     = elapsed >= duration

  $onMount(() => {
    const id = setInterval(() => {
      if (elapsed < duration) elapsed = +(elapsed + 0.1).toFixed(1)
    }, 100)
    $onDestroy(() => clearInterval(id))
  })

  function reset() { elapsed = 0 }
</script>

<h2>Timer</h2>

<div style="max-width:280px">
  <div style="margin-bottom:12px">
    <label style="font-size:12px;color:#6b7280">
      Elapsed: {elapsed.toFixed(1)}s / {duration}s
    </label>
    <div style="height:12px;background:#f3f4f6;border-radius:6px;overflow:hidden;margin-top:4px">
      <div style="height:100%;border-radius:6px;background:{done ? '#22c55e' : '#4f46e5'};
                  width:{Math.round(progress * 100)}%;transition:width .1s"></div>
    </div>
  </div>

  <div style="margin-bottom:14px">
    <label style="font-size:12px;color:#6b7280">
      Duration: {duration}s
    </label>
    <br/>
    <input type="range" min="1" max="30" step="1" bind:value={duration} style="width:100%;margin-top:4px"/>
  </div>

  <button on:click={reset}>Reset</button>
</div>`,
  },

  guiCRUD: {
    file: 'CRUD.mesa',
    group: '7GUIs',
    src: `<script>
  // 7GUIs — CRUD
  // Filter list, select, create, update, delete.

  let prefix  = ''
  let first   = ''
  let last    = ''
  let selId   = null
  let nextId  = 4

  let people = [
    { id: 1, first: 'Hans',   last: 'Emil'       },
    { id: 2, first: 'Max',    last: 'Mustermann'  },
    { id: 3, first: 'Roman',  last: 'Tisch'       },
  ]

  const filtered = people.filter(p =>
    (p.last + ', ' + p.first).toLowerCase().includes(prefix.toLowerCase())
  )

  const selected = people.find(p => p.id === selId) ?? null

  function select(id) {
    selId = id
    const p = people.find(p => p.id === id)
    if (p) { first = p.first; last = p.last }
  }

  function create() {
    if (!first.trim() || !last.trim()) return
    people = [...people, { id: nextId++, first: first.trim(), last: last.trim() }]
    first = ''; last = ''; selId = null
  }

  function update() {
    if (!selId || !first.trim() || !last.trim()) return
    people = people.map(p => p.id === selId ? { ...p, first: first.trim(), last: last.trim() } : p)
  }

  function remove() {
    if (!selId) return
    people = people.filter(p => p.id !== selId)
    selId = null; first = ''; last = ''
  }
</script>

<style>
  .crud { display:flex; gap:16px; flex-wrap:wrap; font-family:sans-serif; font-size:13px }
  .list-box { width:180px; height:160px; overflow-y:auto; border:1px solid #d1d5db;
              border-radius:4px; padding:4px }
  .list-item { padding:4px 8px; cursor:pointer; border-radius:3px }
  .list-item.active { background:#1e1e2e; color:white }
  .list-item:hover:not(.active) { background:#f3f4f6 }
  .fields { display:flex; flex-direction:column; gap:8px }
  .row { display:flex; align-items:center; gap:6px }
  label { width:60px; color:#6b7280; flex-shrink:0 }
  input { border:1px solid #d1d5db; border-radius:4px; padding:4px 8px; width:130px }
  .actions { display:flex; gap:6px; margin-top:4px }
  .filter-row { margin-bottom:8px; display:flex; align-items:center; gap:6px }
</style>

<h2>CRUD</h2>
<div class="crud">
  <div>
    <div class="filter-row">
      <label>Filter</label>
      <input bind:value={prefix} placeholder="Surname…" />
    </div>
    <div class="list-box">
      {#each filtered as p (p.id)}
        <div
          class="list-item {selId === p.id ? 'active' : ''}"
          on:click={() => select(p.id)}
        >{p.last}, {p.first}</div>
      {:else}
        <div style="color:#9ca3af;padding:4px 8px">No results</div>
      {/each}
    </div>
  </div>

  <div class="fields">
    <div class="row">
      <label>First</label>
      <input bind:value={first} placeholder="First name" />
    </div>
    <div class="row">
      <label>Last</label>
      <input bind:value={last} placeholder="Last name" />
    </div>
    <div class="actions">
      <button on:click={create}>Create</button>
      <button on:click={update} disabled={!selId}>Update</button>
      <button on:click={remove} disabled={!selId}>Delete</button>
    </div>
  </div>
</div>`,
  },

  // ── Bindings ──────────────────────────────────────────────────────────────────

  numericInputs: {
    file: 'NumericInputs.mesa',
    group: 'Bindings',
    src: `<script>
  // bind:value on number inputs keeps the signal as a number, not a string.
  // Range sliders work the same way — bind:value syncs both directions.

  let quantity = 1
  let price    = 29.99
  let discount = 0

  const subtotal = quantity * price
  const savings  = subtotal * (discount / 100)
  const total    = subtotal - savings
  const isValid  = quantity > 0 && price > 0
</script>

<h2>Numeric Inputs</h2>

<div style="display:flex;flex-direction:column;gap:12px;max-width:300px">
  <div>
    <label style="font-size:12px;color:#6b7280">Quantity</label>
    <br/>
    <input type="number" bind:value={quantity} min="1" max="99" step="1"
      style="width:100px;margin-top:4px" />
  </div>

  <div>
    <label style="font-size:12px;color:#6b7280">Price (USD)</label>
    <br/>
    <input type="number" bind:value={price} min="0" step="0.01"
      style="width:100px;margin-top:4px" />
  </div>

  <div>
    <label style="font-size:12px;color:#6b7280">Discount: {discount}%</label>
    <br/>
    <input type="range" bind:value={discount} min="0" max="50" step="5"
      style="width:200px;margin-top:4px" />
  </div>
</div>

<hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/>

{#if isValid}
  <p style="margin:4px 0">Subtotal: \${subtotal.toFixed(2)}</p>
  {#if discount > 0}
    <p style="margin:4px 0;color:#22c55e">Discount: −\${savings.toFixed(2)}</p>
  {/if}
  <p style="margin:8px 0;font-weight:600">Total: \${total.toFixed(2)}</p>
{:else}
  <p style="color:#ef4444">Enter a valid quantity and price.</p>
{/if}`,
  },

  checkboxInputs: {
    file: 'CheckboxInputs.mesa',
    group: 'Bindings',
    src: `<script>
  // bind:checked — single boolean binding on a checkbox.
  // bind:group  — array binding shared across multiple checkboxes.
  //               Each checkbox adds/removes its value from the array.

  // Single boolean flags
  let darkMode       = false
  let notifications  = true
  let newsletter     = false

  // Group binding — array of selected values
  let toppings = ['cheese']
  const pizzaToppings = ['cheese', 'pepperoni', 'mushrooms', 'olives', 'peppers']

  const toppingCount = toppings.length
  const summary = toppings.length ? toppings.join(', ') : 'plain'
</script>

<h2>Checkbox Inputs</h2>

<h3 style="font-size:13px;color:#374151;margin-bottom:8px">bind:checked (boolean)</h3>
<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
  <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">
    <input type="checkbox" bind:checked={darkMode} />
    Dark mode: <strong>{darkMode ? 'on' : 'off'}</strong>
  </label>
  <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">
    <input type="checkbox" bind:checked={notifications} />
    Notifications: <strong>{notifications ? 'on' : 'off'}</strong>
  </label>
  <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">
    <input type="checkbox" bind:checked={newsletter} />
    Newsletter: <strong>{newsletter ? 'subscribed' : 'unsubscribed'}</strong>
  </label>
</div>

<h3 style="font-size:13px;color:#374151;margin-bottom:8px">bind:group (array)</h3>
<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
  {#each pizzaToppings as t (t)}
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">
      <input type="checkbox" bind:group={toppings} value={t} />
      {t}
    </label>
  {/each}
</div>
<p style="font-size:13px">
  {toppingCount} topping{toppingCount === 1 ? '' : 's'}: <strong>{summary}</strong>
</p>`,
  },

  fileInput: {
    file: 'FileInput.mesa',
    group: 'Bindings',
    src: `<script>
  // bind:files gives you the input's FileList — and takes one back.
  //
  // The DOM is strict here: input.files accepts a FileList and nothing else,
  // so \`el.files = [file]\` throws. Mesa converts an array of File objects for
  // you, and treats null as "clear", which is the one thing assigning
  // input.files cannot do — Chrome accepts null and then ignores it.
  //
  // Nothing here can pre-load a file: a file input's contents can only come
  // from the user or from a File you construct in code, which is what the
  // second button does.

  let picked
  let dropped = []

  const chosen = picked ? [...picked] : []
  const totalKb = Math.round(chosen.reduce((n, f) => n + f.size, 0) / 102.4) / 10

  function clear() { picked = null }

  function addGenerated() {
    const stamp = chosen.length + 1
    const made = new File(
      ['generated in the browser, file ' + stamp],
      'note-' + stamp + '.txt',
      { type: 'text/plain' }
    )
    // An ARRAY of File objects — the DOM would refuse this one.
    picked = [...chosen, made]
  }
</script>

<h2>File input</h2>

<input type="file" multiple bind:files={picked} />

<p class="sum">
  {chosen.length} file{chosen.length === 1 ? '' : 's'}
  {chosen.length ? '— ' + totalKb + ' KB total' : ''}
</p>

{#each chosen as f, i (f.name + f.size)}
  <p class="row"><span class="idx">{i + 1}</span> {f.name}
     <em>{f.type || 'unknown type'} · {f.size} bytes</em></p>
{:else}
  <p class="row"><em>nothing selected</em></p>
{/each}

<button on:click={addGenerated}>Add a file from code</button>
<button on:click={clear} disabled={!chosen.length}>Clear</button>

<p class="note">
  Reading is a FileList, so <code>[...picked]</code> gives you the files.
  Writing takes a FileList, an array of File objects, or null to clear —
  anything else warns in the console and leaves the input untouched rather
  than throwing a DOM TypeError at you.
</p>

<style>
  .sum  { font-size: 13px; font-weight: 600; margin: 10px 0 6px; }
  .row  { font-size: 12px; margin: 2px 0; }
  .row em { color: #9ca3af; font-style: normal; }
  .idx  { color: #9ca3af; font-family: monospace; margin-right: 4px; }
  button { margin: 8px 6px 0 0; font: inherit; padding: 4px 10px;
           border: 1px solid #d1d5db; border-radius: 6px; background: #fff;
           cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .note { font-size: 12px; color: #9ca3af; max-width: 440px; margin-top: 12px; }
</style>`,
  },

  selectBindings: {
    file: 'SelectBindings.mesa',
    group: 'Bindings',
    src: `<script>
  // bind:value on <select> tracks the selected option value.
  // Changing the bound variable updates the selection.
  // Dynamic options work — just re-render the {#each} list.

  let country  = 'us'
  let font     = 'sans-serif'
  let priority = '2'

  const countries = [
    { code: 'us', name: 'United States', emoji: '🇺🇸' },
    { code: 'gb', name: 'United Kingdom', emoji: '🇬🇧' },
    { code: 'de', name: 'Germany',        emoji: '🇩🇪' },
    { code: 'jp', name: 'Japan',          emoji: '🇯🇵' },
    { code: 'br', name: 'Brazil',         emoji: '🇧🇷' },
    { code: 'au', name: 'Australia',      emoji: '🇦🇺' },
  ]

  const fonts  = ['sans-serif', 'serif', 'monospace', 'cursive']
  const levels = [
    { value: '1', label: '🔴 Critical' },
    { value: '2', label: '🟡 Medium'  },
    { value: '3', label: '🟢 Low'     },
  ]

  const selected = countries.find(c => c.code === country)

  // <select multiple> binds an ARRAY of the selected option values.
  let regions = ['gb', 'de']

  // An option's value does not have to be a string — bind the object itself.
  const people = [
    { id: 1, name: 'Ada Lovelace',   email: 'ada@example.com' },
    { id: 2, name: 'Grace Hopper',   email: 'grace@example.com' },
    { id: 3, name: 'Alan Turing',    email: 'alan@example.com' },
  ]
  let owner = people[1]
</script>

<h2>Select Bindings</h2>

<div style="display:flex;flex-direction:column;gap:16px;max-width:280px">
  <div>
    <label style="font-size:12px;color:#6b7280">Country</label>
    <br/>
    <select bind:value={country} style="margin-top:4px;width:100%">
      {#each countries as c (c.code)}
        <option value={c.code}>{c.emoji} {c.name}</option>
      {/each}
    </select>
    <p style="font-size:13px;margin:6px 0 0">
      Selected: {selected?.emoji} {selected?.name}
    </p>
  </div>

  <div>
    <label style="font-size:12px;color:#6b7280">Font family</label>
    <br/>
    <select bind:value={font} style="margin-top:4px;width:100%">
      {#each fonts as f (f)}<option value={f}>{f}</option>{/each}
    </select>
    <p style="font-size:14px;margin:6px 0 0;font-family:{font}">
      The quick brown fox — in {font}
    </p>
  </div>

  <div>
    <label style="font-size:12px;color:#6b7280">Priority</label>
    <br/>
    <select bind:value={priority} style="margin-top:4px;width:100%">
      {#each levels as l (l.value)}
        <option value={l.value}>{l.label}</option>
      {/each}
    </select>
  </div>

  <div>
    <label style="font-size:12px;color:#6b7280">
      Regions — multiple, so the binding is an array
    </label>
    <br/>
    <select multiple size="4" bind:value={regions} style="margin-top:4px;width:100%">
      {#each countries as c (c.code)}
        <option value={c.code}>{c.emoji} {c.name}</option>
      {/each}
    </select>
    <p style="font-size:13px;margin:6px 0 0">
      {regions.length} selected: {regions.join(', ') || '(none)'}
    </p>
    <button on:click={() => regions = ['us', 'jp']} style="font-size:12px">
      Set from code
    </button>
    <button on:click={() => regions = []} style="font-size:12px">Clear</button>
  </div>

  <div>
    <label style="font-size:12px;color:#6b7280">
      Assignee — option values are objects, not strings
    </label>
    <br/>
    <select bind:value={owner} style="margin-top:4px;width:100%">
      {#each people as p (p.id)}
        <option value={p}>{p.name}</option>
      {/each}
    </select>
    <p style="font-size:13px;margin:6px 0 0">
      Bound value is the object: id={owner?.id}, email={owner?.email}
    </p>
  </div>
</div>

<p style="font-size:12px;color:#9ca3af;max-width:340px;margin-top:14px">
  A multiple select binds an array of option values, and writing an array back
  sets the selection. Object option values survive because the real value is
  kept on the option element — an attribute could only have held
  "[object Object]".
</p>`,
  },

  // ── Mesa-specific ─────────────────────────────────────────────────────────────

  maskedInput: {
    file: 'MaskedInput.mesa',
    group: 'Bindings',
    src: `<script>
  // bind:value|mask({ pattern }) — the signal always holds the FORMATTED value,
  // and the literals in the pattern are inserted as you type.
  //
  //   9  a digit
  //   a  a letter
  //   *  alphanumeric
  //   anything else  a literal, typed for you
  //
  // The pattern argument is an expression, so it can be reactive: the last
  // field re-masks itself when you switch country.

  let expiry  = ''
  let phone   = ''
  let licence = ''
  let postal  = ''

  let country = 'US'
  const postalPattern = country === 'US' ? '99999-9999' : 'a9a 9a9'
  const postalHint    = country === 'US' ? '12345-6789' : 'K1A 0B1'
</script>

<h2>Masked inputs</h2>

<label>
  Expiry <span class="hint">99/99/9999</span>
  <input bind:value|mask({"99/99/9999"})={expiry} placeholder="MM/DD/YYYY" />
</label>

<label>
  Phone <span class="hint">(999) 999-9999</span>
  <input bind:value|mask({"(999) 999-9999"})={phone} placeholder="(555) 010-9999" />
</label>

<label>
  Licence <span class="hint">aaa-9999</span>
  <input bind:value|mask({"aaa-9999"})={licence} placeholder="abc-1234" />
</label>

<label>
  Postal code <span class="hint">{postalPattern} — reactive pattern</span>
  <input bind:value|mask({postalPattern})={postal} placeholder={postalHint} />
</label>

<button on:click={() => country = country === 'US' ? 'CA' : 'US'}>
  Country: {country} — switch
</button>

<hr/>

<p class="out">expiry: <code>{expiry || '(empty)'}</code></p>
<p class="out">phone: <code>{phone || '(empty)'}</code></p>
<p class="out">licence: <code>{licence || '(empty)'}</code></p>
<p class="out">postal: <code>{postal || '(empty)'}</code></p>

<p class="note">
  The bound variable is what you see, not the raw keystrokes — no separate
  "formatted" and "value" states to keep in sync, and nothing to strip before
  display. Switching country re-masks the postal field against the new pattern.
</p>

<style>
  label { display: block; margin-bottom: 10px; font-size: 13px; }
  input { display: block; margin-top: 3px; padding: 5px 8px; font: inherit;
          border: 1px solid #d1d5db; border-radius: 6px; width: 220px; }
  .hint { color: #9ca3af; font-size: 11px; font-family: monospace; }
  .out  { font-size: 12px; margin: 2px 0; color: #6b7280; }
  .note { font-size: 12px; color: #9ca3af; margin-top: 12px; max-width: 420px; }
</style>`,
  },

  attachActions: {
    file: 'AttachActions.mesa',
    group: 'Mesa-specific',
    src: `<script>
  // {@attach fn} — runs fn(el) when the element mounts.
  // Return a cleanup function to run before re-run or on destroy.
  // This is Mesa's equivalent of Svelte's use: directive.

  // ── Action: autofocus ──────────────────────────────────────────────────────
  function autofocus(el) {
    el.focus()
    // No cleanup needed
  }

  // ── Action: clickOutside ───────────────────────────────────────────────────
  function clickOutside(handler) {
    return (el) => {
      const fn = (e) => {
        if (!el.contains(e.target)) handler()
      }
      document.addEventListener('click', fn, true)
      return () => document.removeEventListener('click', fn, true)
    }
  }

  // ── Action: autosize textarea ──────────────────────────────────────────────
  function autosize(el) {
    const resize = () => {
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
    el.addEventListener('input', resize)
    resize()
    return () => el.removeEventListener('input', resize)
  }

  let dropdownOpen = false
  let autosizeText = 'Type here to see the textarea grow automatically...'
  let focusCount   = 0

  function closeDropdown() { dropdownOpen = false }

  $onMount(() => {
    const el = document.getElementById('focus-demo')
    if (el) el.addEventListener('focus', () => focusCount++)
  })
</script>

<h2>&#123;@attach&#125; Actions</h2>

<div style="display:flex;flex-direction:column;gap:20px;max-width:320px">

  <!-- autofocus -->
  <div>
    <h3 style="font-size:13px;margin:0 0 6px">autofocus</h3>
    <input
      id="focus-demo"
      {@attach autofocus}
      placeholder="Focused on mount"
      style="width:100%"
    />
    <p style="font-size:12px;color:#6b7280;margin:4px 0 0">
      Focused {focusCount} time{focusCount === 1 ? '' : 's'}
    </p>
  </div>

  <!-- clickOutside -->
  <div style="position:relative">
    <h3 style="font-size:13px;margin:0 0 6px">clickOutside</h3>
    <button on:click|stopPropagation={() => dropdownOpen = true}>
      Open dropdown
    </button>
    {#if dropdownOpen}
      <div
        {@attach clickOutside(closeDropdown)}
        style="position:absolute;top:100%;left:0;background:white;
               border:1px solid #e5e7eb;border-radius:6px;padding:8px;
               box-shadow:0 4px 12px rgba(0,0,0,.1);width:160px;margin-top:4px;z-index:10"
      >
        <p style="margin:0 0 6px;font-size:13px;font-weight:500">Dropdown</p>
        <p style="margin:0;font-size:12px;color:#6b7280">Click outside to close</p>
      </div>
    {/if}
  </div>

  <!-- autosize -->
  <div>
    <h3 style="font-size:13px;margin:0 0 6px">autosize textarea</h3>
    <textarea
      {@attach autosize}
      bind:value={autosizeText}
      style="width:100%;min-height:60px;resize:none;overflow:hidden;
             border:1px solid #d1d5db;border-radius:4px;padding:8px;
             font-family:inherit;font-size:13px"
    ></textarea>
  </div>

</div>`,
  },

  optimisticUI: {
    file: 'OptimisticUI.mesa',
    group: 'Mesa-specific',
    src: `<script>
  // var — non-reactive sampler and staging area.
  // Writes to var are invisible to the reactive graph.
  // Use for: capturing state before an async operation,
  // optimistic updates that precede a server round-trip,
  // and rollback on failure.

  let price    = 99.99
  let saving   = false
  let saved    = false
  let error    = null

  // var — captures price at the start of the operation.
  // Does NOT subscribe to price changes.
  var priceBeforeSave = null

  // Derived — always reflects current price
  const displayPrice = price

  async function save() {
    if (saving) return
    error   = null
    saving  = true
    saved   = false

    priceBeforeSave = price          // snapshot current value — no re-render
    const optimistic = price * 0.9  // apply discount optimistically
    price = +optimistic.toFixed(2)   // reactive write — UI updates immediately

    try {
      // Simulate a slow server round-trip
      await new Promise((res, rej) =>
        setTimeout(() => Math.random() > 0.3 ? res() : rej(new Error('Server error')), 1200)
      )
      saved = true
    } catch (e) {
      // Rollback to pre-save price on failure
      price = priceBeforeSave
      error = e.message
    } finally {
      saving = false
    }
  }

  function reset() {
    price = 99.99; saved = false; error = null
  }
</script>

<h2>Optimistic UI with <code>var</code></h2>

<div style="max-width:300px">
  <div style="font-size:32px;font-weight:700;margin-bottom:4px">
    \${displayPrice.toFixed(2)}
  </div>

  {#if saving}
    <p style="color:#6b7280;font-size:13px">Applying discount…</p>
  {:else if saved}
    <p style="color:#22c55e;font-size:13px">✓ Saved! 10% discount applied.</p>
  {:else if error}
    <p style="color:#ef4444;font-size:13px">✕ {error} — price restored to \${priceBeforeSave?.toFixed(2)}</p>
  {:else}
    <p style="color:#6b7280;font-size:13px">Click to apply a 10% discount optimistically.</p>
  {/if}

  <div style="display:flex;gap:8px;margin-top:12px">
    <button on:click={save} disabled={saving || saved}>
      {saving ? 'Saving…' : 'Apply 10% discount'}
    </button>
    <button on:click={reset} disabled={saving}>Reset</button>
  </div>

  <details style="margin-top:16px;font-size:12px;color:#6b7280">
    <summary style="cursor:pointer">How it works</summary>
    <p style="margin:8px 0 0;line-height:1.6">
      <code>var priceBeforeSave</code> is declared as non-reactive.
      When the async call starts, we capture the current price
      into it (no re-render), update <code>price</code> optimistically
      (immediate re-render), then roll back on failure by
      restoring from <code>priceBeforeSave</code>.
    </p>
  </details>
</div>`,
  },

  commandPalette: {
    file: 'CommandPalette.mesa',
    group: 'Mesa-specific',
    src: `<script>
  // Command palette — Cmd/Ctrl+K opens, Escape closes,
  // arrow keys navigate, Enter runs the command.
  // Uses <mesa:window> for global keyboard capture.

  let open  = false
  let query = ''
  let activeIdx = 0

  const commands = [
    { id: 'new-file',      label: 'New File',            icon: '📄', category: 'File',   action: () => alert('New file') },
    { id: 'open-file',     label: 'Open File…',          icon: '📂', category: 'File',   action: () => alert('Open file') },
    { id: 'save',          label: 'Save',                icon: '💾', category: 'File',   action: () => alert('Saved') },
    { id: 'save-as',       label: 'Save As…',            icon: '💾', category: 'File',   action: () => alert('Save as') },
    { id: 'find',          label: 'Find in File',        icon: '🔍', category: 'Edit',   action: () => alert('Find') },
    { id: 'replace',       label: 'Find and Replace',    icon: '🔄', category: 'Edit',   action: () => alert('Replace') },
    { id: 'undo',          label: 'Undo',                icon: '↩',  category: 'Edit',   action: () => alert('Undo') },
    { id: 'redo',          label: 'Redo',                icon: '↪',  category: 'Edit',   action: () => alert('Redo') },
    { id: 'toggle-theme',  label: 'Toggle Dark Mode',    icon: '🌙', category: 'View',   action: () => alert('Theme toggled') },
    { id: 'zoom-in',       label: 'Zoom In',             icon: '🔎', category: 'View',   action: () => alert('Zoom in') },
    { id: 'zoom-out',      label: 'Zoom Out',            icon: '🔍', category: 'View',   action: () => alert('Zoom out') },
    { id: 'split-editor',  label: 'Split Editor',        icon: '⬜', category: 'View',   action: () => alert('Split') },
    { id: 'git-commit',    label: 'Git: Commit…',        icon: '✔',  category: 'Git',    action: () => alert('Commit') },
    { id: 'git-push',      label: 'Git: Push',           icon: '⬆',  category: 'Git',    action: () => alert('Push') },
    { id: 'git-pull',      label: 'Git: Pull',           icon: '⬇',  category: 'Git',    action: () => alert('Pull') },
    { id: 'git-branch',    label: 'Git: Create Branch…', icon: '🌿', category: 'Git',    action: () => alert('Branch') },
    { id: 'run-tests',     label: 'Run All Tests',       icon: '🧪', category: 'Run',    action: () => alert('Tests running') },
    { id: 'run-build',     label: 'Build Project',       icon: '🔨', category: 'Run',    action: () => alert('Building') },
    { id: 'run-dev',       label: 'Start Dev Server',    icon: '⚡', category: 'Run',    action: () => alert('Dev server started') },
    { id: 'settings',      label: 'Open Settings',       icon: '⚙',  category: 'System', action: () => alert('Settings') },
    { id: 'keyboard',      label: 'Keyboard Shortcuts',  icon: '⌨',  category: 'System', action: () => alert('Shortcuts') },
    { id: 'about',         label: 'About',               icon: 'ℹ',  category: 'System', action: () => alert('About') },
  ]

  const filtered = query.trim()
    ? commands.filter(c =>
        c.label.toLowerCase().includes(query.toLowerCase()) ||
        c.category.toLowerCase().includes(query.toLowerCase())
      )
    : commands

  // Reset active index whenever results change
  $: filtered, () => { activeIdx = 0 }

  function openPalette()  { open = true; query = ''; activeIdx = 0 }
  function closePalette() { open = false }

  function handleKey(e) {
    if (!open) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        openPalette()
      }
      return
    }
    if (e.key === 'Escape')    { closePalette(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % filtered.length }
    if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = (activeIdx - 1 + filtered.length) % filtered.length }
    if (e.key === 'Enter' && filtered[activeIdx]) {
      filtered[activeIdx].action()
      closePalette()
    }
  }

  function run(cmd) { cmd.action(); closePalette() }

  // Group visible results by category for display
  const grouped = filtered.reduce((acc, cmd) => {
    if (!acc[cmd.category]) acc[cmd.category] = []
    acc[cmd.category].push(cmd)
    return acc
  }, {})
</script>

<mesa:window on:keydown={handleKey} />

<div style="text-align:center;padding:32px 0">
  <button on:click={openPalette}
    style="padding:8px 20px;border-radius:6px;font-size:14px;
           cursor:pointer;background:#1e1e2e;color:#f0d8c0;
           border:1px solid #3d2a5e">
    Open palette &nbsp;<kbd style="font-size:11px;opacity:.7">⌘K</kbd>
  </button>
  <p style="font-size:12px;color:#9ca3af;margin-top:8px">
    Or press Cmd/Ctrl+K anywhere
  </p>
</div>

{#if open}
  <!-- Backdrop -->
  <div on:click={closePalette}
    style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99">
  </div>

  <!-- Palette -->
  <div style="position:fixed;top:15vh;left:50%;transform:translateX(-50%);
              width:min(560px,90vw);background:#1e1e2e;border:1px solid #3d2a5e;
              border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.6);z-index:100;
              overflow:hidden">

    <!-- Search input -->
    <div style="display:flex;align-items:center;gap:10px;padding:14px 16px;
                border-bottom:1px solid #2a1e40">
      <span style="color:#5a4878;font-size:16px">⌕</span>
      <input
        bind:value={query}
        placeholder="Type a command…"
        style="flex:1;background:none;border:none;outline:none;
               color:#f0d8c0;font-size:15px;font-family:inherit"
        {@attach (el) => el.focus()}
      />
      <kbd style="font-size:10px;color:#5a4878;border:1px solid #2a1e40;
                  padding:2px 6px;border-radius:3px">Esc</kbd>
    </div>

    <!-- Results -->
    <div style="max-height:min(400px,60vh);overflow-y:auto;padding:6px 0">
      {#if filtered.length === 0}
        <p style="text-align:center;color:#5a4878;font-size:13px;padding:20px">
          No commands match "{query}"
        </p>
      {:else}
        {#each Object.entries(grouped) as [category, cmds] (category)}
          <div style="padding:4px 14px 2px;font-size:10px;letter-spacing:.1em;
                      text-transform:uppercase;color:#5a4878">
            {category}
          </div>
          {#each cmds as cmd (cmd.id)}
            {@const idx = filtered.indexOf(cmd)}
            <div
              on:click={() => run(cmd)}
              on:mouseenter={() => activeIdx = idx}
              style="display:flex;align-items:center;gap:12px;padding:8px 14px;
                     cursor:pointer;font-size:13px;
                     background:{activeIdx === idx ? 'rgba(200,122,220,.12)' : 'transparent'};
                     color:{activeIdx === idx ? '#f0d8c0' : '#c87adc'}"
            >
              <span style="font-size:15px;width:20px;text-align:center">{cmd.icon}</span>
              <span style="flex:1;color:{activeIdx === idx ? '#f0d8c0' : '#a08ab8'}">{cmd.label}</span>
              {#if activeIdx === idx}
                <kbd style="font-size:10px;color:#5a4878;border:1px solid #2a1e40;
                            padding:2px 6px;border-radius:3px">↵</kbd>
              {/if}
            </div>
          {/each}
        {/each}
      {/if}
    </div>
  </div>
{/if}`,
  },

  // ── UI Component Library (@ui/ imports) ───────────────────────────────────────
  // These examples import components from the ui/ folder next to index.html.
  // The REPL fetches @ui/X.mesa files at runtime, compiles them, and makes them
  // available as imports. Requires `npm run serve` (fetch needs a server).

  uiComponents: {
    file: 'UiShowcase.mesa',
    group: 'UI Library',
    src: `<script>
  import Button from '@ui/forms/Button.mesa'
  import Badge  from '@ui/display/Badge.mesa'
  import Card   from '@ui/layout/Card.mesa'
  import Input  from '@ui/forms/Input.mesa'

  let name    = ''
  let loading = false

  function submit() {
    if (!name.trim()) return
    loading = true
    setTimeout(() => { loading = false }, 1500)
  }
</script>

<h2 style="margin-bottom:16px">UI Component Library</h2>

<Card title="Button" subtitle="variant · size · loading · disabled">
  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
    <Button label="Primary"   variant="primary" />
    <Button label="Secondary" variant="secondary" />
    <Button label="Danger"    variant="danger" />
    <Button label="Ghost"     variant="ghost" />
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
    <Button label="Small"  size="sm" />
    <Button label="Medium" size="md" />
    <Button label="Large"  size="lg" />
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:8px">
    <Button label="With icon" icon="🚀" />
    <Button label="Loading"   loading={true} />
    <Button label="Disabled"  disabled={true} />
  </div>
</Card>

<div style="height:12px"></div>

<Card title="Badge" subtitle="color · dot">
  <div style="display:flex;flex-wrap:wrap;gap:8px">
    <Badge label="Blue"   color="blue" />
    <Badge label="Green"  color="green"  dot={true} />
    <Badge label="Yellow" color="yellow" />
    <Badge label="Red"    color="red"    dot={true} />
    <Badge label="Purple" color="purple" />
    <Badge label="Gray"   color="gray" />
  </div>
</Card>

<div style="height:12px"></div>

<Card title="Input" subtitle="label · hint · error · bind:value">
  <div style="display:flex;flex-direction:column;gap:10px;max-width:320px">
    <Input
      bind:value={name}
      label="Your name"
      placeholder="e.g. Alice"
      hint="Used for the greeting below"
    />
    <Input
      label="Email (error state)"
      value="not-an-email"
      error="Please enter a valid email address"
      type="email"
    />
    <Button
      label={loading ? 'Submitting…' : 'Submit'}
      loading={loading}
      disabled={!name.trim()}
      onclick={submit}
    />
    {#if name && !loading}
      <p style="margin:4px 0 0;font-size:13px;color:#6b7280">
        Hello, <strong>{name}</strong>! 👋
      </p>
    {/if}
  </div>
</Card>`,
  },

  inspect: {
    file: 'Inspect.mesa',
    // The store this example imports. Without it the REPL resolves './store.js'
    // to an empty mock, `cart` and `user` are undefined, and the component dies
    // on mount with "Invalid value used as weak map key" — watchProxy(undefined).
    files: [
      {
        name: 'store.js',
        content: `export const cart = { items: 2, total: 40 }
export const user = { name: 'Alice', role: 'admin' }`,
      },
    ],
    group: 'Mesa-specific',
    src: `<script>
  // $inspect — reactive dev-mode inspector
  //
  // Logs values on every change, unwrapping Mesa proxies
  // so you see the real object instead of Proxy {}.
  //
  // Forms:
  //   $inspect(value)             single value, labelled
  //   $inspect(a, b)              multiple values
  //   $inspect(value).with(fn)    custom inspector
  //
  // Stripped in production builds (debug: false). Never needs an import.

  import { cart, user } from './store.js'
  $: cart
  $: user.name

  let count = 0
  let tab = 'A'

  // These all auto-track and re-log on every change:
  $inspect(count)
  $inspect(cart)
  $inspect(user.name)
  $inspect(count, tab)

  const myHandler = (label, values) => console.log('[custom]', label, ...values)
  $inspect(count).with(myHandler)

  const cartSummary = 'total=' + cart.total
</script>

<div style="max-width:400px">
  <p style="font-size:13px;color:#6b7280;margin-bottom:14px">
    Open the browser console. Every button click re-logs the changed values —
    with proxy unwrapping so you see real data, not a Proxy wrapper.
  </p>

  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
    <button on:click={() => count++}>count++ ({count})</button>
    <button on:click={() => cart.total += 10}>cart.total += 10</button>
    <button on:click={() => user.name = user.name === 'Alice' ? 'Bob' : 'Alice'}>
      toggle user.name
    </button>
    <button on:click={() => tab = tab === 'A' ? 'B' : 'A'}>toggle tab ({tab})</button>
  </div>

  <div style="background:#1a1a2e;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;line-height:2;color:#888">
    <div><span style="color:#EE380D;font-weight:600">[Mesa $inspect]</span> count → <strong style="color:#f0d8c0">{count}</strong></div>
    <div><span style="color:#EE380D;font-weight:600">[Mesa $inspect]</span> cart → <strong style="color:#f0d8c0">{cartSummary}</strong></div>
    <div><span style="color:#EE380D;font-weight:600">[Mesa $inspect]</span> user.name → <strong style="color:#f0d8c0">{user.name}</strong></div>
    <div style="color:#444;margin-top:6px;font-size:11px">
      ↑ mirrors console — real output has full object tree in devtools
    </div>
  </div>

  <p style="font-size:11px;color:#6b7280;margin-top:12px">
    Unlike $: console.log(cart), $inspect unwraps the Proxy so you see
    the actual object. Stripped with debug: false in production builds.
  </p>
</div>`,
  },


  // ── Feature coverage (added 2026-08-02) ──────────────────────────────────────

  awaitBlock: {
    group: 'Async',
    file: 'Await.mesa',
    src: `<script>
  let attempt = 0
  let shouldFail = false

  function load(n, fail) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        fail ? reject(new Error('network unreachable')) : resolve('payload #' + n)
      }, 300)
    })
  }

  const request = load(attempt, shouldFail)
</script>

<h2>{'{#await}'} — pending / then / catch</h2>

{#await request}
  <p class="pending">loading…</p>
{:then value}
  <p class="ok">resolved: <strong>{value}</strong></p>
{:catch err}
  <p class="bad">rejected: <strong>{err.message}</strong></p>
{/await}

<button on:click={() => attempt++}>retry</button>
<label><input type="checkbox" bind:checked={shouldFail} /> force failure</label>`,
  },

  slots: {
    group: 'Template',
    file: 'SlotHost.mesa',
    files: [{
      name: 'Panel.mesa',
      content: `<div class="panel">
  <header><slot name="title">Untitled</slot></header>
  <div class="body"><slot /></div>
  <footer><slot name="actions"><em>no actions</em></slot></footer>
</div>

<style>
  /* Panel's own elements, so these are scoped to Panel. The markup the host
     passes INTO a slot belongs to the host and carries the host's scope — a
     rule here cannot reach it. */
  .panel { border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 12px; }
  header { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600; }
  .body  { padding: 12px; }
  footer { padding: 8px 12px; border-top: 1px solid #e5e7eb; background: #fafafa; }
</style>`,
    }],
    src: `<script>
  import Panel from './Panel.mesa'
  let n = 0
</script>

<Panel>
  <h3 slot="title">Filled title</h3>
  <p>Default slot content — count is {n}.</p>
  <button slot="actions" on:click={() => n++}>bump</button>
</Panel>

<Panel>
  <p>This one leaves the named slots empty, so the fallbacks show.</p>
</Panel>`,
  },

  classSystem: {
    group: 'Styling',
    file: 'ClassSystem.mesa',
    files: [
      {
        name: 'Chip.mesa',
        content: `<script>
  // {class} — take the class the parent passed and put it on this element.
  export let label = ''
</script>
<span {class}>{label}</span>`,
      },
      {
        name: 'Field.mesa',
        content: `<script>
  // The same shorthand works on any element, not just the root.
  export let placeholder = ''
  let text = ''
</script>
<input {class} bind:value={text} placeholder={placeholder} />
<small>{text.length} chars</small>`,
      },
    ],
    src: `<script>
  import Chip from './Chip.mesa'
  import Field from './Field.mesa'
  let tone = 'ok'
</script>

<h2>class, passed into a component</h2>

<p>
  A component does not receive <code>class</code> as an ordinary prop — Mesa
  renames it to <code>$class</code>. The child opts in with
  <code>{'{class}'}</code>, which MERGES it into whatever classes that element
  already has.
</p>

<p>
  The class <em>name</em> crosses the boundary; the <em>styling</em> does not.
  A scoped rule <code>.chip</code> compiles to <code>.chip.HASH</code> with
  THIS component's hash, and the child's elements carry the child's hash — so
  the rule below would match nothing. That is why they are
  <code>:global(...)</code>: you are styling markup you do not own.
</p>

<Chip label="status" class={'chip chip--' + tone} />
<Field placeholder="type here" class="field" />

<button on:click={() => tone = tone === 'ok' ? 'warn' : 'ok'}>toggle tone</button>

<style>
  /* :global — every one of these classes is handed to a child component, and a
     scoped rule cannot reach another component's elements (VISION RULE 55).
     The trade is real: these names are now page-global, so keep them specific. */
  :global(.chip) { padding: 2px 8px; border-radius: 999px; font-size: 12px; }
  :global(.chip--ok)   { background: #dcfce7; color: #166534; }
  :global(.chip--warn) { background: #fef9c3; color: #854d0e; }
  :global(.field) { padding: 4px 8px; border: 1px solid #d0d7de; border-radius: 6px; }

  /* Not passed to a child — an ordinary scoped rule is right here. */
  h2 { font-size: 15px; }
</style>`,
  },

  cssFeatures: {
    group: 'Styling',
    file: 'CssFeatures.mesa',
    src: `<script>
  let wide = false
</script>

<div class="card" class:wide={wide}>
  <h3>Nested CSS, @layer, @container</h3>
  <p>Resize the container with the button.</p>
  <p class="repl-note">This line is styled by a :global() rule.</p>
  <button on:click={() => wide = !wide}>{wide ? 'narrow' : 'widen'}</button>
</div>

<style>
  @layer components {
    .card {
      container-type: inline-size;
      width: 260px;
      padding: 14px;
      border: 1px solid #d0d7de;
      border-radius: 8px;

      &.wide { width: 520px; }

      h3 { margin: 0 0 6px; font-size: 14px; }

      button { cursor: pointer; }
    }
  }

  @container (min-width: 400px) {
    .card h3 { color: #0969da; }
  }

  /* :global() opts out of scoping — the selector is emitted verbatim. */
  :global(.repl-note) { font-style: italic; opacity: .75; }

  /* @apply is passed through as a declaration for Uno/Tailwind to expand.
     With no utility framework loaded it is simply inert. */
  .card p { @apply text-sm; }
</style>`,
  },

  autoEffect: {
    group: 'Reactivity',
    file: 'AutoEffect.mesa',
    src: `<script>
  import { cart } from './store.js'

  let count = 0
  let title = ''

  // $: { } — an auto-tracked EFFECT. It re-runs whenever anything it reads
  // changes, with no dependency list. Use it for side effects; use \`const\`
  // for values you derive.
  //
  // Never write something the block also reads — that is a cycle, and the
  // runtime will cap it at 1000 passes and warn.
  $: {
    const next = 'count is ' + count
    title = next
    document.title = next
  }

  // $: (a, b) — a multi-path WATCH. No body: it declares which paths on an
  // external object are reactive, so mutating them in place re-renders.
  $: (cart.items, cart.total)

  function addToCart() {
    cart.items += 1
    cart.total += 20
  }
</script>

<h2>$: auto-effect</h2>
<p>{title} — also written to document.title</p>
<button on:click={() => count++}>bump</button>

<h2>$: multi-path watch</h2>
<p>{cart.items} items — \${cart.total}</p>
<button on:click={addToCart}>add item</button>`,
    files: [{ name: 'store.js', content: `export const cart = { items: 2, total: 40 }\n` }],
  },

  virtualEach: {
    group: 'Template',
    file: 'VirtualEach.mesa',
    src: `<script>
  const rows = Array.from({ length: 10000 }, (_, i) => ({ id: i, name: 'Row ' + i }))
</script>

<h2>{'{#virtual each}'} — 10,000 rows</h2>

<div class="scroller">
  {#virtual each rows as row (row.id)}
    <div class="row">{row.name}</div>
  {/virtual}
</div>

<style>
  .scroller { height: 240px; overflow-y: auto; border: 1px solid #d0d7de; }
  .row { height: 32px; line-height: 32px; padding: 0 10px; }
</style>`,
  },

  documentGlobals: {
    group: 'Globals',
    file: 'DocumentGlobals.mesa',
    src: `<script>
  let keys = 0
  let clicks = 0
</script>

<mesa:head>
  <title>Mesa REPL — document globals</title>
</mesa:head>

<mesa:document on:keydown={() => keys++} />
<mesa:body on:click={() => clicks++} />

<h2>Document-level listeners</h2>
<p>keydown anywhere: <strong>{keys}</strong></p>
<p>click anywhere: <strong>{clicks}</strong></p>`,
  },

}

/**
 * Grouped structure for building the select menu.
 */
export const EXAMPLE_GROUPS = (() => {
  const groups = {}
  for (const [key, ex] of Object.entries(EXAMPLES)) {
    const g = ex.group ?? 'Other'
    if (!groups[g]) groups[g] = []
    groups[g].push({ key, ...ex })
  }
  return groups
})()

/**
 * The key of the example to load on boot.
 *
 * `index.html` imports this by name. The declaration went missing at some point
 * — the doc comment above it survived, the `export` did not — and because a
 * missing named export is a LINK-time error in ESM, the REPL's entire script
 * module stopped executing. Blank page, one console SyntaxError, no other clue.
 * `repl.test.js` now checks every name index.html imports.
 */
export const DEFAULT_EXAMPLE = 'counter'
