---
title: tell:setup
description: Stand up the post — deploy the tell Worker to your Cloudflare account, as its first member
effects: deploys a Worker and Durable Object to your Cloudflare account with wrangler, and writes ~/.fli/tell/ and ~/.fli/config.json
examples:
  - fli tell:setup --nick sam
  - fli tell:setup --nick sam --account 0123456789abcdef0123456789abcdef
  - fli tell:setup --dry
flags:
  nick:
    char: n
    type: string
    description: The owner's nick — tell.nick in ~/.fli/config.json, else this machine's user name. 2 to 16 of a-z, 0-9, - and _
    defaultValue: ''
  name:
    type: string
    description: The Worker's name, and so its workers.dev host
    defaultValue: 'fli-tell'
  account:
    type: string
    description: The Cloudflare account to deploy to — CLOUDFLARE_ACCOUNT_ID, else whichever wrangler is logged in to
    defaultValue: ''
---

The owner runs this once (`IDEAS/pony-express.md` 1.2). It makes this
machine's key at `~/.fli/tell/key.json`, deploys `core/tell-worker.js` to the
owner's Cloudflare account with `bunx wrangler@4` — logged in the way wrangler
is, `wrangler login` or `CLOUDFLARE_API_TOKEN` — and writes the Worker's
origin to `~/.fli/config.json` as `tell.api`. Then it asks the Worker who its
members are, signed, and the owner must be the answer.

The owner is member one because the deploy says so: the public key goes in as
the `OWNER_KEY` var and the nick as `OWNER_NICK`, and the Durable Object seeds
them. A public key is not a secret, so both are plain vars in
`~/.fli/tell/wrangler.jsonc`, where wrangler's own state lands beside them.

Last it publishes the owner's chain, whose root signs the sealing key, so
letters to the owner are sealed (`FJS-D1400`, `IDEAS/pony-express.md` 4.3).

Run again, it redeploys the same key and keeps every member and letter — that
is how a newer `fli`'s Worker reaches the post. A new key under an old nick is
refused by the post, since the nick is already the old key's.

```js
const { spawn } = await import('node:child_process')

const worker = resolve(global.fliRoot, 'core', 'tell-worker.js')
const wranglerConfig = join(TELL_DIR, 'wrangler.jsonc')

let nick
try { nick = tellNick(flag.nick, readConfig().tell ?? {}) }
catch (e) { log.error(e.message); process.exitCode = 1; return }
if (!/^[a-z0-9-]{1,63}$/.test(flag.name)) {
  log.error(`'${flag.name}' is no Worker name — lower-case letters, digits and -.`)
  process.exitCode = 1
  return
}
const account = flag.account || process.env.CLOUDFLARE_ACCOUNT_ID || ''

if (flag.dry) {
  log.dry(`Would make ${KEY_FILE} if absent, write ${wranglerConfig}, deploy ${worker} as ${flag.name} with bunx wrangler@4, save its origin as tell.api in ${CONFIG_FILE}, and check ${nick} is member one`)
  return
}

const { keys, made } = await tellKeys()
if (made) log.info(`This machine's key is ${KEY_FILE} — it is who you are at the post, so keep it.`)

writeFileSync(wranglerConfig, JSON.stringify({
  name: flag.name,
  main: worker,
  compatibility_date: '2026-09-01',
  ...(account ? { account_id: account } : {}),
  workers_dev: true,
  vars: { OWNER_KEY: keys.publicKey, OWNER_NICK: nick },
  durable_objects: { bindings: [{ name: 'POST', class_name: 'TellPost' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['TellPost'] }],
}, null, 2) + '\n')

// Wrangler's stdout is read for the origin it deployed to and echoed as it
// comes; stdin and stderr stay the person's, for a login or an account pick.
log.info(`Deploying ${flag.name} with wrangler…`)
let printed = ''
const code = await new Promise((done) => {
  const child = spawn('bunx', ['wrangler@4', 'deploy', '--config', wranglerConfig], { cwd: TELL_DIR, stdio: ['inherit', 'pipe', 'inherit'] })
  child.stdout.on('data', (chunk) => { printed += chunk; process.stdout.write(chunk) })
  child.on('error', (e) => { log.error(`bunx did not start (${e.message})`); done(1) })
  child.on('close', done)
})
if (code !== 0) {
  log.error(`wrangler deploy exited ${code} — its output is above. Not logged in? bunx wrangler@4 login`)
  process.exitCode = 1
  return
}
const api = printed.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0]
if (!api) {
  log.error('wrangler deployed but printed no workers.dev origin — is workers.dev turned on for this account? Its dashboard says so under Workers & Pages.')
  process.exitCode = 1
  return
}
writeTellConfig({ api, nick })

// A first workers.dev deploy can take a few seconds to resolve.
let answer
for (let i = 0; i < 20; i++) {
  try {
    answer = await tellFetch(api, keys, 'GET', '/members')
    if (answer.status !== 404 && answer.status < 500) break
  } catch {}
  await new Promise(r => setTimeout(r, 1500))
}
if (answer?.status === 403) {
  log.error(`${api} is up, and this key is no member of it — the post already has an owner under another key. Put that key back at ${KEY_FILE}, or deploy under another --name.`)
  process.exitCode = 1
  return
}
if (answer?.status !== 200) {
  log.error(`${api} did not answer the members check (${answer ? `${answer.status} ${answer.json?.message ?? ''}` : 'no answer'}).`)
  process.exitCode = 1
  return
}
const members = answer.json.members ?? []
const me = members.find(m => m.publicKey === keys.publicKey)
if (!me) {
  log.error(`${api} answered, and does not list this key — the post's members are ${members.map(m => m.nick).join(', ') || 'none'}.`)
  process.exitCode = 1
  return
}
if (me.nick !== nick) log.warn(`This key is ${me.nick} at the post, not ${nick} — a nick is set by the first deploy.`)
if (me.root !== await ownRoot(keys)) writeTellConfig({ root: null })
const published = await publishChain(api, keys).catch(e => e.message)
if (published) log.warn(`The post did not take this member's chain (${published}) — the next \`fli tell\` verb tries again.`)
log.success(`The post is up at ${api}, and ${me.nick} is ${members.length === 1 ? 'its one member' : `one of ${members.length} members`}.`)
echo(`  saved as tell.api in ${CONFIG_FILE}`)
```
