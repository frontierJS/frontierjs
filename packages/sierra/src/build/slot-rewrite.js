/**
 * slot-rewrite.js — Sierra slot system compile-time rewriting
 *
 * PAGE SIDE — <mesa:slot name="sidebar">content</mesa:slot>
 *   → {#snippet sidebar()}content{/snippet}\n{provideSlot('sidebar', sidebar)}
 *
 * LAYOUT SIDE — <slot name="X">fallback</slot> and <slot />
 *   <slot name="sidebar">fallback</slot>
 *   → {#if page.slots.sidebar}{@render page.slots.sidebar()}{:else}fallback{/if}
 *   <slot /> → {@render children?.()}
 *   Also injects: $slots = { sidebar: !!page.slots.sidebar }
 *   And imports `page` from sierra/router if needed.
 */


// A slot name is a snippet name: both rewriters expand it into `{#snippet X()}`
// or `__slot_X`, so it has to be a legal JS identifier. That constraint used to
// live only in the MATCH — a tag whose name did not fit was simply not
// rewritten, and Mesa then dropped an unknown element and everything inside it,
// so `<mesa:slot name="side-bar">` lost its content, `<slot name="side-bar">`
// lost its fallback, and neither compiler said a word (`FJS-800`). `side-bar`
// and `page-header` are the natural spellings, and the package's "an unknown
// `mesa:*` name is an error" does not reach this: `mesa:slot` IS known — it is
// the attribute that did not match.
const SLOT_NAME_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

function assertSlotNames(source, tag, file) {
  const tagRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'g')
  let m
  while ((m = tagRe.exec(source)) !== null) {
    const attrs = m[1] ?? ''
    const name = attrs.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/)
    if (!name) continue

    const expression = name[3] !== undefined
    const value = name[1] ?? name[2] ?? name[3]
    if (!expression && SLOT_NAME_RE.test(value)) continue

    const where = file ? `${file}: ` : ''
    const err = new Error(
      `[Sierra] ${where}<${tag}> name ${expression ? `{${value}}` : `"${value}"`} is not a legal slot name. ` +
      `A slot compiles to a snippet, so the name must be a bare identifier — ` +
      `letters, digits, _ and $, not starting with a digit, and not an expression. ` +
      `Write it as '${suggestSlotName(value)}'.`
    )
    err.code = 'SIERRA_BAD_SLOT_NAME'
    throw err
  }
}

function suggestSlotName(value) {
  const camel = String(value).replace(/[^a-zA-Z0-9_$]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
  return /^[a-zA-Z_$]/.test(camel) ? camel : `slot${camel}`
}

/**
 * Rewrite <mesa:slot name="X">content</mesa:slot> on PAGE files.
 */
export function rewriteMesaSlots(source, file = null) {
  assertSlotNames(source, 'mesa:slot', file)

  const slotRe = /<mesa:slot\s+name="([a-zA-Z_$][a-zA-Z0-9_$]*)"\s*>([\s\S]*?)<\/mesa:slot>/g
  const foundNames = []

  const rewritten = source.replace(slotRe, (_, name, content) => {
    foundNames.push(name)
    return `{#snippet ${name}()}${content}{/snippet}\n{provideSlot('${name}', ${name})}`
  })

  if (foundNames.length === 0) return source

  const alreadyImported = /import\s*\{[^}]*\bprovideSlot\b[^}]*\}\s*from/.test(rewritten)
  if (alreadyImported) return rewritten
  return _injectProvideSlotImport(rewritten)
}

/**
 * Rewrite <slot name="X">fallback</slot> and <slot /> in LAYOUT files.
 *
 * <slot name="sidebar">fallback</slot>
 *   → {#if page.slots.sidebar}{@render page.slots.sidebar()}{:else}fallback{/if}
 *
 * <slot name="sidebar" />  (no fallback)
 *   → {#if page.slots.sidebar}{@render page.slots.sidebar()}{/if}
 *
 * <slot />  (default slot — children)
 *   → {@render children?.()}
 */
export function rewriteLayoutSlots(source, file = null) {
  assertSlotNames(source, 'slot', file)

  // Named slot with content: <slot name="X">fallback</slot>
  const namedWithFallback = /<slot\s+name="([a-zA-Z_$][a-zA-Z0-9_$]*)"\s*>([\s\S]*?)<\/slot>/g
  // Named slot self-closing: <slot name="X" />
  const namedSelfClose = /<slot\s+name="([a-zA-Z_$][a-zA-Z0-9_$]*)"\s*\/>/g
  // Default slot self-closing: <slot />
  const defaultSelfClose = /<slot\s*\/>/g
  // Default slot with fallback: <slot>fallback</slot>
  const defaultWithFallback = /<slot\s*>([\s\S]*?)<\/slot>/g

  const foundNames = []
  // Tracked separately from foundNames: the default slot renders `children`,
  // a prop, while named slots render `__slot_X`, a local let. They need
  // different declarations injected, and a layout may use either or both.
  let hasDefaultSlot = false

  // Check if any slots exist
  let hasSlots = false
  const testSrc = source
  if (namedWithFallback.test(testSrc)) hasSlots = true
  namedWithFallback.lastIndex = 0
  if (!hasSlots && namedSelfClose.test(testSrc)) hasSlots = true
  namedSelfClose.lastIndex = 0
  if (!hasSlots && defaultSelfClose.test(testSrc)) hasSlots = true
  defaultSelfClose.lastIndex = 0
  if (!hasSlots && defaultWithFallback.test(testSrc)) hasSlots = true
  defaultWithFallback.lastIndex = 0

  if (!hasSlots) return source

  let rewritten = source

  // Named slot with fallback
  rewritten = rewritten.replace(namedWithFallback, (_, name, fallback) => {
    foundNames.push(name)
    const fb = fallback.trim()
    if (fb) {
      return `{#if __slot_${name}}{@render __slot_${name}()}{:else}${fb}{/if}`
    }
    return `{#if __slot_${name}}{@render __slot_${name}()}{/if}`
  })

  // Named slot self-closing
  rewritten = rewritten.replace(namedSelfClose, (_, name) => {
    if (!foundNames.includes(name)) foundNames.push(name)
    return `{#if __slot_${name}}{@render __slot_${name}()}{/if}`
  })

  // Default slot with fallback
  rewritten = rewritten.replace(defaultWithFallback, (_, fallback) => {
    hasDefaultSlot = true
    return `{@render children?.()}`
  })

  // Default slot self-closing
  rewritten = rewritten.replace(defaultSelfClose, () => {
    hasDefaultSlot = true
    return `{@render children?.()}`
  })

  // Also rewrite $slots.X in the template.
  // $slots.X → __slot_X (the local let variable, safe for {#if} and {@render})
  rewritten = rewritten.replace(/\$slots\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g, (_, name) => {
    if (!foundNames.includes(name)) foundNames.push(name)
    return `__slot_${name}`
  })

  // Inject the `page` import + local slot variables for each named slot
  rewritten = _injectSlotVars(rewritten, foundNames)

  // Declare the prop the default slot renders. Without this, `<slot />` expands
  // to {@render children?.()} against an undeclared binding: the Mesa compiler
  // emits a reference to $$snippet_children, and the layout throws
  // "ReferenceError: $$snippet_children is not defined" at mount — taking the
  // whole page down to a blank screen, with nothing failing at build time.
  //
  // _injectSlotVars can't do this: it returns early when there are no NAMED
  // slots, which is exactly the plain `<slot />` case.
  if (hasDefaultSlot) rewritten = _injectChildrenProp(rewritten)

  return rewritten
}

/**
 * Ensure the layout declares `children`, the prop `{@render children?.()}` reads.
 *
 * No-ops when the author already declared it, so hand-written layouts that use
 * `{@render children?.()}` directly — the form Sierra's own fixtures use — are
 * left untouched.
 */
function _injectChildrenProp(source) {
  // Already declared, in any of the forms the compiler accepts.
  if (/\bexport\s+let\s+children\b/.test(source)) return source

  const decl = '  export let children = null'

  // Prefer the instance script. `(?!\s+module)` keeps this out of <script module>,
  // where an export would be a module export rather than a prop declaration.
  const instanceScriptRe = /(<script(?!\s+module)[^>]*>)/
  if (instanceScriptRe.test(source)) {
    return source.replace(instanceScriptRe, `$1\n${decl}`)
  }

  // A layout with markup only and no script block at all — still a valid
  // layout, and the most likely shape for a plain `<slot />` wrapper.
  return `<script>\n${decl}\n</script>\n${source}`
}

/**
 * Inject into the layout script:
 *   import { page } from '@frontierjs/sierra/router'  (if not already imported)
 *   const $slots = { sidebar: !!page.slots.sidebar }  (reactive derived)
 */
function _injectSlotVars(source, slotNames) {
  if (slotNames.length === 0) return source

  // Ensure `page` is imported
  let result = _injectPageSlotsImport(source)

  // Inject local let variables + reactive watch for each slot
  // These are local lets so {@render __slot_sidebar()} works without compiler confusion
  // `page.slots` is a plain-object path, so the watch is what makes this
  // reactive — the handler is deferred and fires on every slot registration.
  const slotDecls = slotNames.map(n =>
    `  let __slot_${n} = null\n` +
    `  $: page.slots, () => { __slot_${n} = page.slots.${n} ?? null }\n` +
    `  $: __slot_${n} = page.slots.${n} ?? null`
  ).join('\n')

  // Inject before closing </script> of instance script
  const scriptEndRe = /(<script(?!\s+module)[^>]*>[\s\S]*?)(\n<\/script>)/
  if (scriptEndRe.test(result)) {
    result = result.replace(scriptEndRe, (_, body, closing) => {
      return `${body}\n${slotDecls}${closing}`
    })
  }

  return result
}

function _injectPageSlotsImport(source) {
  // Slots live at `page.slots` now — the eight router signals were replaced by
  // one plain `page` object. Only the import name changed here; the reactivity
  // comes from the `$: page.slots` watch injected alongside the declarations.
  const hasPage = /import\s*\{[^}]*\bpage\b[^}]*\}\s*from\s*'(?:@frontierjs\/sierra\/router|sierra\/router)'/.test(source)
  if (hasPage) return source

  const routerImportRe = /^([ \t]*import\s*\{[^}]*)\}\s*from\s*'(?:@frontierjs\/sierra\/router|sierra\/router)'/m
  if (routerImportRe.test(source)) {
    return source.replace(routerImportRe, (_, prefix) => {
      const trimmed = prefix.trimEnd()
      const sep = trimmed.endsWith(',') ? ' ' : ', '
      return `${trimmed}${sep}page } from '@frontierjs/sierra/router'`
    })
  }
  const instanceScriptRe = /(<script(?!\s+module)[^>]*>)/
  if (instanceScriptRe.test(source)) {
    return source.replace(instanceScriptRe, `$1\n  import { page } from '@frontierjs/sierra/router'`)
  }
  return `<script>\n  import { page } from '@frontierjs/sierra/router'\n</script>\n${source}`
}

function _injectSlotsHelper(source, slotNames) {
  if (slotNames.length === 0) return source

  // Check if `page` is already imported
  const hasPage = /import\s*\{[^}]*\bpage\b[^}]*\}\s*from\s*'(?:@frontierjs\/sierra\/router|sierra\/router)'/.test(source)

  let result = source

  // Add the `page` import if needed
  if (!hasPage) {
    const routerImportRe = /^([ \t]*import\s*\{[^}]*)\}\s*from\s*'(?:@frontierjs\/sierra\/router|sierra\/router)'/m
    if (routerImportRe.test(result)) {
      result = result.replace(routerImportRe, (_, prefix) => {
        const trimmed = prefix.trimEnd()
        const sep = trimmed.endsWith(',') ? ' ' : ', '
        return `${trimmed}${sep}page } from '@frontierjs/sierra/router'`
      })
    } else {
      const instanceScriptRe = /(<script(?!\s+module)(?!\s+context\s*=\s*["\'']module["\''])[^>]*>)/
      if (instanceScriptRe.test(result)) {
        result = result.replace(instanceScriptRe, `$1\n  import { page } from '@frontierjs/sierra/router'`)
      } else {
        result = `<script>\n  import { page } from '@frontierjs/sierra/router'\n</script>\n${result}`
      }
    }
  }

  // $slots is a const memo over page.slots. The `$: page.slots` watch injected
  // alongside it is what makes the path reactive — without that the memo would
  // read an inert object once (RULE 43/45).
  const slotsObj = slotNames.map(n => `${n}: !!page.slots.${n}`).join(', ')
  const slotsLine = `  $: page.slots\n  const $slots = { ${slotsObj} }`

  // Inject before closing </script> of instance script
  const scriptEndRe = /(<script(?!\s+module)[^>]*>[\s\S]*?)(\n<\/script>)/
  if (scriptEndRe.test(result)) {
    result = result.replace(scriptEndRe, (_, body, closing) => {
      return `${body}\n${slotsLine}${closing}`
    })
  }

  return result
}

function _injectProvideSlotImport(source) {
  const routerImportRe = /^([ \t]*import\s*\{[^}]*)\}\s*from\s*'(?:@frontierjs\/sierra\/router|sierra\/router)'/m
  if (routerImportRe.test(source)) {
    return source.replace(routerImportRe, (_, prefix) => {
      const trimmed = prefix.trimEnd()
      const sep = trimmed.endsWith(',') ? ' ' : ', '
      return `${trimmed}${sep}provideSlot } from '@frontierjs/sierra/router'`
    })
  }
  const instanceScriptRe = /(<script(?!\s+module)(?!\s+context\s*=\s*["\'']module["\''])[^>]*>)/
  if (instanceScriptRe.test(source)) {
    return source.replace(instanceScriptRe, `$1\n  import { provideSlot } from '@frontierjs/sierra/router'`)
  }
  return `<script>\n  import { provideSlot } from '@frontierjs/sierra/router'\n</script>\n${source}`
}

export function extractProvidedSlots(source) {
  const names = []
  const mesaRe = /<mesa:slot\s+name="([^"]+)"/g
  let m
  while ((m = mesaRe.exec(source)) !== null) names.push(m[1])
  const provideRe = /provideSlot\(\s*['"]([^'"]+)['"]/g
  while ((m = provideRe.exec(source)) !== null) {
    if (!names.includes(m[1])) names.push(m[1])
  }
  return names
}
