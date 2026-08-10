<script>
  import { glow } from '@/core/glow'
  import { onMount, createEventDispatcher } from 'svelte'

  // Props
  export let value = ''
  export let language = 'mdx'
  export let mark = true
  export let numbered = false
  export let placeholder = 'Enter your content here...'
  export let rows = 0
  export let name = ''
  export let spellcheck = false
  export let theme = 'default' // add themes
  export let typingDelay = 680 // milliseconds
  export let contentEl = undefined

  let typingTimer = null

  // Event dispatcher
  const dispatch = createEventDispatcher()

  // Refs
  let previewEl

  function handleTypingStop() {
    clearTimeout(typingTimer)
    typingTimer = setTimeout(() => {
      dispatch('typingStop', {
        content: value,
        hasChanges: true
      })
    }, typingDelay)
  }

  function setupAutoResize(textarea) {
    function resize() {
      textarea.style.height = 'auto'
      textarea.style.height = textarea.scrollHeight + 'px'
    }

    textarea.addEventListener('input', resize)
    textarea.addEventListener('keydown', (e) => (e.key === 'Enter') && requestAnimationFrame(resize))

    resize()
  }

  onMount(async () => {
    contentEl.addEventListener('keyup', handleTypingStop)
    contentEl.addEventListener('paste', handleTypingStop)
    contentEl = contentEl

    setupAutoResize(contentEl)
  })

  // Reactive content preview
  $: contentPreview = glow(value, { language, mark, numbered })

  // Sync scroll positions
  function syncScroll() {
    if (previewEl) {
      previewEl.scrollTop = contentEl.scrollTop
      previewEl.scrollLeft = contentEl.scrollLeft
    }
  }

  function handleInput(event) {
    value = event.target.value
    dispatch('input', { value })
  }

  function handleChange(event) {
    dispatch('change', { value: event.target.value })
  }

  function handleFocus(event) {
    dispatch('focus', event)
  }

  function handleBlur(event) {
    dispatch('blur', event)
  }

  // NOTE: Export methods for parent component access
  export function focus() {
    contentEl?.focus()
  }

  export function blur() {
    contentEl?.blur()
  }

  export function getElement() {
    return contentEl
  }

</script>

<div class="code-editor {theme}" class:numbered>
  <textarea
    class="textarea code"
    bind:this={contentEl}
    bind:value
    class:numbered
    {placeholder}
    {spellcheck}
    {rows}
    {name}
    on:input={handleInput}
    on:change={handleChange}
    on:focus={handleFocus}
    on:blur={handleBlur}
    on:scroll={syncScroll}
    on:keydown
    on:keyup
    on:keypress></textarea>

  <div class="code-preview">
    <pre bind:this={previewEl}>{@html contentPreview}</pre>
  </div>
</div>
