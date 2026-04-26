---
title: project:view
description: Open FJSChain — a visual map of the project's chain of responsibility in the browser
alias: pview
examples:
  - fli project:view
  - fli project:view --port 4445
  - fli project:view --no-open
flags:
  port:
    char: p
    type: number
    description: Port to serve the viewer on
    defaultValue: 8501
  no-open:
    type: boolean
    description: Start the server without opening the browser
    defaultValue: false
---

<script>
import { createServer } from 'http'
</script>

Generates a fresh project map and opens FJSChain in the browser.
No running API server required.

Refresh the browser tab to regenerate the map from current files.
Press `Ctrl+C` to stop the server.

```js
if (!existsSync(resolve(context.paths.db, 'schema.lite'))) {
  log.error('schema.lite not found — run this from a FJS project root')
  return
}

const port = flag.port
const url  = `http://localhost:${port}`

// ── Locate pre-compiled viewer HTML ───────────────────────────────────────────
// web/viewer/index.html is compiled from FJSChain.jsx — no Babel or JSX at runtime.

const viewerPath = resolve(global.fliRoot, 'web/viewer/index.html')
if (!existsSync(viewerPath)) {
  log.error(`Viewer not found at ${viewerPath}`)
  log.info('Ensure web/viewer/index.html exists in fliRoot')
  return
}

const html = readFileSync(viewerPath, 'utf8')

// ── Services path ─────────────────────────────────────────────────────────────

const servicesDir = existsSync(resolve(context.paths.api, 'src/services'))
  ? resolve(context.paths.api, 'src/services')
  : resolve(context.paths.api, 'services')

// ── Map builder ───────────────────────────────────────────────────────────────

const buildMap = () => {
  try { freshJsonSchema(context) } catch (e) {
    log.warn(`Schema generation failed: ${e.message}`)
  }
  const schema = existsSync(resolve(context.paths.db, 'schema.json'))
    ? JSON.parse(readFileSync(resolve(context.paths.db, 'schema.json'), 'utf8'))
    : {}
  const services   = scanFiles(servicesDir, '.service.ts')
                       .map(f => extractServiceMeta(readFileSync(f, 'utf8'), f))
  const resources  = scanFiles(context.paths.webResources, '.mesa', '.svelte')
                       .map(f => extractResourceMeta(readFileSync(f, 'utf8'), f))
  const migrations = parseMigrationFiles(resolve(context.paths.db, 'migrations'))
  const { packages } = extractServerMeta(context.paths.root)
  return {
    meta:       { generatedAt: new Date().toISOString(), root: context.paths.root },
    schema,
    services:   services.length   ? services   : undefined,
    resources:  resources.length  ? resources  : undefined,
    migrations: migrations.length ? migrations : undefined,
    packages:   packages.length   ? packages   : undefined,
  }
}

log.info('Generating project map...')
let map = buildMap()

const modelCount = Object.values(map.schema?.$defs ?? {})
  .filter(d => d.type === 'object' && !d['x-litestone-file']).length
log.info(`Map: ${(map.services ?? []).length} services · ${modelCount} models · ${(map.migrations ?? []).length} migrations`)

// ── Start server ───────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.url === '/data') {
    map = buildMap()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(map))
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(html)
})

server.listen(port, () => {
  log.success(`FJSChain viewer: ${url}`)
  log.info('Refresh browser tab to update from current files')
})

// ── Open browser ───────────────────────────────────────────────────────────────

if (!flag['no-open']) {
  const opener = {
    linux:  `xdg-open ${url}`,
    darwin: `open ${url}`,
    win32:  `start ${url}`,
  }[process.platform] || `xdg-open ${url}`

  setTimeout(() => {
    try { execSync(opener, { stdio: 'ignore' }) } catch {}
  }, 400)
}

log.info('Ctrl+C to stop')
await new Promise(() => {})
```
