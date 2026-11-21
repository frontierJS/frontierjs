# Guards and hooks

`beforeNavigate` runs before a navigation commits and can redirect or cancel it. `afterNavigate` runs once it has committed. Register both where the app mounts, in `App.mesa`.

```mesa
<script>
  import { RouterView, beforeNavigate, afterNavigate } from '@frontierjs/sierra/router'

  beforeNavigate(async ({ from, to }) => {
    if (to.pathname.startsWith('/admin/') && !isAdmin()) return '/login/'  // redirect
    if (unsavedChanges) return false                                      // cancel
    return true
  })

  afterNavigate(({ from, to }) => trackPageview(to.pathname))
</script>

<RouterView />
```

## What else it can do

- A guard returns `true` to allow, `false` to cancel, or a path to redirect there
- Both functions return an unsubscribe function
- Guards run on the boot navigation, so one protects a direct page load and a refresh
- Guards run on the Back button too, and a refusal puts the address bar back
- A redirect must be a path on this origin, and ten redirects without landing is reported as a loop
- A guard is not run on a hover prefetch

**In depth:** [Sierra README § Guards and hooks](../../../README.md#guards-and-hooks)
