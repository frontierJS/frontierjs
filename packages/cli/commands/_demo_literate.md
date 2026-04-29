---
title: demo:literate
description: literate style demo
---

<script>
const helper = () => 42
</script>

This is the **first** prose paragraph with `inline code` and a [link](https://x.com).

```js
const x = helper()
log.info('first block')
```

## A heading

Some prose between blocks. The next code uses `x` from the previous block.

```js
log.info('second block: ' + x)
```

Final prose explaining what we just did.
