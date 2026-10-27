/*
 * themes.js — what a theme's stylesheet cannot say about it.
 *
 *   import { THEMES } from '@frontierjs/css/themes.js'
 *   THEMES['theme-dracula']   // { label: 'Dracula', blurb: '…', scheme: 'dark' }
 *
 * Keyed by the class, which is the name sierra's themes() returns, so a
 * picker looks a theme up without rewriting it. `scheme` is the theme's
 * `color-scheme`: a picker that groups light and dark, or a switch that
 * pairs them, reads it here rather than keeping its own set — a hand-kept set
 * calls every theme added after it light.
 *
 * The guide imports this, and meta.spec.js fails when a file in src/themes/
 * has no entry, an entry has no file, or `scheme` disagrees with the
 * computed `color-scheme` of the class.
 */
export const THEMES = {
  'theme-default':    { label: 'Default',    blurb: 'Blue on cool neutrals',            scheme: 'light' },
  'theme-dark':       { label: 'Dark',       blurb: 'Inverted neutrals',                scheme: 'dark'  },
  'theme-sunset':     { label: 'Sunset',     blurb: 'Warm oranges',                     scheme: 'light' },
  'theme-forest':     { label: 'Forest',     blurb: 'Green on cool neutrals',           scheme: 'light' },
  'theme-midnight':   { label: 'Midnight',   blurb: 'Purple, deep contrast',            scheme: 'light' },
  'theme-elite':      { label: 'Elite',      blurb: 'Navy and lime, sharp corners',     scheme: 'light' },
  'theme-basecamp':   { label: 'Basecamp',   blurb: 'Deep blue-black',                  scheme: 'dark'  },
  'theme-press':      { label: 'Press',      blurb: 'Newsprint serif',                  scheme: 'light' },
  'theme-notebook':   { label: 'Notebook',   blurb: 'Cream paper, sage ink',            scheme: 'light' },
  'theme-field':      { label: 'Field',      blurb: 'Ink ground, sand type',            scheme: 'dark'  },
  'theme-dracula':    { label: 'Dracula',    blurb: 'Violet and pink on dark',          scheme: 'dark'  },
  'theme-twilight':   { label: 'Twilight',   blurb: 'Sand on warm black',               scheme: 'dark'  },
  'theme-expedition': { label: 'Expedition', blurb: 'Sunset colors on black and white', scheme: 'dark'  },
  'theme-catppuccin': { label: 'Catppuccin', blurb: 'Pastels on blue-violet charcoal',  scheme: 'dark'  },
}
