// src/fake.js — deterministic value catalogue for generated test data
//
// Not a faker clone. Just enough vocabulary that a generated row reads like a row
// instead of `Name a4f2`, with two hard rules:
//
//   1. Every value comes from the caller's SeededRng — same seed, same data.
//   2. Nothing is emitted unless a seed was set. An unseeded factory keeps the
//      old `Label 3` output, so schema-derived test CASES stay stable and
//      diff-able. Pass `seed:` when you want data a human will read.
//
// The lists are deliberately small and boring. They exist to make output legible,
// not to simulate a population.

const FIRST_NAMES = [
  'Ada', 'Alex', 'Amara', 'Anton', 'Beatriz', 'Casey', 'Chen', 'Dara', 'Devi',
  'Elif', 'Emil', 'Farah', 'Grace', 'Hana', 'Ines', 'Ivan', 'Jae', 'Jordan',
  'Kai', 'Kwame', 'Lena', 'Luca', 'Maya', 'Nadia', 'Nils', 'Omar', 'Priya',
  'Quinn', 'Rafael', 'Rosa', 'Sam', 'Sofia', 'Tariq', 'Theo', 'Uma', 'Viktor',
  'Wren', 'Yara', 'Yusuf', 'Zoe',
]

const LAST_NAMES = [
  'Abara', 'Almeida', 'Andersen', 'Bakker', 'Bergman', 'Cardoso', 'Chowdhury',
  'Diallo', 'Dubois', 'Espinoza', 'Fischer', 'Gallagher', 'Haddad', 'Ishikawa',
  'Jensen', 'Kaur', 'Kovacs', 'Lindqvist', 'Marchetti', 'Mbeki', 'Nakamura',
  'Novak', 'Okafor', 'Petrov', 'Quintero', 'Rasmussen', 'Reyes', 'Silva',
  'Sorensen', 'Tanaka', 'Ueda', 'Vargas', 'Weber', 'Yilmaz', 'Zhang',
]

const CITIES = [
  'Aarhus', 'Bristol', 'Cape Town', 'Dakar', 'Edinburgh', 'Fortaleza', 'Ghent',
  'Helsinki', 'Izmir', 'Jaipur', 'Kyoto', 'Lisbon', 'Medellin', 'Nairobi',
  'Osaka', 'Porto', 'Quito', 'Rotterdam', 'Seville', 'Tallinn', 'Uppsala',
  'Valencia', 'Wellington', 'Zagreb',
]

const COUNTRIES = [
  'Argentina', 'Belgium', 'Canada', 'Denmark', 'Estonia', 'Finland', 'Ghana',
  'Iceland', 'Japan', 'Kenya', 'Latvia', 'Morocco', 'Netherlands', 'Norway',
  'Peru', 'Portugal', 'Senegal', 'Spain', 'Sweden', 'Uruguay', 'Vietnam',
]

const COMPANY_HEAD = [
  'Northwind', 'Harbour', 'Copper', 'Lantern', 'Meridian', 'Ironwood', 'Basalt',
  'Aurora', 'Kestrel', 'Foxglove', 'Sandpiper', 'Bluefin', 'Redstone', 'Tidewater',
]
const COMPANY_TAIL = ['Labs', 'Works', 'Supply', 'Group', 'Trading', 'Systems', 'Partners', 'Co']

const STREETS = [
  'Alder', 'Birch', 'Chestnut', 'Dovecote', 'Elm', 'Fennel', 'Granary', 'Harrow',
  'Juniper', 'Kiln', 'Linden', 'Mill', 'Orchard', 'Poplar', 'Quarry', 'Rowan',
]
const STREET_TYPES = ['Street', 'Road', 'Lane', 'Avenue', 'Way', 'Close']

const WORDS = [
  'ledger', 'harbour', 'signal', 'orchard', 'anchor', 'ember', 'thicket', 'quarry',
  'meadow', 'lantern', 'cobble', 'kettle', 'marsh', 'pebble', 'rafter', 'saddle',
  'timber', 'willow', 'bramble', 'cinder', 'drover', 'furrow', 'gable', 'hollow',
]

const TITLE_HEAD = ['Quarterly', 'Draft', 'Interim', 'Annual', 'Revised', 'Working', 'Field']
const TITLE_TAIL = ['review', 'report', 'summary', 'notes', 'plan', 'brief', 'proposal']

const TLDS = ['example.com', 'example.org', 'test.dev', 'sample.io']

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** Sentence of `n` words from the catalogue. */
function sentence(rng, n = 8) {
  const words = Array.from({ length: n }, () => rng.pick(WORDS))
  return cap(words.join(' ')) + '.'
}

export const FAKE = {
  firstName: (rng) => rng.pick(FIRST_NAMES),
  lastName:  (rng) => rng.pick(LAST_NAMES),
  fullName:  (rng) => `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
  city:      (rng) => rng.pick(CITIES),
  country:   (rng) => rng.pick(COUNTRIES),
  company:   (rng) => `${rng.pick(COMPANY_HEAD)} ${rng.pick(COMPANY_TAIL)}`,
  street:    (rng) => `${rng.int(1, 240)} ${rng.pick(STREETS)} ${rng.pick(STREET_TYPES)}`,
  postcode:  (rng) => `${rng.pick(['AB', 'CD', 'EF', 'GH'])}${rng.int(10, 99)} ${rng.int(1, 9)}${rng.pick(['XY', 'ZW', 'QR'])}`,
  title:     (rng) => `${rng.pick(TITLE_HEAD)} ${rng.pick(TITLE_TAIL)}`,
  word:      (rng) => rng.pick(WORDS),
  sentence,
  paragraph: (rng) => Array.from({ length: 3 }, () => sentence(rng, rng.int(6, 12))).join(' '),
  tld:       (rng) => rng.pick(TLDS),
}

// Field names that map to a catalogue entry. Matched case-insensitively against
// the field name with separators stripped, so `first_name`, `firstName` and
// `FirstName` all land on the same generator.
const FIELD_MAP = {
  firstname:    FAKE.firstName,
  givenname:    FAKE.firstName,
  lastname:     FAKE.lastName,
  surname:      FAKE.lastName,
  familyname:   FAKE.lastName,
  name:         FAKE.fullName,
  fullname:     FAKE.fullName,
  displayname:  FAKE.fullName,
  username:     (rng) => `${FAKE.firstName(rng).toLowerCase()}.${FAKE.lastName(rng).toLowerCase()}`,
  city:         FAKE.city,
  town:         FAKE.city,
  country:      FAKE.country,
  company:      FAKE.company,
  companyname:  FAKE.company,
  organisation: FAKE.company,
  organization: FAKE.company,
  street:       FAKE.street,
  address:      FAKE.street,
  addressline1: FAKE.street,
  postcode:     FAKE.postcode,
  postalcode:   FAKE.postcode,
  zip:          FAKE.postcode,
  title:        FAKE.title,
  subject:      FAKE.title,
  headline:     FAKE.title,
  description:  (rng) => FAKE.sentence(rng, 10),
  summary:      (rng) => FAKE.sentence(rng, 10),
  notes:        (rng) => FAKE.sentence(rng, 8),
  body:         FAKE.paragraph,
  content:      FAKE.paragraph,
  bio:          FAKE.paragraph,
  message:      (rng) => FAKE.sentence(rng, 9),
  label:        FAKE.word,
  tag:          FAKE.word,
  category:     FAKE.word,
}

/**
 * A catalogue value for a field name, or null when nothing fits — the caller then
 * falls back to its own `Label seq` output. Returns null without an rng, which is
 * what keeps unseeded factories deterministic and unchanged.
 */
export function fakeFor(fieldName, rng) {
  if (!rng) return null
  const key = String(fieldName).replace(/[\s_-]/g, '').toLowerCase()
  const fn  = FIELD_MAP[key]
  return fn ? fn(rng) : null
}

/** Human-readable email built from the catalogue — `ada.silva3@example.com`. */
export function fakeEmail(rng, seq) {
  if (!rng) return null
  return `${FAKE.firstName(rng).toLowerCase()}.${FAKE.lastName(rng).toLowerCase()}${seq}@${FAKE.tld(rng)}`
}
