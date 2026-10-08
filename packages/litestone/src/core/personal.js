// personal.js — what the schema says about people (FJS-D657)
//
// `@personal(category?)` marks a column about a person and `@@person(child?)` a
// model whose rows are people. Neither changes who may read a column — that is
// the gate's question and `@omit`'s (FJS-D205). What they change is what the
// audit trail keeps, what a redacted copy keeps, and what a data map reports.
//
// The category list is closed and an unlisted value is refused by name. An
// `other` escape is what turns a category into a label nothing can group by.

// ─── Categories and their regimes ─────────────────────────────────────────────
//
// One table, so an app never restates which categories a regime treats as
// special. `gdpr` is the article that singles the category out (null where it is
// ordinary personal data); `special` is GDPR Art. 9 or 10; `sensitive` is CPRA's
// Cal. Civ. Code § 1798.140(ae). A category feeds the data map only and
// enforces nothing.

export const PERSONAL_CATEGORIES = Object.freeze({
  contact:        { covers: 'name, email, phone, postal address',                         gdpr: null,          special: false, sensitive: false },
  device:         { covers: 'IP address, cookie, device id',                              gdpr: 'Recital 30',  special: false, sensitive: false },
  location:       { covers: 'GPS, precise position',                                      gdpr: null,          special: false, sensitive: true  },
  government:     { covers: 'SSN, passport, licence, immigration status',                 gdpr: 'Art. 87',     special: false, sensitive: true  },
  financial:      { covers: 'bank account, card number',                                  gdpr: null,          special: false, sensitive: true  },
  employment:     { covers: 'job title, salary, performance',                             gdpr: 'Art. 88',     special: false, sensitive: false },
  communication:  { covers: 'the body of a message the person sent',                      gdpr: null,          special: false, sensitive: true  },
  demographic:    { covers: 'date of birth, age, gender, language',                       gdpr: null,          special: false, sensitive: false },
  health:         { covers: 'diagnosis, medical record, insurance id',                    gdpr: 'Art. 9',      special: true,  sensitive: true  },
  genetic:        { covers: 'DNA, genetic test results',                                  gdpr: 'Art. 9',      special: true,  sensitive: true  },
  biometric:      { covers: 'fingerprint, face or voice template',                        gdpr: 'Art. 9',      special: true,  sensitive: true  },
  characteristic: { covers: 'ethnicity, religion, politics, union membership, sex life',  gdpr: 'Art. 9',      special: true,  sensitive: true  },
  criminal:       { covers: 'convictions, offences, background checks',                   gdpr: 'Art. 10',     special: true,  sensitive: false },
})

// ─── Person models ────────────────────────────────────────────────────────────

/** Whether a model's rows are people. An `@@auth` model is one by derivation. */
export function isPersonModel(model) {
  return (model?.attributes ?? []).some(a => a.kind === 'person' || a.kind === 'auth')
}

/** Whether a person model's rows are children in the legal sense. */
export function isChildModel(model) {
  return (model?.attributes ?? []).some(a => a.kind === 'person' && a.child)
}

// ─── Names that look personal ─────────────────────────────────────────────────
//
// A column on a person model with one of these names and no `@personal` is a
// parse warning. Compared case-insensitively on the whole name, so `email` and
// `Email` warn and `emailVerified` does not — a false positive on a correct
// schema is what teaches people to stop reading warnings.

export const PERSONAL_NAMES = Object.freeze({
  email:      'contact',
  phone:      'contact',
  firstname:  'contact',
  lastname:   'contact',
  fullname:   'contact',
  address:    'contact',
  address1:   'contact',
  address2:   'contact',
  city:       'contact',
  zip:        'contact',
  postalcode: 'contact',
  country:    'contact',
  dob:        'demographic',
  birthdate:  'demographic',
  dateofbirth:'demographic',
})

/** The category a column's name suggests, or null. */
export function personalNameCategory(fieldName) {
  return PERSONAL_NAMES[String(fieldName).toLowerCase()] ?? null
}
