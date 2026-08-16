# create-frontier

```bash
npm create frontier@latest my-app
bun create frontier my-app
```

Scaffolds a FrontierJS application — schema, API, UI, deploy config, and a check
that runs in CI — then installs it. Every flag `fli new` takes works here:

```bash
npm create frontier@latest my-app -- --no-auth --template api-only
npm create frontier@latest --  --here
```

## What it is

An entry point, and deliberately nothing else. The scaffold lives in
`@frontierjs/cli`, which this package depends on and runs; a second copy here is
how the two would come to disagree about the framework's own defaults.

Three things it adds, all of them about being invoked through `npm create`
rather than about scaffolding:

- **Where "here" is.** `fli` finds a project root by walking up from the working
  directory, which is right for every other command and wrong for this one — run
  inside an existing repository, it would write into that repository's root. This
  pins the working directory.
- **A prompt for the name**, because `npm create frontier@latest` with no
  arguments is what people actually type.
- **A check for Bun before anything is written.** Junction is Bun-only —
  `Bun.serve` is its transport and `bun:sqlite` is its cache and database — so
  finding out after a successful scaffold and an install is the worst moment to
  find out.

## What you get

```
my-app/
├── db/schema.lite          the seed — everything else derives from it
├── api/                    Junction services, hooks, plugin wiring
├── web/                    Sierra routes and Mesa resources
├── deploy/                 Dockerfile + frontier.config.js
├── tsconfig.json           one line of extends over @frontierjs/config
├── biome.json              ditto — linter only, no formatter
├── .editorconfig
└── .github/workflows/ci.yml
```

```bash
cd my-app
bun run dev      # api on 8100, web on 8000
bun run check    # fli check, then lint, then typecheck — what CI runs
```

`fli check` leads that gate because it is the half a linter cannot reach: Biome
reads neither `.mesa` nor `.lite`. See
[`@frontierjs/config`](https://www.npmjs.com/package/@frontierjs/config) for the
tooling opinion and the reasoning behind it, including why there is no formatter.

## Requirements

- **Bun** — `curl -fsSL https://bun.sh/install | bash`
- Node 20.6+ to run this installer itself (`npm create` supplies it)
