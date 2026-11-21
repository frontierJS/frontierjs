# Developing

`vite dev` swaps an edited route in place, shows a runtime error in an overlay and in the terminal, and, in dev only, adds a toolbar over Junction's devtools. The one thing to configure is auto-import, which drops the imports you would otherwise type on every page.

```js
// config/sierra.config.js
export default {
  autoImport: {
    components: ['src/components/UI'],
    modules: { dayjs: 'dayjs' },
  },
}
```

```mesa
<p>Opened {dayjs().format('MMM D')}</p>
<Callout>A Callout.mesa in that folder, no import either.</Callout>
```

## What else it can do

- Editing a route file hot-swaps the component without a full reload
- A `load()` failure is not an overlay error, since the page renders `page.error`
- The devtools toolbar shows requests, events, logs and an N+1 waterfall, and costs the production bundle nothing
- Component folders are scanned recursively and a component is keyed on its file name
- A module binding is a named import, an alias pair, a default or a `star`
- A name the file already imports or declares always wins
- Two sources that provide one name are a build error
- `dev.staticData` runs a prerendered route's `load()` so dev shows the page with its data

**In depth:** [README § Dev experience](../../../README.md#dev-experience)
