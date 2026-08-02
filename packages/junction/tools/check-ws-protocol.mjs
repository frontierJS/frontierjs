// The browser client's service_call frame must carry extras where the server
// reads them. Client and server disagreed: client wrote `params`, server read
// `meta`, so ctx.id was never set and every id-bearing call looked bulk.
import { readFileSync } from 'fs'
const client = readFileSync('/home/claude/review/junction/src/client/index.ts', 'utf8')
const server = readFileSync('/home/claude/review/junction/src/transport/channels.ts', 'utf8')

let bad = 0
const chk = (label, ok, d = '') => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${label}${d ? '  — ' + d : ''}`) }

const frame = client.match(/type: 'service_call',[\s\S]{0,320}?\)\s*\n\s*\}\)/)?.[0] ?? ''
chk('client sends extras under meta',      /\{ meta \}/.test(frame))
chk('client no longer sends params',      !/\{ params \}/.test(frame))
chk('client puts the id in meta',          /meta\.id\s*=\s*id/.test(client))

chk('server reads meta',                   /parsedAny\.meta/.test(server))
chk('server also tolerates params',        /parsedAny\.params/.test(server))
chk('server derives ctx.id from extras',   /const paramId = extra\?\.id/.test(server))

console.log(bad ? `\n  ${bad} check(s) failed` : '\n  client and server agree on the service_call frame')
process.exit(bad ? 1 : 0)
