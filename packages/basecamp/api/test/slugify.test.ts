// FJS-2361 -- slugify() once hand-copied toolbelt's slug() and disagreed on accents and apostrophes.
import { test, expect } from 'bun:test'
import { slugify } from '../src/core/resource.ts'
import { slug } from '@frontierjs/toolbelt/inflect'

test('slugify folds accents and deletes apostrophes like toolbelt slug()', () => {
  expect(slugify('Café Prod')).toBe('cafe-prod')
  expect(slugify("It's a C++ thing")).toBe('its-a-c-thing')
  for (const s of ['v1.2', '  Hello  World ', 'Ünïcode—name']) expect(slugify(s)).toBe(slug(s, { max: 64 }))
})

test('slugify caps at 64 with no trailing separator', () => {
  const out = slugify(`${'a'.repeat(63)} b`)
  expect(out.length).toBeLessThanOrEqual(64)
  expect(out.endsWith('-')).toBe(false)
})
