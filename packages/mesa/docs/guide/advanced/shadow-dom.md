# Shadow DOM

You need this page when you mount a component inside a shadow root: a widget
embedded in someone else's page, or a web-component host that must keep its
styles and events to itself.

```js
import { mount } from '@frontierjs/mesa/runtime'
import App from './App.mesa'

const host = document.getElementById('app')
const shadow = host.attachShadow({ mode: 'open' })
const target = document.createElement('div')
shadow.appendChild(target)

const app = mount(target, App, {
  props: {},
  root: shadow,        // events and styles go here
})

app.destroy()
```

`mount()` takes a `root` option. With a shadow root, Mesa scopes two things to
it:

- **Styles.** The component's stylesheet is adopted into the shadow root with
  `adoptedStyleSheets`, so it applies inside and does not leak out. Blocks that
  render later, such as an `{#if}` that opens, use the same root.
- **Events.** `onclick` and the other delegated events are listened for on the
  shadow root rather than on `document`, so they work with no extra wiring.

`destroy()` removes the component, the delegated listeners and the styles it
added.

## What bites

- **`mount()` needs a node with a parent.** `target` above is inside the shadow
  root before it is passed. The component is inserted after that node.
- **Page CSS does not reach in.** A shadow root is a style boundary both ways, so
  a global stylesheet on the host page does not style your component. Put what
  you need in the component's `<style>`.
- **A scoped style does not reach into a child component.** That is true
  everywhere. Inside a shadow root it matters more, because nothing outside can
  patch it.
- **Pass `root` for the styles.** Without it Mesa has no way to know the target
  is inside a shadow root, so the stylesheet goes to the document, where it
  cannot reach your component.

---

Spec: [README § Shadow DOM mount](../../../README.md#shadow-dom-mount)
