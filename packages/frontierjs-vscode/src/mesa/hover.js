/**
 * Mesa hover documentation provider.
 *
 * Matches the word under the cursor (and surrounding context) against
 * known Mesa tokens and returns a markdown tooltip.
 */

'use strict'

const vscode = require('vscode')

// ─── Hover database ────────────────────────────────────────────────────────────

/**
 * Each entry: { match, hover }
 *   match  — function(word, lineText, position) → boolean
 *   hover  — string (markdown) or function(word, lineText) → string
 *
 * Entries are checked in order — first match wins.
 * Put more specific patterns before more general ones.
 */
const HOVER_ENTRIES = [

  // ── $async.name.prop ────────────────────────────────────────────────────────

  {
    match: (word, line) => /\$async\.\w+\.loading/.test(line) && word === 'loading',
    hover: '**`$async.x.loading`** — `boolean`\n\n`true` on the **first** fetch only. `false` once the first result arrives. Use to show a skeleton UI on initial load.\n\n```js\nconst cities = await getCities(selectedState)\n// $async.cities.loading — true until first result\n```'
  },
  {
    match: (word, line) => /\$async\.\w+\.fetching/.test(line) && word === 'fetching',
    hover: '**`$async.x.fetching`** — `boolean`\n\n`true` whenever a fetch is in flight (including refetches). Use to show a spinner or disable controls during reload.\n\n```js\n<select disabled={$async.cities.fetching}>\n```'
  },
  {
    match: (word, line) => /\$async\.\w+\.error/.test(line) && word === 'error',
    hover: '**`$async.x.error`** — `Error | null`\n\nHolds the error thrown by the most recent failed fetch, or `null` if the last fetch succeeded.\n\n```js\n{#if $async.cities.error}\n  <p>{$async.cities.error.message}</p>\n{/if}\n```'
  },
  {
    match: (word, line) => /\$async\.\w+\.status/.test(line) && word === 'status',
    hover: "**`$async.x.status`** — `'pending' | 'success' | 'error'`\n\nThe current state of the async derivation.\n\n| Value | Meaning |\n|---|---|\n| `'pending'` | First fetch not yet resolved |\n| `'success'` | Last fetch succeeded |\n| `'error'` | Last fetch threw |"
  },
  {
    match: (word, line) => line.includes('$async.') && word === '$async',
    hover: "**`$async.x`** — compiler-generated async state\n\nAuto-created for any `const` initialized with `await` that has reactive deps:\n\n```js\nconst cities = await getCities(selectedState)\n// Generates:\n//   $async.cities.loading   — true on first fetch only\n//   $async.cities.fetching  — true any time a fetch is in flight\n//   $async.cities.error     — Error | null\n//   $async.cities.status    — 'pending' | 'success' | 'error'\n```\n\n> `$async.x` only exists on variables declared with `await` at the top level."
  },

  // ── $context ─────────────────────────────────────────────────────────────────

  {
    match: (word, line) => word === '$context' || line.match(/\$context\./),
    hover: "**`$context`** — subtree-scoped shared state\n\nProvide values to all descendant components. Read with `let`, `const`, or `var` — same semantics as regular variables.\n\n```js\n// Provider (write to provide)\n$context.theme = darkMode       // reactive: darkMode is a signal\n$context.color = 'hsl(' + h + ', 70%, 55%)'  // derived expr\n\n// Consumer (read to consume)\nconst theme = $context.theme    // read-only, re-derives when provider changes\nlet   theme = $context.theme    // writable derived, locally overridable\nvar   theme = $context.theme    // snapshot at mount, non-reactive\n```\n\n> `$context` provides and consumes must be at the **top level** of the script block."
  },

  // ── $.transition / $.entrance ────────────────────────────────────────────────

  {
    match: (word, line) => line.includes('$.transition') && word === 'transition',
    hover: "**`$.transition(fn)`** — View Transitions API wrapper\n\nWraps a state change so the browser cross-fades between old and new DOM. Falls back to `batch(fn)` in unsupported browsers.\n\n```js\n$.transition(() => show = !show)\n$.transition(() => { tab = 'home'; items = newData })\n```\n\nControl the animation with CSS:\n```css\n::view-transition-old(card) { animation: fade-out 200ms ease }\n::view-transition-new(card) { animation: fade-in  200ms ease }\n```\n\n```html\n<div style=\"view-transition-name:card\">\n  {content}\n</div>\n```\n\n> Requires Chrome / Edge / Safari 18+."
  },
  {
    match: (word, line) => line.includes('$.entrance') && word === 'entrance',
    hover: "**`$.entrance({ in, out })`** — enter/exit animation attachment\n\nReturns an attachment function for `{@attach}`. If `out` returns a Promise, the element stays in the DOM until it resolves — no height collapse.\n\n```js\nconst fade = $.entrance({\n  in:  (el) => el.animate(\n    [{ opacity: 0 }, { opacity: 1 }],\n    { duration: 250, fill: 'forwards' }\n  ),\n  out: (el) => el.animate(\n    [{ opacity: 1 }, { opacity: 0 }],\n    { duration: 200, fill: 'forwards' }\n  ).finished  // Promise — defers removal\n})\n```\n\n```html\n{#if show}\n  <div {@attach fade}>content</div>\n{/if}\n```"
  },

  // ── $: reactive annotation ────────────────────────────────────────────────────

  {
    match: (word, line) => word === '$' && /^\s*\$:/.test(line),
    hover: "**`$:`** — Mesa reactive annotation\n\nFour forms depending on shape:\n\n```js\n$: user.name                    // path watch — re-render when user.name changes\n$: count, () => save(count)     // watch + handler — explicit dep\n$: doubled = count * 2          // writable derived — re-derives + overridable\n$: console.log(count)           // side effect — auto-tracked deps\n```\n\n> `$:` annotations must be at the **top level** of the script block — never inside functions or blocks."
  },

  // ── Mesa builtins ─────────────────────────────────────────────────────────────

  {
    match: (word) => word === '$onMount',
    hover: "**`$onMount(fn)`** — lifecycle hook\n\nRuns `fn` after the component's DOM is mounted. **No-op on the server** (SSR safe).\n\n```js\n$onMount(() => {\n  canvas.getContext('2d').fillRect(0, 0, 100, 100)\n})\n```\n\nAlso exported as `onMount` from `@mesa/runtime` for use inside composable helpers."
  },
  {
    match: (word) => word === '$onDestroy',
    hover: "**`$onDestroy(fn)`** — lifecycle hook\n\nRuns `fn` when the component is removed from the DOM. Use for cleanup that doesn't belong in a `{@attach}` return value.\n\n```js\nconst interval = setInterval(tick, 1000)\n$onDestroy(() => clearInterval(interval))\n```\n\nAlso exported as `onDestroy` from `@mesa/runtime`."
  },
  {
    match: (word) => word === '$onCleanup',
    hover: "**`$onCleanup(fn)`** — watch handler cleanup\n\nRegisters `fn` inside a `$:` watch+handler. Runs before the handler re-executes (dep changed) and on component destroy. Must be called **before the first `await`**.\n\n```js\n$: selectedId, async () => {\n  const controller = new AbortController()\n  $onCleanup(() => controller.abort())   // ← before await\n  const data = await fetch(`/api/${selectedId}`, {\n    signal: controller.signal\n  })\n  result = await data.json()\n}\n```"
  },
  {
    match: (word) => word === '$emit',
    hover: "**`$emit(eventName, data?)`** — dispatch component event\n\nCalls the parent's `on{EventName}` prop directly. Both `onclick` and `onClick` naming are checked.\n\n```js\n// MyButton.mesa\nfunction handleClick(e) {\n  $emit('click', e)   // calls parent's onclick / onClick prop\n}\n```\n\n```html\n<!-- Parent -->\n<MyButton onclick={handleClick} />\n```\n\n> `on:event` on a **component** is a compiler error. Use `onclick={fn}` prop instead."
  },
  {
    match: (word) => word === '$props',
    hover: "**`$props`** — all received props\n\nAll props passed to the current component, including undeclared ones. Useful for spread-forwarding.\n\n```js\n// Forward all props to a child\n<Inner {...$props} />\n```"
  },
  {
    match: (word) => word === '$attributes',
    hover: "**`$attributes`** — non-prop attributes\n\nAll attributes passed to the current component that are **not** declared as props. Includes `class`, `style`, `{@attach}` attachments, and event handlers.\n\nUsed inside a component to forward attributes to its root element:\n\n```html\n<div {...$attributes}>\n  <!-- slot content -->\n</div>\n```"
  },

  // ── Template directives ───────────────────────────────────────────────────────

  {
    match: (word, line) => word === 'bind' && line.includes('bind:this'),
    hover: "**`bind:this={ref}`** — DOM element or component reference\n\nCaptures the raw DOM node (or component instance) into a reactive variable. Set immediately after the element mounts.\n\n```html\n<script>let canvas</script>\n<canvas bind:this={canvas}></canvas>\n\n<!-- After mount: canvas is the real HTMLCanvasElement -->\n```\n\n```html\n<script>let chart</script>\n<Chart bind:this={chart} />\n```\n\n> Requires a top-level `let` variable — `const` and `var` are compiler errors."
  },
  {
    match: (word, line) => word === 'bind' && line.includes('bind:group'),
    hover: "**`bind:group={signal}`** — checkbox / radio group binding\n\n**Checkboxes** — signal is an array. Selected values are added/removed:\n```html\n<script>let selected = []</script>\n<input type=\"checkbox\" bind:group={selected} value=\"apples\">\n<input type=\"checkbox\" bind:group={selected} value=\"bananas\">\n```\n\n**Radios** — signal is a scalar. Set to the selected value:\n```html\n<script>let size = 'M'</script>\n<input type=\"radio\" bind:group={size} value=\"S\">\n<input type=\"radio\" bind:group={size} value=\"M\">\n```\n\n> Requires a top-level `let` variable."
  },
  {
    match: (word, line) => word === 'bind' && line.includes('bind:value'),
    hover: "**`bind:value={variable}`** — two-way input binding\n\nWires an input element to a reactive variable. Reads and writes are both live.\n\n```html\n<input bind:value={query}>\n<textarea bind:value={body}>\n<select bind:value={selectedId}>\n```\n\nFor `bind:` on a **component prop**, the prop must be declared with `export let` — `export const` and `export var` are compiler errors."
  },
  {
    match: (word, line) => word === 'bind',
    hover: "**`bind:prop={variable}`** — two-way binding directive\n\n| Form | Purpose |\n|---|---|\n| `bind:value={var}` | Two-way input binding |\n| `bind:this={ref}` | Capture DOM/component reference |\n| `bind:group={arr}` | Checkbox/radio group |\n| `bind:innerWidth={var}` | Window property binding (inside `<mesa:window>`) |\n\nOn component props, `bind:` is only valid on `export let` props."
  },
  {
    match: (word, line) => word === 'class' && line.includes('class:'),
    hover: "**`class:name={expr}`** — conditional CSS class\n\nApplies the class when `expr` is truthy. The shorthand `class:name` applies when a variable named `name` is truthy.\n\n```html\n<div class:active={isActive}>\n<div class:dark>                    <!-- shorthand -->\n<div class:active={isActive} class:loading={isFetching}>\n```"
  },
  {
    match: (word, line) => word === 'style' && line.includes('style:'),
    hover: "**`style:prop={expr}`** — reactive inline style\n\nSets a CSS property reactively. Supports mixed template-literal values for unit composition.\n\n```html\n<div style:color={textColor}>\n<div style:font-size=\"{size}px\">    <!-- mixed value -->\n<div style:display>                 <!-- shorthand: sets display from variable named 'display' -->\n```"
  },
  {
    match: (word, line) => word === 'on' && line.includes('on:'),
    hover: "**`on:event|modifier={handler}`** — DOM event listener\n\n```html\n<button on:click={handler}>\n<form on:submit|preventDefault={onSubmit}>\n<input on:input|debounce(300)={search}>\n<div on:click|once|stopPropagation={handler}>\n```\n\n**Modifiers:**\n\n| Modifier | Effect |\n|---|---|\n| `once` | Remove handler after first call |\n| `passive` | addEventListener `passive: true` |\n| `capture` | Capture phase |\n| `preventDefault` | `e.preventDefault()` |\n| `stopPropagation` | `e.stopPropagation()` |\n| `self` | Only when `target === currentTarget` |\n| `trusted` | Only real user events |\n| `debounce(ms)` | Debounce — arg can be reactive `{delay}` |\n| `throttle(ms)` | Throttle |\n\n> `on:event` on a **component** is a compiler error. Use `onclick={fn}` prop instead."
  },

  // ── {@attach} ────────────────────────────────────────────────────────────────

  {
    match: (word, line) => word === 'attach' && line.includes('@attach'),
    hover: "**`{@attach fn}`** — element lifecycle attachment\n\n`fn(el)` is called when the element mounts. The return value determines cleanup:\n\n```js\n// Return nothing — no cleanup\n(el) => el.focus()\n\n// Return a function — cleanup before re-run and on destroy\n(el) => {\n  el.addEventListener('mousedown', start)\n  return () => el.removeEventListener('mousedown', start)\n}\n\n// Return a Promise — element stays in DOM until resolved\n// (used for exit animations)\n(el) => el.animate([{opacity:1},{opacity:0}], 300).finished\n```\n\n`{@attach}` can be on both DOM elements and components."
  },

  // ── {#each} ──────────────────────────────────────────────────────────────────

  {
    match: (word, line) => word === 'each' && (line.includes('#each') || line.includes('/each')),
    hover: "**`{#each items as item (key)}`** — reactive list rendering\n\n```html\n{#each items as item (item.id)}\n  <div>{item.name}</div>\n{/each}\n\n<!-- With index -->\n{#each items as item, i (item.id)}\n  <div>{i}: {item.name}</div>\n{/each}\n\n<!-- With else (empty state) -->\n{#each items as item (item.id)}\n  <div>{item.name}</div>\n{:else}\n  <p>No items</p>\n{/each}\n```\n\nThe key `(item.id)` is strongly recommended for stateful lists — it lets Mesa reuse DOM nodes on reorder instead of recreating them."
  },

  // ── {#if} ────────────────────────────────────────────────────────────────────

  {
    match: (word, line) => word === 'if' && (line.includes('#if') || line.includes('/if')),
    hover: "**`{#if condition}`** — conditional rendering\n\n```html\n{#if isLoggedIn}\n  <Dashboard />\n{:else if isPending}\n  <Spinner />\n{:else}\n  <Login />\n{/if}\n```\n\nThe element is removed from the DOM when the condition is false (not just hidden). Use `style:display` or CSS for show/hide without unmounting."
  },

  // ── {#await} ─────────────────────────────────────────────────────────────────

  {
    match: (word, line) => word === 'await' && (line.includes('#await') || line.includes('/await')),
    hover: "**`{#await promise}`** — inline promise handling\n\n```html\n{#await loadData()}\n  <p>Loading…</p>\n{:then data}\n  <p>{data.name}</p>\n{:catch error}\n  <p>Error: {error.message}</p>\n{/await}\n```\n\nFor top-level async state with `$async.x`, prefer:\n\n```js\nconst data = await loadData(dep)\n// then use $async.data.loading / fetching / error in template\n```"
  },

  // ── Mesa special elements ─────────────────────────────────────────────────────

  {
    match: (word, line) => line.includes('mesa:window'),
    hover: "**`<mesa:window>`** — window event and property bindings\n\n```html\n<mesa:window\n  on:resize={handleResize}\n  on:keydown|preventDefault={handleKey}\n  bind:innerWidth={width}\n  bind:scrollY={scrollPos}\n  bind:online={isOnline}\n>\n```\n\n**Bindable properties:** `innerWidth`, `innerHeight`, `outerWidth`, `outerHeight`, `devicePixelRatio`, `scrollX`, `scrollY`, `online`\n\nAll `on:` modifiers work on window events."
  },
  {
    match: (word, line) => line.includes('mesa:document'),
    hover: "**`<mesa:document>`** — document event listeners\n\nBind event listeners to `document`. Useful for events that don't fire on `window`.\n\n```html\n<mesa:document\n  on:visibilitychange={handleVisibility}\n  on:keydown|preventDefault={handleKey}\n  on:click={handleGlobalClick}\n>\n```"
  },
  {
    match: (word, line) => line.includes('mesa:body'),
    hover: "**`<mesa:body>`** — body event listeners\n\nBind event listeners to `document.body`. Useful for `mouseenter`/`mouseleave` tracking.\n\n```html\n<mesa:body\n  on:mouseenter={startTracking}\n  on:mouseleave={stopTracking}\n>\n```"
  },
  {
    match: (word, line) => line.includes('mesa:head'),
    hover: "**`<mesa:head>`** — reactive document head\n\nInjects content into `document.head`. Reactive — updates when bindings change. Removed on component destroy.\n\n```html\n<mesa:head>\n  <title>{pageTitle}</title>\n  <meta name=\"description\" content={description}>\n  <link rel=\"stylesheet\" href={themeUrl}>\n</mesa:head>\n```"
  },
  {
    match: (word, line) => line.includes('mesa:portal'),
    hover: "**`<mesa:portal to={target}>`** — render into any DOM node\n\nRenders children into `target`, escaping overflow and stacking context. The `to` expression is reactive — if it changes, the portal moves.\n\n```html\n<mesa:portal to={document.body}>\n  <div class=\"modal\">I'm in body, not the component tree</div>\n</mesa:portal>\n```\n\nContent is removed from the target when the component is destroyed."
  },

  // ── export let / const / var ──────────────────────────────────────────────────

  {
    match: (word, line) => word === 'let' && /^\s*export\s+let/.test(line),
    hover: "**`export let name = default`** — reactive prop\n\nThe parent can pass a new value at any time and the component re-renders. The component can also reassign it. Two-way binding with `bind:` is supported.\n\n```js\nexport let quantity = 1    // parent writes, component reads/writes\nexport let selected        // no default — undefined until parent provides\n```\n\n| | `export let` |\n|---|---|\n| Parent writes | ✓ |\n| Component writes | ✓ |\n| `bind:` valid | ✓ |"
  },
  {
    match: (word, line) => word === 'const' && /^\s*export\s+const/.test(line),
    hover: "**`export const name = default`** — immutable prop\n\nThe parent can pass a value. The component **cannot** reassign it — compiler error if attempted. Use for read-only configuration.\n\n```js\nexport const sku      = 'WGT-001'\nexport const currency = 'USD'\n```\n\n| | `export const` |\n|---|---|\n| Parent writes | ✓ |\n| Component writes | ✗ (compiler error) |\n| `bind:` valid | ✗ (compiler error) |"
  },
  {
    match: (word, line) => word === 'var' && /^\s*export\s+var/.test(line),
    hover: "**`export var name = default`** — non-reactive prop\n\nThe parent passes a value at mount. The component snapshots it immediately and **never re-reads it**, even if the parent later passes a different value.\n\n```js\nexport var taxRate = 0.08    // captured once — parent changes ignored\nexport var region  = 'US'\n```\n\n| | `export var` |\n|---|---|\n| Parent writes | Mount only |\n| Component writes | Has no effect on parent |\n| `bind:` valid | ✗ (compiler error) |"
  },

  // ── let / const / var (non-export) ───────────────────────────────────────────

  {
    match: (word, line) => word === 'let' && /^\s*let\s/.test(line) && !/export/.test(line),
    hover: "**`let name = expr`** — reactive signal\n\nThe primary reactive primitive. The compiler tracks it, wires it to the reactive graph, and re-renders any template bindings when it changes.\n\nThe initializer is evaluated **once at init** — it's a snapshot, not an ongoing derivation. To re-derive from other reactive vars:\n\n```js\nlet count = 0            // reactive signal\nlet items = []           // reactive signal\n\n// ✗ does NOT re-derive when items changes:\nlet first = items[0]\n\n// ✓ use $: writable derived instead:\n$: first = items[0]      // re-derives when items changes, overridable\n```"
  },
  {
    match: (word, line) => word === 'const' && /^\s*const\s/.test(line) && !/export/.test(line),
    hover: "**`const name = expr`** — derived or static value\n\nIf the initializer references reactive variables, Mesa automatically creates a derived memo that recomputes when deps change. If not, it's inlined as a plain constant.\n\n```js\nconst double  = count * 2           // derived — reruns when count changes\nconst isDark  = theme === 'dark'    // derived from theme\nconst cities  = await getCities(s)  // async derived — reruns when s changes\nconst MAX     = 100                 // static — no reactive deps\n```\n\nThe developer cannot assign to a derived `const` — compiler error."
  },
  {
    match: (word, line) => word === 'var' && /^\s*var\s/.test(line) && !/export/.test(line),
    hover: "**`var name = expr`** — non-reactive sampler\n\nIntentionally floats outside the reactive graph. Can **read** reactive values without subscribing. **Writes are invisible** — nothing re-renders.\n\n```js\nlet price = 100\nvar snapshot = price     // captures current value — does NOT subscribe\n                         // snapshot stays 100 even if price changes\n\nvar previous = null      // hold last value for rollback\nvar cache    = new Map() // memoization — no re-renders\n```\n\n> **`var` does not belong in the template.** Use `let` or `const` for template bindings."
  },

]

// ─── Provider ──────────────────────────────────────────────────────────────────

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.Position}     position
 * @returns {vscode.Hover | null}
 */
function provideHover(document, position) {
  const line     = document.lineAt(position.line).text
  const wordRange = document.getWordRangeAtPosition(
    position,
    // Extended word pattern that captures $-prefixed identifiers
    /\$[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*|[a-zA-Z_$][a-zA-Z0-9_$]*/
  )
  const word = wordRange ? document.getText(wordRange) : ''

  for (const entry of HOVER_ENTRIES) {
    if (!entry.match(word, line, position)) continue

    const content = typeof entry.hover === 'function'
      ? entry.hover(word, line)
      : entry.hover

    const md = new vscode.MarkdownString(content)
    md.isTrusted = true
    return new vscode.Hover(md, wordRange)
  }

  return null
}

module.exports = { provideHover }
