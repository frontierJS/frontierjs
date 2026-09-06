---
title: 07-release
description: A release the control plane drove, and the bytes it can name
---

## The other half — a release

The command in step 6 proved the machine takes orders. A **release** is the
thing a control plane exists for, and it is a longer sentence: build these
sources into an image on that machine, start it, and record which bytes ran.

The app gets a source — a git repository, which for this lesson is one made
here on disk:

```console
git init  →  a Dockerfile  →  one commit on main
```

Then a deployment is created against it, and nothing else is typed. Basecamp
writes a `Deployment` row and a `DeploymentStep` per stage, dispatches
`deployment:run` to its own queue, and the job talks to the same Outpost the
last step used — `POST /deploy` with `source.kind: 'git'`, which clones,
`docker build`s and starts a container.

**The assertion that matters is the digest.** A tag is not an identity: two
machines at the same commit hold two images called the same thing with different
bytes in them, and nothing compares them. So what is checked is that
`Deployment.builtImage` carries a digest the MACHINE reported, that a container
is really running here under the name the app was given, and that the two agree.
A release that cannot say which bytes are serving has not been proven to have
released anything.

**No stub.** `BASECAMP_STUB_OUTPOST` would answer this whole protocol and issue
no command — `digest: null` and `healthy: true` — which is the vacuous pass that
`providers/executor.ts` exists to make impossible. This lesson never sets it.

```js
if (!await narrate(context)) return

context.config.__step = 7

if (!needs(context, ['appId', 'dbFile', 'token', 'workspaceId', 'basecamp', 'outpost'], {
  from: {
    appId: '06-command', dbFile: '02-basecamp',
    token: '03-setup', workspaceId: '03-setup',
    basecamp: '01-machine', outpost: '01-machine',
  },
})) return

if (!await must(context, await ensureFleet(context, { outpost: true }), {
  likely: 'the control plane or the machine is not answering — run this lesson from the start',
})) return

// A release BUILDS, so this half needs a daemon. Without one the lesson stops
// rather than fails: everything before this ran, and *no docker here* is a fact
// about the machine and not about the framework — the same answer step 1 gives
// somebody who installed from npm and has no basecamp.
if (!probe.commandExists({ bin: 'docker' }).ok) {
  log.warn('no docker on this machine — the release half needs one')
  log.info('')
  log.info('  Everything above happened: a machine reported in, and a command from the')
  log.info('  control plane really ran on it. A RELEASE builds an image here, which is')
  log.info('  the one thing this machine cannot be asked to do.')
  log.info('')
  context.config.stop = true
  return
}

const as = {
  'content-type':   'application/json',
  authorization:    `Bearer ${context.config.token}`,
  'x-workspace-id': context.config.workspaceId,
}
const appId = context.config.appId

// ─── something to release ─────────────────────────────────────────────────
//
// A real repository on disk, because `POST /deploy` hands `source.repo` to
// `git clone` and a path is a legal git URL. Nothing is fetched from a network.
const repo = join(context.config.ws.dir, 'hello-app')
mkdirSync(repo, { recursive: true })

writeFileSync(join(repo, 'Dockerfile'), [
  '# The smallest thing that can be built and then be seen running.',
  'FROM busybox:1.36',
  'RUN mkdir -p /www && echo "released by basecamp" > /www/index.html',
  'EXPOSE 80',
  'CMD ["httpd", "-f", "-p", "80", "-h", "/www"]',
  '',
].join('\n'), 'utf8')

// `--depth 1 --branch main` is what the machine clones with, so the branch has
// to be named and the commit has to exist.
for (const argv of [
  ['init', '--initial-branch', 'main'],
  ['add', '.'],
  ['-c', 'user.email=tutor@frontier.invalid', '-c', 'user.name=Tutor', 'commit', '-m', 'the app'],
]) {
  const r = probe.runArgv('git', argv, { cwd: repo })
  if (r.code !== 0 && !/nothing to commit/.test(`${r.stdout}${r.stderr}`)) {
    await must(context, {
      ok: false, name: `git ${argv[0]}`, asked: 'a repository with one commit on main',
      got: (r.stderr || r.stdout || `exit ${r.code}`).slice(0, 300),
    }, { likely: 'git could not write here — the workspace may be read-only' })
    return
  }
}

// The app is told where its source is. `patch`, because everything else about
// the row is already right and a release reads the row as it stands.
if (!await must(context, await probe.httpJson({
  url:     hubUrl(context, `/apps/${appId}`),
  method:  'PATCH',
  headers: as,
  body:    JSON.stringify({
    source: { kind: 'git', repo, branch: 'main' },
    config: { port: 0 },
    port:   0,
  }),
  expect:   (j) => Boolean(j.id),
  describe: 'the app now knows what to build',
  name:     `the app is given a source`,
}), {
  likely: 'the patch was refused — a source is a developer-and-above write',
})) return

// ─── the release ──────────────────────────────────────────────────────────
const release = await probe.httpJson({
  url:      hubUrl(context, '/deployments'),
  method:   'POST',
  headers:  as,
  body:     JSON.stringify({ appId, trigger: 'manual' }),
  expect:   (j) => Boolean(j.id),
  describe: 'a Deployment row, and a job on the queue',
  name:     'a release is created',
})
if (!await must(context, release, {
  likely:    'the create refused, which it does when the app has no placement or the machine has no outpost — the reason is in the body above',
  reproduce: `curl -s -X POST ${hubUrl(context, '/deployments')}`,
})) return

const deploymentId = release.json.id

// Durable work again: the call answered when the row was written, so the
// verdict is polled. A build is minutes on a cold daemon.
const finished = await probe.httpJson({
  url:      hubUrl(context, `/deployments/${deploymentId}`),
  headers:  as,
  expect:   (j) => j.status === 'success' || j.status === 'failed',
  describe: 'a release that reached a verdict',
  retries:  120,
  everyMs:  2_000,
  name:     'the release ran to a verdict',
})
if (!await must(context, finished, {
  likely:    'the pipeline is still running or the job never started — the outpost log is below',
  detail:    serverLog(context.config.__servers?.outpost ?? { logPath: '' }, 20),
  reproduce: `curl -s ${hubUrl(context, `/deployments/${deploymentId}`)}`,
})) return

// A build context the DAEMON cannot see is an environment fact, not a release
// that failed. A private /tmp — this shell has one, and so do most CI runners —
// is invisible to a daemon running outside the namespace, so `docker build`
// answers *unable to prepare context* about a directory that is plainly there.
// `scripts/scaffold-build.mjs` names the same class for `fli deploy`.
const machineLog = serverLog(context.config.__servers?.outpost ?? { logPath: '' }, 20)

if (finished.json.status === 'failed' && /unable to prepare context/.test(machineLog)) {
  log.warn('this workspace is somewhere the docker daemon cannot read')
  log.info('')
  log.info('  The machine cloned the app and the daemon could not open the directory to build it.')
  log.info('  A private /tmp does this — the path exists for you and not for the daemon.')
  log.info('')
  log.info(`  fli tutor:fleet --workspace ~/frontier-tutorial   builds somewhere both can see`)
  log.info('')
  // A deliberate exit that SUCCEEDED (FJS-589): everything this lesson is about
  // has already been proven, and the machine refused for a reason that is the
  // machine's.
  context.config.stop = true
  return
}

if (!await must(context, {
  ok:    finished.json.status === 'success',
  name:  'and it succeeded',
  asked: 'status success',
  got:   `status ${finished.json.status}`,
}, {
  likely: 'a step failed — every step carries its own log line, and the outpost output is below',
  detail: machineLog,
})) return

// ─── which bytes ──────────────────────────────────────────────────────────
//
// Read out of the control plane's own row rather than off the response: a
// digest is what the MACHINE reported, and `null` there is the shape a stub
// answers with. This is the line that separates a release from a job that
// returned 200.
let digest = null
if (!await must(context, probe.sqliteRow({
  db:     context.config.dbFile,
  sql:    'select status, builtImage from deployment where id = ?',
  params: [deploymentId],
  expect: (rows) => {
    digest = rows[0]?.builtImage ?? null
    return typeof digest === 'string' && /^sha256:[0-9a-f]{12,}/.test(digest)
  },
  name:   'the control plane recorded which bytes ran',
}), {
  likely: 'the executor answered without building — a stub reports digest: null, which is why this asks',
})) return

// And the machine agrees. `fjs-<appId>` is the name outpost gives a container,
// deliberately stable so a machine cannot accumulate app-1, app-2.
const container = `fjs-${appId}`

if (!await must(context, probe.dockerRunning({
  container,
  name: 'a container of that image is running here',
}), {
  likely:    'the deploy reported success and started nothing — the outpost log is below',
  detail:    serverLog(context.config.__servers?.outpost ?? { logPath: '' }, 20),
  reproduce: `docker ps --filter name=${container}`,
})) return

// The pair. A digest in a row and a container on a machine are two facts, and
// only their AGREEMENT says the row describes what is serving.
const running = probe.dockerImageOf({ container })
if (!await must(context, {
  ok:    String(running.got ?? '').startsWith(digest.slice(0, 20)),
  name:  'and it is the same image the row names',
  asked: `the container to be running ${digest.slice(0, 20)}…`,
  got:   String(running.got ?? 'nothing').slice(0, 30),
}, {
  likely: 'the row and the machine disagree — a rebuild between the two would do this',
})) return

log.info('')
log.info(`  ${digest.slice(0, 23)}…   built on this machine, recorded by the control plane`)
log.info(`  ${container}   still running — the finish step takes it down`)
log.info('')

remember(context, '07-release', { deploymentId, container })
```
