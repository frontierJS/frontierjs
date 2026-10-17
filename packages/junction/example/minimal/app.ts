// example/minimal/app.ts
// The smallest useful Junction app.
//
//   bun run example/minimal/app.ts
//
//   curl http://localhost:3100/api/posts
//   curl http://localhost:3100/api/posts/1
//   curl -X POST  http://localhost:3100/api/posts   -H 'content-type: application/json' -d '{"title":"New","body":"..."}'
//   curl -X PUT   http://localhost:3100/api/posts/1 -H 'content-type: application/json' -d '{"title":"Replaced","body":"..."}'
//   curl -X PATCH http://localhost:3100/api/posts/1 -H 'content-type: application/json' -d '{"title":"Merged"}'
//   curl http://localhost:3100/health
//
// In your own project the import is: '@frontierjs/junction'
import { createApp, defaultConfig, healthPlugin } from '../../index.ts'
import { createDb } from './db.ts'

const app = createApp({
  config: {
    ...defaultConfig,
    name:      'minimal',
    port:      3100,
    apiPrefix: '/api',
  },
  // ./services beside this file loads; ../config would hold junction.config.js.
  root: import.meta.url,
})

// db-less services (createService({ model }) with no db option)
// inherit this client. Swap createDb() for your Litestone client.
app.db = createDb() as never

// GET /health + GET /metrics
app.configure(healthPlugin())

await app.start()
