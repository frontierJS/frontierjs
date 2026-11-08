// release-build.js — what a release is built FROM, for both doors of `fli deploy`.
//
// The SSH door (`deploy/_steps-docker/02-ship`) and the Basecamp door
// (`basecamp:deploy`) both ask here (`FJS-D1967`): a door that decided its own
// source, Dockerfile or web env would build a different release of the same
// commit. The commit as committed (`FJS-D1968`), the Dockerfile
// `chooseDockerfile` picks from THAT tree, and the web env both doors bake
// (`FJS-D1969`).

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { chooseDockerfile, needsGenerated, vendorApp, GENERATED_DIR } from './vendor.js'

export { chooseDockerfile, needsGenerated }

/** The shortest sha a build stamp may be: the SSH door's `--short`. */
const SHA = /^[0-9a-fA-F]{7,64}$/

/**
 * The release's source: HEAD of the app's directory, extracted into a scratch
 * directory the build reads instead of the working tree.
 *
 * `told` is `deploy.api.dockerfile`; `stored` is a Dockerfile text held on the
 * Basecamp App. The stored copy is written into `dir`, never the working tree,
 * so the person's next `git status` does not read it as their change.
 * `vendor` forces `deploy/generated/` even when the Dockerfile does not install
 * from it, for a caller that builds web/ from the generated manifest. `dry`
 * answers `vendors` without writing deploy/generated/ into the working tree,
 * and `image: false` is for a caller that builds no image: it chooses no
 * Dockerfile and vendors nothing.
 */
export function stageRelease({ appRoot, told, stored, vendor = false, dry = false, image = true, log }) {
  const root = realpathSync(appRoot)
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  let top, sha, short
  try {
    top   = realpathSync(git(root, 'rev-parse', '--show-toplevel'))
    sha   = git(root, 'rev-parse', 'HEAD')
    short = git(root, 'rev-parse', '--short', 'HEAD')
  } catch {
    throw new Error(`${root} is not inside a git repository with a commit — a release is a commit`)
  }
  const appRel = relative(top, root)

  // An edit not yet committed is not in what ships, and saying so is the
  // difference between a release that ignored it and one that seemed to.
  // Scoped by pathspec: a git question asked from a package directory answers
  // for the whole repository.
  const dirty = git(root, 'status', '--porcelain', '--', '.').split('\n').filter(Boolean)
  if (dirty.length) {
    log.warn(`${dirty.length} uncommitted change(s) under ${appRel || 'the app'} are not shipped — the release is ${short} as committed:`)
    for (const line of dirty.slice(0, 8)) log.warn(`  ${line}`)
    if (dirty.length > 8) log.warn(`  …and ${dirty.length - 8} more`)
  }

  const scratch = mkdtempSync(join(tmpdir(), 'fli-release-'))
  const dir = join(scratch, 'src')
  const cleanup = () => rmSync(scratch, { recursive: true, force: true })
  try {
    mkdirSync(dir)
    const archive = join(scratch, 'src.tar')
    execFileSync('git', ['archive', '--format=tar', '-o', archive, appRel ? `HEAD:${appRel}` : 'HEAD'], { cwd: top })
    execFileSync('tar', ['-xf', archive, '-C', dir])
    rmSync(archive, { force: true })

    // Judged against the committed tree, so an untracked local Dockerfile is
    // never the one chosen.
    const dockerfile = image ? (told ?? chooseDockerfile(dir, stored)) : null
    const present = Boolean(dockerfile) && existsSync(join(dir, dockerfile))
    const vendors = image && (vendor || (present && needsGenerated(readFileSync(join(dir, dockerfile), 'utf8'))))

    // deploy/generated/ is git-ignored and made here: the manifest the build
    // installs from, with every `link:`/`workspace:` dependency packed beside
    // it (FJS-241).
    if (vendors && !dry) {
      log.info('Vendoring dependencies...')
      vendorApp(root, log)
      cpSync(join(root, GENERATED_DIR), join(dir, GENERATED_DIR), { recursive: true })
    }
    return { sha, short, dirty, top, appRel, dir, dockerfile, present, vendors, cleanup }
  } catch (err) {
    cleanup()
    throw err
  }
}

/**
 * The env web/'s build is given: the build stamp the client compares against
 * what the server states (`FJS-D160`) and, where the API is its own origin,
 * the address the bundle calls, and the widget origin its embed snippet names.
 * All are interpolated into a command line, so
 * the commit is asserted to be a sha rather than trusted (Invariant 8's
 * reasoning applies to a shell as it does to SQL).
 */
export function webBuildEnv({ commit, apiOrigin = null, widgetsOrigin = null }) {
  if (!SHA.test(String(commit)))
    throw new Error(`refusing to build: the commit "${commit}" is not a sha`)
  return {
    VITE_FJS_BUILD: String(commit),
    ...(apiOrigin ? { FRONTIER_PUBLIC_API_URL: apiOrigin } : {}),
    ...(widgetsOrigin ? { FRONTIER_PUBLIC_WIDGETS_URL: widgetsOrigin } : {}),
  }
}

/**
 * The env widgets/'s build is given. A widget runs on a stranger's page, so it
 * cannot reach the API through its own origin: the API origin is always baked,
 * and a build with none would call whatever the bundle defaults to.
 */
export function widgetsBuildEnv({ commit, apiOrigin }) {
  if (!apiOrigin) throw new Error("refusing to build widgets/: no API origin to bake, and a widget on another site has no origin of its own to call")
  return webBuildEnv({ commit, apiOrigin })
}

// A hostname, and nothing a shell could read as syntax: the origin is baked
// into a build environment and may be echoed into a shell line.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i

/** `https://<hostname>`, or a refusal naming where the hostname came from. */
export function originOf(hostname, from) {
  const host = String(hostname ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase()
  if (!HOSTNAME.test(host)) throw new Error(`${from} is ${JSON.stringify(hostname)}, which is not a hostname`)
  return `https://${host}`
}

/** The hostname offered for widgets/ at a terminal; null where the web
 *  hostname is not known, since a guess writes DNS. */
export function suggestedWidgetsHostname(webHostname) {
  const host = String(webHostname ?? '').trim().toLowerCase()
  return HOSTNAME.test(host) ? `widgets.${host}` : null
}

/** `webBuildEnv` as a `K=v K=v` prefix for a shell line the target runs. */
export const envPrefix = (env) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')
