# Search

`paletteSource(client, { models })` is the `search` a `CommandPalette` takes, over the API's `searchService`. One request per pause in typing answers one ranked list, already filtered to the rows the caller may read.

```js
import { getClient, paletteSource } from '@frontierjs/sierra/resource'

const search = paletteSource(getClient(), {
  models: ['lead', 'account'],
  link: { account: async hit => `/accounts/${hit.id}/overview` },
})
if (typeof search !== 'function') throw new Error('expected a search function')
```

```html
<CommandPalette items={NAV} {search} />
```

This page does not run a query: that needs the API's `searchService` mounted, and the doc app does not mount it.

## What else it can do

- A hit becomes a row grouped by the model's plural, labeled by its `@@label` column
- Choosing a hit goes to `/<service>/<id>` lowercased, the route `fli scaffold` writes
- `link` per model replaces that route, and may answer a promise
- `models` narrows what the service mounts and cannot widen it
- A source of the app's own is appended to what this answers

**In depth:** [Sierra README § Search](../../../README.md#search)
