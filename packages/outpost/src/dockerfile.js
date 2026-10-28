// dockerfile.js — which Dockerfile a build uses, and whether it installs from
// `deploy/generated/`.
//
// One lookup order for both doors. The Outpost's `build` (`docker.js`) and the
// laptop's (`fli basecamp:deploy`) ask here, so the image a push builds and the
// image a laptop ships are chosen the same way (`FJS-D1560`); a second default
// held beside this one is how the laptop came to refuse a plain repository
// (`IDEAS/git-deploy.md` Phase 0.3).

import { existsSync, writeFileSync } from 'node:fs'

/** Which Dockerfile a build uses, relative to the context. The App's stored
 *  copy wins (`FJS-D1555`) and is written into the context as
 *  `Dockerfile.basecamp`; without one, `deploy/Dockerfile`, else the root's. */
export function chooseDockerfile(context, stored) {
  if (typeof stored === 'string' && stored.trim()) {
    try { writeFileSync(`${context}/Dockerfile.basecamp`, stored) } catch (err) {
      throw new Error(`could not write the App's Dockerfile into ${context}: ${err.message}`)
    }
    return 'Dockerfile.basecamp'
  }
  return existsSync(`${context}/deploy/Dockerfile`) ? 'deploy/Dockerfile' : 'Dockerfile'
}

/** Whether a Dockerfile installs from `deploy/generated/`, the context
 *  `fli deploy:vendor` writes and git ignores. The text is the authority: the
 *  folder's presence beside it was the old test, and it refused a plain
 *  repository's own file for the directory it sat in. A comment does not count. */
export function needsGenerated(text) {
  return String(text ?? '').split('\n').some(l => !/^\s*#/.test(l) && l.includes('deploy/generated'))
}

/** The port the image listens on, read off its last `EXPOSE` — the first
 *  number when the line names several, `8080/tcp` read as 8080 — or null when
 *  no `EXPOSE` says, or the last one is a variable docker would expand. EXPOSE
 *  binds nothing; the number is what `-p` is pointed at when the App stores
 *  none, so a wrong read fails the health check and not silently. */
export function exposedPort(text) {
  let port = null
  for (const raw of String(text ?? '').split('\n')) {
    const m = /^\s*EXPOSE\s+(\S+)/i.exec(raw)
    if (!m) continue
    const n = Number(m[1].split('/')[0])
    port = Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
  }
  return port
}
