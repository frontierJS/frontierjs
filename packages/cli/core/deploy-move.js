// ─── deploy-move.js — moving an install between the two deploy doors ─────────
//
// `deploy:move` carries an app's env, its ENCRYPTION_KEY and its database
// between the SSH door (`<path>/db`, `.env.production`, `secrets/`) and the
// Basecamp door (Basecamp Variables, Outpost's `apps/<id>/data`). Everything
// here is pure or takes the host it acts on, so the command body reads as the
// sequence and the shell, the quoting and the plan are tested without a box.
//
// No secret value is ever an argument or a printed line: values travel on a
// script's stdin, and a plan names keys only.

import { layout } from '@frontierjs/outpost/layout'
import { pipeCommand, shQuote, transportFor } from './machine.js'
import { parseEnvText } from './local-env.js'
import { pushEnvLines } from './global-env.js'
import { mergeVariables, SECRET_NAME } from './release-preflight.js'

export const MOVE_DOORS = ['basecamp', 'ssh']

/**
 * Keys each door sets for its own container and a move never carries: the
 * port the app listens on is the one that door forwards to (3000 over SSH, the
 * App's container port under Outpost), so a carried PORT leaves the app
 * listening where nothing forwards and the release fails its health check.
 */
export const DOOR_OWNED = new Set(['PORT', 'FRONTIER_PORT_BE'])
const carried = (key) => !DOOR_OWNED.has(key)

// Where Outpost keeps an app's data and reads an archive to restore it from.
export const outpostDataDir = (appId) => `${layout().apps}/${appId}/data`
export const outpostRestoreDir = () => layout().restore

// ─── Where a Basecamp server is reached ──────────────────────────────────────
// The URI form carries a port with no `-p`, which machine.js cannot pass.
export function serverDestination(server) {
  if (!server?.ipAddress) throw new Error(`server '${server?.name}' records no ipAddress, so it cannot be reached over ssh`)
  const user = server.sshUser || 'root'
  return Number(server.sshPort ?? 22) === 22
    ? `${user}@${server.ipAddress}`
    : `ssh://${user}@${server.ipAddress}:${server.sshPort}`
}

// ─── Root on a box, over a pipe ──────────────────────────────────────────────
// `asRootOn` reads its script on stdin, which a stream of tar bytes needs for
// itself, so the script is an argument here. It carries paths and flags and no
// secret.
const asRoot = (script) => {
  const quoted = shQuote(script)
  return `if [ "$(id -u)" = 0 ]; then sh -c ${quoted}; else sudo -n sh -c ${quoted}; fi`
}

/** The shell command that runs `script` as root on `host`, its stdin free for data. */
export function rootPipe(host, script) {
  const transport = transportFor(host)
  const wrapped = asRoot(script)
  return pipeCommand(host, transport, transport === 'local' ? wrapped : shQuote(wrapped))
}

// ─── Reading the SSH install ─────────────────────────────────────────────────
/** A script printing the env file and each secrets/ file, each under a marker line `token` makes unguessable. */
export function readSourceScript({ envFile, secretsDir, token }) {
  return `set -eu
echo ${shQuote(`@@${token} env`)}
[ -f ${shQuote(envFile)} ] && cat ${shQuote(envFile)} || true
echo
for f in ${shQuote(secretsDir)}/*; do
  [ -f "$f" ] || continue
  echo "@@${token} secret $(basename "$f")"
  cat "$f"
  echo
done
echo ${shQuote(`@@${token} end`)}
`
}

/** What `readSourceScript` printed: `{ env, secrets }`, a secret's trailing newline dropped. */
export function parseSourceRead(out, token) {
  const mark = `@@${token} `
  const sections = []
  for (const line of String(out).split('\n')) {
    if (line.startsWith(mark)) {
      const [kind, ...name] = line.slice(mark.length).split(' ')
      sections.push({ kind, name: name.join(' '), lines: [] })
    } else sections.at(-1)?.lines.push(line)
  }
  if (sections.at(-1)?.kind !== 'end') throw new Error('the read of the env file and secrets did not finish')
  const body = (s) => s.lines.join('\n').replace(/\n$/, '')
  const secrets = {}
  for (const s of sections.filter(s => s.kind === 'secret')) secrets[s.name] = body(s).replace(/\r$/, '')
  return { env: body(sections.find(s => s.kind === 'env') ?? { lines: [] }), secrets }
}

/**
 * The SSH install's environment as Variables to write: every key of the env
 * file and of secrets/, a secrets/ file winning over an env line of its name.
 * `secretKeys` holds ENCRYPTION_KEY and each secrets/ file.
 */
export function sourceVariables({ env, secrets }) {
  const values = {}
  for (const [line, value] of Object.entries(parseEnvText(env))) values[line.replace(/^export\s+/, '')] = value
  for (const [name, value] of Object.entries(secrets)) values[name] = value
  for (const key of DOOR_OWNED) delete values[key]
  return { values, secretKeys: new Set(['ENCRYPTION_KEY', ...Object.keys(secrets)].filter(k => k in values)) }
}

// ─── The Variables diff, SSH → Basecamp ──────────────────────────────────────
/**
 * What writing `source` into the App's Variables does. A key the container
 * holds with another value is overwritten: the App's own minted ENCRYPTION_KEY
 * is replaced, which is the point. A secret is never `same`, its value being
 * unreadable. `isSecret` is frozen on a row, so a plain row of a key that is
 * now a secret is deleted and made again (`recreate`). An environment's row
 * is shadowed by an App row, not edited, since it is every App's.
 * `kept` are keys only Basecamp holds, left alone.
 *
 * @returns {{ create: object[], patch: object[], recreate: object[], added: string[], replaced: string[], same: string[], kept: string[], secret: string[] }}
 */
export function planVariables({ values, secretKeys, rows, appId }) {
  const held = mergeVariables(rows, appId)
  const out  = { create: [], patch: [], recreate: [], added: [], replaced: [], same: [], kept: [], secret: [] }
  for (const [key, value] of Object.entries(values)) {
    const wantSecret = secretKeys.has(key) || SECRET_NAME.test(key)
    const row = held.get(key)
    if (row && !row.isSecret && !wantSecret && row.value === value) { out.same.push(key); continue }
    out[row ? 'replaced' : 'added'].push(key)
    const own = row?.appId === appId
    if (own && (row.isSecret || !wantSecret)) {
      out.patch.push({ id: row.id, version: row.version, key, value })
      if (row.isSecret) out.secret.push(key)
    } else {
      const isSecret = wantSecret || !!row?.isSecret
      ;(own ? out.recreate : out.create).push({ ...(own && { id: row.id }), appId, key, value, isSecret })
      if (isSecret) out.secret.push(key)
    }
  }
  out.kept = [...held.keys()].filter(k => !(k in values)).sort()
  return out
}

// ─── The Apps that let go, Basecamp → SSH ────────────────────────────────────
/**
 * The other Apps of the environment whose Domain names a hostname the SSH door
 * serves. `fli basecamp:deploy` puts an app with web/ on a static App holding
 * the Domain, so the API App alone letting go leaves its routes in Caddy and
 * the SSH door's preflight refuses the box. A static App is let go with the
 * API; a container App holding the name is another app, so it is `foreign`
 * and the move refuses rather than delete it.
 */
export function frontingApps({ siblings, appId, hosts }) {
  const wanted = new Set(hosts.filter(Boolean).map(h => String(h).toLowerCase()))
  const fronts = [], foreign = []
  for (const s of siblings ?? []) {
    if (s.id === appId) continue
    const names = (s.domains ?? []).map(d => String(d.hostname).toLowerCase()).filter(h => wanted.has(h))
    if (!names.length) continue
    ;(s.source?.kind === 'inline' ? fronts : foreign).push({ id: s.id, name: s.name, hosts: names })
  }
  return { fronts, foreign }
}

// ─── The env file, Basecamp → SSH ────────────────────────────────────────────
// A line cannot carry a newline, and `docker --env-file` reads no quoting, so
// such a value is refused by its key rather than written as another value.
const writable = (value) => !/[\r\n\0]/.test(value)

/**
 * The SSH install's files from the App's Variables: ENCRYPTION_KEY alone for
 * `secrets/ENCRYPTION_KEY`, every other key merged into the env file's
 * `current` text, which keeps its comments and the keys only it holds.
 *
 * @param {{ key: string, value: string }[]} variables
 */
export function planEnvWrite({ variables, current = '' }) {
  variables = variables.filter(v => carried(v.key))
  const unwritable = variables.filter(v => !writable(v.value)).map(v => v.key)
  const keyed      = variables.find(v => v.key === 'ENCRYPTION_KEY')
  const rest       = variables.filter(v => v.key !== 'ENCRYPTION_KEY' && writable(v.value))
  const merged     = pushEnvLines(current, rest.map(v => `${v.key}=${v.value}`).join('\n'), { overwrite: true })
  return {
    text: merged.text, encryptionKey: keyed && writable(keyed.value) ? keyed.value : null,
    added: merged.added, replaced: merged.replaced, same: merged.same, unwritable,
  }
}

/** The script, run as root with its text on stdin, that writes the two files. `owner` is what `deploy:setup` gave the secrets directory. */
export function writeFilesScript({ envFile, secretsDir, text, encryptionKey, owner, token }) {
  const dir = shQuote(secretsDir)
  return `set -eu
umask 077
env=${shQuote(envFile)}
tmp=$(mktemp "$(dirname "$env")/.env-XXXXXX")
cat > "$tmp" <<'${token}'
${text.replace(/\n$/, '')}
${token}
if [ -f "$env" ]; then chown --reference="$env" "$tmp"; chmod --reference="$env" "$tmp"
else chmod 600 "$tmp"; [ -z "\${SUDO_USER:-}" ] || chown "$SUDO_USER" "$tmp"; fi
mv "$tmp" "$env"
${encryptionKey == null ? '' : `mkdir -p ${dir}
key=$(mktemp ${dir}/.key-XXXXXX)
printf '%s\\n' ${shQuote(encryptionKey)} > "$key"
chmod 400 "$key"
mv "$key" ${shQuote(`${secretsDir}/ENCRYPTION_KEY`)}
chown -R ${owner} ${dir}
`}`
}

// ─── The data directory ──────────────────────────────────────────────────────
/** A script printing `<files> <bytes> <entries>` under `dir`; a missing directory is `0 0 0`. */
export const treeStatScript = (dir) => `d=${shQuote(dir)}
if [ -d "$d" ]; then
  files=$(find "$d" -type f | wc -l)
  bytes=$(find "$d" -type f -exec stat -c %s {} + | awk '{ b += $1 } END { printf "%.0f", b }')
  entries=$(find "$d" -mindepth 1 | wc -l)
  echo "$files \${bytes:-0} $entries"
else echo "0 0 0"; fi`

export function parseTreeStat(out) {
  const [files, bytes, entries] = String(out).trim().split('\n').at(-1).split(/\s+/).map(Number)
  if (![files, bytes, entries].every(Number.isFinite)) throw new Error(`could not read the data directory's size: '${String(out).trim().slice(0, 80)}'`)
  return { files, bytes, entries }
}

export const tarOutScript = (dir) => `tar -C ${shQuote(dir)} -czf - .`

/** Empties `dir` first under `overwrite` and refuses (exit 3) a non-empty one otherwise: a -wal left beside a new database is replayed into it. */
export const tarInScript = ({ dir, overwrite, owner }) => `set -eu
d=${shQuote(dir)}
mkdir -p "$d"
if [ -n "$(ls -A "$d")" ]; then
  ${overwrite ? 'find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} +' : 'echo "$d already holds files" >&2; exit 3'}
fi
tar -xzf - -C "$d"
chown -R ${owner} "$d"
chmod 750 "$d"`

/** Outpost reads a restore archive by this name and refuses any other shape. */
export const archiveName = (appId, token) => `move-${String(appId).replace(/[^A-Za-z0-9-]/g, '-')}-${token}.tar.gz`

export const stageArchiveScript = (path) => `set -eu
umask 077
mkdir -p ${shQuote(dirnameOf(path))}
cat > ${shQuote(path)}`

export const dropArchiveScript = (path) => `rm -f ${shQuote(path)}`

const dirnameOf = (path) => path.slice(0, path.lastIndexOf('/'))

/**
 * Run `from` and pipe its stdout into `to`: both are shell commands, and the
 * bytes pass through this process, so the two boxes may be anywhere. A tar that
 * dies partway makes the receiver see a short archive, and a receiver that
 * refuses kills the sender with a broken pipe, so which side's reason is the
 * real one cannot be told from the exit codes: both are named.
 */
export async function streamTar({ from, to, spawn = Bun.spawn }) {
  const src = spawn(['sh', '-c', from], { stdout: 'pipe', stderr: 'pipe' })
  const dst = spawn(['sh', '-c', to], { stdin: src.stdout, stdout: 'pipe', stderr: 'pipe' })
  const [a, b, aErr, bErr] = await Promise.all([
    src.exited, dst.exited, new Response(src.stderr).text(), new Response(dst.stderr).text(),
  ])
  const last = (text) => text.trim().split('\n').pop() || 'no reason given'
  const failed = [
    a !== 0 && `the read side failed (exit ${a}): ${last(aErr)}`,
    b !== 0 && `the write side failed (exit ${b}): ${last(bErr)}`,
  ].filter(Boolean)
  if (failed.length) throw new Error(failed.join('; '))
}

// ─── What is printed ─────────────────────────────────────────────────────────
/** `fli deploy` as the next step spells it, so the tier follows the move. */
export const deployCommand = (flag = {}) =>
  `fli deploy${flag.production ? ' --production' : flag.stage ? ' --stage' : ''}`

/**
 * The lines that close a move, the exact next command first. `.env` is never
 * edited here. Moving to ssh, `deploy:setup` comes before the release: it could
 * not write the routes while Basecamp held the hostname, and a release only
 * rewrites routes that are there.
 */
export function nextSteps({ to, flag = {}, envFile = '.env' }) {
  const tier = flag.production ? ' --production' : flag.stage ? ' --stage' : ''
  if (to === 'ssh') return [
    `Remove BASECAMP_APP_ID from ${envFile}, so fli deploy takes the SSH door`,
    `Then fli deploy:setup${tier} to write the routes, and ${deployCommand(flag)}`,
  ]
  return [
    `Set BASECAMP_APP_ID in ${envFile} to the App's id, if it is not already`,
    `Then ${deployCommand(flag)}`,
  ]
}

/** What a failed move leaves, by how far it got. */
export function failureNote({ to, stopped, container, dbDir, host }) {
  if (to === 'basecamp' && stopped)
    return `The SSH install on ${host} is stopped and unrouted, its data untouched at ${dbDir}: fli deploy under the SSH door (BASECAMP_APP_ID removed) starts it again`
  if (to === 'ssh' && stopped)
    return 'The Basecamp App is in the Trash with its data in place on its machine: restore it from there to undo'
  return null
}

export const bytesOf = (n) => {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
