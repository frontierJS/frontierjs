// src/domain/release/dockerfile-template.ts
// The two seeds an App's own Dockerfile starts from (FJS-D1555): the
// repository's file, read off a public forge, or the FrontierJS template.
//
// The template is for an app whose dependencies are `link:@frontierjs/*`. Such
// an app builds where the workspace is (FJS-D942), so the image clones the
// framework, `bun link`s every package, and only then installs the app — the
// way `fli deploy:vendor` is avoided on a machine that has no workspace. The
// rest of it is the shape `fli make:deploy` writes
// (`packages/cli/commands/make/deploy.md`): the API on 3000, `/db` as the
// volume, migrate then start.
//
// `readRepoDockerfile` reads ONE public file with no credential. A vendor API
// with a key would be a conduit connector; this is a GET a browser could make,
// kept out of the service file so a service never holds a fetch().

import { DOCKERFILE_BYTES, byteLength } from './app-source.ts'

/** Where the template clones the framework from. */
export const FRAMEWORK_REPO = 'https://github.com/frontierjs/frontierjs'

/** The two files a repository's Dockerfile is looked for at, in this order —
 *  `deploy/Dockerfile` is where `fli make:deploy` writes one. */
export const DOCKERFILE_PATHS = ['deploy/Dockerfile', 'Dockerfile']

const READ_TIMEOUT_MS = 5_000

// A ref lands in a RUN line, so anything a shell would read twice is refused.
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

/** The FrontierJS Dockerfile, cloning the framework at `ref`. */
export function fjsDockerfileTemplate({ ref = 'dev' }: { ref?: string } = {}): string {
  if (!REF.test(ref) || ref.includes('..')) throw new Error(`'${ref}' is not a branch or tag name`)
  return `# FrontierJS app, built on the machine from its repository.
# The app depends on the framework by link:, so the framework is cloned and
# every package linked before the app installs. Edit this copy in Basecamp;
# a release builds with the file it shipped.

FROM oven/bun:${Bun.version}

# git for the clone; the base image has none.
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git ca-certificates \\
 && rm -rf /var/lib/apt/lists/*

# The framework at ${ref}. bun link registers each package under its own name,
# which is what a link: dependency resolves against.
WORKDIR /frontierjs
RUN git clone --depth 1 --branch ${ref} ${FRAMEWORK_REPO} . \\
 && bun install \\
 && for p in packages/*/; do (cd "$p" && bun link); done

# The app. Its own install comes after the links, or link: resolves to nothing.
WORKDIR /app
COPY . .
RUN bun install

# Mount point for the live database: the release runs with a volume on /db,
# and DATABASE_URL and AUDIT_PATH point inside it. A database left on its
# default path is inside the container and lost at the next swap.
RUN mkdir -p /db && chown bun:bun /db
USER bun

ENV NODE_ENV=production
ENV FRONTIER_PORT_BE=3000
EXPOSE 3000

# Migrate, then serve. A failed migration exits non-zero, the health check
# fails and the release restores the previous container.
CMD ["sh", "-c", "bun run db:migrate && bun api/index.ts"]
`
}

// ─── The repository's own file ───────────────────────────────────────────

// A segment of an owner or repository name; anything else in a URL path is
// a second path.
const NAME = '[A-Za-z0-9][A-Za-z0-9._-]*'
const GITHUB    = new RegExp(`^(?:https?://|ssh://git@|git@)?github\\.com[/:](${NAME})/(${NAME}?)(?:\\.git)?/?$`)
const BITBUCKET = new RegExp(`^(?:https?://(?:[^@/]+@)?|ssh://git@|git@)?bitbucket\\.org[/:](${NAME})/(${NAME}?)(?:\\.git)?/?$`)

function stripGit(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -4) : name
}

/** The forge a remote is on and the repository it names there, or null for a
 *  remote on neither. The one reading of a remote's owner and name: the raw
 *  read below and a connect's writes address the same repository. */
export function forgeRepo(remote: string): { forge: 'github' | 'bitbucket'; owner: string; name: string } | null {
  const r  = remote.trim()
  const gh = GITHUB.exec(r)
  if (gh) return { forge: 'github', owner: gh[1], name: stripGit(gh[2]) }
  const bb = BITBUCKET.exec(r)
  if (bb) return { forge: 'bitbucket', owner: bb[1], name: stripGit(bb[2]) }
  return null
}

/** The raw URLs a remote's Dockerfile is read at, in order, or `[]` for a
 *  remote that is not a public forge this reads. No branch is the default
 *  branch, which both forges answer for `HEAD`. */
export function rawDockerfileUrls(repo: string, branch?: string | null): string[] {
  const ref = branch && REF.test(branch) && !branch.includes('..') ? branch : 'HEAD'
  const encRef = ref.split('/').map(encodeURIComponent).join('/')
  const at = forgeRepo(repo)
  if (at?.forge === 'github')
    return DOCKERFILE_PATHS.map(p => `https://raw.githubusercontent.com/${at.owner}/${at.name}/${encRef}/${p}`)
  if (at?.forge === 'bitbucket')
    return DOCKERFILE_PATHS.map(p => `https://bitbucket.org/${at.owner}/${at.name}/raw/${encRef}/${p}`)
  return []
}

/**
 * The repository's Dockerfile, `deploy/Dockerfile` before `Dockerfile`, or
 * null when neither is readable. A private repository is null too: the forge
 * answers it as missing or as a sign-in page, the same as a public one with no
 * file, so a null seeds blank — the machine builds the repository's own — and
 * never the template (`FJS-D1570`).
 */
export async function readRepoDockerfile(
  { repo, branch }: { repo: string; branch?: string | null },
  { fetch: get = globalThis.fetch }: { fetch?: typeof globalThis.fetch } = {},
): Promise<{ path: string; content: string } | null> {
  const urls = rawDockerfileUrls(repo, branch)
  for (const [i, url] of urls.entries()) {
    let res: Response
    try {
      res = await get(url, { redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
    } catch {
      continue
    }
    if (res.status !== 200) continue
    const content = await res.text()
    // A sign-in page answered 200 is not a Dockerfile.
    if (!content.trim() || /^\s*</.test(content)) continue
    if (byteLength(content) > DOCKERFILE_BYTES) continue
    return { path: DOCKERFILE_PATHS[i], content }
  }
  return null
}
