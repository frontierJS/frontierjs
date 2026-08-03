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

export const commandPalette = {
  open: false,

  show()   { this.open = true  },
  hide()   { this.open = false },
  toggle() { this.open = !this.open },
}
