/**
 * Mesa completions provider.
 *
 * Trigger characters: $ { : | <
 *
 * Context is determined by inspecting the text before the cursor on the
 * current line and whether the cursor is inside a <script> block.
 *
 * All completions are static (no file analysis needed for Tier 1).
 * Dynamic completions (reactive var names for class:/style:) do a lightweight
 * regex scan of the document's <script> block.
 */

'use strict'

const vscode = require('vscode')
const { CompletionItem, CompletionItemKind, SnippetString, MarkdownString } = vscode

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a CompletionItem quickly */
function item(label, kind, detail, doc, insertText) {
  const ci = new CompletionItem(label, kind)
  if (detail)     ci.detail     = detail
  if (doc)        ci.documentation = new MarkdownString(doc)
  if (insertText) ci.insertText = insertText instanceof SnippetString
    ? insertText
    : new SnippetString(insertText)
  return ci
}

const K = CompletionItemKind

/** Extract top-level let/const/var names from the script block */
function getScriptVarNames(document) {
  const src = document.getText()
  const scriptMatch = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (!scriptMatch) return []
  const scriptSrc = scriptMatch[1]
  const names = []
  const re = /^\s*(?:export\s+)?(?:let|const|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm
  let m
  while ((m = re.exec(scriptSrc)) !== null) names.push(m[1])
  return [...new Set(names)]
}

/** Check if cursor is inside the <script> block */
function isInScript(document, position) {
  const src = document.getText()
  const offset = document.offsetAt(position)
  const scriptStart = src.search(/<script[^>]*>/)
  if (scriptStart === -1) return false
  const scriptTagEnd = src.indexOf('>', scriptStart) + 1
  const scriptClose  = src.indexOf('</script>', scriptTagEnd)
  return offset > scriptTagEnd && (scriptClose === -1 || offset < scriptClose)
}

/** Check if cursor is inside a tag (between < and >) — for attribute completions */
function isInTag(document, position) {
  const lineText = document.lineAt(position.line).text
  const charIdx  = position.character
  // Simple heuristic: scan backwards for < or >
  const before = lineText.slice(0, charIdx)
  const lastOpen  = before.lastIndexOf('<')
  const lastClose = before.lastIndexOf('>')
  return lastOpen > lastClose && !before.slice(lastOpen).startsWith('</')
}

// ─── Completion sets ──────────────────────────────────────────────────────────

function dollarCompletions(inScript) {
  const results = []

  if (inScript) {
    // $: forms
    results.push(
      item('$: watch+handler', K.Keyword, 'Watch + handler',
        '`$: dep, () => { }` — explicit dep, handler runs untracked',
        '$: ${1:dep}, ${2:async }() => {\n\t$0\n}'),
      item('$: writable derived', K.Keyword, 'Writable derived signal',
        '`$: name = expr` — re-derives when deps change, manually overridable',
        '$: ${1:name} = ${2:expr}'),
      item('$: side effect', K.Keyword, 'Auto-tracked side effect',
        '`$: expr` — reruns when any reactive variable it reads changes',
        '$: ${1:expr}'),
    )

    // $context
    results.push(
      item('$context.key = value', K.Variable, 'Provide context',
        '`$context.key = expr` — provide reactive value to all descendants',
        '\\$context.${1:key} = ${2:value}'),
      item('const x = $context.key', K.Variable, 'Consume context (read-only)',
        '`const name = $context.key` — read-only, re-derives when provider changes',
        'const ${1:name} = \\$context.${2:key}'),
      item('let x = $context.key', K.Variable, 'Consume context (writable)',
        '`let name = $context.key` — writable derived, locally overridable',
        'let ${1:name} = \\$context.${2:key}'),
    )

    // $. namespace
    results.push(
      item('$.transition(fn)', K.Function, 'View Transitions wrapper',
        '`$.transition(fn)` — wraps state change in View Transitions API',
        '\\$.transition(() => {\n\t$0\n})'),
      item('$.entrance({ in, out })', K.Function, 'Enter/exit animation',
        '`$.entrance({ in, out })` — returns an attachment for enter/exit animation',
        [
          '\\$.entrance({',
          '\tin:  (el) => el.animate(',
          '\t\t[{ opacity: 0, transform: \'translateY(-8px)\' }, { opacity: 1, transform: \'translateY(0)\' }],',
          '\t\t{ duration: ${1:250}, easing: \'ease-out\', fill: \'forwards\' }',
          '\t),',
          '\tout: (el) => el.animate(',
          '\t\t[{ opacity: 1, transform: \'translateY(0)\' }, { opacity: 0, transform: \'translateY(-8px)\' }],',
          '\t\t{ duration: ${2:200}, easing: \'ease-in\', fill: \'forwards\' }',
          '\t).finished',
          '})',
        ].join('\n')),
    )

    // Lifecycle builtins
    results.push(
      item('$onMount', K.Function, 'Lifecycle — after mount',
        '`$onMount(fn)` — runs after component\'s DOM is mounted. No-op on server.',
        '\\$onMount(() => {\n\t$0\n})'),
      item('$onDestroy', K.Function, 'Lifecycle — on destroy',
        '`$onDestroy(fn)` — runs when component is removed from DOM.',
        '\\$onDestroy(() => {\n\t$0\n})'),
      item('$onCleanup', K.Function, 'Watch cleanup',
        '`$onCleanup(fn)` — cleanup inside `$:` watch+handler. Runs before re-run and on destroy.',
        '\\$onCleanup(() => {\n\t$0\n})'),
      item('$emit', K.Function, 'Dispatch component event',
        '`$emit(name, data?)` — calls the parent\'s `onclick`/`onClick` prop.',
        '\\$emit(\'${1:click}\'${2:, $3})'),
      item('$props', K.Variable, 'All received props',
        '`$props` — all props passed to this component, including undeclared ones.'),
      item('$attributes', K.Variable, 'Non-prop attributes',
        '`$attributes` — all non-prop attributes (class, style, attachments, events).'),
      item('$async', K.Variable, 'Async state',
        '`$async.x.loading/fetching/error/status` — auto-generated for async derived consts.'),
    )
  }

  return results
}

function braceCompletions() {
  return [
    item('{#if}', K.Keyword, 'Conditional block',
      '`{#if condition}...{/if}`',
      '{#if ${1:condition}}\n\t$0\n{/if}'),
    item('{#if}{:else}', K.Keyword, 'Conditional with else',
      '`{#if}...{:else}...{/if}`',
      '{#if ${1:condition}}\n\t$2\n{:else}\n\t$3\n{/if}'),
    item('{#each}', K.Keyword, 'Each block',
      '`{#each items as item (key)}...{/each}`',
      '{#each ${1:items} as ${2:item} (${2:item}.${3:id})}\n\t$0\n{/each}'),
    item('{#each}{:else}', K.Keyword, 'Each with empty state',
      '`{#each}...{:else}...{/each}`',
      '{#each ${1:items} as ${2:item} (${2:item}.${3:id})}\n\t$4\n{:else}\n\t$5\n{/each}'),
    item('{#await}', K.Keyword, 'Await block',
      '`{#await promise}{:then value}{:catch error}{/await}`',
      '{#await ${1:promise}}\n\t<p>Loading…</p>\n{:then ${2:value}}\n\t$0\n{:catch ${3:error}}\n\t<p>{${3:error}.message}</p>\n{/await}'),
    item('{#snippet}', K.Keyword, 'Snippet block',
      '`{#snippet name(params)}...{/snippet}`',
      '{#snippet ${1:name}(${2:params})}\n\t$0\n{/snippet}'),
    item('{#key}', K.Keyword, 'Key block — destroy/recreate on change',
      '`{#key expr}...{/key}` — tears down and remounts content when expr changes',
      '{#key ${1:expr}}\n\t$0\n{/key}'),
    item('{@render}', K.Keyword, 'Render a snippet',
      '`{@render name(args)}` — mounts a snippet inline',
      '{@render ${1:snippet}($2)}'),
    item('{@attach}', K.Keyword, 'Element lifecycle attachment',
      '`{@attach fn}` — runs fn(el) on mount, cleanup on destroy',
      '{@attach ${1:fn}}'),
    item('{@html}', K.Keyword, 'Raw HTML injection',
      '`{@html expr}` — injects raw HTML (unescaped)',
      '{@html ${1:expr}}'),
  ]
}

function bindColon(afterBind) {
  // Completions for text after "bind:"
  const dom = [
    item('bind:class', K.Property, '$class prop — two-way class passthrough',
      '`bind:class` — auto-wires the `$class` prop; parent passes `class="..."` on component',
      'class'),
    item('bind:value', K.Property, 'Two-way input binding',
      '`bind:value={var}` — wires input/textarea/select to a reactive variable',
      'value={${1:variable}}'),
    item('bind:this', K.Property, 'Element reference',
      '`bind:this={ref}` — captures DOM element or component instance',
      'this={${1:ref}}'),
    item('bind:group', K.Property, 'Checkbox/radio group',
      '`bind:group={arr}` — checkbox (array) or radio (scalar) group binding',
      'group={${1:selected}}'),
    item('bind:checked', K.Property, 'Checkbox checked',
      '`bind:checked={bool}` — two-way bind checkbox checked state',
      'checked={${1:checked}}'),
  ]
  const window = [
    item('bind:innerWidth',       K.Property, 'Window property', '`bind:innerWidth={var}` — reactive `window.innerWidth`',       'innerWidth={${1:width}}'),
    item('bind:innerHeight',      K.Property, 'Window property', '`bind:innerHeight={var}` — reactive `window.innerHeight`',      'innerHeight={${1:height}}'),
    item('bind:scrollX',          K.Property, 'Window property', '`bind:scrollX={var}` — reactive `window.scrollX`',             'scrollX={${1:x}}'),
    item('bind:scrollY',          K.Property, 'Window property', '`bind:scrollY={var}` — reactive `window.scrollY`',             'scrollY={${1:y}}'),
    item('bind:online',           K.Property, 'Window property', '`bind:online={var}` — reactive `navigator.onLine`',            'online={${1:online}}'),
    item('bind:devicePixelRatio', K.Property, 'Window property', '`bind:devicePixelRatio={var}` — reactive device pixel ratio',  'devicePixelRatio={${1:dpr}}'),
  ]
  if (afterBind === 'window') return window
  return dom
}

const COMMON_EVENTS = [
  'click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'mouseenter', 'mouseleave',
  'keydown', 'keyup', 'keypress',
  'input', 'change', 'submit', 'reset', 'focus', 'blur', 'focusin', 'focusout',
  'scroll', 'resize', 'wheel',
  'touchstart', 'touchend', 'touchmove',
  'pointerdown', 'pointerup', 'pointermove', 'pointerenter', 'pointerleave',
  'dragstart', 'drag', 'dragend', 'dragover', 'dragenter', 'dragleave', 'drop',
  'contextmenu', 'select', 'load', 'error',
  'visibilitychange', 'fullscreenchange',
  'animationstart', 'animationend', 'transitionend',
]

function onColon() {
  return COMMON_EVENTS.map((ev) =>
    item(`on:${ev}`, K.Event, `DOM event: ${ev}`,
      `\`on:${ev}={handler}\``,
      `${ev}={\${1:handler}}`
    )
  )
}

const MODIFIERS = [
  { name: 'preventDefault',  detail: 'Calls e.preventDefault()' },
  { name: 'stopPropagation', detail: 'Calls e.stopPropagation()' },
  { name: 'self',            detail: 'Only fires when target === currentTarget' },
  { name: 'trusted',         detail: 'Only fires for real user events' },
  { name: 'once',            detail: 'Remove listener after first call' },
  { name: 'passive',         detail: 'addEventListener passive:true (scroll perf)' },
  { name: 'capture',         detail: 'Capture phase listener' },
  { name: 'debounce(300)',   detail: 'Debounce — arg can be reactive {delay}' },
  { name: 'throttle(500)',   detail: 'Throttle in ms' },
]

function pipeModifiers() {
  return MODIFIERS.map(({ name, detail }) =>
    item(`|${name}`, K.Operator, detail,
      `\`|${name}\` — ${detail}`,
      name.includes('(') ? `${name.split('(')[0]}(\${1:${name.match(/\((\d+)/)?.[1] ?? 'ms'}})` : name
    )
  )
}

function mesaColonCompletions() {
  const elements = [
    { name: 'window',   detail: 'Window events + property bindings',
      doc: '`<mesa:window>` — bind events and properties to `window`.\n\nSupports `on:` events and `bind:innerWidth`, `bind:scrollY`, `bind:online` etc.' },
    { name: 'document', detail: 'Document event listeners',
      doc: '`<mesa:document>` — bind event listeners to `document`.' },
    { name: 'body',     detail: 'Body event listeners',
      doc: '`<mesa:body>` — bind event listeners to `document.body`.' },
    { name: 'head',     detail: 'Reactive document head',
      doc: '`<mesa:head>` — inject reactive content into `document.head`. Removed on destroy.' },
    { name: 'portal',   detail: 'Render into any DOM node',
      doc: '`<mesa:portal to={target}>` — render children into `target`, escaping overflow/stacking context.' },
    { name: 'boundary', detail: 'Error boundary',
      doc: '`<mesa:boundary>` — catch errors in the subtree and render a fallback.' },
  ]
  return elements.map(({ name, detail, doc }) =>
    item(`mesa:${name}`, K.Class, detail, doc,
      name === 'portal'
        ? `mesa:portal to={\${1:document.body}}>\n\t$0\n</mesa:portal>`
        : name === 'head'
        ? `mesa:head>\n\t$0\n</mesa:head>`
        : `mesa:${name}>`
    )
  )
}

function classColonCompletions(document) {
  const vars = getScriptVarNames(document)
  const base = [
    item('class:active={expr}',  K.Property, 'Conditional class', '`class:active={isActive}`', 'active={${1:condition}}'),
    item('class:name (shorthand)', K.Property, 'Shorthand class', '`class:name` — applies class when variable `name` is truthy', '${1:name}'),
  ]
  const dynamic = vars.map((v) =>
    item(`class:${v}`, K.Property, `Apply class when \`${v}\` is truthy`,
      `\`class:${v}\` — shorthand, applies when \`${v}\` is truthy`,
      v)
  )
  return [...base, ...dynamic]
}

function styleColonCompletions(document) {
  const vars = getScriptVarNames(document)
  const commonProps = [
    ['color',            'CSS color'],
    ['background-color', 'CSS background color'],
    ['background',       'CSS background'],
    ['font-size',        'CSS font size — supports mixed: `"{size}px"`'],
    ['font-weight',      'CSS font weight'],
    ['font-family',      'CSS font family'],
    ['width',            'CSS width'],
    ['height',           'CSS height'],
    ['max-width',        'CSS max-width'],
    ['min-width',        'CSS min-width'],
    ['padding',          'CSS padding'],
    ['margin',           'CSS margin'],
    ['border',           'CSS border'],
    ['border-radius',    'CSS border-radius'],
    ['opacity',          'CSS opacity'],
    ['display',          'CSS display'],
    ['flex',             'CSS flex'],
    ['grid',             'CSS grid'],
    ['gap',              'CSS gap'],
    ['transform',        'CSS transform'],
    ['transition',       'CSS transition'],
    ['z-index',          'CSS z-index'],
    ['cursor',           'CSS cursor'],
    ['overflow',         'CSS overflow'],
    ['visibility',       'CSS visibility'],
    ['position',         'CSS position'],
    ['top',              'CSS top'],
    ['left',             'CSS left'],
    ['right',            'CSS right'],
    ['bottom',           'CSS bottom'],
  ]

  const propItems = commonProps.map(([prop, detail]) =>
    item(`style:${prop}`, K.Property, detail,
      `\`style:${prop}={expr}\` or \`style:${prop}="{expr}unit"\` for mixed values`,
      `${prop}={\${1:value}}`)
  )

  const varItems = vars.map((v) =>
    item(`style:${v}`, K.Property, `Set style from reactive variable \`${v}\``,
      `\`style:${v}={${v}}\``,
      `${v}={${v}}`)
  )

  return [...propItems, ...varItems]
}

function exportCompletions() {
  return [
    item('export let', K.Keyword, 'Reactive prop',
      '`export let name = default` — parent writes, component reads/writes, `bind:` valid',
      'let ${1:name}${2: = ${3:defaultValue}}'),
    item('export const', K.Keyword, 'Immutable prop',
      '`export const name = default` — parent writes, component cannot reassign',
      'const ${1:name}${2: = ${3:defaultValue}}'),
    item('export var', K.Keyword, 'Non-reactive prop',
      '`export var name = default` — snapshot at mount, frozen thereafter',
      'var ${1:name}${2: = ${3:defaultValue}}'),
  ]
}

// ─── Provider ──────────────────────────────────────────────────────────────────

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.Position}     position
 * @param {vscode.CancellationToken} _token
 * @param {vscode.CompletionContext} context
 * @returns {vscode.CompletionItem[]}
 */
function provideCompletionItems(document, position, _token, context) {
  const lineText  = document.lineAt(position.line).text
  const before    = lineText.slice(0, position.character)
  const inScript  = isInScript(document, position)
  const inTag     = isInTag(document, position)

  // ── $ trigger ───────────────────────────────────────────────────────────────
  if (context.triggerCharacter === '$' || /\$$/.test(before)) {
    if (inScript) return dollarCompletions(true)
    // In template: only $context, $async
    return dollarCompletions(false).filter((c) =>
      ['$context', '$async', '$.transition', '$.entrance'].some((p) => c.label.startsWith(p))
    )
  }

  // ── { trigger — template block keywords ────────────────────────────────────
  if (context.triggerCharacter === '{' && !inScript) {
    return braceCompletions()
  }

  // ── Inside tag — directive attributes ──────────────────────────────────────
  if (inTag) {

    // After "bind:" — what property
    const bindMatch = before.match(/\bbind:(\w*)$/)
    if (bindMatch) {
      const inWindow = lineText.includes('mesa:window')
      return bindColon(inWindow ? 'window' : 'dom')
    }

    // After "on:" — event names
    const onMatch = before.match(/\bon:([a-zA-Z]*)$/)
    if (onMatch) return onColon()

    // After "on:event|" or "|modifier|" — modifiers
    if (/\bon:[a-zA-Z]+(\|[a-zA-Z0-9()]*)*\|$/.test(before)) {
      return pipeModifiers()
    }

    // After "class:" — class directive completions
    if (/\bclass:(\w*)$/.test(before)) return classColonCompletions(document)

    // After "style:" — style directive completions
    if (/\bstyle:(\w*)$/.test(before)) return styleColonCompletions(document)

    // After "<mesa:" — mesa special elements
    if (/(<|<\/)mesa:(\w*)$/.test(before)) return mesaColonCompletions()

    // General attribute completions when in a tag
    if (context.triggerCharacter === ':') {
      if (/\bbind:$/.test(before)) return bindColon('dom')
      if (/\bon:$/.test(before))   return onColon()
      if (/\bclass:$/.test(before)) return classColonCompletions(document)
      if (/\bstyle:$/.test(before)) return styleColonCompletions(document)
    }

    // Offer all directives when starting to type an attribute
    if (/[\s\t](\w*)$/.test(before)) {
      return [
        item('bind:value',    K.Property, 'Two-way binding', '', 'bind:value={${1:var}}'),
        item('bind:this',     K.Property, 'Element ref',     '', 'bind:this={${1:ref}}'),
        item('bind:group',    K.Property, 'Group binding',   '', 'bind:group={${1:arr}}'),
        item('class:',        K.Property, 'Class directive', '', 'class:${1:name}'),
        item('style:',        K.Property, 'Style directive', '', 'style:${1:prop}={${2:value}}'),
        item('on:click',      K.Event,    'Click event',     '', 'on:click={${1:handler}}'),
        item('on:input',      K.Event,    'Input event',     '', 'on:input={${1:handler}}'),
        item('on:submit',     K.Event,    'Submit event',    '', 'on:submit|preventDefault={${1:handler}}'),
        item('{@attach}',     K.Keyword,  'Attach lifecycle','', '{@attach ${1:fn}}'),
      ]
    }
  }

  // ── < trigger — Mesa special elements ──────────────────────────────────────
  if (/(<|<\/)mesa:(\w*)$/.test(before)) {
    return mesaColonCompletions()
  }

  // ── export trigger ─────────────────────────────────────────────────────────
  if (inScript && /^\s*export\s+$/.test(before)) {
    return exportCompletions()
  }

  // ── | trigger — modifiers after on:event ──────────────────────────────────
  if (context.triggerCharacter === '|' && inTag) {
    if (/\bon:[a-zA-Z]+/.test(before)) return pipeModifiers()
  }

  return []
}

module.exports = { provideCompletionItems }
