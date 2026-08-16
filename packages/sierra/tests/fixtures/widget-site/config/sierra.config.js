export default {
  target: 'widget',
  widgets: {
    dir:    'src/Embeds',
    outDir: 'dist/embeds',
    // Every widget's tag and class take this. A host page writes <mt-counter>,
    // and the prefix is what keeps two vendors' widgets off each other's names.
    prefix: 'mt-',
    // Readable output — the assertions read the built file, and a minified one
    // says nothing about WHY it is inert when it is.
    minify: false,
  },
}
