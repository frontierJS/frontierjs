// docker-context.js — can the build machine's docker READ the build context?
//
// The failure this exists for reads as a missing file that is plainly there:
//
//   #1 transferring dockerfile: 2B done
//   ERROR: failed to solve: failed to read dockerfile:
//          open Dockerfile: no such file or directory
//
// while `cat deploy/Dockerfile` on the same machine, in the same directory, in
// the same shell, prints it. Nothing the caller writes changes it — an absolute
// `-f` does not help and neither does naming the context absolutely — because
// the file is not what is missing. The DOCKER CLI cannot see it.
//
// ─── measured ────────────────────────────────────────────────────────────────
//
// Ubuntu, docker 29.6.1 installed from the `docker` snap, one tree copied to
// each path and built with `docker build -f deploy/Dockerfile .`:
//
//   ~/mxQ            ~/mxQ/b          ~/mxQ/b/c          ok
//   ~/.mxQ           ~/.mxQ/b         ~/.mxQ/b/c         FAIL
//   ~/vis/.deep/app                                      ok
//   /tmp/vis/app     /tmp/.hid/app                       FAIL
//   /var/tmp/vis/app                                     FAIL
//
// so it is neither *a dot-directory anywhere in the path* nor a docker rule. It
// is the snap's `home` interface, which grants `@{HOME}/[^.]*` — everything
// under the invoking user's home EXCEPT a hidden directory directly under it —
// and grants nothing outside home at all, `/tmp` and `/var/tmp` included, since
// a snap gets a private /tmp. A dot-directory FURTHER down is fine, because the
// rule is about the first component and not about dots.
//
// That is why this asks rather than pattern-matching `path`. The two readings
// disagree in both directions: a rule refusing a dot component would pass
// `/tmp/build` and `/srv/apps/x`, which also fail here, and would refuse
// `/srv/.apps/myapp` on the docker.com packages, where it builds. And the
// machine that decides is the BUILDER, which under a declared `deploy.builder`
// is not this laptop and whose docker packaging this tree cannot know.
//
// The probe is `docker build --check`, which resolves and parses the dockerfile
// and builds nothing. It is graded on the error TEXT rather than on its exit
// status: `--check` also exits non-zero for an ordinary lint warning, and a
// docker too old to carry the flag refuses it with a different sentence, which
// this reads as *cannot tell* rather than as a refusal.
//
// One cause has TWO sentences, depending on how far in the read got:
//
//   failed to read dockerfile: open Dockerfile: no such file or directory
//   resolve : lstat deploy: no such file or directory
//
// so what is graded is *docker says no such file* about a path the shell has
// just read in the same script. `--check` parses the Dockerfile and does not
// resolve a COPY source — measured, a `COPY nope.txt /` over a readable context
// answers *no warnings found* — so a missing build input cannot be mistaken for
// this.

// ─── the probe ───────────────────────────────────────────────────────────────
// Run on the builder, with the build context as the cwd. `sh`, not bash: the
// script travels on stdin to `sh -s` (core/machine.js), so a remote builder's
// login shell is not in the question.
export function contextProbe(dockerfile) {
  return [
    `printf 'fli:home=%s\\n' "$HOME"`,
    `printf 'fli:pwd=%s\\n' "$(pwd)"`,
    `printf 'fli:dockerbin=%s\\n' "$(command -v docker 2>/dev/null)"`,
    `printf 'fli:docker=%s\\n' "$(readlink -f "$(command -v docker 2>/dev/null)" 2>/dev/null)"`,
    `if [ -f ${dockerfile} ]; then printf 'fli:shellread=yes\\n'; else printf 'fli:shellread=no\\n'; fi`,
    `printf 'fli:check=<<\\n'`,
    `docker build --check -f ${dockerfile} . 2>&1 || true`,
  ].join('\n')
}

export function parseProbe(out) {
  const probe = { home: '', pwd: '', docker: '', dockerbin: '', shellread: '', check: '' }
  if (!out) return probe
  const lines = String(out).split('\n')
  let inCheck = false
  for (const line of lines) {
    if (inCheck) { probe.check += line + '\n'; continue }
    if (line === 'fli:check=<<') { inCheck = true; continue }
    const m = /^fli:(home|pwd|docker|dockerbin|shellread)=(.*)$/.exec(line)
    if (m) probe[m[1]] = m[2]
  }
  probe.check = probe.check.trim()
  return probe
}

// ─── which fact about this path put it out of reach ──────────────────────────
// Named separately from the refusal because the answer is what the operator has
// to act on, and because a path that is inside home and not hidden is a THIRD
// answer: something else denies it, and saying *move it out of a dot-directory*
// there would be advice that does not work.
export function pathReason(pwd, home) {
  if (!pwd || !home) return 'unknown'
  const rest = pwd === home ? '' : pwd.startsWith(home + '/') ? pwd.slice(home.length + 1) : null
  if (rest === null) return 'outside-home'
  const first = rest.split('/')[0] ?? ''
  return first.startsWith('.') ? 'hidden-under-home' : 'unknown'
}

const UNREADABLE = /no such file or directory/i

// A snap wrapper resolves to the `snap` binary rather than into /snap/bin, so
// both spellings are the same fact and reading either alone misses it.
function isSnap(probe) {
  const bin  = probe.dockerbin ?? ''
  const real = probe.docker ?? ''
  return bin.startsWith('/snap/') || real.startsWith('/snap/') || real === '/usr/bin/snap'
}

/**
 * null where the context reads, or where the probe cannot tell; otherwise the
 * operator's lines, most specific first.
 *
 * A dockerfile the SHELL cannot read is not this: the file is genuinely absent
 * and 02b-build-check already says so in its own words.
 */
export function contextRefusal(probe, { host, dockerfile, contextPath }) {
  if (!probe || probe.shellread !== 'yes')  return null
  if (!UNREADABLE.test(probe.check ?? ''))  return null

  const where  = contextPath ?? probe.pwd
  const snap   = isSnap(probe)
  const reason = pathReason(probe.pwd, probe.home)
  const lines  = [
    ['error', `docker on ${host} cannot read the build context at ${where}`],
    ['info',  `  ${dockerfile} is there — the shell reads it — and docker answers "no such file or directory".`],
  ]

  if (snap) {
    lines.push(['info', `  docker is the SNAP (${probe.dockerbin || probe.docker}), which is confined to ${probe.home} and cannot see`])
    lines.push(['info', `  a hidden directory directly under it, nor anything outside it — /tmp and /var/tmp included.`])
  } else {
    lines.push(['info', `  docker is ${probe.docker || 'not on PATH as a resolvable file'}; something is confining its reads.`])
  }

  if (reason === 'outside-home')
    lines.push(['info', `  fix: put deploy.path under ${probe.home || "the build user's home"}, or install docker from docker.com.`])
  else if (reason === 'hidden-under-home')
    lines.push(['info', `  fix: rename the "${(probe.pwd.slice((probe.home + '/').length).split('/')[0])}" directory so it does not start with a dot, or install docker from docker.com.`])
  else
    lines.push(['info', `  fix: check what confines docker's reads on that machine (snap, AppArmor, SELinux, a rootless daemon).`])

  return lines
}
