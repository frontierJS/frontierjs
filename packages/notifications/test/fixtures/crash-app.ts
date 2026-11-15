// A junction app with notifications configured that throws uncaught once it
// is listening. crash-ping.test.ts runs it as its own process, because only a
// real crash shows the ping leaving before `process.exit(1)`.

import { createApp } from '@frontierjs/junction'
import { notifications } from '../../plugin.ts'

const app = createApp({ logLevel: 'silent', config: { name: 'crash-fixture', port: 0, shutdown: { timeout: 5_000 } } })
app.configure(notifications({ db: undefined }))
await app.start()
setTimeout(() => { throw new Error('fixture boom') }, 10)
