# After the build

When `vite build` finishes, Sierra writes the files a site needs beside the pages: the 404, a sitemap, redirects, `robots.txt` and the rest. Most are switched on by one config key.

```js
// config/sierra.config.js
export default {
  target: 'static',
  siteUrl: 'https://example.com',
  llms: true,
  markdownPages: true,
  plugins: [{
    name: 'stamp-build',
    closeBundle({ outDir }) {
      console.log(`built into ${outDir}`)
    },
  }],
}
```

## What else it can do

- `404/index.html` becomes `404.html` on every build
- `sitemap.xml` lists the routes that are `indexed`
- `_redirects` collects routes with `redirect:` and the app's own file
- `llms.txt` and a per-page `index.md` follow `llms` and `markdownPages`
- Speculation Rules prerender a same-origin link on hover in a static build
- A theme gets an inline script in `<head>` that applies the saved choice before first paint
- A manifest is graded, never written, and the build says whether a browser will install the app
- A plugin's `closeBundle` runs once with `{ outDir, root, config, routeTable }` after the pages are written
- `build.deferJS` adds `defer` to script tags

**In depth:** [README § Post-build pipeline](../../../README.md#post-build-pipeline)
