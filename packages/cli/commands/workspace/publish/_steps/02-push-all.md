---
title: 02-push-all
description: Tag the graded commit, then push it and its tags, before anything ships
---

<script>
import { execSync } from 'child_process'
</script>

```js
const { released, repo, interactive, prompts, graded } = $.config
if (!released?.length) return

const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

// Tagged HERE, after the green run and never before: a tag written ahead of the
// gate strands on the refused commit when fixes land (`FJS-D1720`). Each tag
// goes on the graded sha, not HEAD, so a commit that landed mid-run is not
// named by a tag it was never graded under.
for (const { cwd, sha, tags } of graded) {
  for (const tag of tags) {
    if (flag.dry) { log.dry(`  Would tag ${tag} at ${sha.slice(0, 12)}`); continue }
    if (git(cwd, `tag --list ${JSON.stringify(tag)}`) === tag) continue
    git(cwd, `tag ${JSON.stringify(tag)} ${sha}`)
    log.success(`  tagged ${tag} at ${sha.slice(0, 12)}`)
  }
}

// What goes out: the graded sha to the branch HEAD is on, and these tags by
// name. `git push origin HEAD --tags` would ship a commit nobody graded and
// every stale local tag with it. `--no-verify` is the point of the order: CI
// already passed on exactly this sha, so the hook's fast tier re-proves less.
const pushArgs = ({ cwd, sha, tags }) => {
  const branch = git(cwd, 'rev-parse --abbrev-ref HEAD')
  if (branch === 'HEAD') throw new Error(`${cwd} is on a detached HEAD -- there is no branch to push ${sha.slice(0, 12)} to`)
  return `push --no-verify origin ${sha}:refs/heads/${branch} ${tags.map(t => JSON.stringify(`refs/tags/${t}`)).join(' ')}`
}

if (flag.dry) {
  for (const g of graded) log.dry(`  Would run in ${g.cwd}: git ${pushArgs(g)}`)
  return
}

if (interactive && flag.push) {
  echo('')
  if (!await prompts.confirm('  Push the release commit and tags?', { default: true })) {
    prompts.close()
    log.info('  Not pushed, nothing published. The release commit and tags are local;')
    log.info('  `fli ws:pub` again pushes them and finishes this release')
    $.config.abort = true
    return
  }
}

// --no-push is handled HERE rather than as a `skip:` predicate so the run says
// what is left to do. Preflight refuses it beside `--to tarballs`, so what
// follows is npm alone.
if (!flag.push) {
  log.info('  --no-push: the release commit and tags stay local. Push with:')
  for (const g of graded) log.info(`    git -C ${g.cwd} ${pushArgs(g)}`)
  return
}

const failed = []
for (const g of graded) {
  const label = repo ? 'workspace' : g.tags[0]
  log.info(`  Pushing ${label}...`)
  try {
    execSync(`git ${pushArgs(g)}`, { cwd: g.cwd, stdio: 'inherit' })
    log.success(`  ✓ ${label}`)
  } catch (err) {
    failed.push(label)
    log.error(`  ✗ ${label} push failed: ${err.message}`)
  }
}

// A GitHub Release is made on a commit GitHub has, so nothing ships until the
// push goes through (`FJS-3616`).
if (failed.length) {
  log.error('  Nothing published. Fix the push and run `fli ws:pub` again: it finishes this release rather than bumping')
  throw new Error(`push failed: ${failed.join(', ')} — nothing published`)
}
```
