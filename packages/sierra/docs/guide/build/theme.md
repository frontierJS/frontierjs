# The theme

`theme` is a plain object holding the resolved theme class and the person's choice, and `setTheme` and `toggleTheme` change it. With `theme` configured, the saved choice is applied before first paint, so a reload does not flash.

```js
import { theme, setTheme } from '@frontierjs/sierra'

setTheme('theme-dark')

if (theme.value !== 'theme-dark') throw new Error(`expected theme-dark, got ${theme.value}`)
```

## What else it can do

- `theme.value` is the resolved class and never `'system'`, and `theme.preference` is what was chosen
- In a component, watch it with `$: theme.value` or a read is a snapshot taken at mount
- `toggleTheme` advances to the next theme in `themes`
- `setTheme('system')` follows the operating system again
- The choice is saved under `<prefix>:<key>` and reaches the app's other open tabs
- `theme: { themes, default, system, persist, key, apply, attribute }` in the config sets the list and the default
- An entry may name several classes, a mode and an accent: `'theme-dark theme-sunset'`
- `setScheme('light' | 'dark')` is for a page whose window a host owns, and is never saved

**In depth:** [README § Theme](../../../README.md#theme)
