---
title: web:component
description: Create a Mesa component in src/components/
examples:
  - fli web:component Button
  - fli web:component forms/Input --open
  - fli web:component Modal
args:
  -
    name: name
    description: Component name or path (e.g. Button or forms/Input) — PascalCase
    required: true
flags:
  open:
    char: o
    type: boolean
    description: Open the file in editor after creating
    defaultValue: false
---

<script>
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname, basename } from 'path'

// A literal closing script tag ends this block — core/compiler.js extracts it
// with a non-greedy match and does not care that the tag is inside a string.
const SC = '<' + '/script>'

const makeComponent = (name) => `<script>
  // Props are declared with \`export let\`, with the default standing in when the
  // caller omits one.
  export let label = '${name}'

  // Local state is a plain \`let\`. Replacement is what makes it reactive
  // (Mesa RULE 43) — \`count = count + 1\` notifies, \`obj.n++\` does not.
  let count = 0
${SC}

<button class="${name.charAt(0).toLowerCase() + name.slice(1)}" on:click={() => count = count + 1}>
  {label} {count > 0 ? '(' + count + ')' : ''}
</button>

<style>
  /* Styles are scoped to this component — the compiler rewrites the selectors,
     so a bare element name here cannot reach the rest of the page. Use
     :global(...) deliberately when you mean to. */
  button {
    border: 1px solid #d1d5db;
    background: #fff;
    border-radius: 6px;
    padding: 6px 12px;
    font: inherit;
    cursor: pointer;
  }
</style>
`
</script>

Creates a Mesa component under `src/components/`. Components are PascalCase —
the route scanner uses that to tell a component from a page, so a lowercase name
placed under `src/routes/` would be picked up as a route instead.

Import it with a relative path (`import Button from '../components/Button.mesa'`)
— Sierra resolves no `@/` alias.

```js
const raw  = arg.name.replace(/\.mesa$/, '').replace(/^\/+/, '')
const file = raw + '.mesa'
const name = basename(raw)

if (!/^[A-Z]/.test(name)) {
  log.warn(`Components are PascalCase — got '${name}'. A lowercase name under src/routes/ is scanned as a route.`)
}

const filePath = resolve(context.paths.webComponents, file)

if (flag.dry) {
  log.dry(`Would create: ${filePath}`)
  return
}

if (existsSync(filePath)) {
  log.error(`${filePath} already exists — delete it or edit it directly`)
  return
}

mkdirSync(dirname(filePath), { recursive: true })
writeFileSync(filePath, makeComponent(name), 'utf8')
log.success(`Created ${filePath}`)

if (flag.open) {
  const editor = process.env.EDITOR || 'vi'
  context.exec({ command: `${editor} "${filePath}"` })
}
```
