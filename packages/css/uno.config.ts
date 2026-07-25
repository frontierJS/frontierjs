import { defineConfig, presetUno, transformerDirectives } from 'unocss'

export default defineConfig({
  presets: [presetUno()],
  transformers: [transformerDirectives()],

  shortcuts: [
    // ─── Inline base ──────────────────────────────────────────────
    ['chip', 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-center'],

    // ─── Extends chip ─────────────────────────────────────────────
    ['pill',  'chip rounded-full px-2 py-0.5 text-xs'],
    ['badge', 'chip rounded px-2 py-0.5 text-xs'],
    ['btn',   'chip rounded px-3.5 py-1.5 text-sm cursor-pointer transition hover:brightness-105'],

    // ─── Block base ───────────────────────────────────────────────
    ['surface', 'block rounded-lg'],

    // ─── Extends surface (visual treatment lives in surface.css) ──
    ['card',    'surface p-5'],
    ['alert',   'surface flex items-start gap-3 px-4 py-3'],
    ['toast',   'surface fixed bottom-4 right-4 px-4 py-3 shadow-lg'],
    ['dialog',  'surface p-0'],
    ['popover', 'surface absolute px-3 py-2 text-sm shadow-md'],
    ['drawer',  'surface fixed top-0 bottom-0 right-0 w-80 h-screen p-0'],

    // ─── Standalone block primitives ──────────────────────────────
    ['field', 'block w-full px-3 py-2 text-sm rounded-md transition'],
    ['table', 'w-full border-collapse'],

    // ─── Layout helpers ───────────────────────────────────────────
    ['stack',   'flex flex-col gap-4'],
    ['cluster', 'flex flex-wrap items-center gap-2'],
    ['center',  'grid place-items-center'],
    ['split',   'flex justify-between items-center gap-4'],
  ],

  // ─── Tonal mixing — lighten/darken via color-mix ──────────────
  rules: [
    [/^lighten$/, () => ({
      '--bg':    'color-mix(in srgb, var(--bg-mix) 25%, white)',
      '--color': 'color-mix(in srgb, var(--color) 10%, var(--bg-mix))',
    })],

    [/^lighten-(.+)$/, ([, pct]) => {
      const v = 100 - pct
      return {
        '--bg':    `color-mix(in srgb, var(--bg-mix) ${pct}%, white)`,
        '--color': `color-mix(in srgb, var(--bg-mix) ${v}%, var(--bg))`,
      }
    }],

    [/^darken$/, () => ({
      '--bg':    'color-mix(in srgb, var(--bg-mix) 50%, black)',
      '--color': 'color-mix(in srgb, var(--bg-mix) 50%, white)',
    })],

    [/^darken-(.+)$/, ([, pct]) => {
      const v = 100 - pct
      return {
        '--bg':    `color-mix(in srgb, var(--bg-mix) ${pct}%, black)`,
        '--color': `color-mix(in srgb, var(--bg-mix) ${v}%, white)`,
      }
    }],
  ],
})
