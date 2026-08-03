// themeStore.js — plain JavaScript, no Mesa.
// Manages the active theme token set. Components watch specific paths with $:.
//
// Usage in a component:
//   import { theme } from '../stores/themeStore.js'
//   $: theme.mode
//   theme.setMode('dark')
//
// Mount <ThemeProvider /> once at app root to apply the class to <html>.

const STORAGE_KEY = 'mesa-ui-theme'

function getSystemPreference() {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function load() {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function save(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch {}
}

const stored = load()

export const theme = {
  // 'light' | 'dark' | 'system'
  preference: stored?.preference ?? 'system',

  // Resolved mode — what is actually applied right now
  get mode() {
    return this.preference === 'system' ? getSystemPreference() : this.preference
  },

  get isDark()  { return this.mode === 'dark'  },
  get isLight() { return this.mode === 'light' },

  setMode(preference) {
    this.preference = preference
    save({ preference })
    this._apply()
  },

  toggle() {
    this.setMode(this.isDark ? 'light' : 'dark')
  },

  _apply() {
    if (typeof document === 'undefined') return
    const html = document.documentElement
    if (this.isDark) {
      html.classList.add('dark')
    } else {
      html.classList.remove('dark')
    }
  },

  _init() {
    this._apply()
    // React to system preference changes when user chose 'system'
    if (typeof window !== 'undefined') {
      window.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', () => {
          if (this.preference === 'system') this._apply()
        })
    }
  },
}

// Apply immediately on module load (before first render)
theme._init()
