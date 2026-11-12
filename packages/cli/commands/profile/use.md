---
title: profile:use
description: Refuses — there is no current profile to switch; a project names its own with FLI_PROFILE in its .env
examples:
  - fli profile:use acme
args:
  -
    name: name
    description: Whatever was typed — every form is refused
    required: false
---

This command exists to say no where a person would type it. A selector
remembered on the machine would make the same directory spend whichever client
was picked last, and a deploy with the wrong client's token destroys real work,
so the project's own `.env` names its profile and nothing else does
(`FJS-D1943`).

```js
const here = global.fliProfile?.name
log.error('fli has no current profile to switch — a project names its own with FLI_PROFILE=<name> in its .env')
echo`  {dim this directory spends}  ${here ? chalk.bold(here) : 'no profile'}`
echo`  {dim for one command}         FLI_PROFILE=<name> fli …`
echo`  {dim every profile}           fli profiles`
process.exitCode = 1
```
