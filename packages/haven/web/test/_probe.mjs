import { join } from 'node:path'
import { createTestEnv } from '@frontierjs/testing'
import { buildHavenApp } from '../../api/src/app.ts'
import { POST_KEY, signIn } from '../../api/test/sign-in.ts'
const WEB = join(import.meta.dir, '..')
const TUI = join(WEB, '../node_modules/@frontierjs/sierra/src/tools/tui.js')
const env = await createTestEnv({ schema: join(WEB, '../db/schema.lite'), listen: true,
  api: ({ db }) => buildHavenApp({ db, sessionKey: 'k', port: 0, postKey: POST_KEY }) })
const sq = await env.system.room.create({ data: { slug: 'square', name: 'The square' } })
const sam = await signIn(env.port, 'sam'), ana = await signIn(env.port, 'ana')
const ws = new WebSocket(`ws://localhost:${env.port}/ws`, ['fjs', `fjs.bearer.${sam.token}`])
ws.onmessage = (e) => { const f = JSON.parse(String(e.data)); if (f.type === 'event') console.log('SAM GOT', f.event, JSON.stringify(f.data).slice(0, 200)) }
await new Promise(r => setTimeout(r, 300))
ws.send(JSON.stringify({ type: 'subscribe', channel: `room:${sq.id}`, meta: { x: 3, y: 3 } }))
await new Promise(r => setTimeout(r, 300))
console.log('--- ana frames')
const r = Bun.spawn(['bun', TUI, '--frame', '/', '--api', `http://localhost:${env.port}`], { cwd: WEB, env: { ...process.env, HAVEN_TOKEN: ana.token }, stdout: 'pipe', stderr: 'pipe' })
console.log((await new Response(r.stdout).text()).split('\n').filter(l => /here|@|S/.test(l)).join('\n'))
await new Promise(r => setTimeout(r, 300))
await env.close(); process.exit(0)
