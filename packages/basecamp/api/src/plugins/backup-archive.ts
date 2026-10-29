// src/plugins/backup-archive.ts — a local hub archive, streamed to a browser.
//
//   GET /backup-archive/{id}?expires=&sig=   ← basecamp-<stamp>.tar.gz
//
// The local half of `backups.download` (`IDEAS/backups.md` 4.2); a remote
// archive is answered with the bucket's own pre-signed GET and never passes
// through here. The answer is the same file either way: the archive directory
// tarred with its own name as the one top entry, which is what `backup:run`
// uploads and what `litestone restore --from-backup` unpacks.
//
// ─── The link carries its own credential ──────────────────────────────────
//
// A download is a navigation, and a navigation carries no bearer; the cookie
// is on only while a sign-in provider is configured. So `backups.download`
// (behind the sysadmin refusal) mints a link signed for one row and five
// minutes, the shape of a pre-signed GET, and this route checks nothing else.
// The key is random per process: a restart voids every link outstanding,
// which costs a click, and there is no key to keep or leak.
//
// The path is in `NAVIGATED_API_PATHS` (web/config/api-paths.js), or both
// proxies answer the navigation with the SPA shell.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { basename }      from 'node:path'
import { localArchive }  from '../domain/backup/backup-archives.ts'
import type { App }      from '@frontierjs/junction'

const KEY    = randomBytes(32)
const TTL_MS = 5 * 60_000

const sign = (id: string, expires: number) => createHmac('sha256', KEY).update(`${id}\n${expires}`).digest('hex')

/** The link one local archive downloads by, good for five minutes. */
export function mintArchiveUrl(id: string, now = Date.now()): string {
  const expires = now + TTL_MS
  return `/backup-archive/${encodeURIComponent(id)}?expires=${expires}&sig=${sign(id, expires)}`
}

function signed(id: string, expires: string, sig: string): boolean {
  const at = Number(expires)
  if (!Number.isFinite(at) || at < Date.now()) return false
  const want = Buffer.from(sign(id, at)), got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got)
}

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

export function backupArchive(app: App) {
  app.get('/backup-archive/{id}', async (ctx) => {
    const id = ctx.route.id
    // One answer for a bad, an expired and a forged link: the remedy is the same.
    if (!signed(id, String(ctx.query.expires ?? ''), String(ctx.query.sig ?? '')))
      return plain(403, 'This download link has expired. Press Download again.')

    const sys = (app.db as any).asSystem()
    const hub = await sys.hubConfig.findFirst({ where: { id: 'hub' }, select: { appId: true } })
    const row = hub?.appId && await sys.appBackup.findFirst({ where: { id, appId: hub.appId } })
    const dir = row && localArchive(app, row)
    if (!dir) return plain(404, `Backup '${id}' has no archive on this disk`)

    const name = basename(dir)
    const proc = Bun.spawn(['tar', '-czf', '-', '-C', `${dir}/..`, name], { stdout: 'pipe', stderr: 'pipe' })
    // The 200 is sent before tar finishes, so a failure mid-stream reaches the
    // browser only as a truncated file; this line is where it is said.
    proc.exited.then(async code => {
      if (code !== 0) app.logger.error('backup archive download failed', {
        backup_id: id, code, stderr: (await new Response(proc.stderr).text()).trim().slice(0, 500) })
    })
    return new Response(proc.stdout, { headers: {
      'content-type':        'application/gzip',
      'content-disposition': `attachment; filename="${name}.tar.gz"`,
      'cache-control':       'no-store',
    } })
  })
}
