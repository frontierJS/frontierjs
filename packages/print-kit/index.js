// @frontierjs/print-kit — an HTML document to a PDF, an element to a PNG, in one
// headless Chromium (FJS-D816). `./print.css` is the stylesheet every printed
// document carries after the app's own.
export { createPrinter, printerPlugin } from './src/printer.js'
export { cssString, marginContent, pageRules, printDocument } from './src/document.js'
