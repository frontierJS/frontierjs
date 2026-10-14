// Forked from site-auditor/val/core.mjs. ksite: decodeHtmlText is added here.
export function htmlToText(html) {
  return (html||"")
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&")
    .replace(/\s+/g," ");
}

/** Decodes the entities an attribute or <title> carries, so "Poppy &amp; Pine" compares equal to "Poppy & Pine". */
export function decodeHtmlText(s) {
  return String(s || "")
    .replace(/&quot;/gi, '"').replace(/&#0*34;/g, '"')
    .replace(/&apos;/gi, "'").replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&"); // last — decoding it first would double-decode
}
