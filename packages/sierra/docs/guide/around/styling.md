# Styling with @frontierjs/css

`@frontierjs/css` is the styling language: plain CSS, no build step. You style with a tone (`danger`) and a treatment (`outlined`), never a color, and a theme is one class on an ancestor. Import it once with `import '@frontierjs/css'` in `src/main.js`.

```html
<body class="theme-default">
  <button class="btn danger outlined">Delete</button>
  <article class="card raised success">Paid</article>
</body>
```

## What else it can do

- There are three kinds of class: an element (`btn`, `card`), a treatment that composes onto anything, and anatomy that nests inside an element
- Seven tones work on every element that takes one: `primary`, `secondary`, `muted`, `info`, `success`, `warning`, `danger`
- Treatments such as `raised`, `outlined`, `ghost` and `glass` chain freely
- A theme class nests, so a `theme-midnight` header can sit inside a `theme-default` page
- `THEMES` from `@frontierjs/css/themes.js` gives each theme's label, blurb and `light` or `dark` scheme for a picker
- Text and fill contrast are derived from the tone, so there is no text color to pick
- UnoCSS is an opt-in layer: run it beside the package for one-off adjustments, with its reset imported into a CSS layer
- A theme sets tokens and ships no selector of its own

**In depth:** [css README § The idea](../../../../css/README.md#the-idea), [§ Tones](../../../../css/README.md#tones), [§ Themes](../../../../css/README.md#themes), [§ Using it with UnoCSS](../../../../css/README.md#using-it-with-unocss)
