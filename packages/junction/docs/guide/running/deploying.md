# Deploying

Deploy is `fli deploy`, from the Dockerfile `fli make:deploy` writes. Junction has no build step of its own: the image runs the app with `bun`.

```bash
fli make:deploy     # writes the Dockerfile
fli deploy          # builds the image and ships it
```

## What else it can do

- A container host such as CapRover, Fly, Railway or Cloudflare's container product works like any Docker target
- An app that bundles itself with `bun build` registers its services statically and states no `root`, because directory autoload scans source files beside the entry point
- A missing services directory boots clean with `"services":0`, and the boot banner names the directories that were looked at
- Junction needs Bun for `Bun.serve` and `bun:sqlite`, so it does not run on Cloudflare Workers

**In depth:** [README § Deploying](../../../README.md#deploying)
