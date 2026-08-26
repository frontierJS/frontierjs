// widgets/config/sierra.config.js
// One config is one target. Paths are relative to the Vite root — the widgets/
// surface — since every widget command runs from here, never from the app root.

export default {
  target: 'widget',

  widgets: {
    // A widget is a .mesa file in here, or a directory holding index.mesa. A
    // .mesa BESIDE an index.mesa is that widget's own component and is not
    // built as a second script.
    dir:    'src/Embeds',
    outDir: 'dist/embeds',
    // Every widget's tag and class take this. Two vendors' widgets land on the
    // same page more often than anyone expects, and a prefix is what keeps
    // <booking> from being a name both of them claimed.
    prefix: "fjs-",
  },
}
