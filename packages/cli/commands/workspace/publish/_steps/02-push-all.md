---
title: 02-push-all
description: Push the release commit and tags, before anything ships
skip: "flag.dry"
---

<script>
import { execSync } from 'child_process'
</script>

```js
const { released, repo, interactive, prompts } = $.config
if (!released?.length) return

// Pushed BEFORE step 03 because a GitHub Release can only be made on a commit
// GitHub has: `gh release create --target <local sha>` answers 422
// `target_commitish is invalid` for every package (FJS-3616). A version pushed
// and then not published is the in-flight case the next run already finishes.
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
  log.info(`    git -C ${repo ?? released[0].dir} push origin HEAD --tags`)
  return
}

// One repo means one push. The old per-package loop pushed the same branch
// once per member, so a sixteen-package release was fifteen no-ops.
const targets = repo
  ? [{ label: 'workspace', dir: repo }]
  : released.map(({ name, dir }) => ({ label: name, dir }))

const failed = []
for (const { label, dir } of targets) {
  log.info(`  Pushing ${label}...`)
  try {
    // Branch and tags in ONE invocation. `git push` then `git push --tags` runs
    // the repo's pre-push hook twice, and in this workspace that hook is the
    // fast CI tier — 49s of typecheck, paid twice per release for one push's
    // worth of work. `--follow-tags` is not the answer: it carries annotated
    // tags only, and the release tags above are lightweight.
    execSync('git push origin HEAD --tags', { cwd: dir, stdio: 'inherit' })
    log.success(`  ✓ ${label}`)
  } catch (err) {
    failed.push(label)
    log.error(`  ✗ ${label} push failed: ${err.message}`)
  }
}

// A refused push is most often the pre-push hook failing CI, which is a reason
// not to publish, so nothing ships until it goes through.
if (failed.length) {
  log.error('  Nothing published. Fix the push and run `fli ws:pub` again: it finishes this release rather than bumping')
  throw new Error(`push failed: ${failed.join(', ')} — nothing published`)
}
```
