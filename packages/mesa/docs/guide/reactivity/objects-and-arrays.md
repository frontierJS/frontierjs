# Objects and arrays

Replacing a value is reactive. Changing it in place is not, until you watch the
path with `$:`.

```mesa
<script>
  let todos = ['Write docs']
  let user = { name: 'Ada' }

  $: todos
  $: user.name

  function add() { todos.push('Ship it') }
  function rename() { user.name = 'Grace' }
</script>

<button onclick={add}>{todos.length} todos</button>
<button onclick={rename}>{user.name}</button>
```

With the two `$:` lines, `push` and the property assignment both update the page.
Delete them and neither does.

## Replacing needs no watch

Assigning a new array or object is a normal `let` write and always notifies.

```js
todos = [...todos, 'Ship it']
user = { ...user, name: 'Grace' }
```

## Announcing a mutation

If you mutate in place and cannot add a watch, assign the value to itself. `o = o`
skips the equality check for that one write and always notifies.

```js
todos.sort()
todos = todos
```

## Watch the narrowest path

`$: user` watches the whole object, and `$: user.name` only that field. Several paths
go in one statement: `$: (cart.items, cart.total)`.

## Getters

A getter on an object is invisible to the compiler. Watch what the getter reads,
not the getter itself.

```js
let user = { first: 'Ada', last: 'L', get full() { return this.first + ' ' + this.last } }

$: user.first      // {user.full} updates when first changes
$: user            // so does a whole-object watch
```

`$: user.full` never fires, because nothing ever writes to it.

---

Spec: [VISION.md § 15](../../VISION.md#15-object-and-array-reactivity) · RULE 43
