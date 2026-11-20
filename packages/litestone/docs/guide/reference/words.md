# Every word, A–Z

The reference lists every word a `.lite` file can hold: what it does, what it accepts, where it is legal, and a worked example. It is generated from the language's own table, and each example is parsed by the test suite, so a sample that does not work is a red build.

It is one page in four groups:

- declarations, what may sit at the top of a file (`model`, `enum`, `database`, `trait` and the rest)
- field attributes, such as `@id`, `@default`, `@relation` and `@guarded`
- model attributes, such as `@@index`, `@@gate`, `@@allow` and `@@trail`
- transition words, which go inside `@@transitions`

Inside a group the words sit under a heading for the job they do: identify a row, reach another row, compute a value, hide or lock a value, record who and when, clean or refuse a value, shape the table, decide who may, wire it to the app.

```sh
litestone explain @guarded      # one word, from the terminal, with no schema needed
litestone explain               # the list
litestone explain --json        # the same rows as data
```

## What else it can do

- Studio's Explore panel asks the same rows, and places a word into your schema after showing the diff
- `litestone catalog --reference` regenerates the page, so it never drifts from the parser
- Each entry links to the topic doc that explains the word in full, and to related words

**In depth:** [The `.lite` language, word by word](../../reference.snapshot.md), [CLI § Schema tools](../../cli.md#schema-tools)
