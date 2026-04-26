# Publishing

Notes on publishing `@frontierjs/litestone` to npm.

## Package scope

Published under the `@frontierjs` scope:

```bash
npm publish --access public
```

The unscoped name `litestone` is blocked by npm's similarity check (support ticket filed). Use `@frontierjs/litestone` in all references.

## Install from private GitHub

Before the package is published, install directly from GitHub:

```json
{
  "dependencies": {
    "@frontierjs/litestone": "git+ssh://git@github.com:frontierjs/litestone.git"
  }
}
```

## Platform-specific optional packages

Litestone uses an esbuild pattern for platform-specific binaries (if applicable). The main package has `optionalDependencies` for each platform target, and the install script picks the right one.

## Pre-publish checklist

- [ ] All tests passing: `bun test test/litestone.test.ts`
- [ ] No `$rotateKey` test failures (3 known failures — fix before publish)
- [ ] `version` bumped in `package.json`
- [ ] `PUBLISHING.md` in repo root updated
- [ ] TypeScript declarations current: `bunx litestone types`
- [ ] README accurate (run the doc update checklist)
- [ ] `npm publish --dry-run` to verify package contents

## Version strategy

Pre-1.0: `0.x.y` for breaking changes, `0.x.y+1` for features, `0.x.y+0.0.1` for patches.
Post-1.0: standard semver.

## Testing the published package

```bash
# Pack locally
npm pack

# Install the tarball in a test project
cd /tmp/test-project
npm install /path/to/frontierjs-litestone-1.0.0.tgz
```
