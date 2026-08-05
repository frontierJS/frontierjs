# @frontierjs/ui

Mesa components over [`@frontierjs/css`](../css). 63 components across forms,
display, layout, overlay and feedback.

```bash
bun add @frontierjs/ui @frontierjs/css @frontierjs/mesa
```

```js
import '@frontierjs/css'
```

```html
<body class="theme-default">
```

```svelte
<script>
  import Button from '@frontierjs/ui/components/forms/Button.mesa'
  import Alert  from '@frontierjs/ui/components/feedback/Alert.mesa'
</script>

<Alert tone="warning" title="Heads up">Your trial ends Friday.</Alert>
<Button tone="danger" onclick={remove}>Delete</Button>
```

---

## The split

`@frontierjs/css` ships **zero JavaScript**. That is deliberate, and it is
exactly the line between the two packages:

| | `@frontierjs/css` | `@frontierjs/ui` |
| --- | --- | --- |
| Owns | how it looks, what the markup *is* | keyboard, focus, ARIA, state |
| Ships | plain CSS, no build step | `.mesa` components |
| Answers | "what is a Card" | "how does this Modal trap focus" |

A stylesheet cannot give you a focus-trapped dialog, a roving-tabindex
tablist, a combobox, or a toast queue. This package is that half. Every
component here draws itself with the css vocabulary and adds only behaviour.

**There is no second design system here.** No colour maps, no size scales, no
`tokens.css`. A component that wants to be red does not carry a red — it takes
a tone.

## Tones

Seven, from the css package, and they work on everything:

`primary` · `secondary` · `muted` · `info` · `success` · `warning` · `danger`

```svelte
<Button tone="danger">Delete</Button>
<Badge tone="success">Paid</Badge>
<Card tone="warning">Card expiring</Card>
<Alert tone="info">Scheduled maintenance Sunday.</Alert>
```

Fill and text colour are both derived from the tone's luminance, verified at
zero WCAG AA failures across all 42 tone × theme combinations — so there is
never a text colour to pick.

`utils.js` exports `tone(name)`, which maps the older prop spellings onto the
seven: `error` → `danger`, `red` → `danger`, `green` → `success`, `gray` →
`muted`, and so on. An unrecognised name resolves to `''` (untoned) rather
than guessing, so a typo renders in the component's own default instead of
silently wrong. Every component still accepts its previous `color=` / `type=`
prop through that map.

## Treatments

Tones and treatments are different kinds of class in the css package, and they
compose freely — which is why `variant` on Button takes either:

```svelte
<Button variant="outlined" tone="danger">Delete</Button>   <!-- red outline -->
<Button variant="ghost">Cancel</Button>
<Button variant="link">Learn more</Button>
<Button tone="primary" loading>Saving</Button>
<Button square aria-label="Delete"><IconTrash /></Button>
```

The old six-value `variant` conflated the two, which is why `outline` and
`danger` used to be mutually exclusive. Both spellings still work.

## What's in the box

**forms** — `Button` `Btn` `Field` `Fieldset` `Label` `Input` `Textarea`
`Select` `Checkbox` `Switch` `RadioGroup` `NumberInput` `Slider` `Combobox`
`MultiSelect` `DatePicker` `FileUpload`

**display** — `Badge` `Pill` `Tag` `Dot` `Kbd` `Mono` `Divider` `Breadcrumbs`
`Pagination` `Steps` `SectionHeader` `Callout` `EmptyState` `CopyButton`
`Avatar` `AvatarGroup` `Stat` `StatCard` `Table` `Bar` `Sparkline`
`AccountStatus`

**layout** — `Card` `Accordion` `AccordionItem` `Tabs` `TabList` `Tab` `TabPanel`

**overlay** — `Modal` `Drawer` `Popover` `Tooltip` `DropdownMenu`
`DropdownItem` `DropdownLabel` `DropdownSeparator` `CommandPalette`
`ConfirmationPopover`

**feedback** — `Alert` `AlertProvider` `Toast` `Toaster` `Progress` `Spinner`
`Skeleton`

**stores** — `toastStore` `alertStore` `themeStore` `commandPaletteStore`

## The platform does the work

Where the browser already has the behaviour, these components use it instead
of reimplementing it. That is not a style preference — each one deleted a real
bug:

| Component | Built on | What that replaced |
| --- | --- | --- |
| `Modal`, `Drawer` | `<dialog>` + `showModal()` | a hand-rolled Tab focus trap that could not make the background inert |
| `Accordion` | `<details>` / `<summary>` | a button with `aria-expanded` and a grid-rows animation |
| `Progress`, `Bar` | `<progress>` | a div with `role="progressbar"` and three ARIA attributes to keep in sync |
| `Switch` | `<input type="checkbox">` | a `<button role="switch">` that no form ever submitted |
| `RadioGroup` | real radios + `:has(:checked)` | a selected-state class beside the checked state |
| `Fieldset` | `<fieldset disabled>` | `opacity` + `pointer-events: none`, which a keyboard user tabbed straight through |
| `Select` | the UA's own chevron | `appearance: none` plus a hand-drawn arrow |
| `FileUpload` | a real `<button>` dropzone | `role="button"` plus a keydown handler that also scrolled the page on Space |
| `Table` | a `<button>` in the `<th>` | `on:click` on the `<th>`, which no keyboard user could reach |
| `Tabs`, `Breadcrumbs` | `[aria-selected]`, `[aria-current]` | an `.active` class that could disagree with what was announced |

`Tooltip` moved the other way for the same reason: it is now anchored rather
than portaled, because the anchored form is what carries `aria-describedby`
and shows on focus. A portaled tooltip escapes `overflow: hidden`; it also
announces nothing. Reach for `Popover` when you genuinely need to break out of
a scroll container.

## Escape hatches

Every component takes `{class}`, and it **merges** with the component's own
classes rather than replacing them:

```svelte
<Button class="my-thing">Save</Button>
<!-- → <button class="btn primary my-thing"> -->
```

Your own stylesheet is unlayered, and unlayered CSS beats every cascade layer
in `@frontierjs/css`, so overriding needs no `!important` and no specificity
ladder.

## Tests

```bash
bun run test     # inside this package
```

Two suites, and the split matters:

- **`test/compile-all.mjs`** — every `.mesa` compiles *and* the emitted
  JavaScript parses. Those are different claims: Mesa can report zero errors
  and still emit a module that throws on load.
- **`test/render.mjs`** — renders a component from each tier and asserts the
  css vocabulary reaches the DOM, and that no utility class has crept back in.
  This is the suite that would have caught the original problem, where 55 of
  63 components were styled with Tailwind/Uno classes that nothing in this
  repo generates — so every one of them rendered unstyled while compiling
  perfectly.

## Status

Alpha, zero production consumers. Verified by compiling and rendering, **not
in a browser** — see `PROJECT_STATE.md` for what is and is not confirmed.
