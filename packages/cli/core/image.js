// image.js — which bytes ran, and how far that answer travels.
//
// The first step of 2.3f (`IDEAS/deploy-plane.md`). The pipeline builds on the
// target and names the result `${appId}:${shortSha}` from the SHA of that
// server's own checkout, so **two servers at the same commit hold two images
// with the same name and different bytes**, the same server rebuilding after a
// dependency change produces a third, and nothing compares them. The failure
// shape is the worst available: stage and production reporting the same version
// while running different code.
//
// A tag is a NAME. What identifies bytes is a digest, and Docker offers two of
// them with very different reach — which is the whole substance of this module,
// because reporting the weaker one as though it were the stronger is how the
// problem comes back wearing a fix:
//
//   RepoDigests  the registry digest. Identifies these bytes ANYWHERE, because
//                it is the hash of the pushed manifest. Present only once an
//                image has been pushed or pulled.
//   Id           the image config hash. Identifies these bytes ON THIS HOST.
//                Present always, including for an image that never left.
//
// A build-on-target pipeline has no registry, so `Id` is what exists and the
// honest thing is to record it AND say what it covers. That is the same line
// `@frontierjs/outpost` draws about building on the target: an answer that is
// true while there is one machine and stops being true at the second.

/**
 * The identity of an inspected image.
 *
 * Takes what `docker image inspect` returns — the array, or one element of it —
 * so the decision is a pure function over data and can be tested without a
 * daemon. Answers `null` for anything it cannot read, because a plausible wrong
 * digest is worse than no digest: the whole point is that two things which look
 * alike are not.
 *
 * @returns {{ digest: string, ref: string, scope: 'registry'|'host' } | null}
 */
export function imageIdentity(inspected) {
  const first = Array.isArray(inspected) ? inspected[0] : inspected
  if (!first || typeof first !== 'object') return null

  // A registry digest wins wherever one exists: it is the only one that means
  // the same thing on a second machine.
  const repo = (Array.isArray(first.RepoDigests) ? first.RepoDigests : [])
    .find(r => typeof r === 'string' && r.includes('@'))
  if (repo) {
    const digest = repo.slice(repo.indexOf('@') + 1)
    if (digest) return { digest, ref: repo, scope: 'registry' }
  }

  const id = typeof first.Id === 'string' ? first.Id : null
  if (id) return { digest: id, ref: id, scope: 'host' }

  return null
}

/**
 * What to say about it, in one line, without overstating the reach.
 *
 * The scope is in the sentence rather than in a footnote because the reader is
 * an operator comparing two environments, and *this host only* is the entire
 * difference between a digest that settles that comparison and one that cannot.
 */
export function describeIdentity(identity) {
  if (!identity) return 'unknown — nothing could say which bytes this is'
  return identity.scope === 'registry'
    ? `${short(identity.digest)}  (registry digest — the same bytes anywhere)`
    : `${short(identity.digest)}  (image id — these bytes on this host; no registry to compare across)`
}

/** Enough to read and to grep for, in Docker's own convention. */
export function short(digest) {
  if (typeof digest !== 'string') return ''
  const bare = digest.startsWith('sha256:') ? digest.slice(7) : digest
  return `sha256:${bare.slice(0, 12)}`
}

/**
 * The one way to ADDRESS an image once its identity is known.
 *
 * A local image id is runnable as-is; a registry digest has to be named against
 * its repository (`repo@sha256:…`), which is what `ref` already holds. Falls
 * back to the tag, and a caller that fell back is running a NAME — which is the
 * thing this module exists to stop being invisible.
 */
export function addressOf(identity, tag) {
  if (!identity) return { address: tag, addressed: 'tag' }
  return { address: identity.ref, addressed: identity.scope }
}

/**
 * The rows of `docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}'`.
 *
 * Parsed here rather than at the call site because the last column contains
 * spaces, so splitting naively takes the date apart and leaves the id looking
 * fine. Two fixed fields then the rest.
 */
export function parseImageList(text) {
  return String(text ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [tag, id, ...rest] = line.split(/\s+/)
      return { tag, id, created: rest.join(' ') }
    })
    .filter(r => r.tag && r.id)
}

/**
 * Is rolling back from one of these to the other actually a change?
 *
 * Two tags can name ONE image — a rebuild that produced identical layers, or a
 * retag — so a rollback chosen by tag can restore the bytes it was trying to
 * leave. That is invisible when the list shows names, which is why the id is in
 * the list at all.
 */
export function movesBytes(from, to) {
  if (!from?.id || !to?.id) return true   // cannot tell; do not block the operator
  return from.id !== to.id
}
