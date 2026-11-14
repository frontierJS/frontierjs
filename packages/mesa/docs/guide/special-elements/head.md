# `<mesa:head>`

Put reactive content into `document.head`: a title, meta tags, a link.

```mesa
<script>
  export let pageTitle = 'Home'
  export let description = ''
</script>

<mesa:head>
  <title>{pageTitle}</title>
  <meta name="description" content={description}>
</mesa:head>

<h1>{pageTitle}</h1>
```

The content updates when `pageTitle` or `description` changes. It is removed
from the head when the component is destroyed.

---

Spec: [VISION.md § 12.3](../../VISION.md#123-mesahead)
