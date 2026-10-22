---
title: env:send
description: Share .env (or some of its keys) as a one-read Vaultwarden Send link
alias: esend
examples:
  - fli esend
  - fli esend STRIPE_KEY DATABASE_URL
  - fli esend --file .env.production --max-access 2 --days 3
  - fli esend --password hunter2
  - fli esend -g DIGITALOCEAN_TOKEN CLOUDFLARE_TOKEN
args:
  -
    name: keys
    description: Only these keys (the whole file when none)
    variadic: true
flags:
  file:
    char: f
    type: string
    description: Env file to send
    defaultValue: '.env'
  global:
    char: g
    type: boolean
    description: Send from the global FLI env (~/.config/fli/.env) instead of the project's
    defaultValue: false
  max-access:
    type: number
    description: Reads before the link stops working
    defaultValue: 1
  days:
    type: number
    description: Days before the Send is deleted (the server caps it at 31)
    defaultValue: 1
  password:
    type: string
    description: A password the receiver must also pass
    defaultValue: ''
  name:
    type: string
    description: The Send's name in your vault (the project and file when empty)
    defaultValue: ''
---

<script>
import { basename, resolve } from 'path'
</script>

Encrypt an env file into a Vaultwarden/Bitwarden text Send and print the link.
The receiver runs `fli env:pull --from send --url '<link>'`, or opens it in a
browser. The server holds only ciphertext; the key is the link's fragment.

Logs in as the vault user `env:pull --from vaultwarden` uses — `VW_URL` +
`VW_CLIENT_ID`/`VW_CLIENT_SECRET` (or `VW_EMAIL`) + `VW_PASSWORD` — and the
Send is that user's, listed under Send in its vault. A key missing at a
terminal is asked for (the password without echo) and saved to the global env.

```js
const { pickEnv } = await import(resolve(global.fliRoot, 'core/global-env.js'))
let body, count, source
try {
  ({ body, count, source } = pickEnv({
    root: $.paths.root, file: flag.file, global: flag.global,
    keys: (arg.keys?.trim() || '').split(/\s+/).filter(Boolean),
  }))
} catch (e) { log.error(e.message); process.exitCode = 1; return }

const env = $.env
const { loginNeeds }               = await import(resolve(global.fliRoot, 'core/vaultwarden.js'))
const { acquireMissing, ttyPrompts } = await import(resolve(global.fliRoot, 'core/requires.js'))
const needs = loginNeeds(env)
if (needs.length) {
  const left = await acquireMissing('env:send', needs, {
    interactive: tty.interactive, write: !flag.dry, env,
    say: (t, level = 'error') => log[level](t), ...ttyPrompts(tty),
  })
  if (left.length) { process.exitCode = 1; return }
}

if (flag.dry) {
  log.dry(`Would send ${count} var(s) from ${source} — ${flag['max-access']} read(s), ${flag.days} day(s)`)
  return
}

const { openVault } = await import(resolve(global.fliRoot, 'core/vaultwarden.js'))
let sent
try {
  const vault = await openVault({
    url: env.VW_URL, clientId: env.VW_CLIENT_ID, clientSecret: env.VW_CLIENT_SECRET,
    email: env.VW_EMAIL, password: env.VW_PASSWORD,
  })
  sent = await vault.createSend({
    name: flag.name || (flag.global ? 'fli global .env' : `${basename($.paths.root)} ${flag.file}`),
    text: body,
    maxAccessCount: flag['max-access'],
    days: flag.days,
    password: flag.password || null,
  })
} catch (err) {
  log.error(`Send failed: ${err.message}`)
  process.exitCode = 1
  return
}

log.success(`${count} var(s) · ${flag['max-access']} read(s) · until ${sent.until.slice(0, 16).replace('T', ' ')} UTC`)
echo(sent.link)

if (tty.interactive && await tty.keys('Copy the link to the clipboard?', { y: 'copy', n: 'no' }) === 'y') {
  const { copyToClipboard, clipboardTools } = await import(resolve(global.fliRoot, 'core/clipboard.js'))
  if (copyToClipboard(sent.link)) log.success('Copied')
  else log.warn(`Could not copy — is ${clipboardTools() ?? 'a clipboard tool'} installed?`)
}
```
