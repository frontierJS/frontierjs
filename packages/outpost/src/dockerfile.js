// dockerfile.js — which Dockerfile a build uses, whether it installs from
// `deploy/generated/`, and that folder for an app that links nothing.
//
// One lookup order for both doors. The Outpost's `build` (`docker.js`) and the
// laptop's (`fli basecamp:deploy`) ask here, so the image a push builds and the
// image a laptop ships are chosen the same way (`FJS-D1560`); a second default
// held beside this one is how the laptop came to refuse a plain repository
// (`IDEAS/git-deploy.md` Phase 0.3).

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

export const GENERATED_DIR = 'deploy/generated'
export const VENDOR_DIR    = 'deploy/generated/vendor'
export const MANIFEST_FILE = 'deploy/generated/app-manifest.json'

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

const LINKED = /^(link:|workspace:)/

/** The dependency names no registry can install: `link:` and `workspace:`,
 *  and a tarball already pointing into the generated directory, which is
 *  output wiped on every vendor run. Both fields, because an app's own
 *  `build:web` needs its devDependencies. */
export function linkedDeps(manifest) {
  const out = []
  for (const field of ['dependencies', 'devDependencies'])
    for (const [name, spec] of Object.entries(manifest?.[field] ?? {}))
      if (typeof spec === 'string' && (LINKED.test(spec) || spec.startsWith(`file:./${VENDOR_DIR}/`))) out.push(name)
  return [...new Set(out)]
}

/** `deploy/generated/` for an app that links nothing: the manifest, and the
 *  lockfile beside it, which the template's install freezes on. One Dockerfile
 *  serves both source modes because this half needs no workspace, so a machine
 *  building a clone writes it as a laptop does (`FJS-4066`). Answers the
 *  lockfile copied, or null. */
export function writeUnlinked(root, manifest) {
  mkdirSync(`${root}/${GENERATED_DIR}`, { recursive: true })
  writeFileSync(`${root}/${MANIFEST_FILE}`, JSON.stringify(manifest, null, 2) + '\n')
  for (const lock of ['bun.lock', 'bun.lockb']) {
    if (!existsSync(`${root}/${lock}`)) continue
    copyFileSync(`${root}/${lock}`, `${root}/${GENERATED_DIR}/${lock}`)
    return lock
  }
  return null
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
