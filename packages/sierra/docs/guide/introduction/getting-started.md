# Getting started

Install Sierra and Mesa, add three small files to `web/`, and Vite serves the app. Sierra reads the route table from `src/routes/` and boots the router for you.

```bash
bun add @frontierjs/sierra @frontierjs/mesa
bun add -d vite
```

```js
// web/config/sierra.config.js
export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',

  junction: {
    url:       'http://localhost:8000',
    apiPrefix: '/api',
    tokenKey:  'myapp_token',
  },
}
```

```text
// web/config/vite.config.js
import { defineConfig } from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

export default defineConfig(createSierraViteConfig(sierraConfig))
```

```html
<!-- web/index.html -->
<div id="app"></div>
<script type="module" src="virtual:sierra"></script>
```

```mesa
<!-- web/src/App.mesa -->
<script>
  import { RouterView } from '@frontierjs/sierra/router'
</script>

<RouterView />
```

```bash
cd web && vite -c config/vite.config.js          # dev
cd web && vite build -c config/vite.config.js    # production
```

## What else it can do

- `virtual:sierra` boots the router, Junction, theme and analytics, and mounts `src/App.mesa` into `#app`
- Without an `App.mesa` it mounts the bare `RouterView`
- `src/main.js` is optional and holds the app's side-effect imports, such as `import '@frontierjs/css'`
- `<RouterView {failed} />` takes a `failed` snippet drawn when a route throws while it renders
- `@frontierjs/junction` and `@frontierjs/litestone` are optional peers, installed when you use resources and schema seeding
- `example/` is a runnable app over a real Junction API

**In depth:** [Sierra README § Installation](../../../README.md#installation), [§ Quick start](../../../README.md#quick-start)
