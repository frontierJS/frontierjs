---
title: 03-wire
description: A mailer that is one method, and the plugin that reads it
---

## Wiring it

Two plugins, in this order:

```text
app.configure(mail({ mailer: createOutboxMailer(join(import.meta.dir, '..', '..', 'db', 'outbox.jsonl')) }))

app.configure(notifications({
  db,
  transports: { email: { mailer: 'default' } },
}))
```

An app made with `--with notifications` already has the second one, with
email off; the step adds the mailer above it and turns the email transport on.

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
if (!await narrate($)) return

$.config.__step = 3

if (!needs($, ['appDir'], { from: '01-app' })) return

const app     = $.config.appDir
const appTs   = join(app, 'api', 'src', 'app.ts')
const mailer  = join(app, 'api', 'src', 'core', 'outbox-mailer.ts')

$.config.outbox = join(app, 'db', 'outbox.jsonl')

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

const MAILER = [
  '// ─── Notifications ────────────────────────────────────────────────────────',
  '// The mailer comes FIRST. notifications declares requires: [mailer]',
  '// when its email transport uses one, so the wrong order is refused at',
  '// startup rather than at the first send.',
  "app.configure(mail({ mailer: createOutboxMailer(join(import.meta.dir, '..', '..', 'db', 'outbox.jsonl')) }))",
  '',
  'app.configure(notifications({',
  '  db,',
  "  transports: { email: { mailer: 'default' } },",
  '}))',
].join('\n')

if (!/^app\.configure\(mail\(/m.test(src)) {
  // `fli new --with notifications` configures the plugin with email off, so the
  // app either has that block, to be replaced with its comment saying so, or no
  // plugin at all, to be added after channels. Matched rather than compared, the
  // same way tutor:jobs finds its anchor: an app that has narrowed the channels
  // callback down is still the same place.
  const SCAFFOLDED = src.match(/(?:\/\/ ─── Notifications[^\n]*\n(?:\/\/[^\n]*\n)*)?app\.configure\(notifications\(\{\s*db\s*\}\)\)/)?.[0]
  const CONFIGURE  = SCAFFOLDED ? null
                   : (src.match(/app\.configure\(channels\(\([\s\S]*?\n\}\)\)/)
                   ?? src.match(/app\.configure\(channels\(\)\)/))?.[0]
  const imports    = [...src.matchAll(/^import .*$/gm)]

  if ((!SCAFFOLDED && (!CONFIGURE || src.includes('notifications('))) || imports.length === 0) {
    await must($, {
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

  const wanted = [
    [/\bimport\s*\{[^}]*\bjoin\b[^}]*\}\s*from\s*'node:path'/, "import { join }                from 'node:path'"],
    [/\bimport\s*\{[^}]*\bmail\b[^}]*\}\s*from\s*'@frontierjs\/junction\/mail'/, "import { mail }                from '@frontierjs/junction/mail'"],
    [/\bimport\s*\{[^}]*\bnotifications\b[^}]*\}\s*from\s*'@frontierjs\/notifications'/, "import { notifications }       from '@frontierjs/notifications'"],
    [/\bimport\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*'\.\/core\/db/,    "import { db }                  from './core/db.ts'"],
    [/\bimport\s*\{[^}]*\bcreateOutboxMailer\b/,               "import { createOutboxMailer }  from './core/outbox-mailer.ts'"],
  ].filter(([seen]) => !seen.test(src)).map(([, line]) => line)

  const last = imports[imports.length - 1]
  src = src.slice(0, last.index + last[0].length)
    + wanted.map(line => '\n' + line).join('')
    + src.slice(last.index + last[0].length)

  src = SCAFFOLDED
    ? src.replace(SCAFFOLDED, MAILER)
    : src.replace(CONFIGURE, [CONFIGURE, '', MAILER].join('\n'))

  writeFileSync(appTs, src, 'utf8')
}

const api = await restartApi($)
if (!await must($, api.up, {
  likely:    'the API did not come back — the last of its output is below',
  reproduce: `cd ${app} && PORT=${$.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

// Asked of the RUNNING app: the edit above proves the text is there, and this
// proves both plugins registered — which is the half a bad import or the wrong
// order would fail at.
if (!await must($, probe.httpJson({
  url:      apiUrl($, '/manifest'),
  expect:   (j) => Array.isArray(j.plugins)
                && j.plugins.includes('mailer')
                && j.plugins.includes('notifications'),
  describe: 'mailer and notifications among the running app plugins',
  name:     'the app can notify, and has something to send mail with',
}), {
  likely:    'a plugin threw on register — the last of the API output is below',
  detail:    serverLog(api),
  reproduce: `curl -s http://127.0.0.1:${$.config.apiPort}/api/manifest`,
})) return
```
