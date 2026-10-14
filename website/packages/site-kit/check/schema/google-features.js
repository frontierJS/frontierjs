/**
 * ksite-discovery / google-features.mjs
 *
 * What Google actually grants, as a declared table rather than checks scattered
 * through the audit.
 *
 * The distinction this file exists for: **schema.org's rules and Google's rules
 * are not the same rules.** schema.org marks almost every property optional —
 * a `LocalBusiness` with nothing but a `name` is valid schema.org and always
 * has been. Google's search gallery is where requiredness lives, and it is
 * stricter, narrower, and changes without the vocabulary changing at all.
 *
 * Three things follow, and each one was previously got wrong somewhere in this
 * codebase:
 *
 *   1. **Required and recommended are different findings.** A local result is
 *      built from `name` and `address` and nothing else is required. The audit
 *      used to report eight properties in one undifferentiated "missing" list,
 *      which reads as eight failures when it is at most two.
 *
 *   2. **Complete is not the same as eligible.** FAQPage has been restricted to
 *      government and health sites since 2023, and review markup an entity
 *      controls about itself has never earned stars. Both can be flawless and
 *      still win nothing, so eligibility is a field here, not a footnote.
 *
 *   3. **A rule needs a citation.** Every entry carries the doc URL it came
 *      from, because these change and the next person needs to check rather
 *      than trust. Requiredness below was read off the pages named in `docs`.
 *
 * Deliberately not exhaustive. This is the set a home-services business can
 * plausibly earn: local result, logo, breadcrumb, FAQ, review snippet. Product,
 * Recipe, Event, Job Posting and the rest are real features that no site in
 * this pipeline's corpus is going to be graded on.
 *
 * Pure and dependency-free by design — it imports nothing, so `schema.mjs` can
 * import it later without a cycle.
 */

const str = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return str(v[0]);
  if (typeof v === "object") return str(v.name ?? v["@value"] ?? v.url ?? v["@id"] ?? "");
  return "";
};
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const filled = (v) => (Array.isArray(v) ? v.length > 0 : !!str(v) || (v != null && typeof v === "object"));

/**
 * A rich-result feature, as Google documents it.
 *
 * `claimed`      does the page carry the markup this feature is built on?
 * `required`     properties without which the feature cannot appear
 * `recommended`  properties Google names as improving it
 * `ineligible`   a reason the feature is unavailable no matter how complete
 *                the markup is — "" when it is genuinely available
 */
export const GOOGLE_FEATURES = [
  {
    key: "local-business",
    label: "Local business result",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/local-business",
    claimed: (sc) => !!sc?.business,
    // Two. Not eight. Google: "address" and "name" are the required properties
    // for LocalBusiness; everything else on that page is marked recommended.
    required: [
      ["name",    (sc) => !!str(sc.business?.name)],
      ["address", (sc) => filled(sc.business?.address)],
    ],
    recommended: [
      ["telephone",                (sc) => !!str(sc.business?.telephone)],
      ["url",                      (sc) => !!str(sc.business?.url)],
      ["openingHoursSpecification",(sc) => filled(sc.business?.openingHoursSpecification) || filled(sc.business?.openingHours)],
      ["geo",                      (sc) => filled(sc.business?.geo)],
      ["priceRange",               (sc) => !!str(sc.business?.priceRange)],
      ["image",                    (sc) => filled(sc.business?.image) || filled(sc.business?.logo)],
      ["areaServed",               (sc) => filled(sc.business?.areaServed)],
      ["sameAs",                   (sc) => arr(sc.business?.sameAs).length > 0],
    ],
    ineligible: () => "",
  },
  {
    key: "logo",
    label: "Organization logo",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/logo",
    claimed: (sc) => !!sc?.business,
    // Google's logo page says outright: "There are no required properties."
    // `logo` itself is recommended. Treating a missing logo as a failure would
    // be inventing a rule.
    required: [],
    recommended: [
      ["logo", (sc) => filled(sc.business?.logo)],
      ["url",  (sc) => !!str(sc.business?.url)],
    ],
    ineligible: () => "",
  },
  {
    key: "breadcrumb",
    label: "Breadcrumb trail",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/breadcrumb",
    claimed: (sc) => (sc?.breadcrumbs || []).length > 0,
    required: [
      ["itemListElement", (sc) => (sc.breadcrumbs || []).length > 0],
      ["position",        (sc) => (sc.breadcrumbs || []).every(b => b.position > 0)],
      ["name",            (sc) => (sc.breadcrumbs || []).every(b => !!b.name)],
      // `item` is required on every element except the last, where Google
      // falls back to the containing page's URL. Checking it on the last one
      // would report an error on markup that is exactly right.
      ["item",            (sc) => (sc.breadcrumbs || []).slice(0, -1).every(b => !!b.url)],
    ],
    recommended: [],
    ineligible: () => "",
  },
  {
    key: "faq",
    label: "FAQ rich result",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/faqpage",
    claimed: (sc) => (sc?.faqs || []).length > 0,
    required: [
      ["acceptedAnswer", (sc) => !(sc.validity?.questionsNoAnswer > 0)],
      ["name",           (sc) => (sc.faqs || []).every(f => !!f.question)],
    ],
    recommended: [],
    // The specific defects are counted and reported by the validity section
    // ("2 Questions have no acceptedAnswer"), which is more use than a list of
    // property names. This flag keeps the two from saying the same thing twice.
    defectsReportedElsewhere: true,
    // Restricted to well-known government and health sites in August 2023.
    // Complete FAQPage markup on a cleaning company earns understanding, not
    // an accordion, and selling it as the accordion is selling last year's
    // result.
    ineligible: () =>
      "Since August 2023 Google shows FAQ rich results only for well-known government and health sites. The markup still helps Google understand the page.",
  },
  {
    key: "review-snippet",
    label: "Review stars",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/review-snippet",
    claimed: (sc) => (sc?.validity?.reviewsTotal || 0) > 0 || !!sc?.business?.aggregateRating,
    required: [
      ["author",       (sc) => !(sc.validity?.reviewsNoAuthor > 0)],
      ["reviewRating", (sc) => !(sc.validity?.reviewsNoRating > 0)],
      ["ratingValue",  (sc) => !sc.validity?.ratingNoValue],
      ["ratingCount or reviewCount", (sc) => !sc.validity?.ratingNoCount],
    ],
    recommended: [],
    defectsReportedElsewhere: true,
    // Google: "If the entity that's being reviewed controls the reviews about
    // itself, their pages that use LocalBusiness or any other type of
    // Organization structured data are ineligible for star review feature."
    ineligible: (sc) => {
      const v = sc?.validity || {};
      if (!(v.reviewsSelfServing > 0 || v.ratingSelfServing)) return "";
      const what = [
        v.reviewsSelfServing ? `${v.reviewsSelfServing} review${v.reviewsSelfServing === 1 ? "" : "s"}` : "",
        v.ratingSelfServing ? "an aggregateRating" : "",
      ].filter(Boolean).join(" and ");
      return `the page marks up ${what} about the business publishing it, and Google does not grant stars for reviews an entity controls about itself. No amount of fixing this markup produces stars. It still helps Google understand the page, and the rating is worth confirming against the Google Business Profile.`;
    },
  },
];

/**
 * Grade a page's structured data against the table.
 *
 * Returns one row per feature the page actually claims — a site with no
 * breadcrumbs is not failing the breadcrumb feature, it simply isn't asking
 * for it, and reporting absence as a defect is how an audit turns into a
 * checklist nobody believes.
 *
 * @param {object} sc an `extractSchema` result
 * @returns {{key,label,docs,missingRequired:string[],missingRecommended:string[],
 *            ineligible:string,earns:boolean}[]}
 */
export function evaluateFeatures(sc) {
  if (!sc) return [];
  const out = [];
  for (const f of GOOGLE_FEATURES) {
    if (!f.claimed(sc)) continue;
    const missingRequired    = f.required.filter(([, ok]) => !ok(sc)).map(([n]) => n);
    const missingRecommended = f.recommended.filter(([, ok]) => !ok(sc)).map(([n]) => n);
    const ineligible = f.ineligible(sc) || "";
    out.push({
      key: f.key, label: f.label, docs: f.docs,
      missingRequired, missingRecommended, ineligible,
      defectsReportedElsewhere: !!f.defectsReportedElsewhere,
      // The one question the client is actually asking.
      earns: !ineligible && missingRequired.length === 0,
    });
  }
  return out;
}
