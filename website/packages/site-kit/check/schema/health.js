/**
 * health.js — `schemaHealth()`, forked from site-auditor/val/discovery.mjs.
 *
 * Kept as close to the source as possible so the two can be diffed. The one
 * behavioural change: the auditor only fetches some inner pages
 * (`wantsPageSchema`), while this reads every built page, so every row counts
 * as eligible and the coverage note never fires.
 */
import { hoursDisagreement, readSchemaHours, sameBusinessName, sameStreetAddress } from "./schema.js";
import { evaluateFeatures } from "./google-features.js";

// Every row the ksite audit passes in was read from disk or fetched in full.
const wantsPageSchema = (row) => !!row;

/**
 * What the audit should *say* about a site's structured data.
 *
 * The scorecard had one binary item — "Structured data: present/absent" — which
 * is the weakest possible finding in a document whose job is to argue for a
 * rebuild. It also can't distinguish the states that matter: absent, absent
 * from JSON-LD but present as microdata, broken, syntactically fine but
 * meaningless, and present-but-not-earning-anything.
 *
 * Four questions, in order, because each only matters if the one before it
 * passed:
 *
 *   1. Is there any structured data at all, in any syntax?
 *   2. Does it parse, and does its `@context` make the types mean anything?
 *   3. Do its values meet the rules a rich result is granted under?
 *   4. Does it agree with the page it is sitting on, and with the other pages?
 *
 * Pure: takes what discovery and the row fetches already produced, adds no
 * requests. Every finding names a thing that is true of the markup, not a
 * guess about intent — and nothing here writes to the record.
 *
 * @param {object} discovery homepage discovery result
 * @param {object[]} rows sitemap rows, some carrying `row.schema`
 * @param {{schemaPagesSkipped?: number}} [opts] what the run capped, so coverage can say so
 * @returns {{present: boolean, blocks: number, parsed: number, broken: number,
 *            types: string[], pagesWithSchema: number, pagesMissingSchema: string[],
 *            findings: {level: "error"|"warn"|"info", key: string, message: string}[]}}
 */
export function schemaHealth(discovery, rows = [], opts = {}) {
  const sc = discovery?.schema || null;
  const biz = sc?.business || null;
  const md  = discovery?.microdata || null;
  const val = sc?.validity || null;
  const findings = [];
  const add = (level, key, message) => findings.push({ level, key, message });
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const blocks = sc?.blocks || 0;
  const parsed = sc?.blocksParsed || 0;
  const broken = Math.max(0, blocks - parsed);
  const recovered = (sc?.parseErrors || []).filter(e => e.recovered).length;
  const inert = (sc?.contextIssues || []).length;

  /* 1 ── is there anything, in any syntax? */
  if (!blocks && md?.present) {
    // Not "no structured data". Squarespace and older WordPress themes ship
    // microdata and no JSON-LD; calling that site unmarked is a false claim
    // the client can disprove in one look at their own source.
    add("warn", "microdata-only",
      `No JSON-LD, but the page ships ${md.formats.join(" and ")}${md.types.length ? ` declaring ${md.types.slice(0,6).join(", ")}` : ""}. ` +
      (md.business
        ? "Google still reads it, but JSON-LD is the syntax it recommends and the one every current tool assumes."
        : "None of it identifies the business — there is no LocalBusiness or Organization node in any syntax on this page."));
  } else if (!blocks) {
    add("error", "absent", "No JSON-LD found in the served HTML, and no microdata or RDFa either. Google is reading this site by inference alone.");
    // The audit fetches static HTML and does not run scripts, so schema that a
    // page builder or tag manager injects at runtime is invisible to it. We
    // deliberately don't render JS to find out — but "none found" and "none
    // exists" are different claims, and only the first one is ours to make.
    const injector = /wix|squarespace|webflow|shopify|hubspot|duda|godaddy/i.test(discovery?.cms || "")
      ? discovery.cms
      : (discovery?.thirdParty || []).find(t => /tag manager/i.test(t.name || ""))?.name || "";
    add("info", "static-fetch-only",
      injector
        ? `This audit reads the served HTML and does not execute JavaScript. ${injector} can inject structured data at runtime — confirm with Google's Rich Results Test before reporting that the site has none.`
        : "This audit reads the served HTML and does not execute JavaScript. If structured data is injected client-side it would not appear here — confirm with Google's Rich Results Test before reporting that the site has none.");
  }
  if (md?.legacyVocab) {
    add("error", "legacy-vocab", "Markup uses data-vocabulary.org, which Google stopped supporting in 2020. It earns nothing and reports as an error in Search Console.");
  }

  /* 2 ── does it parse, and does it mean anything? */
  if (broken) {
    add("error", "unparseable", `${broken} of ${blocks} JSON-LD blocks failed to parse — the markup is present and Google discards it.`);
  }
  if (recovered) {
    add("warn", "invalid-json", `${plural(recovered, "JSON-LD block is", "JSON-LD blocks are")} invalid JSON that we recovered by repair. A validator will reject what we accepted.`);
  }
  if (inert) {
    const missing = (sc.contextIssues || []).filter(c => c.status === "missing").length;
    const types = [...new Set((sc.contextIssues || []).flatMap(c => c.types))].slice(0, 6);
    add("error", "inert-context",
      `${plural(inert, "block declares", "blocks declare")} ${missing === inert ? "no @context" : "a non-schema.org @context"}${types.length ? ` (${types.join(", ")})` : ""}. The JSON is valid and the types mean nothing without it — every consumer discards these.`);
  }

  /* References to nodes that aren't there, and properties with no value.
   *
   * Both are per page and both repeat on every page one template renders, so
   * they're grouped by what's wrong and counted by page — "provider on 11
   * pages", not eleven findings. The homepage counts as a page.
   */
  const pages = [{ url: "", sc }, ...rows.filter(r => r.schema).map(r => ({ url: r.url, sc: r.schema }))].filter(p => p.sc);
  const where = (urls) => {
    const shown = urls.slice(0, 3).map(u => { if (!u) return "the homepage"; try { return new URL(u).pathname; } catch { return u; } });
    return shown.join(", ") + (urls.length > 3 ? ", …" : "");
  };
  const dangling = new Map();
  for (const p of pages) for (const d of p.sc.danglingRefs || []) {
    const k = `${d.prop}|${d.id}`;
    if (!dangling.has(k)) dangling.set(k, { ...d, urls: [] });
    dangling.get(k).urls.push(p.url);
  }
  for (const d of dangling.values()) {
    add("warn", "dangling-ref",
      `${d.prop || "A property"} points at ${d.id} on ${plural(d.urls.length, "page", "pages")} (${where(d.urls)}), and no node on ${d.urls.length === 1 ? "that page" : "those pages"} carries that @id. ` +
      `A reference resolves only to a node on the same page, so ${d.prop || "the property"} says nothing there.`);
  }
  const empties = new Map();
  for (const p of pages) for (const path of p.sc.emptyValues || []) {
    if (!empties.has(path)) empties.set(path, []);
    empties.get(path).push(p.url);
  }
  if (empties.size) {
    const list = [...empties].slice(0, 8).map(([path, urls]) => `${path}${urls.length > 1 ? ` (${urls.length} pages)` : ""}`);
    add("info", "empty-values",
      `${plural(empties.size, "property is", "properties are")} emitted with no value — null, "" or []: ${list.join(", ")}${empties.size > 8 ? ", …" : ""}. ` +
      "Consumers treat these as absent, so nothing is lost, but it's a template writing out fields it had nothing to put in.");
  }

  if (blocks && !biz) {
    add("error", "no-business", "Structured data exists but no LocalBusiness or Organization node — nothing identifies the business itself.");
  }

  if (biz) {
    const types = Array.isArray(biz["@type"]) ? biz["@type"] : [biz["@type"]].filter(Boolean);
    const generic = types.length && types.every(t => /^(?:https?:\/\/schema\.org\/)?(?:Organization|Corporation|NGO)$/.test(t));
    if (generic) {
      add("warn", "generic-type", `Marked up as ${types.join("/")} rather than a LocalBusiness subtype — local rich results key off the more specific type.`);
    }
    /* A type schema.org does not define.
     *
     * This is the failure no other check in the audit can see: it parses, the
     * @context is right, every required property is present, and Google reads
     * the node as a bare `Thing` — so no local result, from markup that looks
     * immaculate. There is no cleaning-service type in schema.org at all;
     * `HouseCleaningService`, `CleaningService` and `MaidService` are all
     * invented and between them they are on most of this corpus.
     *
     * Only fires when *every* declared type is invented. `["LocalBusiness",
     * "HouseCleaningService"]` is fine — the real type carries the node and the
     * invented one is inert decoration.
     */
    const invented = (sc?.vocabulary?.unknownTypes || []).filter(u => types.some(t => String(t).endsWith(u.type)));
    if (invented.length === types.length && types.length) {
      const names = invented.map(u => u.type).join("/");
      const suggest = invented.find(u => u.suggest)?.suggest;
      add("error", "invented-type",
        `${names} is not a type schema.org defines, so Google reads this node as an untyped Thing and it earns no local result. The markup is otherwise correct, which is why nothing else reports it.` +
        (suggest ? ` There is no cleaning-service type in the vocabulary at all — ${suggest} and HomeAndConstructionBusiness are the real options.` : ""));
    } else if (invented.length) {
      // The common and harmless shape: ["LocalBusiness", "HouseCleaningService"].
      // The real type carries the node and the invented one is inert, so this is
      // worth knowing and not worth fixing urgently.
      const real = types.filter(t => !invented.some(u => String(t).endsWith(u.type)));
      add("info", "invented-type",
        `${invented.map(u => u.type).join("/")} is not a type schema.org defines and is ignored, but ${real.join("/")} on the same node carries it, so nothing is lost.`);
    }
    const others = (sc?.raw || []).filter(n => {
      const t = Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]];
      return t.some(x => typeof x === "string" && /Business|Organization/.test(x)) && n.name && n.name !== biz.name;
    });
    if (others.length) {
      add("warn", "conflicting-names", `More than one business node, under different names: ${[biz.name, ...others.map(n => n.name)].filter(Boolean).join(" / ")}.`);
    }
    // The same name twice is the other half of that check. The audit merged
    // these nodes to read the business; the finding says it had to.
    const split = sc?.splitBusiness || [];
    if (split.length) {
      const label = (n) => n.type + (n.id ? ` (${n.id})` : "");
      const carries = split.filter(n => n.only.length).map(n => `${n.type} alone carries ${n.only.slice(0, 6).join(", ")}${n.only.length > 6 ? ", …" : ""}`);
      add("info", "business-split",
        `${split.map(label).join(" and ")} both describe "${biz.name}", and nothing in the markup says they are one business — no shared @id, and neither refers to the other. ` +
        (carries.length ? `${carries.join("; ")}. ` : "") +
        "This audit merged them to read the business; a consumer isn't obliged to. Give them one @id, or merge them into a single node.");
    }
    const pa = discovery?.phoneAnalysis;
    if (pa?.hasDiscrepancy) {
      add("info", "nap-phone", `Schema phone (${pa.schema}) differs from the number shown on the page (${pa.display}) — usually call tracking, worth confirming.`);
    }
  }

  /* 3 ── would any of it actually earn a result? */
  if (val) {
    if (val.relativeUrls.length) {
      const list = val.relativeUrls.map(r => `${r.prop}="${r.value}"`).join(", ");
      add("error", "relative-urls", `URL properties are relative, which schema.org does not allow: ${list}. Google cannot resolve them and the image never appears.`);
    }
    /* Self-serving review markup.
     *
     * This block used to tell clients that fixing their review markup would
     * win them stars. It won't, and saying so was the most confidently wrong
     * thing the audit produced. Google:
     *
     *   "If the entity that's being reviewed controls the reviews about
     *    itself, their pages that use LocalBusiness or any other type of
     *    Organization structured data are ineligible for star review feature."
     *
     * That is every cleaning company with a testimonials section, i.e. the
     * whole corpus. The markup can still be *invalid* — Search Console reports
     * it either way, and invalid nodes can drag down the business node they sit
     * in — so the defects are still worth naming. They are named as defects,
     * not as a feature waiting to be unlocked.
     */
    // The finding itself comes from the feature table below, which is where the
    // rule and its citation live. What it decides here is severity.
    const selfServing = val.reviewsSelfServing > 0 || val.ratingSelfServing;
    // Downgraded when self-serving: a defect in markup that was never going to
    // earn a result is a tidiness problem, not a lost opportunity.
    const revLevel = selfServing ? "info" : "error";
    const revWarn  = selfServing ? "info" : "warn";
    const earns    = selfServing ? "" : " and earns no snippet";

    if (val.ratingOutOfRange) {
      add(revLevel, "rating-invalid", `aggregateRating is ${val.ratingOutOfRange} — outside its own scale, so the whole rating is invalid${earns}.`);
    } else if (val.ratingNoValue) {
      add(revLevel, "rating-invalid", `aggregateRating has no ratingValue — an incomplete rating invalidates the node it sits on${earns}.`);
    } else if (val.ratingNoCount) {
      add(revLevel, "rating-invalid", `aggregateRating has no reviewCount or ratingCount. Google requires one of the two; without it the rating is invalid${earns}.`);
    }
    if (val.reviewsNoAuthor) {
      add(revLevel, "reviews-no-author", `${plural(val.reviewsNoAuthor, "review has", "reviews have")} no author, which Google requires on every Review${earns}.`);
    }
    if (val.reviewsAnonymous) {
      add(revWarn, "reviews-anonymous", `${plural(val.reviewsAnonymous, "review is", "reviews are")} attributed to "Anonymous" or similar, which is not a valid author name${earns}.`);
    }
    if (val.reviewsNoRating) {
      add(revWarn, "reviews-no-rating", `${plural(val.reviewsNoRating, "review carries", "reviews carry")} no reviewRating, which Google requires on every Review${earns}.`);
    }
    if (val.questionsNoAnswer) {
      add("error", "faq-no-answer", `${plural(val.questionsNoAnswer, "Question has", "Questions have")} no acceptedAnswer text. A Question without an answer invalidates the FAQPage.`);
    }
    if (val.addressIsString) {
      add("info", "address-unstructured", "address is a plain string rather than a PostalAddress. It's legal, but Google parses the structured form far more reliably.");
    } else if (val.addressMissing.length) {
      add("warn", "address-incomplete", `PostalAddress is missing ${val.addressMissing.join(", ")}. A local result is built from the complete address.`);
    }
    if (val.phoneSuspect) {
      add("warn", "phone-invalid", `telephone is "${val.phoneSuspect}" — too few digits to dial.`);
    }
    if (val.geoSuspect) {
      add("warn", "geo-invalid", `geo coordinates are ${val.geoSuspect}.`);
    }
    if (val.placeholderSameAs.length) {
      add("warn", "placeholder-social", `sameAs contains unfilled template links: ${val.placeholderSameAs.join(", ")}.`);
    }
    if (val.nonHttpSameAs.length) {
      add("warn", "placeholder-social", `sameAs contains values that are not URLs: ${val.nonHttpSameAs.join(", ")}.`);
    }
  }

  /* 4 ── does it agree with the page, and with the other pages? */
  if (biz) {
    const ci = discovery?.contactInfo || {};
    const brandName = discovery?.brand?.nameSource === "og:site_name" ? discovery.brand.name : "";
    if (biz.name && brandName && !sameBusinessName(biz.name, brandName)) {
      add("warn", "nap-name", `Schema calls the business "${biz.name}"; og:site_name says "${brandName}". Google weighs name consistency across a site.`);
    }
    const schemaStreet = typeof biz.address === "string" ? biz.address : (biz.address?.streetAddress || "");
    const pageStreet = ci.addresses?.[0] || "";
    if (schemaStreet && pageStreet && !sameStreetAddress(schemaStreet, pageStreet)) {
      add("warn", "nap-address", `Schema address ("${schemaStreet}") doesn't match the one printed on the page ("${pageStreet}").`);
    }

    const readHours = readSchemaHours(biz);
    const clash = hoursDisagreement(readHours.hours, ci.hours);
    if (clash.length) {
      const shown = clash.slice(0, 3).map(c => `${c.day} ${c.schema} vs ${c.page}`).join("; ");
      add("warn", "hours-conflict",
        `Opening hours in the markup disagree with the hours printed on the page on ${plural(clash.length, "day", "days")}: ${shown}. The record asks rather than picking a side.`);
    }
    if (readHours.overnight.length) {
      // Reported rather than dropped in silence — see `readSchemaHours`.
      // ksite: the source's wording was about its intake record. Here it's
      // almost always 12-hour time ("07:00-4:30"), not a night shift.
      add("warn", "hours-overnight", `openingHours closes before it opens on ${readHours.overnight.join(", ")}, which reads as an overnight shift. If that isn't meant, a closing time is in 12-hour form (e.g. 4:30 for 16:30) — use 24-hour times.`);
    }
  }

  const pageBusinesses = rows
    .map(r => ({ url: r.url, b: r.schema?.business }))
    .filter(x => x.b);
  if (biz?.name) {
    const nameClash = pageBusinesses.filter(x => x.b.name && !sameBusinessName(biz.name, x.b.name));
    if (nameClash.length) {
      add("warn", "page-name-conflict",
        `Inner pages name the business differently from the homepage ("${biz.name}"): ${nameClash.slice(0,3).map(x => `${x.b.name} on ${x.url}`).join("; ")}.`);
    }
  }
  const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (biz?.telephone) {
    const homePhone = digits(biz.telephone);
    const phoneClash = pageBusinesses.filter(x => x.b.telephone && digits(x.b.telephone) !== homePhone);
    if (phoneClash.length) {
      add("warn", "page-phone-conflict",
        `Inner pages carry a different phone number in their markup than the homepage (${biz.telephone}): ${phoneClash.slice(0,3).map(x => `${x.b.telephone} on ${x.url}`).join("; ")}.`);
    }
  }

  // Content the site has, without the markup that would let it be indexed as
  // that content. Cheap to fix and the most common thing an audit can sell.
  const anyPage = (f) => rows.some(f);
  if (!sc?.faqs?.length && !rows.some(r => r.schema?.faqs?.length)
      && anyPage(r => r.extracted?.faqs?.length || r.type === "faq")) {
    add("info", "faq-unmarked", "FAQ content exists on the site with no FAQPage markup.");
  }
  if (!sc?.services?.length && !rows.some(r => r.schema?.services?.length)
      && anyPage(r => r.type === "service")) {
    add("info", "services-unmarked", "Service pages exist with no Service or OfferCatalog markup.");
  }

  // Distinct URLs, one page. Both of these were found by hand on
  // waterwavecleaning.com, where six /services/* URLs share one H1 and one body
  // — the audit read all six, reported six services with the same name, and
  // said nothing about why (decision 89).
  const svcRows = rows.filter(r => r.type === "service" && r.extracted);
  const groupBy = (list, key) => {
    const groups = new Map();
    for (const r of list) {
      const k = key(r);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return [...groups.values()].filter(g => g.length > 1).sort((x, y) => y.length - x.length);
  };
  const sameBody = groupBy(svcRows, r => r.extracted.contentHash);
  if (sameBody.length) {
    const g = sameBody[0];
    add("warn", "service-pages-duplicate-body",
      `${g.length} service pages serve identical body content — ${g.slice(0, 3).map(r => new URL(r.url).pathname).join(", ")}${g.length > 3 ? ", …" : ""}. ` +
      `Only the title and meta description differ, so there is one page's worth of content behind ${g.length} URLs.`);
  } else {
    const sameH1 = groupBy(svcRows, r => r.extracted.h1);
    if (sameH1.length) {
      const g = sameH1[0];
      add("warn", "service-pages-duplicate-h1",
        `${g.length} service pages share one H1 ("${g[0].extracted.h1}") — ${g.slice(0, 3).map(r => new URL(r.url).pathname).join(", ")}${g.length > 3 ? ", …" : ""}. ` +
        `Each page's H1 should name the service that page is about.`);
    }
  }
  /* 5 ── graded against what Google documents, feature by feature.
   *
   * The checks above ask whether the markup is well-formed and honest. This
   * asks the only question the client has: does it earn anything? The rules
   * are declared in `google-features.mjs` with the doc each came from, rather
   * than sprinkled through here — this used to be one undifferentiated
   * "Business node is missing: address, telephone, url, opening hours, logo or
   * image, areaServed, priceRange, sameAs", which reads as eight failures
   * when Google requires exactly two of those eight.
   *
   * FAQPage is graded from the whole crawl, not the homepage: /faq is where it
   * lives on almost every site, and a feature is claimed if any page claims it.
   */
  const features = evaluateFeatures(sc && {
    ...sc,
    faqs: [...(sc.faqs || []), ...rows.flatMap(r => r.schema?.faqs || [])],
  });
  for (const f of features) {
    if (f.missingRequired.length && !f.defectsReportedElsewhere) {
      // An unavailable feature can't be broken. Saying "this cannot appear"
      // about something that was never going to appear is noise dressed as
      // urgency, so eligibility decides the level.
      add(f.ineligible ? "info" : "error", "feature-blocked",
        `${f.label} cannot appear: ${plural(f.missingRequired.length, "required property is", "required properties are")} missing — ${f.missingRequired.join(", ")}.`);
    }
    if (f.ineligible) {
      add("info", "feature-ineligible", `${f.label}: ${f.ineligible}`);
    } else if (f.earns && f.missingRecommended.length) {
      const list = f.missingRecommended.length > 1
        ? `${f.missingRecommended.slice(0, -1).join(", ")} and ${f.missingRecommended.at(-1)}`
        : f.missingRecommended[0];
      add("info", "feature-thin",
        `${f.label}: Google also recommends ${list}, which the markup doesn't carry.`);
    }
  }

  /* 6 ── words schema.org doesn't define.
   *
   * Undefined terms under a schema.org @context are dropped by every consumer,
   * silently. A typo'd property is therefore indistinguishable from an absent
   * one at a distance, which is why this reads the vocabulary rather than a
   * pattern. Both are notes, not errors — a stray property costs the node
   * nothing, unlike an invented type on the business itself.
   */
  const vocab = sc?.vocabulary;
  if (vocab?.unknownProps?.length) {
    const shown = vocab.unknownProps.slice(0, 6);
    add("info", "unknown-props",
      `${plural(vocab.unknownProps.length, "property is", "properties are")} not defined by schema.org and are discarded: ${shown.join(", ")}${vocab.unknownProps.length > shown.length ? "…" : ""}.`);
  }

  const targets = rows.filter(wantsPageSchema);
  const withSchema = targets.filter(r => r.schema?.blocks);
  const pagesMissingSchema = targets.filter(r => r.schema && !r.schema.blocks).map(r => r.url);
  // Pages that wanted a schema fetch and never got one. Without this, "2 pages
  // missing structured data" reads as a complete count on a site where seventy
  // were never opened.
  //
  // The number is derived, not passed in. `schemaPagesSkipped` counts only the
  // rows that reached the cap *inside* the page-fetch window — on a 126-row
  // sitemap fetched 25 rows deep it reported 12 against a denominator of 74,
  // and a coverage line whose own arithmetic doesn't work is worse than none.
  // The cap is still named when it fired, as one reason among two.
  const checked = withSchema.length + pagesMissingSchema.length;
  const notChecked = Math.max(0, targets.length - checked);
  if (notChecked > 0) {
    const capped = opts.schemaPagesSkipped || 0;
    add("info", "coverage-capped",
      `Structured data was checked on ${checked} of ${targets.length} eligible pages — ${notChecked} were not fetched${capped ? ` (${capped} of them hit the per-run cap)` : ""}. The page-level counts cover only what was checked.`);
  }

  return {
    present: !!blocks || !!md?.present,
    blocks, parsed, broken, inert,
    types: sc?.types || [],
    parseErrors: sc?.parseErrors || [],
    contextIssues: sc?.contextIssues || [],
    validity: val,
    vocabulary: vocab || null,
    features,
    microdata: md,
    pagesWithSchema: withSchema.length,
    pagesChecked: checked,
    pagesEligible: targets.length,
    pagesSkipped: notChecked,
    pagesMissingSchema,
    // Errors first, then warnings, then notes. The list is read top-down into a
    // report and a flat one buried the disqualifying findings among the notes.
    findings: findings.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]),
  };
}

const LEVEL_RANK = { error: 0, warn: 1, info: 2 };
