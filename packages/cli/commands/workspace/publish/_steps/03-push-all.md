---
title: 03-push-all
description: Push the release commit and tags
skip: "flag.dry"
---

<script>
import { execSync } from 'child_process'
</script>

```js
const { released, repo, startTime } = context.config
if (!released?.length) return

// --no-push is handled HERE rather than as a `skip:` predicate so the run still
// reports what it did, and says what is left to do. A skipped step prints one
// line about itself and nothing about the release.
if (flag['no-push']) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  log.success(`Published ${released.length} package(s) in ${elapsed}s`)
  log.info('  --no-push: the release commit and tags are local. Push with:')
  log.info(`    git -C ${repo ?? released[0].dir} push origin HEAD --tags`)
  return
}

// One repo means one push. The old per-package loop pushed the same branch
// once per member, so a sixteen-package release was fifteen no-ops.
const targets = repo
  ? [{ label: 'workspace', dir: repo }]
  : released.map(({ name, dir }) => ({ label: name, dir }))

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
    log.warn(`  ✗ ${label} push failed: ${err.message}`)
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
log.success(`Published ${released.length} package(s) in ${elapsed}s`)
```
