/**
 * core/desktop-surface.js — what a `desktop/` surface IS.
 *
 * The one owner of the desktop surface's shape, called by `fli make:desktop`.
 * `example/desktop/` is this module's output and `tests/desktop-surface.test.js`
 * holds the two byte for byte, so `verify:desktop` — the only thing that builds
 * and runs a shell — proves what every generated app gets.
 *
 * ── Two shapes, one surface (FJS-D263) ────────────────────────────────────
 *
 * A native window around screens BUNDLED into the binary, never loaded from a
 * server. The screens are either this surface's own `src/` (a desktop-only app)
 * or another surface's, named by `wraps` — which builds that surface's `src/`
 * into `desktop/dist` while the config, the release and the output stay here.
 * Either way the output is this surface's: `vite build` empties its outDir, so
 * a wrapped build writing into `web/dist` deletes the SPA's.
 *
 * ── Why the API origin is a refusal and not a default ─────────────────────
 *
 * The page is served from `tauri://localhost` (`http://tauri.localhost` on
 * Windows and Android). A same-origin default — right for `web/` behind a proxy
 * — sends every call to the shell, which answers nothing and says nothing. So
 * `desktop.config.js` states `api` and `deploy/build.mjs` refuses a build that
 * does not; `null` is how an app with no API says so.
 *
 * ── The shell ──────────────────────────────────────────────────────────────
 *
 * `shell/` is a Tauri 2 crate, named for what it is rather than `src-tauri/`,
 * because `src/` on a surface means the screens. A debug build accepts a probe
 * script through `FJS_DESKTOP_PROBE` and registers the two commands it reports
 * through; a release build does neither. WebKitGTK and WKWebView speak no CDP,
 * so that probe is the only way a drive reaches into the page, and every
 * generated app has it for the day it writes one.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname }                     from 'node:path'

// ─── names ────────────────────────────────────────────────────────────────────

/**
 * Every name the shell needs, from the app's own.
 *
 * The identifier decides where the OS keeps the app's data — its localStorage,
 * so its session — and changing it after anyone has installed the app loses
 * that data without an error. `make:desktop` says so when it writes one.
 */
export function desktopNames(appName = 'app') {
  const slug = String(appName)
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app'
  return {
    slug,
    crate:       `${slug}-desktop`,
    productName: String(appName).replace(/^@[^/]+\//, ''),
    identifier:  `dev.${slug}.desktop`,
  }
}

/** Wrapped, the screens are another surface's and the directories are fewer. */
export function desktopSurfaceDirs({ wraps = null } = {}) {
  return [
    'config',
    ...(wraps ? [] : ['src/routes', 'src/components', 'public']),
    'test',
    'deploy',
    'shell/src',
    'shell/icons',
  ]
}

// ─── config ───────────────────────────────────────────────────────────────────

export function desktopConfig({ wraps = null, hasApi = true, apiPort = 8100 } = {}) {
  const api = hasApi
    ? `process.env.VITE_API_URL ?? 'http://localhost:${apiPort}'`
    : 'null'
  return `// desktop/config/desktop.config.js
//
// The desktop surface: a native window around a surface's screens, with those
// screens BUNDLED into the app rather than loaded from a server (FJS-D263).
//
// \`wraps\` names the surface whose src/ is built. Omitted, this surface builds
// its own src/, which is what a desktop-only app has. Either way the build
// writes desktop/dist and never the wrapped surface's dist/: \`vite build\`
// empties its outDir, so the two builds would delete each other.
//
// \`api\` is where the bundled page finds the API, and deploy/build.mjs refuses
// a build that does not say. The page is served from tauri://localhost, so a
// same-origin default would send every call to the shell. \`null\` is the answer
// for an app with no API. VITE_API_URL is the name every surface's build reads.
export default {
${wraps ? `  wraps: '${wraps}',\n` : ''}  api:${wraps ? '  ' : ''} ${api},
}
`
}

// ─── the screens, when this surface owns them ─────────────────────────────────

export function desktopSierraConfig({ slug = 'app', hasApi = true, devPort = 8800 } = {}) {
  const junction = hasApi
    ? `
  junction: {
    // deploy/build.mjs sets VITE_API_URL from desktop.config.js, so a built
    // shell always names the API: its own origin is tauri://localhost. Unset is
    // \`bun run dev:desktop\` in a browser, where Vite proxies /api. Guarded
    // twice because Vite also loads this file in Node.
    url:       import.meta.env?.VITE_API_URL ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost:${devPort}'),
    tokenKey:  '${slug}_token',
    // Must match the API's config.apiPrefix.
    apiPrefix: '/api',
  },
`
    : ''
  return `// desktop/config/sierra.config.js
// Paths are relative to the Vite root, desktop/.

export default {
  target:        'spa',
  routesDir:     'src/routes',
  trailingSlash: 'always',
${junction}}
`
}

export function desktopViteConfig({ hasApi = true, devPort = 8800, apiPort = 8100 } = {}) {
  const proxy = hasApi
    ? `
    // The browser half of the writing loop has no VITE_API_URL, so the page
    // calls its own origin and this sends it on. A built shell never uses it.
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws':  { target: API, ws: true },
    },`
    : ''
  const apiConst = hasApi
    ? `const API  = process.env.API_URL || 'http://localhost:' + (process.env.FLI_PORT_BE ?? ${apiPort})\n`
    : ''
  return `// desktop/config/vite.config.js
//
// \`bun run dev:desktop\` writes the screens in a browser. \`bun run build:desktop\`
// builds them with this file into desktop/dist and compiles that INTO the shell.

import { dirname, resolve } from 'node:path'
import { fileURLToPath }    from 'node:url'
import { defineConfig }     from 'vite'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import sierraConfig from './sierra.config.js'

// The Vite root is the surface root, one level up from config/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
${apiConst}
const base = createSierraViteConfig(sierraConfig)

export default defineConfig({
  ...base,
  root: ROOT,
  server: {
    ...base.server,
    // dev / desktopDev / this app's project id. See packages/cli/core/ports.js.
    port:       parseInt(process.env.DESKTOP_PORT ?? '${devPort}', 10),
    // Vite hops to the next free port without a word.
    strictPort: true,${proxy}
  },
})
`
}

export function desktopIndexHtml({ productName = 'app' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${productName}</title>
  </head>
  <body class="app theme-default">
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`
}

export function desktopMainEntry() {
  return `// desktop/src/main.js — the entry index.html loads.
//
// \`virtual:sierra\` boots the router and registers the schema, and it is
// imported FIRST: a route module that evaluates before the schemas are
// registered gets a bare make() with no field rules.
import 'virtual:sierra'
import '@frontierjs/css'

import { mount } from '@frontierjs/mesa/runtime'
import { RouterView } from '@frontierjs/sierra/router'

// mount()'s first argument is an anchor NODE, not an element id.
const root   = document.getElementById('app')
const anchor = document.createTextNode('')
root.appendChild(anchor)

mount(anchor, RouterView, { root })
`
}

export function desktopHomePage({ productName = 'app' } = {}) {
  return `---
title: ${productName}
---
<div class="container stack">
  <h1>${productName}</h1>
  <p class="text-muted">
    A desktop app. <code>bun run build:desktop</code> bundles these screens into
    the shell; a link here is routed in the page, never loaded from a server.
  </p>
</div>
`
}

// ─── the build ────────────────────────────────────────────────────────────────

export function desktopBuildScript() {
  return `// desktop/deploy/build.mjs — build the desktop app: its screens, then the shell.
//
//   bun run build:desktop              debug shell
//   bun run build:desktop -- --release
//   VITE_API_URL=https://api.example.com bun run build:desktop -- --release
//
// The one reader of desktop/config/desktop.config.js (FJS-D263). Two refusals,
// both for failures that otherwise build clean and ship broken:
//
//   • no \`api\`: the page is served from tauri://localhost, so a same-origin
//     default sends every API call to the shell. \`null\` says there is no API.
//   • a bundle that does not carry \`api\` after the build: the screens'
//     sierra.config.js is what inlines it, and one that stopped reading
//     VITE_API_URL builds a desktop app pointed at nothing.
//
// The screens are built into desktop/dist and never into a wrapped surface's
// own dist/, because \`vite build\` empties its outDir. The shell compiles dist
// INTO the binary, so building one half alone runs the previous other half.

import { spawnSync }                             from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve }                from 'node:path'
import { fileURLToPath }                         from 'node:url'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP     = resolve(DESKTOP, '..')
const SHELL   = join(DESKTOP, 'shell')
const release = process.argv.includes('--release')

const { default: config } = await import(join(DESKTOP, 'config', 'desktop.config.js'))

const screens    = config.wraps ? join(APP, config.wraps) : DESKTOP
const viteConfig = join(screens, 'config', 'vite.config.js')
if (!existsSync(viteConfig)) refuse(
  \`\${config.wraps ? \`wraps: '\${config.wraps}'\` : 'this surface'} has no config/vite.config.js at \${viteConfig}.\`)
if (config.api === undefined) refuse(
  'desktop.config.js names no api. The page is served from tauri://localhost, so a same-origin ' +
  'default would send every API call to the shell. Set api: null if this app has no API.')

// From the screens' own directory: a surface's vite config may leave its root
// to the working directory, which is what \`cd web && vite\` relies on.
const dist = join(DESKTOP, 'dist')
run('bun', ['--bun', 'vite', 'build', '-c', viteConfig, '--outDir', dist, '--emptyOutDir'], {
  cwd: screens,
  env: { ...process.env, ...(config.api ? { VITE_API_URL: config.api } : {}) },
})

if (config.api && !bundleNames(dist, config.api)) refuse(
  \`the build finished and no file under \${dist} contains \${config.api}. The screens' \` +
  'sierra.config.js has to read VITE_API_URL for junction.url.')

run('cargo', ['build', ...(release ? ['--release'] : []), '--manifest-path', join(SHELL, 'Cargo.toml')], {
  cwd: DESKTOP,
})

console.log(\`\\n  desktop shell: \${join(SHELL, 'target', release ? 'release' : 'debug', crateName())}\`)

// ─── helpers ──────────────────────────────────────────────────────────────

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) refuse(\`\${cmd} could not be started: \${r.error.message}\`)
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function bundleNames(dir, needle) {
  const assets = join(dir, 'assets')
  if (!existsSync(assets)) return false
  return readdirSync(assets)
    .filter(f => f.endsWith('.js'))
    .some(f => readFileSync(join(assets, f), 'utf8').includes(needle))
}

// The binary is named for the crate, so Cargo.toml is read rather than restated.
function crateName() {
  const line = readFileSync(join(SHELL, 'Cargo.toml'), 'utf8')
    .split('\\n')
    .find(l => l.startsWith('name'))
  return line?.split('"')[1] ?? 'desktop'
}

function refuse(message) {
  console.error(\`\\n  build:desktop refused — \${message}\\n\`)
  process.exit(1)
}
`
}

// ─── the shell ────────────────────────────────────────────────────────────────

export function desktopCargoToml({ crate = 'app-desktop' } = {}) {
  return `[package]
name    = "${crate}"
version = "0.0.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
`
}

export function desktopBuildRs() {
  return `fn main() {
    tauri_build::build()
}
`
}

export function desktopTauriConf({ productName = 'app', identifier = 'dev.app.desktop' } = {}) {
  // No devUrl: with one set, a debug build loads the dev server instead of the
  // bundle, and the page stops being the thing a release ships.
  return `${JSON.stringify({
    productName,
    version:    '0.0.0',
    identifier,
    build:      { frontendDist: '../dist' },
    app:        { windows: [], security: { csp: null } },
    bundle:     { active: false, icon: ['icons/icon.png'] },
  }, null, 2)}
`
}

export function desktopMainRs({ productName = 'app' } = {}) {
  return `// desktop/shell/src/main.rs — the native window around the bundled screens.
//
// The page is served from tauri://localhost (http://tauri.localhost on Windows
// and Android), so the API is always another origin: its URL is inlined by
// deploy/build.mjs and its CORS list has to name this origin (FJS-1090).
//
// frontendDist is compiled INTO the binary. Rebuilding the screens without
// rebuilding this crate runs the previous bundle.
//
// A debug build injects a probe when FJS_DESKTOP_PROBE names a script.
// WebKitGTK and WKWebView speak no CDP, so a drive cannot reach into the page
// the way a browser drive does; the probe runs inside it and reports through
// the two commands below. A release build neither reads the variable nor
// registers the commands, so a shipped app cannot be scripted from its
// environment.

use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(debug_assertions)]
#[tauri::command]
fn probe_report(line: String) {
    println!("[probe] {line}");
}

#[cfg(debug_assertions)]
#[tauri::command]
fn probe_done(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

fn probe_script() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let path = std::env::var("FJS_DESKTOP_PROBE").ok()?;
    match std::fs::read_to_string(&path) {
        Ok(script) => Some(script),
        Err(e) => panic!("FJS_DESKTOP_PROBE={path} could not be read: {e}"),
    }
}

fn main() {
    let probe = probe_script();

    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = if probe.is_some() {
        builder.invoke_handler(tauri::generate_handler![probe_report, probe_done])
    } else {
        builder
    };

    builder
        .setup(move |app| {
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(${JSON.stringify(productName)})
                .inner_size(1280.0, 900.0);
            if let Some(script) = &probe {
                window = window.initialization_script(script);
            }
            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the desktop shell failed to start");
}
`
}

export function desktopShellGitignore() {
  return `# cargo's output, and the schemas tauri-build writes on every build.
/target/
/gen/
`
}

/**
 * A placeholder icon. tauri-build reads `bundle.icon` at compile time and a
 * missing file fails the build, so the surface cannot be scaffolded without one.
 * Stored rather than compressed so the bytes do not depend on which zlib the
 * runtime carries — the example is compared to this byte for byte.
 */
export function desktopIcon() {
  const size = 32
  const row  = Buffer.alloc(1 + size * 4)
  for (let x = 0; x < size; x++) row.set([0x2b, 0x4c, 0x7e, 0xff], 1 + x * 4)
  const raw  = Buffer.concat(Array.from({ length: size }, () => row))

  // zlib: a header, one STORED deflate block (raw is under 65535 bytes), adler32.
  const len  = raw.length
  let a = 1, b = 0
  for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521 }
  const idat = Buffer.concat([
    Buffer.from([0x78, 0x01, 0x01, len & 0xff, len >> 8, ~len & 0xff, (~len >> 8) & 0xff]),
    raw,
    u32((b << 16) | a),
  ])

  const ihdr = Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ])
}

function u32(n) {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(n >>> 0)
  return out
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let c = ~0
  for (const byte of body) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return Buffer.concat([u32(data.length), body, u32(~c)])
}

// ─── writing it ───────────────────────────────────────────────────────────────

/**
 * Create the surface. Every file is written only when it is absent.
 *
 * @returns {{ written: string[], skipped: string[] }} paths relative to `root`
 */
export function scaffoldDesktopSurface({
  root, appName = 'app', wraps = null, hasApi = true,
  apiPort = 8100, devPort = 8800,
} = {}) {
  const dir   = 'desktop'
  const base  = resolve(root, dir)
  const names = desktopNames(appName)
  for (const d of desktopSurfaceDirs({ wraps })) mkdirSync(resolve(base, d), { recursive: true })

  const files = [
    ['config/desktop.config.js', desktopConfig({ wraps, hasApi, apiPort })],
    ...(wraps ? [] : [
      ['config/sierra.config.js', desktopSierraConfig({ slug: names.slug, hasApi, devPort })],
      ['config/vite.config.js',   desktopViteConfig({ hasApi, devPort, apiPort })],
      ['index.html',              desktopIndexHtml(names)],
      ['src/main.js',             desktopMainEntry()],
      ['src/routes/index.mesa',   desktopHomePage(names)],
    ]),
    ['deploy/build.mjs',          desktopBuildScript()],
    ['shell/.gitignore',          desktopShellGitignore()],
    ['shell/Cargo.toml',          desktopCargoToml(names)],
    ['shell/build.rs',            desktopBuildRs()],
    ['shell/tauri.conf.json',     desktopTauriConf(names)],
    ['shell/src/main.rs',         desktopMainRs(names)],
    ['shell/icons/icon.png',      desktopIcon()],
  ]

  const written = []
  const skipped = []
  for (const [rel, body] of files) {
    const abs = resolve(base, rel)
    if (existsSync(abs)) { skipped.push(`${dir}/${rel}`); continue }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
    written.push(`${dir}/${rel}`)
  }
  return { written, skipped }
}

/**
 * The scripts an app with this surface runs. A wrapped surface has no dev
 * server of its own — its screens are written with the wrapped surface's.
 */
export function desktopScripts({ wraps = null } = {}) {
  return {
    ...(wraps ? {} : { 'dev:desktop': 'cd desktop && bun --bun vite -c config/vite.config.js' }),
    'build:desktop': 'bun desktop/deploy/build.mjs',
  }
}
