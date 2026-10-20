// ─── local-env.js — the env `deploy:local` gives the container ───────────────
//
// The project `.env` is written for a process whose cwd is the app root, so
// `DATABASE_URL=./db/app.db` is right on the host and names an empty file inside
// the image, where the mounted directory is /db. The container's app then opens a
// database nobody mounted and the run is refused as a production deploy.
// `--env-file` takes the file whole; these are the values that must be re-rooted
// and are passed as `--env` after it.

/** `KEY=value` lines of a dotenv text as an object; comments and blanks skipped. */
export function parseEnvText(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    out[t.slice(0, eq).trim()] = val
  }
  return out
}

/**
 * The variables whose value is a path under the app's `./db`, re-rooted at the
 * directory the container mounts it on. Matched by value rather than by name, so
 * `AUDIT_PATH` and a caravan path follow `DATABASE_URL` without a list to keep.
 *
 * @returns {Record<string, string>}
 */
export function containerEnvOverrides(text, mountDir) {
  const out = {}
  for (const [key, val] of Object.entries(parseEnvText(text))) {
    const m = val.match(/^(?:\.\/)?db\/(.*)$/)
    if (m) out[key] = `${mountDir}/${m[1]}`
  }
  return out
}
