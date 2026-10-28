---
title: workspace:post
description: Deploy the project's post — the tell Worker at network.frontierjs.com, with the maintainer running it as member one
alias: ws:post
effects: deploys a Worker and Durable Object to Cloudflare with wrangler, routes network.frontierjs.com to it, and writes ~/.fli/frontier/ and ~/.fli/config.json
examples:
  - fli ws:post
  - fli ws:post --nick jordan
  - fli ws:post --dry
flags:
  nick:
    char: n
    type: string
    description: The owner's nick — frontier.nick in ~/.fli/config.json, else this machine's user name. 2 to 16 of a-z, 0-9, - and _
    defaultValue: ''
---

How the maintainers deploy the project's post, the only one (`FJS-D1414`).
It makes this machine's key at `~/.fli/frontier/key.json`, deploys
`core/tell-worker.js` with `bunx wrangler@4` — logged in the way wrangler is,
`wrangler login` or `CLOUDFLARE_API_TOKEN`, to the account holding the
`frontierjs.com` zone — as the custom domain every `fli` speaks to
(`POST_ORIGIN` in `core/tell.js`), with no `workers.dev` route. Then it asks
the post who its members are, signed, and this machine must be the answer.

The owner is member one because the deploy says so: the public key goes in as
the `OWNER_KEY` var and the nick as `OWNER_NICK`, and the Durable Object seeds
them. A public key is not a secret, so both are plain vars in
`~/.fli/frontier/wrangler.jsonc`, where wrangler's own state lands beside them.

Run again, it redeploys the same key and keeps every member and letter — that
is how a newer `fli`'s Worker reaches the post. The Worker's name is fixed: the
Durable Object's storage belongs to it, so another name is an empty post. A new
key under the old nick is refused by the post, since the nick is the old key's.

Last it publishes the owner's chain, whose root signs the sealing key, so
letters to the owner are sealed (`FJS-D1400`, `FJS-D1416`).

```js
const { spawn } = await import('node:child_process')
const { FRONTIER_DIR, KEY_FILE, CONFIG_FILE, POST_ORIGIN, readConfig, tellFetch } = await import(new URL('file://' + global.fliRoot + '/core/tell.js'))
const { writeMemberConfig, machineKeys, ownRoot, publishOwn, pickNick } = await import(new URL('file://' + global.fliRoot + '/core/frontier-member.js'))

const WORKER = 'fli-tell'
const worker = path.join(global.fliRoot, 'core', 'tell-worker.js')
const wranglerConfig = path.join(FRONTIER_DIR, 'wrangler.jsonc')
const host = new URL(POST_ORIGIN).host

let nick
try { nick = pickNick(flag.nick, readConfig().frontier ?? {}) }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would make ${KEY_FILE} if absent, write ${wranglerConfig}, deploy ${worker} as ${WORKER} on ${host} with bunx wrangler@4, and check ${nick} is member one`)
  return
}

const { keys, made } = await machineKeys()
if (made) log.info(`This machine's key is ${KEY_FILE} — it is who you are at the post, so keep it.`)

fs.writeFileSync(wranglerConfig, JSON.stringify({
  name: WORKER,
  main: worker,
  compatibility_date: '2026-09-01',
  workers_dev: false,
  routes: [{ pattern: host, custom_domain: true }],
  vars: { OWNER_KEY: keys.publicKey, OWNER_NICK: nick },
  durable_objects: { bindings: [{ name: 'POST', class_name: 'TellPost' }] },
  r2_buckets: [{ binding: 'FILES', bucket_name: 'frontier-files' }],
  migrations: [{ tag: 'v1', new_sqlite_classes: ['TellPost'] }],
}, null, 2) + '\n')

// stdin and stderr stay the person's, for a login or an account pick.
log.info(`Deploying ${WORKER} to ${host} with wrangler…`)
const code = await new Promise((done) => {
  const child = spawn('bunx', ['wrangler@4', 'deploy', '--config', wranglerConfig], { cwd: FRONTIER_DIR, stdio: 'inherit' })
  child.on('error', (e) => { log.error(`bunx did not start (${e.message})`); done(1) })
  child.on('close', done)
})
if (code !== 0) {
  log.error(`wrangler deploy exited ${code} — its output is above. Not logged in? bunx wrangler@4 login`)
  process.exitCode = 1
  return
}

// A new custom domain answers once its certificate is issued, which can take a minute or two.
let answer
for (let i = 0; i < 60; i++) {
  try {
    answer = await tellFetch(POST_ORIGIN, keys, 'GET', '/members')
    if (answer.status !== 404 && answer.status < 500) break
  } catch {}
  await new Promise(r => setTimeout(r, 3000))
}
if (answer?.status === 403) {
  log.error(`${POST_ORIGIN} is up, and this key is no member of it — the post already has an owner under another key. Put that key back at ${KEY_FILE}.`)
  process.exitCode = 1
  return
}
if (answer?.status !== 200) {
  log.error(`${POST_ORIGIN} did not answer the members check (${answer ? `${answer.status} ${answer.json?.message ?? ''}` : 'no answer'}).`)
  process.exitCode = 1
  return
}
const members = answer.json.members ?? []
const me = members.find(m => m.publicKey === keys.publicKey)
if (!me) {
  log.error(`${POST_ORIGIN} answered, and does not list this key — the post's members are ${members.map(m => m.nick).join(', ') || 'none'}.`)
  process.exitCode = 1
  return
}
if (me.nick !== nick) log.warn(`This key is ${me.nick} at the post, not ${nick} — a nick is set by the first deploy.`)
writeMemberConfig({ nick: me.nick })
if (me.root !== await ownRoot(keys)) writeMemberConfig({ root: null })
const published = await publishOwn(POST_ORIGIN, keys).catch(e => e.message)
if (published) log.warn(`The post did not take ${published} — the next \`fli tell\` verb tries again.`)
log.success(`The post is up at ${POST_ORIGIN}, and ${me.nick} is ${members.length === 1 ? 'its one member' : `one of ${members.length} members`}.`)
echo(`  saved as frontier.nick in ${CONFIG_FILE}`)
```
