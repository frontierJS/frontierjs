// web/src/lib/titlebar.js — the desktop window's title bar in the theme's colors.
// The shell draws the bar (a GTK header bar, desktop/shell/src/main.rs
// with_titlebar); the page knows the theme, so it sends the bar the topbar's
// colors on load and on every switch. Sierra's theme lands as a class on
// <html>, and `system` follows the OS scheme. In a browser there is no shell
// and this does nothing.
//
// The kit's tokens can be any CSS color (oklch, color-mix) and the shell takes
// only #rrggbb, so each is painted once on a 1px canvas and read back.

const invoke = globalThis.__TAURI__?.core?.invoke

function hex(css) {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#000'
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

// A token read through a property that resolves it: a custom property computes to its text.
function token(names) {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = `${names.map((n) => `var(${n}`).join(', ')}, currentColor${')'.repeat(names.length)}`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return hex(color)
}

let sent = ''
function send() {
  // The same chain the kit's .topbar reads, so the window's bar continues the page's.
  const background = token(['--topbar-bg', '--surface'])
  const foreground = token(['--ink'])
  const rule = token(['--rule'])
  const key = background + foreground + rule
  if (key === sent) return
  sent = key
  invoke('set_titlebar', { background, foreground, rule }).catch((e) => console.warn('title bar:', e))
}

if (invoke) {
  requestAnimationFrame(send)
  new MutationObserver(() => requestAnimationFrame(send)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style'],
  })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => requestAnimationFrame(send))
}
