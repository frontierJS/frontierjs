/**
 * ksite-discovery / vocabulary.mjs
 *
 * Does this markup use words schema.org actually defines?
 *
 * Everything else in the audit checks structure, values and Google's feature
 * rules. None of it can catch the failure that matters most here, because an
 * invented type is not an error in any of those senses: it parses, it sits
 * under a correct `@context`, it carries every property Google asks for, and
 * every consumer reads it as a bare `Thing`.
 *
 * The case that prompted this file: **there is no cleaning-service type in
 * schema.org.** `HouseCleaningService`, `CleaningService` and `MaidService` are
 * all invented, and between them they are on most of this corpus. The nearest
 * real types are `HomeAndConstructionBusiness` and plain `LocalBusiness`; the
 * only vocabulary type with "clean" in its name is `DryCleaningOrLaundry`,
 * which means something else. This codebase had noticed half of it — a comment
 * in `schema.mjs` calls `HomeCleaningService` "not real schema.org and
 * everywhere" — while `HouseCleaningService`, equally invented, is used as the
 * canonical business type across three test files.
 *
 * A site whose only business type is invented is not eligible for a local rich
 * result, and nothing else in the audit would ever say so.
 *
 * Two limits, both learned from running it against real markup:
 *
 *   - **Google prescribes terms schema.org never adopted.** `query-input` is in
 *     Google's own sitelinks-searchbox example and is not in the vocabulary.
 *     Reporting it as undefined is true and useless, so the small set of terms
 *     Google tells people to write is allowed through.
 *
 *   - **Property misplacement is not checked at all.** `domainIncludes` is
 *     guidance, not constraint, and carrying the domain table would cost more
 *     than half the file budget for findings that were optional to act on. See
 *     `scripts/build-vocab.mjs`.
 */

import { PROP_NAMES, TYPE_TREE } from "./schema-vocab.js";

/** type → direct supertypes. Parsed once at import from the delimited snapshot. */
const TYPES = new Map(
  TYPE_TREE.split(";").map(entry => {
    const i = entry.indexOf(">");
    return i < 0 ? [entry, []] : [entry.slice(0, i), entry.slice(i + 1).split(",")];
  })
);

const PROPS = new Set(PROP_NAMES.split(","));

/**
 * Terms Google documents that schema.org does not define.
 *
 * Not a general escape hatch — everything here has to be traceable to a Google
 * doc that tells people to write it, because the alternative is reporting a
 * site as broken for following the instructions it was given.
 */
const GOOGLE_TERMS = new Set([
  "query-input",   // sitelinks searchbox, in Google's own example markup
]);

const strip = (t) => String(t ?? "").replace(/^https?:\/\/(?:www\.)?schema\.org\//i, "").replace(/^schema:/, "").trim();

/** ksite: the real type that differs only in case (`organization` → `Organization`), or "". */
const TYPES_LOWER = new Map([...TYPES.keys()].map(t => [t.toLowerCase(), t]));
export function caseOfType(type) {
  const t = strip(type);
  const real = TYPES_LOWER.get(t.toLowerCase()) || "";
  return real !== t ? real : "";
}

/** Is this a type schema.org defines? */
export function isKnownType(type) {
  return TYPES.has(strip(type));
}

/** Is this a property schema.org defines, or one Google prescribes? */
export function isKnownProperty(prop) {
  const p = strip(prop);
  return PROPS.has(p) || GOOGLE_TERMS.has(p);
}

/** A type and everything it inherits from. */
export function ancestorsOf(type) {
  const seen = new Set(), stack = [strip(type)];
  while (stack.length) {
    for (const parent of TYPES.get(stack.pop()) ?? []) {
      if (!seen.has(parent)) { seen.add(parent); stack.push(parent); }
    }
  }
  return seen;
}

/** Does this type descend from `ancestor` (or equal it)? */
export function isSubtypeOf(type, ancestor) {
  const t = strip(type);
  return t === ancestor || ancestorsOf(t).has(ancestor);
}

/**
 * The nearest real type for an invented one — what the site probably meant.
 *
 * Nothing declares `HouseCleaningService` a subclass of anything, so there is
 * no ancestry to walk and this reads the suffix instead. `LocalBusiness` is the
 * honest generalisation of `…Service`/`…Business`: naming a specific real
 * subtype would be guessing at what the company does, which is the kind of
 * confident invention this codebase has been bitten by before.
 */
export function nearestRealType(type) {
  const t = strip(type);
  if (isKnownType(t)) return t;
  if (/(?:Service|Business|Company|Store|Shop|Contractor|Agency)$/.test(t)) return "LocalBusiness";
  return "";
}

/**
 * Check every node's `@type` and property names against the vocabulary.
 *
 * @param {object[]} nodes deep node list from an `extractSchema` pass
 * @returns {{unknownTypes: {type: string, suggest: string}[], unknownProps: string[]}}
 */
export function checkVocabulary(nodes = []) {
  const unknownTypes = new Map();
  const unknownProps = new Set();

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;

    const types = (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]])
      .filter(t => typeof t === "string").map(strip).filter(Boolean);
    for (const t of types) {
      if (!isKnownType(t) && !unknownTypes.has(t)) unknownTypes.set(t, nearestRealType(t));
    }

    for (const key of Object.keys(node)) {
      if (key.startsWith("@")) continue;
      const p = strip(key);
      if (!isKnownProperty(p)) unknownProps.add(p);
    }
  }

  return {
    unknownTypes: [...unknownTypes].map(([type, suggest]) => ({ type, suggest })),
    unknownProps: [...unknownProps],
  };
}
