/*
 * cert.js — the certificate this machine's command port answers with.
 *
 * Self-signed, naming no address: a fleet machine may have only an IP, and it
 * cannot see which one the world reaches it at. Basecamp trusts it because the
 * certificate travels in the enrollment exchange — over Basecamp's own HTTPS,
 * beside the single-use token — and the conduit target pins exactly it
 * (`FJS-1603`). A different certificate on this port, for any reason, fails
 * every command until the machine enrolls again.
 *
 * The install script has to make it in shell, before this package is on the
 * machine, so it builds its openssl line from `OPENSSL_CERT_ARGS` rather than
 * spelling a second one.
 */

import { spawnSync }                  from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { join }                       from 'node:path'

/** Everything but the two output paths. P-256, ten years, and a subject that
 *  names no address — the pin replaces the hostname check. */
export const OPENSSL_CERT_ARGS = [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
  '-days', '3650', '-subj', '/CN=outpost',
]

/**
 * The certificate and key in `dir`, made on the first call and read on every
 * one after — so a restart keeps the certificate Basecamp pinned.
 *
 * @param {string} dir
 * @returns {{ certPath: string, keyPath: string, cert: string }}
 */
export function ensureCert(dir) {
  const certPath = join(dir, 'outpost.crt')
  const keyPath  = join(dir, 'outpost.key')

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true })
    const made = spawnSync('openssl', [...OPENSSL_CERT_ARGS, '-keyout', keyPath, '-out', certPath],
      { encoding: 'utf8' })
    if (made.error || made.status !== 0)
      throw new Error(`outpost: could not make a certificate with openssl — ${made.error?.message ?? made.stderr.trim()}`)
    chmodSync(keyPath, 0o600)
  }

  return { certPath, keyPath, cert: readFileSync(certPath, 'utf8') }
}
