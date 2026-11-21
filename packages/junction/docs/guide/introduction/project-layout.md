# Project layout

Junction owns the `api/` directory of an app, beside `db/` and `web/`. Where `createApp` is called is the root, and `services/` and `routes/` are found beside that file, so nothing has to be listed.

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// my-app/api/src/app.ts, services/notes.service.ts, routes/hooks/calendar.ts, config/
const api = join(mkdtempSync(join(tmpdir(), 'my-app-')), 'api')
for (const dir of ['src/services', 'src/routes/hooks', 'config']) mkdirSync(join(api, dir), { recursive: true })
writeFileSync(join(api, 'src/app.ts'), '')
writeFileSync(join(api, 'src/services/notes.service.ts'), `export default { name: 'notes', async find() { return [{ id: 1 }] } }`)
writeFileSync(join(api, 'src/routes/hooks/calendar.ts'), `export const POST = async (ctx) => ctx.json({ ok: true })`)

const app = createApp({ root: pathToFileURL(join(api, 'src/app.ts')).href })
await app._startForTest()
app.http.router.build()

const notes = await app.http.fetch(new Request('http://app/notes'))
const hook  = await app.http.fetch(new Request('http://app/hooks/calendar', { method: 'POST' }))
if (notes.status !== 200 || hook.status !== 200) throw new Error(`expected 200 and 200, got ${notes.status} and ${hook.status}`)
```

## What else it can do

- `*.service.ts` files in `services/` mount at boot, and a service answers to its camelCase name
- A file in `routes/` answers the URL its path spells, and `[id].ts` captures `ctx.route.id`
- A route file exports `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, and an `options` object keyed by verb
- A file or folder beginning `_` stays private to the files beside it
- `config/junction.config.js` sits above `src/`, as `web/config/sierra.config.js` does
- `jobs/` and `notifications/` beside `services/` belong to caravan and the notifications package
- The boot banner names the services directory it loaded, or says `none`
- `fli api:routes` lists what is mounted, and `--raw` lists only what a plugin or the app added

**In depth:** [README § Structure](../../../README.md#structure), [§ Where the services are](../../../README.md#where-the-services-are), [§ Where the routes are](../../../README.md#where-the-routes-are)
