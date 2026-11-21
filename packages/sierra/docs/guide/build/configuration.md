# Configuration

Everything Sierra does at build time is read from one file, `sierra.config.js`. A key you leave out has a default, so a small app states two or three of them.

```js
// config/sierra.config.js
export default {
  target: 'static',
  siteUrl: 'https://example.com',
  llms: true,
  document: { lang: 'en', bodyClass: 'app theme-default' },
}
```

## What else it can do

- `target` picks `'spa'` (the default), `'static'` or `'widget'`
- `routesDir`, `outDir` and `base` move the routes folder, the build output and the public path
- `trailingSlash` is `'always'`, `'never'` or `'preserve'`
- `junction: { url, apiPrefix, tokenKey, cookieAuth, … }` wires the browser to the API, as data only
- `schema` names the `.lite` file, or `false` to turn seeding off
- `theme`, `analytics` and `devtools` switch on those features and hand them their options
- `autoImport` lists the components and module bindings that need no import
- `siteUrl` feeds the sitemap, and `llms` and `markdownPages` emit `llms.txt` and a markdown copy of each page
- `offline` and `push` write a service worker with a precache list and Web Push handlers
- `functions` points at a directory of host functions that answer their own path
- `plugins` adds Vite plugins, and `vite` is deep-merged over everything last

**In depth:** [README § Configuration](../../../README.md#configuration)
