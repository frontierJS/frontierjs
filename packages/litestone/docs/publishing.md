# Publishing

Notes on publishing `@frontierjs/litestone` to npm. The workspace-wide
procedure is `fli workspace:publish` (`ws:pub`, `packages/cli/commands/workspace/publish/`),
which bumps and publishes every changed package; `fli
npm:publish` is the one-package call. What follows is what is specific to this
package.

## Package scope

Published under the `@frontierjs` scope:

```bash
npm publish --access public
```

The unscoped name `litestone` is blocked by npm's similarity check. Use
`@frontierjs/litestone` in all references.

## Pre-publish checklist

- `bun run test` passes — the package's own runner; `bun test` over the tree
  runs bun's runner over files that are not tests, and reports failures that
  belong to nothing (`docs/TESTING.md`)
- `bun run test:browser` passes — the OPFS seam, in a real Chrome
- `version` bumped in `package.json`; `fli ws:exports` has committed the
  published surface to `exports.snapshot.md`, which the `snapshots` CI phase
  grades
- `litestone catalog --snapshot --check` and `--reference --check` are clean
- `npm publish --dry-run` to verify package contents against `files` in
  `package.json`

## Version strategy

Pre-1.0: `0.x.y` for breaking changes, `0.x.y+1` for features, `0.x.y+0.0.1` for patches.
Post-1.0: standard semver. Below 1.0 a caret in a consumer pins the MINOR, so a
publish silences every loose peer range that names this package.

## Testing the published package

```bash
# Pack locally
npm pack

# Install the tarball in a test project
cd /tmp/test-project
npm install /path/to/frontierjs-litestone-<version>.tgz
```
