---
title: 03-wire
description: A mailer that is one method, and the plugin that reads it
---

## Wiring it

Two plugins, in this order:

```text
app.configure(mailerPlugin(createOutboxMailer(join(import.meta.dir, '..', '..', 'db', 'outbox.jsonl'))))

app.configure(notificationsPlugin({
  db,
  transports: { email: { mailer: 'default' } },
}))
```

**The order is enforced rather than remembered.** The plugin declares
`requires: ['mailer']` when its email transport uses one, so configuring them
the wrong way round refuses at startup naming both plugins — not at the first
send, an hour after the deploy, to one person.

The mailer is written here rather than installed, and it is nine lines:

```text
export function createOutboxMailer(path: string) {
  return {
    async send(message) {
      appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...message }) + '\n', 'utf8')
      return { id: 'outbox', accepted: true }
    },
  }
}
```

That is the whole of `IMail` — **one method**. Resend and SMTP adapters ship in
Junction and either would work here; a file is used because it can be READ back,
and an assertion about mail that a lesson cannot read is not an assertion. In a
real app this is what you point at a provider on the day you have one, and
nothing that sends mail changes.

`db` is passed because the in-app transport writes a row, and it writes it
through `asSystem()` — which is the gate you set in step 1 being the reason the
package can write a row that no request could.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app     = context.config.appDir
const appTs   = join(app, 'api', 'src', 'app.ts')
const mailer  = join(app, 'api', 'src', 'core', 'outbox-mailer.ts')

context.config.outbox = join(app, 'db', 'outbox.jsonl')

writeFileSync(mailer, [
  '// api/src/core/outbox-mailer.ts',
  '//',
  "// Junction's IMail is one method. This one writes a line per message so the",
  '// lesson can read the mail back; swap it for createSmtpMailer or',
  '// createResendMailer and nothing that SENDS changes.',
  '',
  "import { appendFileSync } from 'node:fs'",
  '',
  'type Message = { to?: string, subject?: string, html?: string, text?: string }',
  '',
  'export function createOutboxMailer(path: string) {',
  '  return {',
  '    async send(message: Message) {',
  "      appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...message }) + '\\n', 'utf8')",
  "      return { id: 'outbox', accepted: true }",
  '    },',
  '  }',
  '}',
  '',
].join('\n'), 'utf8')

let src = readFileSync(appTs, 'utf8')

if (!src.includes('notificationsPlugin')) {
  // Matched rather than compared, the same way tutor:jobs finds its anchor: an
  // app that has narrowed the channels callback down is still the same place.
  const CONFIGURE = (src.match(/app\.configure\(channels\(\([\s\S]*?\n\}\)\)/)
                  ?? src.match(/app\.configure\(channels\(\)\)/))?.[0]
  const imports   = [...src.matchAll(/^import .*$/gm)]

  if (!CONFIGURE || imports.length === 0) {
    await must(context, {
      ok:    false,
      name:  'api/src/app.ts has the place this step edits',
      asked: "the scaffold's own app.ts",
      got:   'a file that has been changed under the lesson',
    }, {
      likely:    'add the two plugins by hand — the prose above is the whole of them',
      reproduce: `grep -n 'app.configure' ${appTs}`,
    })
    return
  }

  const last = imports[imports.length - 1]
  src = src.slice(0, last.index + last[0].length)
    + "\nimport { join }                from 'node:path'"
    + "\nimport { mailerPlugin }        from '@frontierjs/junction'"
    + "\nimport { notificationsPlugin } from '@frontierjs/notifications'"
    + "\nimport { db }                  from './core/db.ts'"
    + "\nimport { createOutboxMailer }  from './core/outbox-mailer.ts'"
    + src.slice(last.index + last[0].length)

  src = src.replace(CONFIGURE, [
    CONFIGURE,
    '',
    '// ─── Notifications ────────────────────────────────────────────────────────',
    '// The mailer comes FIRST. notificationsPlugin declares requires: [mailer]',
    '// when its email transport uses one, so the wrong order is refused at',
    '// startup rather than at the first send.',
    "app.configure(mailerPlugin(createOutboxMailer(join(import.meta.dir, '..', '..', 'db', 'outbox.jsonl'))))",
    '',
    'app.configure(notificationsPlugin({',
    '  db,',
    "  transports: { email: { mailer: 'default' } },",
    '}))',
  ].join('\n'))

  writeFileSync(appTs, src, 'utf8')
}

const api = await restartApi(context)
if (!await must(context, api.up, {
  likely:    'the API did not come back — the last of its output is below',
  reproduce: `cd ${app} && PORT=${context.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

// Asked of the RUNNING app: the edit above proves the text is there, and this
// proves both plugins registered — which is the half a bad import or the wrong
// order would fail at.
if (!await must(context, probe.httpJson({
  url:      apiUrl(context, '/manifest'),
  expect:   (j) => Array.isArray(j.plugins)
                && j.plugins.includes('mailer')
                && j.plugins.includes('notifications'),
  describe: 'mailer and notifications among the running app plugins',
  name:     'the app can notify, and has something to send mail with',
}), {
  likely:    'a plugin threw on register — the last of the API output is below',
  detail:    serverLog(api),
  reproduce: `curl -s http://127.0.0.1:${context.config.apiPort}/api/manifest`,
})) return
```
