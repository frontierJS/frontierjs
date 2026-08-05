// commandPaletteStore.js — plain JavaScript.
// Replaces the React CommandPaletteProvider / useCommandPalette hook.
//
// Mount the global ⌘K listener once in your app root:
//
//   import { commandPalette } from './stores/commandPaletteStore.js'
//   $: commandPalette.open   ← watch in any component
//
//   <!-- In App.mesa -->
//   <mesa:window on:keydown={(e) => {
//     if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
//       e.preventDefault()
//       commandPalette.toggle()
//     }
//   }} />
//
//   {#if commandPalette.open}
//     <CommandPalette items={COMMANDS} onclose={() => commandPalette.hide()} />
//   {/if}

// The writes go through `_w`: a component watches this object with
// `watchProxy`, and only a write through that proxy notifies. `this.open = true`
// set the flag and told nobody, so ⌘K flipped a boolean nothing was listening
// to and the palette never appeared.
import { watchProxy } from '@frontierjs/mesa/runtime'

export const commandPalette = {
  open: false,

  show()   { _w.open = true  },
  hide()   { _w.open = false },
  toggle() { _w.open = !this.open },
}

const _w = watchProxy(commandPalette)
