/**
 * ksite-discovery / schema.mjs
 *
 * Everything that reads structured data: JSON-LD, microdata, RDFa, and the
 * checks that decide whether any of it is worth anything.
 *
 * Part of a set split for Val.town's 80,000-character-per-file limit. This
 * file exists because the JSON-LD work pushed `extract-html.mjs` to 84k — past
 * the limit the split was for, so the project would have failed to upload. It
 * is a straight lift: nothing moved here changed behavior.
 */

import { htmlToText } from "./text.js";
import { checkVocabulary } from "./vocabulary.js";

/* ───────────────────────────────────────────────────────────────────────────
 * JSON-LD
 *
 * Structured data is the highest-confidence source in the whole audit — a value
 * off a business node skips the Confirm bucket and lands in the record as fact.
 * That makes both directions expensive: markup we fail to read costs a field
 * the client then gets asked for, and markup we read *wrongly* writes a
 * confident falsehood.
 *
 * Four rules the previous implementation broke, each one found by feeding it
 * markup that real sites ship:
 *
 *   1. **A document is not always one object.** Top-level arrays are ordinary
 *      (`[{LocalBusiness},{FAQPage}]`) and `@graph` nests. The old flattener
 *      handled exactly one shape — a lone object with a `@graph` — and pushed a
 *      top-level array into the node list *as a single node*, so every node in
 *      it vanished silently. A whole site read as "no structured data".
 *
 *   2. **Type matching must be exact.** `st.includes(type)` meant a query for
 *      `Service` matched `HouseCleaningService` — i.e. the business node
 *      itself — so the company's own name was emitted as a service, at high
 *      confidence, outranking the real nav-derived list. Types are compared by
 *      equality against explicit sets now. Business detection keeps a suffix
 *      heuristic because sites invent subtypes (`HomeCleaningService` is not
 *      real schema.org and is everywhere); *services* get no heuristic at all,
 *      because that is where a false positive gets published.
 *
 *   3. **`@id` references are the norm, not an edge case.** Yoast, RankMath and
 *      most WP SEO plugins emit a graph of `{"@id": "…#organization"}` pointers.
 *      Unresolved, a business's address is the string `{"@id": …}` and the
 *      address is lost while looking present.
 *
 *   4. **A parse failure is a finding, not a shrug.** `catch {}` reported
 *      broken markup identically to absent markup, which are opposite pieces of
 *      advice. Failures are counted and returned.
 *
 * Everything here is additive on the returned shape: `parseErrors`, `blocks`
 * and `blocksParsed` are new, and no existing key changed meaning.
 * ─────────────────────────────────────────────────────────────────────────── */

const SCHEMA_ORG_PREFIX = /^https?:\/\/(?:www\.)?schema\.org\//i;

/** Normalized `@type` list — always an array, never namespaced, never null. */
export function typesOf(node) {
  if (!node || typeof node !== "object") return [];
  const t = node["@type"];
  const list = Array.isArray(t) ? t : (t == null ? [] : [t]);
  return list.filter(x => typeof x === "string")
             .map(x => x.replace(SCHEMA_ORG_PREFIX, "").trim())
             .filter(Boolean);
}

// Node types that are values rather than entities. Excluded from the reported
// `types` list so "what markup does this site have" stays readable.
const VALUE_TYPES = new Set([
  "PostalAddress","GeoCoordinates","GeoCircle","GeoShape","AggregateRating","Rating",
  "OpeningHoursSpecification","ContactPoint","ImageObject","Question","Answer","ListItem",
  "PropertyValue","QuantitativeValue","MonetaryAmount","PriceSpecification",
  "UnitPriceSpecification","Country","State","Duration","EntryPoint","SearchAction",
  "ReadAction","OrderAction","Language","DayOfWeek","Brand","Audience","Distance",
]);

// Types that are never a business however they are spelled. Guards the suffix
// heuristic below — "Service" and "Offer" end in nothing useful but a bare
// `Service` node must stay a service.
const NEVER_BUSINESS = new Set([
  "Service","Product","Offer","AggregateOffer","OfferCatalog","ItemList","ListItem",
  "WebSite","WebPage","AboutPage","ContactPage","CollectionPage","ItemPage","FAQPage",
  "Review","UserReview","Person","BreadcrumbList","Article","BlogPosting","NewsArticle",
  "Event","SearchAction","FinancialProduct","Question","Answer","SiteNavigationElement",
]);

// Explicit business types, including the invented-but-ubiquitous ones.
const BIZ_TYPES = new Set([
  "LocalBusiness","Organization","Corporation","NGO","ProfessionalService",
  "HomeAndConstructionBusiness","CleaningService","HouseCleaningService","JanitorialService",
  "DryCleaningOrLaundry","MovingCompany","GeneralContractor","HVACBusiness","Plumber",
  "Electrician","RoofingContractor","HousePainter","Locksmith","PestControlService",
  "SelfStorage","ChildCare","Store","AutoRepair","EmploymentAgency",
]);

// A LocalBusiness subtype outranks a bare Organization when both are present.
const GENERIC_BIZ = new Set(["Organization","Corporation","NGO"]);

const SERVICE_TYPES = new Set(["Service","Product","IndividualProduct","ProductModel","ProductGroup"]);
const CATALOG_TYPES = new Set(["ItemList","OfferCatalog"]);
const OFFER_TYPES   = new Set(["Offer","AggregateOffer"]);

/**
 * Properties whose value is *a different organization*.
 *
 * A well-marked-up site names other companies on purpose: the BBB under
 * `recognizedBy`, a chamber of commerce under `memberOf`, the charities and
 * swim teams it sponsors under `sponsor`. Every one of those is an
 * `Organization` or an `NGO`, so every one was a business candidate — and
 * since `sameAs` unions across candidates, austinsmaidservice.com's social
 * links came back with the BBB's own page and two chambers' homepages mixed
 * in. `socialOf()` would have published a third party's URL as the client's
 * profile, and the backfill could have taken a sponsor's street address.
 *
 * Deliberately narrow. `provider`, `publisher`, `author` and `copyrightHolder`
 * are NOT here: on a small business site those are the business itself, and
 * excluding them would throw away the node the audit is looking for.
 */
const FOREIGN_ORG_PROPS = new Set([
  "sponsor", "funder", "recognizedBy", "memberOf", "parentOrganization",
  "subOrganization", "affiliation", "alumniOf", "accreditingBody",
  "sourceOrganization", "competitor", "hasCredential",
]);

/** Every node sitting under a foreign-organization property, transitively. */
function foreignOrgNodes(docs) {
  const foreign = new Set();
  const mark = (v, depth) => {
    if (depth > 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(x => mark(x, depth + 1)); return; }
    if (foreign.has(v)) return;
    foreign.add(v);
    for (const k of Object.keys(v)) mark(v[k], depth + 1);
  };
  const walk = (v, depth) => {
    if (depth > 12 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    for (const k of Object.keys(v)) {
      if (FOREIGN_ORG_PROPS.has(k)) mark(v[k], depth + 1);
      else walk(v[k], depth + 1);
    }
  };
  docs.forEach(d => walk(d, 0));
  return foreign;
}

const isBusinessType = (t) =>
  !NEVER_BUSINESS.has(t) &&
  (BIZ_TYPES.has(t) || /(?:Business|Service|Contractor|Company|Agency|Store|Shop)$/.test(t));

/** The only context that makes a block schema.org data. Protocol-relative is legal. */
const SCHEMA_ORG_CONTEXT = /^(?:https?:)?\/\/(?:www\.)?schema\.org\/?$/i;

/**
 * Is this block's `@context` one that makes its `@type`s mean anything?
 *
 * JSON-LD without a context is not schema.org data. It parses, it looks like
 * structured data in an audit, and every consumer — Google included — discards
 * it. Nothing checked this, so an inert block counted as healthy markup, which
 * is the most expensive thing this section can get wrong: it tells a client
 * their structured data is fine when it earns them nothing.
 *
 * Lenient by design. Every `@context` in the document is collected, at any
 * depth, and one schema.org among them is enough — a block that mixes in
 * another vocabulary is still schema.org data. Only "no context anywhere" and
 * "contexts, none of them schema.org" are reported.
 *
 * @returns {"ok"|"missing"|"foreign"}
 */
export function contextStatus(doc) {
  const found = [];
  const walk = (v, depth) => {
    if (depth > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (v["@context"] != null) found.push(v["@context"]);
    for (const k of Object.keys(v)) if (k !== "@context") walk(v[k], depth + 1);
  };
  walk(doc, 0);
  if (!found.length) return "missing";
  const isSchemaOrg = (v) => {
    if (typeof v === "string") return SCHEMA_ORG_CONTEXT.test(v.trim());
    if (Array.isArray(v)) return v.some(isSchemaOrg);
    if (v && typeof v === "object") return Object.values(v).some(isSchemaOrg);
    return false;
  };
  return found.some(isSchemaOrg) ? "ok" : "foreign";
}

/**
 * Read every JSON-LD block out of a page.
 *
 * Tolerates the four ways real pages break `JSON.parse`: a `;charset=` suffix on
 * the type attribute, CDATA and comment wrappers, HTML-entity-encoded payloads,
 * and trailing commas. A payload recovered by any of those repairs is still
 * recorded in `errors` with `recovered: true` — the site's markup *is* invalid
 * and the audit should say so even though we read it anyway.
 *
 * `contexts` reports each parsed block's `@context` health alongside. Parsing
 * and meaning are separate failures: a block can be perfect JSON and still be
 * invisible to every consumer.
 */
export function parseJsonLdBlocks(html) {
  const rx = /<script\b[^>]*\btype\s*=\s*["'][^"']*application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  const docs = [], errors = [], contexts = [];
  let blocks = 0, m;

  while ((m = rx.exec(html || "")) !== null) {
    blocks++;
    const raw = m[1];
    const body = raw
      .replace(/^\s*<!--/, "").replace(/-->\s*$/, "")
      // CDATA markers, with or without the JS comment guards they usually wear
      // (`/*<![CDATA[*/`, `//<![CDATA[`, or bare) — all three are in the wild.
      .replace(/(?:\/\/|\/\*)?\s*<!\[CDATA\[\s*(?:\*\/)?/g, "")
      .replace(/(?:\/\/|\/\*)?\s*\]\]>\s*(?:\*\/)?/g, "")
      .trim();
    if (!body) { errors.push({ block: blocks, reason: "empty", recovered: false, snippet: "" }); continue; }

    const attempts = [
      [body, null],
      [decodeEntities(body), "html-entity encoded"],
      [body.replace(/,(\s*[}\]])/g, "$1"), "trailing comma"],
      [decodeEntities(body).replace(/,(\s*[}\]])/g, "$1"), "html-entity encoded + trailing comma"],
    ];
    let parsed = null, reason = null, failure = "";
    for (const [text, repair] of attempts) {
      try { parsed = JSON.parse(text); reason = repair; break; }
      catch (e) { failure = e.message; }
    }
    if (parsed === null) {
      errors.push({ block: blocks, reason: failure || "invalid JSON", recovered: false, snippet: body.slice(0, 120) });
      continue;
    }
    if (reason) errors.push({ block: blocks, reason, recovered: true, snippet: body.slice(0, 120) });
    const status = contextStatus(parsed);
    if (status !== "ok") contexts.push({ block: blocks, status, types: deepNodes([parsed]).flatMap(typesOf) });
    docs.push(parsed);
  }
  return { docs, blocks, errors, contexts };
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/gi, '"').replace(/&#0*34;/g, '"')
    .replace(/&apos;/gi, "'").replace(/&#0*39;/g, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#0*10;/g, "\\n").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&"); // last — decoding it first would double-decode
}

/** Top-level entity nodes: unwraps arrays and `@graph`, at any nesting depth. */
function flattenDocs(docs) {
  const out = [], seen = new Set();
  const walk = (v, depth) => {
    if (depth > 10 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (seen.has(v)) return;
    seen.add(v);
    if (v["@graph"]) {
      walk(v["@graph"], depth + 1);
      if (typesOf(v).length) out.push(v); // a wrapper may also be a node
      return;
    }
    out.push(v);
  };
  docs.forEach(d => walk(d, 0));
  return out;
}

/** Every typed node anywhere in the tree — a nested FAQPage is still an FAQPage. */
function deepNodes(docs) {
  const out = [], seen = new Set();
  const walk = (v, depth) => {
    if (depth > 12 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (seen.has(v)) return;
    seen.add(v);
    if (typesOf(v).length) out.push(v);
    for (const k of Object.keys(v)) if (k !== "@context" && k !== "@type") walk(v[k], depth + 1);
  };
  docs.forEach(d => walk(d, 0));
  return out;
}

/** Index of `@id` → node, for reference resolution. Pure pointers aren't indexed. */
function indexById(docs) {
  const byId = new Map(), seen = new Set();
  const walk = (v, depth) => {
    if (depth > 12 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (seen.has(v)) return;
    seen.add(v);
    const id = typeof v["@id"] === "string" ? v["@id"] : null;
    if (id && Object.keys(v).length > 1 && !byId.has(id)) byId.set(id, v);
    for (const k of Object.keys(v)) if (k !== "@context") walk(v[k], depth + 1);
  };
  docs.forEach(d => walk(d, 0));
  return byId;
}

/** Replace `{"@id": "…"}` pointers with the node they point at. Cycle-safe. */
function resolveRefs(v, byId, depth = 0, stack = new Set()) {
  if (depth > 8 || !v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(x => resolveRefs(x, byId, depth + 1, stack));
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === "@id" && typeof v["@id"] === "string") {
    const target = byId.get(v["@id"]);
    if (!target || stack.has(target)) return v;
    const next = new Set(stack); next.add(target);
    return resolveRefs(target, byId, depth + 1, next);
  }
  const out = {};
  for (const k of keys) out[k] = resolveRefs(v[k], byId, depth + 1, stack);
  return out;
}

/** First usable string out of a value that may be a string, array, or `{@value}`. */
function firstString(v) {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) { for (const x of v) { const s = firstString(x); if (s) return s; } return ""; }
  if (v && typeof v === "object") return firstString(v["@value"] ?? v.name ?? v.url ?? "");
  return "";
}

/** Strip markup out of a schema string — FAQ answers routinely carry `<p>` tags. */
const plain = (v) => {
  const s = firstString(v);
  return (/[<&]/.test(s) ? htmlToText(s) : s).replace(/\s+/g, " ").trim();
};

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/* ── three defects that read as nothing ───────────────────────────────────
 *
 * Each of these was on taleencommercialcleaning.com, a site we generated, and
 * the audit reported none of them — because the extractor does the charitable
 * thing with each and so never sees it. It drops nulls (correctly: JSON-LD
 * does), leaves an unresolvable `@id` as a pointer, and backfills a business
 * node from its identically-named sibling. Reading generously is right for the
 * record; saying nothing about it is not right for the report. All three read
 * the *raw* documents, before `resolveRefs` has papered over anything.
 * ─────────────────────────────────────────────────────────────────────── */

/** Every `{"@id": …}` pointer whose target no node on this page defines. */
function danglingRefs(docs, byId) {
  const out = [], seen = new Set(), dup = new Set();
  const walk = (v, prop, depth) => {
    if (depth > 12 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, prop, depth + 1)); return; }
    if (seen.has(v)) return;
    seen.add(v);
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v["@id"] === "string") {
      const id = v["@id"];
      // Only fragment ids. A bare page URL (`mainEntityOfPage: {"@id": url}`)
      // is a legitimate reference to a document, not to a node that ought to
      // be here; `…/#localbusiness` names a node, and that one should be.
      if (id.includes("#") && !byId.has(id) && !dup.has(`${prop}|${id}`)) {
        dup.add(`${prop}|${id}`);
        out.push({ prop, id: id.slice(0, 160) });
      }
      return;
    }
    for (const k of keys) if (k !== "@context") walk(v[k], k, depth + 1);
  };
  docs.forEach(d => walk(d, "", 0));
  return out;
}

/** `Type.property` for every property emitted as null, "" or []. */
function emptyValues(docs) {
  const out = new Set(), seen = new Set();
  const walk = (v, owner, depth) => {
    if (depth > 12 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, owner, depth + 1)); return; }
    if (seen.has(v)) return;
    seen.add(v);
    const type = typesOf(v)[0] || owner;
    for (const [k, x] of Object.entries(v)) {
      if (k === "@graph") { walk(x, type, depth + 1); continue; }
      if (k.startsWith("@")) continue;
      const empty = x === null || (typeof x === "string" && !x.trim()) || (Array.isArray(x) && !x.length);
      if (empty) out.add(`${type || "(untyped)"}.${k}`);
      else walk(x, type, depth + 1);
    }
  };
  docs.forEach(d => walk(d, "", 0));
  return [...out];
}

/**
 * Top-level business nodes naming the same business with nothing tying them
 * together — no shared `@id`, and neither pointing at the other. Distinct ids
 * don't link two nodes; they assert two entities. `extractSchema` merges these
 * by backfill, so the record never notices; a consumer is not obliged to.
 *
 * @returns {{type: string, id: string, only: string[]}[]} [] when there is no split
 */
function splitBusinessNodes(docs) {
  const top = flattenDocs(docs).filter(n => typesOf(n).some(isBusinessType) && plain(n.name));
  const refsIn = (node) => {
    const ids = new Set(), seen = new Set();
    const walk = (v, depth) => {
      if (depth > 12 || !v || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
      if (Object.keys(v).length === 1 && typeof v["@id"] === "string") ids.add(v["@id"]);
      for (const k of Object.keys(v)) if (k !== "@context") walk(v[k], depth + 1);
    };
    for (const k of Object.keys(node)) if (k !== "@id") walk(node[k], 0);
    return ids;
  };
  const linked = (a, b) => {
    const ia = typeof a["@id"] === "string" ? a["@id"] : "", ib = typeof b["@id"] === "string" ? b["@id"] : "";
    return (ia && ia === ib) || (ib && refsIn(a).has(ib)) || (ia && refsIn(b).has(ia));
  };
  const filled = (x) => x != null && !(typeof x === "string" && !x.trim()) && !(Array.isArray(x) && !x.length);
  for (const n of top) {
    const group = top.filter(m => sameBusinessName(plain(m.name), plain(n.name)));
    if (group.length < 2 || group.every((a, i) => group.slice(i + 1).every(b => linked(a, b)))) continue;
    return group.map(node => ({
      type: typesOf(node).join("/"),
      id: typeof node["@id"] === "string" ? node["@id"] : "",
      only: Object.keys(node).filter(k => !k.startsWith("@") && filled(node[k])
        && group.every(o => o === node || !filled(o[k]))),
    }));
  }
  return [];
}

export function extractSchema(html) {
  const { docs, blocks, errors, contexts } = parseJsonLdBlocks(html);
  const byId     = indexById(docs);
  const resolved = docs.map(d => resolveRefs(d, byId));
  const all      = flattenDocs(resolved);   // top-level entities — what the page shipped
  const nodes    = deepNodes(resolved);     // every typed node, however deeply nested

  const ofType = (wanted) => {
    const want = wanted instanceof Set ? wanted : new Set(wanted);
    return nodes.filter(n => typesOf(n).some(t => want.has(t)));
  };
  const first = (types) => ofType(types)[0] || null;

  // Business — a page may carry several business-ish nodes (e.g. a sparse
  // Organization AND a rich LocalBusiness with rating/address/phone). Graph
  // order is not priority, so score candidates by completeness + type
  // specificity and take the best, then merge in fields from the others so a
  // value present on any business node is available.
  // Organizations the site names but does not claim to be — sponsors, the BBB,
  // the local chamber — are excluded before ranking. See `foreignOrgNodes`.
  const foreign = foreignOrgNodes(resolved);
  const bizCandidates = nodes.filter(n => !foreign.has(n) && typesOf(n).some(isBusinessType));
  const bizScore = (n) => {
    let s = 0;
    if (n.aggregateRating) s += 5;
    if (n.address)         s += 3;
    if (n.telephone)       s += 2;
    if (n.geo)             s += 2;
    if (n.openingHours || n.openingHoursSpecification) s += 2;
    if (n.email)           s += 1;
    if (n.priceRange)      s += 1;
    if (n.hasOfferCatalog || n.makesOffer) s += 1;
    if (n.areaServed)      s += 1;
    // Type specificity — a LocalBusiness subtype outranks a bare Organization
    if (typesOf(n).some(t => !GENERIC_BIZ.has(t))) s += 4;
    return s;
  };
  const ranked = [...bizCandidates].sort((a,b) => bizScore(b) - bizScore(a));
  let business = ranked[0] ? { ...ranked[0] } : null;
  // Backfill: if the top node is missing a field another business node has, borrow it
  if (business && ranked.length > 1) {
    const BACKFILL = ["aggregateRating","address","telephone","geo","openingHours","openingHoursSpecification","email","priceRange","foundingDate","founder","logo","image","slogan","alternateName","areaServed","hasOfferCatalog","makesOffer","paymentAccepted","knowsLanguage","hasMap","description"];
    for (const node of ranked.slice(1)) {
      for (const f of BACKFILL) if (business[f] == null && node[f] != null) business[f] = node[f];
    }
  }
  // `sameAs` is unioned rather than backfilled — a site that splits its socials
  // across an Organization and a LocalBusiness node has both, and taking only
  // the winner's list silently drops half the social links.
  if (business) {
    const links = [...new Set(ranked.flatMap(n => asArray(n.sameAs).map(u => firstString(u)).filter(Boolean)))];
    if (links.length) business.sameAs = links;
    else delete business.sameAs;
  }
  business = normalizeBusiness(business);

  // FAQs — `mainEntity` may be one Question or many, and answers routinely
  // carry HTML, which would otherwise be published verbatim as body copy.
  const faqs = ofType(["FAQPage","QAPage"]).flatMap(fp =>
    asArray(fp.mainEntity).map(item => ({
      question: plain(item?.name ?? item?.text),
      answer:   plain(asArray(item?.acceptedAnswer ?? item?.suggestedAnswer)[0]?.text),
    })).filter(f => f.question)
  );

  // Services. Containers are descended into and never emitted themselves; only
  // an explicitly service-shaped node produces a row. See rule 2 above — this is
  // where a loose type match published the company's own name as a service.
  const svcOut = [], svcSeen = new Set();
  const walkServices = (node, depth = 0) => {
    if (depth > 6 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(n => walkServices(n, depth + 1)); return; }
    if (svcSeen.has(node)) return;
    svcSeen.add(node);
    const t = typesOf(node);
    if (t.some(x => CATALOG_TYPES.has(x))) {
      walkServices(node.itemListElement, depth + 1);
      walkServices(node.hasOfferCatalog, depth + 1);
      return;
    }
    if (t.includes("ListItem")) { walkServices(node.item, depth + 1); return; }
    if (t.some(x => OFFER_TYPES.has(x)) && node.itemOffered) { walkServices(node.itemOffered, depth + 1); return; }
    const name = plain(node.name);
    if (!name) return;
    svcOut.push({ name, url: firstString(node.url), description: plain(node.description), price: priceOf(node) });
  };
  nodes.filter(n => typesOf(n).some(t => SERVICE_TYPES.has(t) || CATALOG_TYPES.has(t) || OFFER_TYPES.has(t)))
       .forEach(n => walkServices(n));
  // A business lists what it sells here; the catalog is often not a top-level node.
  if (business) { walkServices(business.hasOfferCatalog); walkServices(business.makesOffer); }
  const svcDedupe = new Set();
  const services = svcOut.filter(s => {
    const k = s.name.toLowerCase();
    // The business is not one of its own services — belt and braces on rule 2.
    if (business?.name && k === business.name.toLowerCase()) return false;
    if (svcDedupe.has(k)) return false;
    svcDedupe.add(k);
    return true;
  });

  // Reviews — standalone + embedded in business, deduped. `author` may be a
  // string, an object, or a list; `reviewRating` may be a bare number.
  const asReview = (r) => ({
    name:   plain(r?.author ?? r?.name),
    rating: firstString(r?.reviewRating?.ratingValue ?? r?.reviewRating ?? ""),
    text:   plain(r?.reviewBody ?? r?.description),
    date:   firstString(r?.datePublished),
  });
  const rvSeen = new Set();
  // Deduped by identity, not by content: a review nested under the business is
  // found twice, once by the type sweep and once here, and it is the same
  // object both times. The content dedupe below can't stand in for this —
  // `validity` counts nodes, and a double count doubles every review finding.
  const reviewNodes = [...new Set([...ofType(["Review","UserReview"]), ...asArray(business?.review)])].filter(Boolean);
  const reviews = reviewNodes
    .map(asReview)
    .filter(r => {
      if (!r.name && !r.text) return false;
      const k = `${r.name}::${r.text.slice(0,60)}`.toLowerCase();
      if (rvSeen.has(k)) return false;
      rvSeen.add(k);
      return true;
    });

  // Breadcrumbs
  const breadcrumbs = ofType(["BreadcrumbList"]).flatMap(bl =>
    asArray(bl.itemListElement).map(i => ({
      position: Number(i?.position) || 0,
      name:     plain(i?.name ?? i?.item?.name),
      url:      firstString(i?.item?.url ?? i?.item?.["@id"] ?? i?.item ?? i?.url),
    }))
  ).sort((a,b)=>a.position-b.position);

  // WebSite, WebPage, Article
  const person  = first(["Person"]);
  const website = first(["WebSite"]);
  const webpage  = first(["WebPage","AboutPage","ContactPage","CollectionPage","ItemPage"]);
  const article  = first(["Article","BlogPosting","NewsArticle"]);

  // Events
  const events = ofType(["Event"]).map(e=>({ name:plain(e.name), startDate:firstString(e.startDate), location:plain(e.location?.name), url:firstString(e.url) })).filter(e=>e.name);

  // SameAs
  const sameAs = asArray(business?.sameAs);

  // Entity types present, value objects (PostalAddress, Rating, Question…)
  // filtered out so the reported list answers "what markup does this site have".
  const types = [...new Set(nodes.flatMap(typesOf))].filter(t => !VALUE_TYPES.has(t));

  return {
    raw:all, types, business, person, faqs, services, reviews, breadcrumbs,
    website, webpage, article, events, sameAs,
    // Parse health. `blocks` counts LD script tags found, `blocksParsed` how
    // many yielded JSON. blocks > blocksParsed means the site HAS structured
    // data and it is broken — the opposite advice from having none.
    //
    // `contextIssues` is the third state: parsed cleanly, means nothing. The
    // nodes are still extracted and still reach the record — a business
    // stating its own phone number stated it whether or not Google can read
    // the block — but the audit reports the block as inert.
    blocks, blocksParsed: docs.length, parseErrors: errors, contextIssues: contexts,
    // What the markup would and wouldn't earn, as opposed to what it contains.
    validity: auditSchemaValidity(business, reviewNodes, ofType(["Question"])),
    // Whether the words are words schema.org defines. An invented type parses,
    // validates, and is read as a bare `Thing` — no other check can see it.
    vocabulary: checkVocabulary(nodes),
    // What the reading above forgave. See `danglingRefs` and its neighbours.
    danglingRefs: danglingRefs(docs, byId),
    emptyValues: emptyValues(docs),
    splitBusiness: splitBusinessNodes(docs),
  };
}

/* ── the two fields the business states and the audit used to guess ────────
 *
 * Hours were read only off page text, and service areas only off URL slugs —
 * while the business node sitting right next to them said both outright. Of
 * five live cleaning sites sampled, three declare `areaServed` and four declare
 * hours in one of the two legal forms.
 *
 * Both return the registry's canonical shape, not schema.org's: `company_hours`
 * is a per-day object (`hoursToSchema` in the generator turns it back into a
 * schema string at emit) and `areas` is an array of strings.
 * ───────────────────────────────────────────────────────────────────────── */

const DAY_NAMES = {
  mo:"Monday", mon:"Monday", monday:"Monday",
  tu:"Tuesday", tue:"Tuesday", tues:"Tuesday", tuesday:"Tuesday",
  we:"Wednesday", wed:"Wednesday", wednesday:"Wednesday",
  th:"Thursday", thu:"Thursday", thur:"Thursday", thurs:"Thursday", thursday:"Thursday",
  fr:"Friday", fri:"Friday", friday:"Friday",
  sa:"Saturday", sat:"Saturday", saturday:"Saturday",
  su:"Sunday", sun:"Sunday", sunday:"Sunday",
};
const DAY_ORDER = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

const dayName = (d) => DAY_NAMES[firstString(d).replace(SCHEMA_ORG_PREFIX, "").trim().toLowerCase()] || null;

/** "08:00:00" | "8am" | "8:30 PM" → "08:00" | "08:00" | "20:30". "" if unreadable. */
function hhmm(t) {
  const m = firstString(t).trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?m\.?/i)
         || firstString(t).trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?$/);
  if (!m) return "";
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = (m[3] || "").toLowerCase();
  if (h > 23 || min > 59) return "";
  if (mer === "a") h = h === 12 ? 0 : h;
  else if (mer === "p") h = h === 12 ? 12 : h + 12;
  if (h > 23) return "";
  return `${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}`;
}

/** "Mo-Fr" / "Mo,We,Fr" / "Monday" → full day names. */
function expandDays(spec) {
  const out = [];
  for (const part of String(spec).split(/\s*,\s*/)) {
    const range = part.split(/\s*[-–—]\s*/);
    if (range.length === 2) {
      const a = dayName(range[0]), b = dayName(range[1]);
      if (!a || !b) continue;
      const i = DAY_ORDER.indexOf(a), j = DAY_ORDER.indexOf(b);
      out.push(...(i <= j ? DAY_ORDER.slice(i, j+1) : [...DAY_ORDER.slice(i), ...DAY_ORDER.slice(0, j+1)]));
    } else {
      const d = dayName(part);
      if (d) out.push(d);
    }
  }
  return out;
}

/**
 * Business hours off a schema business node, as `{Monday: "08:00-17:00", …}`.
 *
 * Reads both legal forms: `openingHoursSpecification` objects and the
 * `openingHours` string ("Mo-Fr 08:00-17:00", or several runs in one string).
 * Closed days are omitted rather than recorded as closed — schema.org omits
 * them too, so their absence is not a statement that the business is shut.
 *
 * A range that ends before it starts is dropped, not guessed at. "9-5" meaning
 * 09:00–17:00 is the obvious reading and also the one that silently publishes
 * wrong hours when it's a genuine overnight shift; the generator's
 * `normalizeRange` refuses the same case for the same reason.
 */
export function readSchemaHours(business) {
  const hours = {};
  const allDay = [], overnight = [], unreadable = [];
  const note = (list, day) => { if (!list.includes(day)) list.push(day); };
  const put = (day, open, close) => {
    if (!day || hours[day]) return;
    const o = hhmm(open), c = hhmm(close);
    if (!o || !c) { note(unreadable, day); return; }
    // schema.org's convention for open around the clock is `opens` and
    // `closes` both "00:00". The registry can hold that as a range, so say it
    // rather than dropping the one thing the markup was clearest about.
    if (o === "00:00" && c === "00:00") { hours[day] = "00:00-23:59"; note(allDay, day); return; }
    // An overnight shift (22:00–06:00) is real, and `company_hours` has no way
    // to express it — `normalizeRange` in the registry rejects a close before
    // an open outright. Drop it, but report it: silently losing a stated day
    // is how the record ends up claiming a business is closed when it isn't.
    if (c <= o) { note(overnight, day); return; }
    hours[day] = `${o}-${c}`;
  };

  for (const spec of asArray(business?.openingHoursSpecification)) {
    if (!spec || typeof spec !== "object") continue;
    // Seasonal and holiday overrides carry a validity window. They are real
    // hours for a fortnight and wrong for the rest of the year.
    if (spec.validFrom || spec.validThrough) continue;
    const days = asArray(spec.dayOfWeek).map(dayName).filter(Boolean);
    (days.length ? days : DAY_ORDER).forEach(d => put(d, spec.opens, spec.closes));
  }

  for (const line of asArray(business?.openingHours)) {
    const s = firstString(line);
    if (!s) continue;
    const rx = /([A-Za-z]{2,9}(?:\s*[-–—,]\s*[A-Za-z]{2,9})*)\s+(\d{1,2}(?::\d{2})?(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?(?::\d{2})?\s*(?:[ap]\.?m\.?)?)/gi;
    let m;
    while ((m = rx.exec(s)) !== null) expandDays(m[1]).forEach(d => put(d, m[2], m[3]));
  }
  return { hours, allDay, overnight, unreadable };
}

/** The `company_hours` object alone. `readSchemaHours` for what had to be dropped. */
export function extractSchemaHours(business) {
  return readSchemaHours(business).hours;
}

/* ── validity, as distinct from presence ──────────────────────────────────
 *
 * Every check that came before this asked whether a property is *there*. None
 * asked whether its value is one a consumer will accept, and the two come
 * apart constantly: a `Review` with no `author` is ineligible for a review
 * snippet, an `aggregateRating` with no count is invalid outright, a `logo`
 * that is `/img/logo.png` is not a URL. All three read as present.
 *
 * The audit exists to tell a client what their markup earns. "Present" is not
 * an answer to that, and reporting present-but-inert as healthy is worse than
 * reporting nothing, because it forecloses the question.
 *
 * These are Google's documented requirements, not schema.org's — schema.org
 * marks almost everything optional, and the rich-result rules are what decide
 * whether any of it shows up.
 * ─────────────────────────────────────────────────────────────────────── */

/** schema.org URL properties must be absolute. Relative ones are simply invalid. */
const isAbsUrl = (s) => /^(?:https?:)?\/\//i.test(s) || /^data:/i.test(s);

// Social links a template shipped and nobody filled in. A `sameAs` pointing at
// a network's front door tells Google nothing and is worth the same as absent.
const PLACEHOLDER_SOCIAL =
  /(?:your(?:page|company|business|handle|name)|username|yourusername|profile\.php\?id=\s*$|example\.(?:com|org))/i;

/**
 * Is this review about the business that published the page?
 *
 * Google: "If the entity that's being reviewed controls the reviews about
 * itself, their pages that use LocalBusiness or any other type of Organization
 * structured data are ineligible for star review feature." The LocalBusiness
 * reference says it from the other side — `review` and `aggregateRating` are
 * "only recommended for sites that capture reviews about other local
 * businesses."
 *
 * Three ways a review is about the publisher: it's nested inside the business
 * node, its `itemReviewed` names the business, or it has no `itemReviewed` at
 * all on a page that has a business node — which is every testimonials section
 * on every site in this pipeline's corpus.
 */
function reviewIsSelfServing(review, business, nested) {
  if (!business) return false;
  if (nested.has(review)) return true;
  const target = review?.itemReviewed;
  if (target == null) return true;
  const name = plain(typeof target === "object" ? (target?.name ?? "") : target);
  if (!name) return true;
  return sameBusinessName(name, plain(business.name));
}

export function auditSchemaValidity(business, reviewNodes = [], questionNodes = []) {
  const v = {
    reviewsNoAuthor: 0, reviewsAnonymous: 0, reviewsNoRating: 0, reviewsTotal: reviewNodes.length,
    reviewsSelfServing: 0, ratingSelfServing: false,
    ratingNoCount: false, ratingNoValue: false, ratingOutOfRange: "",
    questionsNoAnswer: 0, questionsTotal: questionNodes.length,
    addressIsString: false, addressMissing: [],
    relativeUrls: [], placeholderSameAs: [], nonHttpSameAs: [],
    phoneSuspect: "", geoSuspect: "",
  };
  const nested = new Set(asArray(business?.review).filter(Boolean));
  for (const r of reviewNodes) {
    const author = r?.author;
    const name = plain(typeof author === "object" ? (author?.name ?? author) : author);
    if (!name) v.reviewsNoAuthor++;
    else if (/^(?:anonymous|a\s+google\s+user|guest|n\/?a)$/i.test(name)) v.reviewsAnonymous++;
    if (!firstString(r?.reviewRating?.ratingValue ?? r?.reviewRating ?? "")) v.reviewsNoRating++;
    if (reviewIsSelfServing(r, business, nested)) v.reviewsSelfServing++;
  }
  // An aggregateRating hanging off the business node is the same claim in
  // summary form, and carries the same ineligibility.
  if (business?.aggregateRating) v.ratingSelfServing = true;

  for (const q of questionNodes) {
    if (!plain(asArray(q?.acceptedAnswer ?? q?.suggestedAnswer)[0]?.text)) v.questionsNoAnswer++;
  }

  // Everything below reads the business node. Reviews and Questions above do
  // not — an FAQPage on a page with no business node still has to be checked.
  if (!business) return v;

  const ar = business.aggregateRating;
  if (ar && typeof ar === "object") {
    const val = Number(firstString(ar.ratingValue));
    const best = Number(firstString(ar.bestRating)) || 5;
    const worst = Number(firstString(ar.worstRating)) || 1;
    if (!firstString(ar.ratingValue)) v.ratingNoValue = true;
    else if (Number.isFinite(val) && (val > best || val < worst)) {
      v.ratingOutOfRange = `${val} on a ${worst}–${best} scale`;
    }
    if (!firstString(ar.reviewCount) && !firstString(ar.ratingCount)) v.ratingNoCount = true;
  }

  if (typeof business.address === "string") v.addressIsString = true;
  else if (business.address && typeof business.address === "object") {
    v.addressMissing = [
      ["streetAddress",   !firstString(business.address.streetAddress)],
      ["addressLocality", !firstString(business.address.addressLocality)],
      ["addressRegion",   !firstString(business.address.addressRegion)],
      ["postalCode",      !firstString(business.address.postalCode)],
    ].filter(([, gone]) => gone).map(([k]) => k);
  }

  for (const prop of ["url", "logo", "image"]) {
    for (const raw of asArray(business[prop])) {
      const s = firstString(raw);
      if (s && !isAbsUrl(s)) v.relativeUrls.push({ prop, value: s.slice(0, 120) });
    }
  }
  for (const s of asArray(business.sameAs)) {
    if (!s) continue;
    if (!isAbsUrl(s)) v.nonHttpSameAs.push(s.slice(0, 120));
    else if (PLACEHOLDER_SOCIAL.test(s)) v.placeholderSameAs.push(s.slice(0, 120));
  }

  // A dialable number has enough digits to dial. Anything shorter is a
  // fragment, a extension, or the template's leftovers.
  if (business.telephone && (business.telephone.match(/\d/g) || []).length < 7) {
    v.phoneSuspect = business.telephone.slice(0, 40);
  }

  const geo = business.geo;
  if (geo && typeof geo === "object") {
    const rawLat = firstString(geo.latitude), rawLng = firstString(geo.longitude);
    const lat = Number(rawLat), lng = Number(rawLng);
    // ksite: Number("") is 0, so a GeoCoordinates with no values read as null island.
    if (!rawLat || !rawLng) v.geoSuspect = "missing — the GeoCoordinates node has no latitude/longitude";
    else if (!Number.isFinite(lat) || !Number.isFinite(lng)) v.geoSuspect = "not numeric";
    else if (lat === 0 && lng === 0) v.geoSuspect = "0, 0 — null island";
    else if (Math.abs(lat) > 90 || Math.abs(lng) > 180) v.geoSuspect = `out of range (${lat}, ${lng})`;
  }

  return v;
}

/* ── schema against the page it sits on ───────────────────────────────────
 *
 * Only the phone number was ever compared (`analyzePhones`). Name, address and
 * hours were taken from the markup unchallenged and written into the record at
 * **high** confidence, which skips the Confirm bucket entirely.
 *
 * A stale `openingHoursSpecification` is one of the most common defects on a
 * small business site — the markup was written once by a plugin and the footer
 * has been edited since. When the two disagree, the markup is not evidence; it
 * is one of two claims, and the record should be asking rather than asserting.
 * These functions find the disagreement. Demoting on it happens in prefill.
 * ─────────────────────────────────────────────────────────────────────── */

/** Compare `{Monday: "08:00-17:00"}` against footer text hours. Days both state. */
export function hoursDisagreement(schemaHours, textHours) {
  const parse = (raw) => {
    const s = firstString(raw).trim();
    if (!s) return null;
    if (/^closed$/i.test(s)) return "closed";
    const m = s.match(/(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)/i);
    if (!m) return null;
    const o = hhmm(m[1]), c = hhmm(m[2]);
    return o && c ? `${o}-${c}` : null;
  };
  const out = [];
  for (const day of DAY_ORDER) {
    const a = schemaHours?.[day];
    const b = parse(textHours?.[day]);
    if (!a || !b || a === b) continue;
    out.push({ day, schema: a, page: b });
  }
  return out;
}

/** Loose business-name equality: case, punctuation and the suffix all ignored. */
export function sameBusinessName(a, b) {
  const norm = (s) => firstString(s).toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:llc|l\.l\.c|inc|incorporated|corp|corporation|co|ltd|pllc|lp)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return true;                       // nothing to disagree about
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Do two street addresses point at the same place?
 *
 * Every `number + word` pair in each string is collected and any shared pair
 * means yes. Taking only the *first* number found is what a tidier version did,
 * and it called austinsmaidservice.com a NAP mismatch: the footer scrape reads
 * "7 Online 8711 Burnet Rd #A13" — the same address with a fragment of the
 * scheduling blurb welded to the front — so the first number was "7" and the
 * comparison failed against a perfectly matching address.
 *
 * Lenient on purpose. This decides whether to *raise a conflict* and demote a
 * field to the Confirm bucket, so a missed conflict costs a finding while a
 * false one costs a wrong claim in the report and a question the client has
 * already answered.
 */
export function sameStreetAddress(a, b) {
  const keys = (s) => {
    const t = firstString(s).toLowerCase().replace(/\s+/g, " ").trim();
    const out = new Set();
    for (const m of t.matchAll(/\b(\d{1,6})\s+([a-z0-9'.-]+)/g)) {
      const word = m[2].replace(/[^a-z0-9]/g, "");
      if (word) out.add(`${m[1]} ${word}`);
    }
    return out;
  };
  const x = keys(a), y = keys(b);
  if (!x.size || !y.size) return true;
  for (const k of x) if (y.has(k)) return true;
  return false;
}

/* ── the other two syntaxes ───────────────────────────────────────────────
 *
 * JSON-LD is the syntax Google recommends and by far the most common, but it
 * is not the only one that counts as structured data. Squarespace themes and
 * pre-2016 WordPress themes emit **microdata** (`itemscope`/`itemtype`) and
 * nothing else, and the audit read those sites as having no structured data at
 * all — a flatly wrong headline claim about markup sitting in HTML we had
 * already fetched.
 *
 * This finds and reports; it deliberately does not feed the record. Reading
 * values out of microdata means walking element subtrees to find where each
 * `itemscope` ends, and we have no DOM here — a regex would attribute a nested
 * item's `itemprop` to its parent. Presence is reliable; values are not, and a
 * wrong value at high confidence costs more than a missing one.
 * ─────────────────────────────────────────────────────────────────────── */

// Retired by Google in 2020; anything still using it earns nothing at all.
const LEGACY_VOCAB = /data-vocabulary\.org/i;

/**
 * Microdata and RDFa presence, as a claim about what the page ships.
 *
 * RDFa needs a `typeof` to count. Bare `property=` attributes are not evidence
 * of it — every site with Open Graph tags has dozens of them, and treating
 * those as RDFa would report structured data on essentially every page.
 *
 * @returns {{present: boolean, formats: string[], types: string[],
 *            props: number, legacyVocab: boolean, business: boolean}}
 */
export function extractMicrodata(html) {
  const s = html || "";
  const norm = (u) => u.replace(SCHEMA_ORG_PREFIX, "").replace(/^.*\//, "").trim();

  const itemtypeAttrs = [...s.matchAll(/\bitemtype\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const hasScope = /\bitemscope\b/i.test(s);
  const mdTypes = itemtypeAttrs
    .filter(u => SCHEMA_ORG_PREFIX.test(u.trim()))
    .flatMap(u => u.trim().split(/\s+/)).map(norm).filter(Boolean);
  const mdProps = (s.match(/\bitemprop\s*=\s*["'][^"']+["']/gi) || []).length;

  // `typeof` on an element inside a schema.org `vocab`, or naming a type we
  // recognize outright — RDFa Lite lets the vocab be declared far up the tree.
  const vocabIsSchema = [...s.matchAll(/\bvocab\s*=\s*["']([^"']+)["']/gi)]
    .some(m => SCHEMA_ORG_PREFIX.test(m[1].trim()));
  const rdfaTypes = [...s.matchAll(/\btypeof\s*=\s*["']([^"']+)["']/gi)]
    .flatMap(m => m[1].trim().split(/\s+/)).map(norm)
    .filter(t => t && (vocabIsSchema || BIZ_TYPES.has(t) || VALUE_TYPES.has(t) || NEVER_BUSINESS.has(t)));

  const formats = [];
  if (hasScope && (mdTypes.length || mdProps)) formats.push("microdata");
  if (rdfaTypes.length) formats.push("RDFa");
  const types = [...new Set([...mdTypes, ...rdfaTypes])];

  return {
    present: formats.length > 0,
    formats, types,
    props: mdProps,
    legacyVocab: itemtypeAttrs.some(u => LEGACY_VOCAB.test(u)),
    business: types.some(isBusinessType),
  };
}

/**
 * Service areas the business states outright, as plain names.
 *
 * `areaServed` arrives as a list of Place objects, a single Place whose `name`
 * is itself a list, or bare strings — all three are in the live sample. A
 * `GeoCircle` is skipped on purpose: a radius in metres is not a place name,
 * and turning one into a city list would be inventing the cities.
 */
export function extractAreaServed(business) {
  const out = [], seen = new Set();
  const add = (name, within) => {
    let s = firstString(name).replace(/\s+/g, " ").trim();
    if (!s || s.length > 80) return;
    // "Albuquerque" + containedInPlace "NM" → "Albuquerque, NM". Composition of
    // two things the markup states, not an inference about where a city is.
    const w = firstString(within).replace(/\s+/g, " ").trim();
    if (w && !s.includes(",") && w.toLowerCase() !== s.toLowerCase()) s = `${s}, ${w}`;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  const walk = (v, depth = 0) => {
    if (depth > 4 || v == null) return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (typeof v === "string") { add(v, ""); return; }
    if (typeof v !== "object") return;
    const within = v.containedInPlace ?? v.containedIn ?? v.address?.addressRegion ?? "";
    if (Array.isArray(v.name)) { v.name.forEach(n => add(n, within)); return; }
    if (v.name) { add(v.name, within); return; }
    if (v.address) walk(v.address, depth + 1);
  };
  walk(business?.areaServed);
  return out;
}

/** Price off a Service/Product/Offer, tolerating the shapes it comes in. */
function priceOf(n) {
  const off = asArray(n.offers ?? n.priceSpecification)[0];
  if (off == null) return n.price != null ? firstString(n.price) : "";
  if (typeof off !== "object") return firstString(off);
  const p = off.price ?? off.priceSpecification?.price ?? off.lowPrice;
  return p != null ? firstString(p) : "";
}

/**
 * Flatten the handful of business fields that arrive in more than one shape.
 *
 * Every consumer downstream treats these as scalars — `prefill.mjs` assigns
 * `biz.telephone` straight into a string field, and `socialOf` calls `.find` on
 * `biz.sameAs`, which throws outright on the perfectly legal `"sameAs": "…"`.
 * Normalizing once here beats defending in each of a dozen call sites.
 *
 * `ratingCount` is folded into `reviewCount` because schema.org allows either
 * and consumers only ever read the latter — a real 212-review business was
 * reading as having a rating and no reviews.
 */
function normalizeBusiness(biz) {
  if (!biz) return null;
  const b = { ...biz };
  for (const k of ["name","telephone","email","priceRange","slogan","alternateName","foundingDate","description"]) {
    if (b[k] != null) b[k] = firstString(b[k]);
  }
  if (b.telephone) b.telephone = b.telephone.replace(/^tel:\s*/i, "").trim();
  if (b.email)     b.email     = b.email.replace(/^mailto:\s*/i, "").trim();
  if (b.sameAs != null) b.sameAs = asArray(b.sameAs).map(u => firstString(u)).filter(Boolean);
  if (Array.isArray(b.address)) b.address = b.address[0];   // multi-location: first wins
  if (b.aggregateRating && typeof b.aggregateRating === "object") {
    const ar = { ...b.aggregateRating };
    if (ar.reviewCount == null && ar.ratingCount != null) ar.reviewCount = ar.ratingCount;
    b.aggregateRating = ar;
  }
  return b;
}
